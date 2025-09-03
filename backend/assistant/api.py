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
    raise NotImplementedError


def history(
    org_id: uuid.UUID, user_id: uuid.UUID, *, client_id: uuid.UUID | None = None, limit: int = 20
) -> list[AssistantAnswer]:
    raise NotImplementedError


def suggested_questions(org_id: uuid.UUID, client_id: uuid.UUID | None = None) -> list[str]:
    raise NotImplementedError
