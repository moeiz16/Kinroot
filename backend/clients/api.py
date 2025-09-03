"""Public interface of the clients system of record (builder A) used by the domain core.

Party and Relationship rows are the truth; the graph app projects them (signals -> graph outbox).
"""

from __future__ import annotations

import uuid
from datetime import date

from kinroot.contracts import Actor, PartyRecord


def party_records(
    org_id: uuid.UUID, *, party_ids: list[uuid.UUID] | None = None, active_only: bool = True
) -> list[PartyRecord]:
    """Parties as resolution/screening inputs (merged-away parties excluded when active_only)."""
    raise NotImplementedError


def client_party_ids(org_id: uuid.UUID, client_id: uuid.UUID) -> list[uuid.UUID]:
    """The client's own party plus every party linked into its structure (for screening scope)."""
    raise NotImplementedError


def merge_parties(org_id: uuid.UUID, survivor_id: uuid.UUID, merged_ids: list[uuid.UUID], actor: Actor) -> None:
    """Re-point relationships, documents and hits to the survivor; mark merged parties `merged_into`;
    keep source records for split. Audited ("party.merged"). Triggers graph sync via signals."""
    raise NotImplementedError


def split_party(
    org_id: uuid.UUID, survivor_id: uuid.UUID, record_ids: list[uuid.UUID], actor: Actor
) -> list[uuid.UUID]:
    """Reverse a merge for the given source records; returns the restored party ids. Audited ("party.split")."""
    raise NotImplementedError


def set_client_rating(org_id: uuid.UUID, client_id: uuid.UUID, rating: str, assessed_on: date) -> None:
    """Cache the decision-of-record rating on the client (list views, constellation, review frequency)."""
    raise NotImplementedError


def block_client(org_id: uuid.UUID, client_id: uuid.UUID, reason_code: str, actor: Actor) -> None:
    """Stop onboarding / further work (e.g. confirmed sanctions match). Neutral wording to fee earners."""
    raise NotImplementedError
