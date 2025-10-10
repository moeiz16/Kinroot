"""Assistant tools. Each runs portable Cypher through the graph layer (or reads screening / risk records) and
returns citable facts. Every call is permission-checked against the caller's permissions; no tool reads
cases, concerns or suspicious-matter reports (tipping-off controls, ADR 0005).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from rapidfuzz import fuzz

from graph import service as graph
from graph import sync
from graph.ownership import GEdge, compute_ubo, fmt_pct
from kinroot.contracts import Citation
from resolution.normalize import clean

PERMISSIONS = {
    "find_party": "graph:read",
    "who_controls": "graph:read",
    "path_between": "graph:read",
    "changes_since": "graph:read",
    "screening_status": "screening:read",
    "risk_reasons": "risk:read",
}


class NotPermitted(Exception):
    pass


@dataclass
class Fact:
    text: str  # one sentence, no trailing full stop
    cites: list[Citation]


@dataclass
class ToolResult:
    tool: str
    label: str
    args: dict[str, Any]
    facts: list[Fact] = field(default_factory=list)
    node_ids: list[str] = field(default_factory=list)
    edge_ids: list[str] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)

    @property
    def count(self) -> int:
        return len(self.facts)


def check(tool: str, permissions: frozenset[str]) -> None:
    if PERMISSIONS[tool] not in permissions:
        raise NotPermitted(tool)


def _edge_cite(edge_id: str, label: str) -> Citation:
    return Citation(type="edge", id=edge_id, label=label)


def _hop_label(names: dict[str, str], e: Any) -> str:
    src, dst = names.get(e.src, e.src), names.get(e.dst, e.dst)
    since = f" (since {graph.fmt_date(e.valid_from)})" if e.valid_from and not e.valid_from.startswith("0000") else ""
    if e.kind == "ownership":
        return f"{src} owns {fmt_pct(e.pct)}% of {dst}{since}"
    if e.kind == "control":
        return f"{src} is {(e.role or 'controller').replace('_', ' ')} of {dst}{since}"
    return f"{src} is registered at {dst}"


# ── find_party ────────────────────────────────────────────────────────────────────────────────────
def find_party(org_id: Any, name: str, permissions: frozenset[str], *, limit: int = 3) -> ToolResult:
    check("find_party", permissions)
    nodes = graph.search(org_id, name, limit=limit)
    res = ToolResult("find_party", f"Looked up “{name}” in the ownership records", {"name": name})
    for n in nodes:
        res.facts.append(
            Fact(f"{n.label} is a {n.kind} in the records", [Citation(type="node", id=n.id, label=n.label)])
        )
        res.node_ids.append(n.id)
    res.data["matches"] = [{"id": n.id, "label": n.label, "kind": n.kind, "clientId": n.client_id} for n in nodes]
    return res


def resolve_names(org_id: Any, question: str) -> list[dict[str, Any]]:
    """Parties whose names appear in the question (fuzzy, longest first, non-overlapping)."""
    q = clean(question)
    repo = sync.read_repo(org_id)
    found = []
    for row in repo.party_names():
        variants = {clean(row["name"]), row.get("normName") or ""}
        best, best_len, pos = 0.0, 0, -1
        for name in variants:
            if len(name) < 4:
                continue
            score = 100.0 if name in q else float(fuzz.partial_ratio(name, q))
            if score > best or (score == best and len(name) > best_len):
                best, best_len, pos = score, len(name), q.find(name)
        if best >= 92:
            found.append(
                {"id": row["id"], "name": row["name"], "kind": row["kind"], "score": best, "len": best_len, "pos": pos}
            )
    found.sort(key=lambda r: (-r["score"], -r["len"]))
    picked: list[dict[str, Any]] = []
    for r in found:
        if any(clean(r["name"]) in clean(p["name"]) for p in picked):
            continue  # "Bellmere" inside "Bellmere Holdings Pty Ltd"
        picked.append(r)
    picked.sort(key=lambda r: r["pos"] if r["pos"] >= 0 else 999)
    return picked[:4]


# ── who_controls ──────────────────────────────────────────────────────────────────────────────────
def who_controls(org_id: Any, party_id: str, permissions: frozenset[str], *, as_of: date | None = None) -> ToolResult:
    check("who_controls", permissions)
    as_of = as_of or graph.today()
    repo = sync.read_repo(org_id)
    sub = repo.upstream([party_id], as_of)
    focus = sub.nodes.get(party_id)
    name = focus.name if focus else "this party"
    ubo = compute_ubo(sub, party_id, threshold_pct=graph.threshold_for(org_id), max_depth=repo.max_depth)
    names = {k: v.display for k, v in sub.nodes.items()}
    res = ToolResult(
        "who_controls", f"Traced the owners and controllers of {name}", {"partyId": party_id, "asOf": as_of.isoformat()}
    )
    for o in ubo.owners:
        if not o.is_ubo and (o.pct or 0) < 10:
            continue
        cites: list[Citation] = []
        path = o.paths[0] if o.paths else (o.control_paths[0] if o.control_paths else None)
        if path is not None:
            cites = [_edge_cite(e.id, _hop_label(names, e)) for e in path.edges]
            res.edge_ids += [e.id for e in path.edges]
            res.node_ids += path.node_ids
        bits = []
        if o.pct is not None:
            bits.append(f"owns {fmt_pct(o.pct)}% of {name}")
        if o.control_roles:
            bits.append("controls it as " + ", ".join(r.replace("_", " ") for r in o.control_roles))
        status = "a beneficial owner" if o.is_ubo else "below the beneficial-ownership threshold"
        res.facts.append(Fact(f"{o.name} {' and '.join(bits)} and is {status}", cites))
    if ubo.cycles:
        cyc = ubo.cycles[0]
        edges = [e for e in sub.edges.values() if e.kind == "ownership" and e.src in cyc and e.dst in cyc]
        res.facts.append(
            Fact(
                f"Ownership runs in a circle through {', '.join(names.get(c, c) for c in cyc)}",
                [_edge_cite(e.id, _hop_label(names, e)) for e in edges],
            )
        )
        res.edge_ids += [e.id for e in edges]
    if ubo.unexplained_pct >= 1 and ubo.unknown_owner_ids:
        nid = sorted(ubo.unknown_owner_ids)[0]
        res.facts.append(
            Fact(
                f"{fmt_pct(ubo.unexplained_pct)}% of {name} cannot be traced to a person",
                [Citation(type="node", id=nid, label=names.get(nid, nid))],
            )
        )
    res.node_ids.append(party_id)
    res.data = {"owners": len(ubo.owners), "warnings": ubo.warnings}
    return res


# ── path_between ──────────────────────────────────────────────────────────────────────────────────
def path_between(org_id: Any, a: str, b: str, permissions: frozenset[str], *, as_of: date | None = None) -> ToolResult:
    check("path_between", permissions)
    conn = graph.connection(org_id, a, b, as_of=as_of)
    repo = sync.read_repo(org_id)
    nodes = repo.nodes([a, b, *[n for p in conn.paths for n in p.node_ids]])
    names = {k: v.display for k, v in nodes.items()}
    an, bn = names.get(a, "the first party"), names.get(b, "the second party")
    res = ToolResult("path_between", f"Searched for links between {an} and {bn}", {"fromId": a, "toId": b})
    for p in conn.paths[:2]:
        cites = []
        for h in p.hops:
            if h.kind == "address":
                cites.append(
                    Citation(
                        type="node", id=h.to_id, label=f"{names.get(h.from_id, h.from_id)} shares a registered address"
                    )
                )
            else:
                cites.append(
                    _edge_cite(
                        h.edge_id,
                        _hop_label(names, GEdge(h.edge_id, h.from_id, h.to_id, h.kind, pct=h.pct, role=h.role)),
                    )
                )
        res.facts.append(
            Fact(
                f"{an} is linked to {bn} in {len(p.hops)} step{'s' if len(p.hops) != 1 else ''}: "
                f"{p.sentence.rstrip('.')}",
                cites,
            )
        )
        res.node_ids += p.node_ids
        res.edge_ids += [h.edge_id for h in p.hops]
    res.data = {"found": conn.found}
    return res


# ── clients a party reaches (pull the thread) ──────────────────────────────────────────────────────
def clients_reached(
    org_id: Any, party_id: str, permissions: frozenset[str], *, as_of: date | None = None
) -> ToolResult:
    """Every client this party owns or controls, directly or through other entities, with the path to each.
    Reported as a path search (same permission), so the answer cites each link on the way."""
    check("path_between", permissions)
    thread = graph.pull_thread(org_id, party_id, as_of=as_of)
    repo = sync.read_repo(org_id)
    nodes = repo.nodes([party_id, *thread.node_ids])
    names = {k: v.display for k, v in nodes.items()}
    who = names.get(party_id, "This party")
    res = ToolResult("path_between", f"Followed {who}'s links to the firm's clients", {"fromId": party_id})
    for entry in thread.entries[:4]:
        path = entry.paths[0] if entry.paths else None
        if path is None or not path.hops:
            continue
        cites = [
            _edge_cite(
                h.edge_id, _hop_label(names, GEdge(h.edge_id, h.from_id, h.to_id, h.kind, pct=h.pct, role=h.role))
            )
            for h in path.hops
            if h.kind != "address"
        ]
        if not cites:
            continue
        share = f", holding {fmt_pct(entry.effective_pct)}% in effect" if entry.effective_pct else ""
        res.facts.append(Fact(f"{who} reaches {entry.client_name}{share}: {path.sentence.rstrip('.')}", cites))
        res.node_ids += path.node_ids
        res.edge_ids += [h.edge_id for h in path.hops]
    res.data = {"clients": len(thread.entries)}
    return res


# ── changes_since ─────────────────────────────────────────────────────────────────────────────────
def changes_since(org_id: Any, client_id: str, since: date, permissions: frozenset[str]) -> ToolResult:
    check("changes_since", permissions)
    diff = graph.graph_diff(org_id, client_id, since, graph.today())
    res = ToolResult(
        "changes_since",
        f"Compared the structure on {graph.fmt_date(since)} with today",
        {"clientId": client_id, "since": since.isoformat()},
    )
    names = {n.id: n.label for n in diff.nodes_added + diff.nodes_removed}
    repo = sync.read_repo(org_id)
    all_ids = {e.source for e in diff.added + diff.removed} | {e.target for e in diff.added + diff.removed}
    all_ids |= {c.after.source for c in diff.changed} | {c.after.target for c in diff.changed}
    names.update({k: v.display for k, v in repo.nodes(all_ids).items()})

    def lbl(e: Any) -> str:
        if e.kind == "ownership":
            return f"{names.get(e.source, e.source)} owns {fmt_pct(e.pct)}% of {names.get(e.target, e.target)}"
        role = (e.role or "controller").replace("_", " ")
        return f"{names.get(e.source, e.source)} is {role} of {names.get(e.target, e.target)}"

    edges = [*diff.added, *diff.removed, *[c.after for c in diff.changed]]
    if not edges:
        return res
    for e, sentence in zip(edges, diff.summary, strict=False):
        res.facts.append(Fact(sentence, [_edge_cite(e.id, lbl(e))]))
        res.edge_ids.append(e.id)
        res.node_ids += [e.source, e.target]
    return res


# ── screening_status ──────────────────────────────────────────────────────────────────────────────
def screening_status(org_id: Any, client_id: str, permissions: frozenset[str]) -> ToolResult:
    check("screening_status", permissions)
    from screening import service as screening

    page = screening.list_hits(org_id, status=None, client_id=client_id, limit=20)
    res = ToolResult("screening_status", "Checked screening results for the structure", {"clientId": client_id})
    words = {
        "pending": "is awaiting review",
        "true_match": "was confirmed",
        "false_positive": "was cleared as a false positive",
        "escalated": "was escalated for review",
    }
    for h in page.items:
        kind = "sanctions" if h.entry.list_kind == "sanctions" else "politically exposed persons"
        res.facts.append(
            Fact(
                f"{h.party_name} has a possible match on the {kind} list ({h.entry.name}) "
                f"that {words.get(h.status, h.status)}",
                [Citation(type="hit", id=h.id, label=f"{h.party_name} ~ {h.entry.name} (score {h.score:.2f})")],
            )
        )
        res.node_ids.append(h.party_id)
    return res


# ── risk_reasons ──────────────────────────────────────────────────────────────────────────────────
def risk_reasons(org_id: Any, client_id: str, permissions: frozenset[str]) -> ToolResult:
    check("risk_reasons", permissions)
    from risk import service as risk

    a = risk.latest_assessment(org_id, client_id)
    res = ToolResult("risk_reasons", "Read the latest risk assessment", {"clientId": client_id})
    if a is None:
        return res
    for r in a.reasons[:5]:
        cites = []
        for ev in r.evidence[:3]:
            if ev["type"] == "edge":
                cites.append(Citation(type="edge", id=ev["id"], label=r.message))
                res.edge_ids.append(ev["id"])
            elif ev["type"] in ("node", "hit"):
                cites.append(Citation(type="node" if ev["type"] == "node" else "hit", id=ev["id"], label=r.message))
                if ev["type"] == "node":
                    res.node_ids.append(ev["id"])
        if not cites:
            continue  # only evidence-backed reasons can be cited
        res.facts.append(Fact(f"{r.message.rstrip('.')} ({r.points} points)", cites))
    res.data = {"rating": a.rating, "score": a.score, "methodology": a.methodology_version}
    return res
