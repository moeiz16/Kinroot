"""Public interface of entity resolution (builder B). ADR 0003.

Pipeline: blocking (phonetic name key, birth year, company number, postcode) -> pairwise features
(Jaro-Winkler, token-set ratio, Double Metaphone / NYSIIS agreement, DOB exact/partial/transposed, identifier
agreement, address token overlap, jurisdiction) -> Fellegi-Sunter baseline (EM-estimated m/u) and a calibrated
LightGBM pair classifier (champion) -> band by thresholds chosen on the validation PR curve -> SHAP reasons.
"""

from __future__ import annotations

import uuid
from typing import Literal

from kinroot.contracts import (
    Actor,
    CandidateStatus,
    MatchBand,
    MatchCandidateView,
    MatchScore,
    MergeOutcome,
    Page,
    PartyRecord,
    Thresholds,
)

from . import service


def score_pair(left: PartyRecord, right: PartyRecord) -> MatchScore:
    """Pure function: same inputs + same model version -> identical score."""
    return service.score_pair(left, right)


def find_candidates(org_id: uuid.UUID, *, party_ids: list[uuid.UUID] | None = None) -> int:
    """Block + score (all parties, or only pairs touching `party_ids`); upsert MatchCandidate rows.

    Pairs in the auto-merge band are merged immediately (status "auto_merged", audited as the system).
    Returns the number of new or updated candidates.
    """
    return service.find_candidates(org_id, party_ids=party_ids)


def list_candidates(
    org_id: uuid.UUID,
    *,
    status: CandidateStatus | None = "pending",
    band: MatchBand | None = None,
    client_id: uuid.UUID | None = None,
    offset: int = 0,
    limit: int = 25,
) -> Page[MatchCandidateView]:
    """Review queue, highest probability first."""
    return service.list_candidates(org_id, status=status, band=band, client_id=client_id, offset=offset, limit=limit)


def get_candidate(org_id: uuid.UUID, candidate_id: uuid.UUID) -> MatchCandidateView:
    return service.get_candidate(org_id, candidate_id)


def decide(
    org_id: uuid.UUID,
    candidate_id: uuid.UUID,
    decision: Literal["merge", "not_match", "defer"],
    actor: Actor,
    note: str = "",
) -> MergeOutcome:
    """Record the officer's decision; on "merge" calls clients.api.merge_parties. Raises DomainConflict
    ("already_decided") when the candidate is no longer pending. Decisions become labelled training pairs."""
    return service.decide(org_id, candidate_id, decision, actor, note)


def propose_merge(org_id: uuid.UUID, left_id: uuid.UUID, right_id: uuid.UUID, actor: Actor) -> MatchCandidateView:
    """Manual "fuse" (drag one node onto another): scores the pair and opens a pending candidate."""
    return service.propose_merge(org_id, left_id, right_id, actor)


def split(org_id: uuid.UUID, party_id: uuid.UUID, record_ids: list[uuid.UUID], actor: Actor, note: str) -> MergeOutcome:
    """Undo a merge for the given source records (calls clients.api.split_party)."""
    return service.split(org_id, party_id, record_ids, actor, note)


def thresholds() -> Thresholds:
    return service.thresholds()


def queue_stats(org_id: uuid.UUID) -> dict[str, int | float]:
    """{"pending": n, "autoMergedLast30d": n, "decidedLast30d": n, "reviewRate": 0.07}"""
    return service.queue_stats(org_id)
