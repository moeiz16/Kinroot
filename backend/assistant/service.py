"""Assistant service: one question in, one cited answer out, persisted for the caller's history and the audit trail."""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import date
from typing import Any

from django.utils import timezone

from graph.common import as_uuid, audit, kinroot_setting
from kinroot.contracts import Actor, AssistantAnswer, AssistantStep, Citation, NotFound

from . import agent
from .models import AssistantExchange

log = logging.getLogger(__name__)
MAX_QUESTION = 500


def _client(org_id: Any, client_id: Any) -> Any:
    from clients.models import Client

    c = Client.objects.filter(org_id=org_id, id=as_uuid(client_id)).first()
    if c is None:
        raise NotFound("client")
    return c


def _to_answer(x: AssistantExchange) -> AssistantAnswer:
    return AssistantAnswer(
        id=str(x.id),
        question=x.question,
        answer=x.answer,
        citations=[Citation(**c) for c in x.citations],
        steps=[AssistantStep(**s) for s in x.steps],
        highlight=x.highlight,
        mode=x.mode,  # type: ignore[arg-type]
        created_at=x.created_at,
        grounded=x.grounded,
    )


def ask(
    org_id: Any,
    question: str,
    actor: Actor,
    *,
    permissions: frozenset[str],
    client_id: Any = None,
    as_of: date | None = None,
) -> AssistantAnswer:
    question = (question or "").strip()
    if not question:
        raise ValueError("Ask a question.")
    if len(question) > MAX_QUESTION:
        raise ValueError(f"Questions are limited to {MAX_QUESTION} characters.")
    client = _client(org_id, client_id) if client_id else None
    client_party = {"id": str(client.party_id), "name": client.name} if client else None
    today = as_of or timezone.localdate()
    if "assistant:use" not in permissions:
        outcome = agent.Outcome(agent.NOT_PERMITTED, [], [], grounded=False)
    elif kinroot_setting("LLM_FAKE", True):
        outcome = agent.run_offline(org_id, question, permissions, client_party, today)
    else:
        try:
            outcome = agent.run_cloud(org_id, question, permissions, client_party, today)
        except Exception:
            log.warning("cloud assistant unavailable; answering offline", exc_info=True)
            outcome = agent.run_offline(org_id, question, permissions, client_party, today)
    x = AssistantExchange.objects.create(
        org_id=org_id,
        user_id=actor.user_id,
        client=client,
        question=question,
        answer=outcome.answer,
        citations=[asdict(c) for c in outcome.citations],
        steps=[asdict(s) for s in outcome.steps],
        highlight={"nodeIds": outcome.node_ids, "edgeIds": outcome.edge_ids},
        mode=outcome.mode,
        grounded=outcome.grounded,
    )
    audit(
        actor,
        "assistant.asked",
        resource_type="client" if client else None,
        resource_id=client.id if client else None,
        metadata={"tools": [s.tool for s in outcome.steps], "grounded": outcome.grounded, "mode": outcome.mode},
    )
    return _to_answer(x)


def history(org_id: Any, user_id: Any, *, client_id: Any = None, limit: int = 20) -> list[AssistantAnswer]:
    qs = AssistantExchange.objects.filter(org_id=org_id, user_id=user_id)
    if client_id:
        qs = qs.filter(client_id=as_uuid(client_id))
    return [_to_answer(x) for x in qs.order_by("-created_at")[: max(1, min(limit, 100))]]


def suggested_questions(org_id: Any, client_id: Any = None) -> list[str]:
    from clients.models import Client

    if client_id:
        c = _client(org_id, client_id)
        out = [f"Who controls {c.name}?", f"What changed in {c.name}'s structure in the last 90 days?"]
        if c.rating:
            out.append(f"Why is {c.name} rated {c.rating} risk?")
        out.append(f"Is anyone in {c.name}'s structure on a sanctions or PEP list?")
        other = Client.objects.filter(org_id=org_id, status="active").exclude(id=c.id).order_by("name").first()
        if other:
            out.append(f"How is {c.name} connected to {other.name}?")
        return out
    # Highest-risk structures first (ratings are words, so rank them explicitly; people have no structure to trace).
    rank = {"high": 0, "medium": 1, "low": 2}
    active = Client.objects.filter(org_id=org_id, status="active").exclude(kind="individual")
    clients = sorted(active, key=lambda c: (rank.get(c.rating or "", 3), c.name))[:2]
    if len(clients) >= 2:
        return [
            f"Who controls {clients[0].name}?",
            f"How is {clients[0].name} connected to {clients[1].name}?",
            f"What changed in {clients[1].name}'s structure in the last 90 days?",
        ]
    return ["Who controls this client?", "What changed in the structure in the last 90 days?"]


def pin(org_id: Any, answer_id: Any, client_id: Any, actor: Actor) -> dict[str, Any]:
    """Pin one of the caller's own answers to a client's dossier (it joins the client's Timeline)."""
    x = (
        AssistantExchange.objects.filter(org_id=org_id, id=as_uuid(answer_id), user_id=actor.user_id).first()
        if actor.user_id is not None
        else None
    )
    if x is None:
        raise NotFound("answer")
    if not x.grounded:
        raise ValueError("Only answers traced from the ownership records can be pinned.")
    client = _client(org_id, client_id)
    x.pinned_client, x.pinned_by_id, x.pinned_at = client, actor.user_id, timezone.now()
    x.save(update_fields=["pinned_client", "pinned_by", "pinned_at"])
    audit(actor, "assistant.pinned", resource_type="client", resource_id=client.id, metadata={"answer": str(x.id)})
    return {"answer_id": str(x.id), "client_id": str(client.id), "pinned_at": x.pinned_at}


def pinned(org_id: Any, client_id: Any) -> list[dict[str, Any]]:
    """Answers pinned to a client's dossier, newest first. Assistant answers never contain case data."""
    client = _client(org_id, client_id)
    rows = (
        AssistantExchange.objects.filter(org_id=org_id, pinned_client=client)
        .select_related("pinned_by")
        .order_by("-pinned_at")[:50]
    )
    return [
        {
            "id": str(x.id),
            "question": x.question,
            "answer": x.answer,
            "citations": x.citations,
            "pinned_by_name": x.pinned_by.full_name if x.pinned_by else "",
            "pinned_at": x.pinned_at,
        }
        for x in rows
    ]
