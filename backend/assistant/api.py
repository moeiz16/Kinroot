"""Public interface of the investigation assistant (builder B).

Tools (each a portable Cypher query through graph.api, scoped to the caller's org and permissions):
find_party, who_controls, path_between, changes_since, screening_status, risk_reasons.
LLM_FAKE=true (default) -> deterministic planner + templated answers; otherwise LiteLLM with the configured
model chain. Answers must cite graph elements; ungrounded drafts are withheld (grounded=False).
Tipping-off: the assistant never reads cases/SMR data, and never reveals screening/risk details the caller's
permissions would not show.
"""

from __future__ import annotations

import uuid
from datetime import date

from kinroot.contracts import Actor, AssistantAnswer

from . import service


def ask(
    org_id: uuid.UUID,
    question: str,
    actor: Actor,
    *,
    permissions: frozenset[str],
    client_id: uuid.UUID | None = None,
    as_of: date | None = None,
) -> AssistantAnswer:
    """Answer one question (max 500 chars). Persists the Q&A for the audit trail."""
    return service.ask(org_id, question, actor, permissions=permissions, client_id=client_id, as_of=as_of)


def history(
    org_id: uuid.UUID, user_id: uuid.UUID, *, client_id: uuid.UUID | None = None, limit: int = 20
) -> list[AssistantAnswer]:
    return service.history(org_id, user_id, client_id=client_id, limit=limit)


def suggested_questions(org_id: uuid.UUID, client_id: uuid.UUID | None = None) -> list[str]:
    return service.suggested_questions(org_id, client_id)


def pin(org_id: uuid.UUID, answer_id: uuid.UUID, client_id: uuid.UUID, actor: Actor) -> dict:
    """Pin the caller's own grounded answer to a client's dossier. NotFound for other people's answers."""
    return service.pin(org_id, answer_id, client_id, actor)


def pinned(org_id: uuid.UUID, client_id: uuid.UUID) -> list[dict]:
    """Answers pinned to a client's dossier, newest first."""
    return service.pinned(org_id, client_id)
