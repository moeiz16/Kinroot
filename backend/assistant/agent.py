"""Investigation agent: plans tool calls, runs them (permission-checked), composes a cited answer and refuses
to show anything it cannot ground.

- Offline (LLM_FAKE=true, default): a deterministic planner reads the question's intent, names and dates, and
  answers from templates. Same question + same records = same answer.
- Cloud (LLM_FAKE=false + a provider key): LiteLLM with tool calling chooses the tools; the final draft must
  cite only facts the tools returned. A draft that fails the grounding check is replaced by the deterministic
  answer built from the same tool results, so a model can phrase but never invent.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from django.conf import settings

from kinroot.contracts import AssistantStep, Citation

from . import tools

log = logging.getLogger(__name__)
SAFE_MESSAGE = "I couldn't confirm that from the ownership records."
NOT_PERMITTED = "That information isn't available with your current access."
MONTHS = {
    m: i
    for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)
}

INTENTS = [
    (
        "path_between",
        re.compile(
            r"\b(connect|connected|connection|link|linked|path|related|relationship) (between|to|with)\b"
            r"|\bhow (is|are) .+ (connected|linked|related)\b",
            re.I,
        ),
    ),
    ("changes_since", re.compile(r"\b(chang|since|new owner|recent|what happened|what's different|differ)", re.I)),
    ("screening_status", re.compile(r"\b(sanction|pep|politically exposed|screen|watch ?list|match(es)? on)", re.I)),
    ("risk_reasons", re.compile(r"\b(why|risk|rating|rated|high-risk|score)\b", re.I)),
    (
        "who_controls",
        re.compile(
            r"\b(who (owns|controls|is behind|runs)|beneficial owner|ubo|ultimate"
            r"|control(s|led)?|own(s|ed|ership)?|behind)\b",
            re.I,
        ),
    ),
]


@dataclass
class Plan:
    intent: str | None
    parties: list[dict[str, Any]]
    since: date | None = None


@dataclass
class Outcome:
    answer: str
    citations: list[Citation]
    steps: list[AssistantStep]
    node_ids: list[str] = field(default_factory=list)
    edge_ids: list[str] = field(default_factory=list)
    grounded: bool = True
    mode: str = "offline"


def parse_since(question: str, today: date) -> date | None:
    q = question.lower()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", q)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r"(\d{1,2}) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{4})", q)
    if m:
        return date(int(m.group(3)), MONTHS[m.group(2)], int(m.group(1)))
    m = re.search(r"(last|past) (\d+) (day|week|month|year)s?", q)
    if m:
        n, unit = int(m.group(2)), m.group(3)
        return today - timedelta(days=n * {"day": 1, "week": 7, "month": 30, "year": 365}[unit])
    m = re.search(r"(last|past|this) (week|month|quarter|year)", q)
    if m:
        return today - timedelta(days={"week": 7, "month": 30, "quarter": 91, "year": 365}[m.group(2)])
    return None


def plan(org_id: Any, question: str, client_party: dict[str, Any] | None, today: date) -> Plan:
    parties = tools.resolve_names(org_id, question)
    intent = next((name for name, rx in INTENTS if rx.search(question)), None)
    if intent == "changes_since" and not re.search(r"\b(chang|since|recent|happened|differ)", question, re.I):
        intent = None
    if intent is None and (parties or client_party):
        intent = "who_controls"
    if client_party is not None:
        mentioned = any(p["id"] == client_party["id"] for p in parties)
        # the client is the default subject; for "connected to X" it is the default other end
        if (intent != "path_between" and not mentioned) or (
            intent == "path_between" and len(parties) == 1 and not mentioned
        ):
            parties.insert(0, client_party)
    since = parse_since(question, today)
    if intent == "changes_since" and since is None:
        since = today - timedelta(days=90)
    return Plan(intent, parties, since)


def _client_for_party(org_id: Any, party_id: str) -> Any:
    from clients.models import Client

    return Client.objects.filter(org_id=org_id, party_id=party_id).first()


def run_offline(
    org_id: Any, question: str, permissions: frozenset[str], client_party: dict[str, Any] | None, today: date
) -> Outcome:
    p = plan(org_id, question, client_party, today)
    results: list[tools.ToolResult] = []
    denied = False
    try:
        if p.intent == "path_between":
            if len(p.parties) >= 2:
                results.append(tools.path_between(org_id, p.parties[0]["id"], p.parties[1]["id"], permissions))
        elif p.parties:
            subject = p.parties[0]
            client = _client_for_party(org_id, subject["id"])
            if p.intent == "who_controls":
                results.append(tools.who_controls(org_id, subject["id"], permissions))
            elif p.intent == "changes_since" and client is not None and p.since is not None:
                results.append(tools.changes_since(org_id, str(client.id), p.since, permissions))
            elif p.intent == "screening_status" and client is not None:
                results.append(tools.screening_status(org_id, str(client.id), permissions))
            elif p.intent == "risk_reasons" and client is not None:
                results.append(tools.risk_reasons(org_id, str(client.id), permissions))
    except tools.NotPermitted:
        denied = True
    return compose(results, denied=denied, intent=p.intent, plan_=p)


def compose(
    results: list[tools.ToolResult], *, denied: bool = False, intent: str | None = None, plan_: Plan | None = None
) -> Outcome:
    citations: list[Citation] = []
    index: dict[tuple[str, str], int] = {}
    sentences: list[str] = []
    steps = [AssistantStep(tool=r.tool, label=r.label, args=r.args, result_count=r.count) for r in results]  # type: ignore[arg-type]
    for r in results:
        for f in r.facts:
            marks = []
            for c in f.cites:
                key = (c.type, c.id)
                if key not in index:
                    citations.append(c)
                    index[key] = len(citations)
                marks.append(f"[{index[key]}]")
            if marks:
                sentences.append(f"{f.text} {''.join(dict.fromkeys(marks))}.")
    node_ids = sorted({n for r in results for n in r.node_ids})
    edge_ids = sorted({e for r in results for e in r.edge_ids})
    if denied:
        return Outcome(NOT_PERMITTED, [], steps, grounded=False)
    if not sentences:
        empty = {
            "changes_since": "No ownership or control changes were recorded in that period.",
            "screening_status": "No screening matches are recorded for this structure.",
        }.get(intent or "")
        if empty and results:
            return Outcome(empty, [], steps, node_ids, edge_ids, grounded=True)
        return Outcome(SAFE_MESSAGE, [], steps, grounded=False)
    answer = " ".join(sentences)
    ok = grounded(answer, citations)
    return Outcome(answer if ok else SAFE_MESSAGE, citations if ok else [], steps, node_ids, edge_ids, grounded=ok)


ABBREVIATIONS = re.compile(r"\b(Hon|Mr|Mrs|Ms|Dr|Prof|St|No|Pty|Ltd|Co|Inc|Jr|Sr|retd|vs|approx)\.", re.I)


def grounded(answer: str, citations: list[Citation]) -> bool:
    """Every sentence must carry at least one [n] marker and every marker must point at a citation."""
    if not answer.strip() or not citations:
        return False
    text = ABBREVIATIONS.sub(lambda m: m.group(1) + "\u2024", answer.strip())  # protect "Hon." etc.
    text = re.sub(r"(?<=\d)\.(?=\d)", "\u2024", text)  # and decimals
    parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    for s in parts:
        marks = [int(m) for m in re.findall(r"\[(\d+)\]", s)]
        if not marks or any(m < 1 or m > len(citations) for m in marks):
            return False
    return True


# ── Cloud mode (LiteLLM tool calling) ─────────────────────────────────────────────────────────────
TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "find_party",
            "description": "Find parties by name in the firm's ownership records.",
            "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "who_controls",
            "description": "Beneficial owners and controllers of a party, with ownership paths.",
            "parameters": {"type": "object", "properties": {"party_id": {"type": "string"}}, "required": ["party_id"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "path_between",
            "description": "Shortest relationship paths between two parties.",
            "parameters": {
                "type": "object",
                "properties": {"from_id": {"type": "string"}, "to_id": {"type": "string"}},
                "required": ["from_id", "to_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "changes_since",
            "description": "Ownership and control changes in a client's structure since a date (YYYY-MM-DD).",
            "parameters": {
                "type": "object",
                "properties": {"client_id": {"type": "string"}, "since": {"type": "string"}},
                "required": ["client_id", "since"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "screening_status",
            "description": "Sanctions and PEP screening matches for a client's structure.",
            "parameters": {
                "type": "object",
                "properties": {"client_id": {"type": "string"}},
                "required": ["client_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "risk_reasons",
            "description": "Reasons behind a client's current risk rating.",
            "parameters": {
                "type": "object",
                "properties": {"client_id": {"type": "string"}},
                "required": ["client_id"],
            },
        },
    },
]
SYSTEM = (
    "You help an AML/CTF compliance team investigate ownership structures. Use the tools; never guess. "
    "Write at most five short sentences. End every sentence with the citation markers [n] of the facts it uses, "
    "taken only from the numbered facts the tools returned. If the facts do not answer the question, say so."
)


def _call_tool(org_id: Any, name: str, args: dict[str, Any], permissions: frozenset[str]) -> tools.ToolResult:
    if name == "find_party":
        return tools.find_party(org_id, str(args["name"]), permissions)
    if name == "who_controls":
        return tools.who_controls(org_id, str(args["party_id"]), permissions)
    if name == "path_between":
        return tools.path_between(org_id, str(args["from_id"]), str(args["to_id"]), permissions)
    if name == "changes_since":
        return tools.changes_since(
            org_id, str(args["client_id"]), date.fromisoformat(str(args["since"])[:10]), permissions
        )
    if name == "screening_status":
        return tools.screening_status(org_id, str(args["client_id"]), permissions)
    if name == "risk_reasons":
        return tools.risk_reasons(org_id, str(args["client_id"]), permissions)
    raise ValueError(f"unknown tool {name}")


def _numbered(results: list[tools.ToolResult]) -> tuple[str, list[Citation]]:
    cits: list[Citation] = []
    idx: dict[tuple[str, str], int] = {}
    lines = []
    for r in results:
        for f in r.facts:
            nums = []
            for c in f.cites:
                if (c.type, c.id) not in idx:
                    cits.append(c)
                    idx[(c.type, c.id)] = len(cits)
                nums.append(idx[(c.type, c.id)])
            lines.append(f"- {f.text} {''.join(f'[{n}]' for n in nums)}")
    return "\n".join(lines), cits


def run_cloud(
    org_id: Any, question: str, permissions: frozenset[str], client_party: dict[str, Any] | None, today: date
) -> Outcome:
    import litellm  # optional dependency: pip install -e "backend[ai]"

    cfg: dict[str, Any] = settings.KINROOT
    models: list[str] = [str(cfg["LLM_MODEL"]), *list(cfg.get("LLM_FALLBACK_MODELS") or [])]
    context = f"Today is {today.isoformat()}."
    if client_party:
        context += f" The question is about {client_party['name']} (party_id {client_party['id']}"
        client = _client_for_party(org_id, client_party["id"])
        context += f", client_id {client.id})." if client else ")."
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM + " " + context},
        {"role": "user", "content": question},
    ]
    results: list[tools.ToolResult] = []
    denied = False
    for _round in range(4):
        resp = litellm.completion(
            model=models[0],
            fallbacks=models[1:],
            messages=messages,
            tools=TOOL_SCHEMAS,
            timeout=cfg["LLM_TIMEOUT_SECONDS"],
            temperature=0,
        )
        msg = resp.choices[0].message
        calls = getattr(msg, "tool_calls", None) or []
        if not calls:
            break
        messages.append(
            {
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [c.model_dump() if hasattr(c, "model_dump") else c for c in calls],
            }
        )
        for call in calls:
            try:
                r = _call_tool(org_id, call.function.name, json.loads(call.function.arguments or "{}"), permissions)
                results.append(r)
                content = "\n".join(f"- {f.text}" for f in r.facts) or "No records found."
                if r.tool == "find_party":
                    content = json.dumps(r.data.get("matches", []))
            except tools.NotPermitted:
                denied = True
                content = "Not permitted for this user."
            except Exception as exc:  # bad ids from the model are reported back, never raised to the user
                content = f"Tool error: {type(exc).__name__}"
            messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
    facts, citations = _numbered(results)
    fallback = compose(results, denied=denied)
    if not citations:
        return Outcome(
            fallback.answer,
            fallback.citations,
            fallback.steps,
            fallback.node_ids,
            fallback.edge_ids,
            fallback.grounded,
            mode="cloud",
        )
    final = litellm.completion(
        model=models[0],
        fallbacks=models[1:],
        timeout=cfg["LLM_TIMEOUT_SECONDS"],
        temperature=0,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Question: {question}\n\nNumbered facts:\n{facts}\n\nAnswer:"},
        ],
    )
    draft = (final.choices[0].message.content or "").strip()
    steps = [AssistantStep(tool=r.tool, label=r.label, args=r.args, result_count=r.count) for r in results]  # type: ignore[arg-type]
    numbers_ok = all(n in facts for n in re.findall(r"\d+(?:\.\d+)?%", draft))
    if grounded(draft, citations) and numbers_ok:
        return Outcome(draft, citations, steps, fallback.node_ids, fallback.edge_ids, True, mode="cloud")
    return Outcome(
        fallback.answer,
        fallback.citations,
        steps,
        fallback.node_ids,
        fallback.edge_ids,
        fallback.grounded,
        mode="cloud",
    )
