"""Public interface of screening (builder B).

Lists: SANCTIONS_SOURCE=bundled uses the synthetic sample shipped in screening/data/ (entries prefixed
"SAMPLE-", clearly labelled); =opensanctions loads the subset fetched by scripts/fetch_opensanctions.py from
data/opensanctions/. Matching reuses resolution features (names, aliases, DOB, nationality, identifiers).
"""

from __future__ import annotations

import uuid
from typing import Literal

from kinroot.contracts import Actor, HitStatus, ListEntryView, Page, ScreeningHitView, ScreeningRunResult


def screen_client(org_id: uuid.UUID, client_id: uuid.UUID, actor: Actor) -> ScreeningRunResult:
    """Screen the client and every party in its structure (UBOs, officers, controllers) against all lists."""
    raise NotImplementedError


def screen_org(org_id: uuid.UUID, actor: Actor, *, reason: str = "list_update") -> ScreeningRunResult:
    """Re-screen the whole client book (job "screening.rescreen_org"); only NEW hits are raised."""
    raise NotImplementedError


def list_hits(
    org_id: uuid.UUID,
    *,
    status: HitStatus | None = "pending",
    client_id: uuid.UUID | None = None,
    list_kind: Literal["sanctions", "pep", "adverse_media"] | None = None,
    offset: int = 0,
    limit: int = 25,
) -> Page[ScreeningHitView]:
    raise NotImplementedError


def get_hit(org_id: uuid.UUID, hit_id: uuid.UUID) -> ScreeningHitView:
    raise NotImplementedError


def review_hit(
    org_id: uuid.UUID,
    hit_id: uuid.UUID,
    decision: Literal["true_match", "false_positive", "escalate"],
    reason: str,
    actor: Actor,
) -> ScreeningHitView:
    """`reason` is required (min 10 chars). true_match on sanctions -> client blocked + critical alert;
    true_match on PEP -> EDD trigger. escalate -> creates an internal concern for the compliance officer."""
    raise NotImplementedError


def list_versions() -> list[dict[str, str]]:
    """[{"list": "sanctions", "source": "...", "version": "2025-10-10", "entries": "1234", "loadedAt": "..."}]"""
    raise NotImplementedError


def get_entry(entry_id: str) -> ListEntryView:
    raise NotImplementedError


def load_lists(*, source: str | None = None) -> dict[str, str]:
    """(Re)load list data; returns {list: version}. A new version enqueues an org-wide re-screen."""
    raise NotImplementedError
