"""Public interface of screening (builder B).

Lists: SANCTIONS_SOURCE=bundled uses the synthetic sample shipped in screening/data/ (entries prefixed
"SAMPLE-", clearly labelled); =opensanctions loads the subset fetched by scripts/fetch_opensanctions.py from
data/opensanctions/. Matching reuses resolution features (names, aliases, DOB, nationality, identifiers).
"""

from __future__ import annotations

import uuid
from typing import Literal

from kinroot.contracts import Actor, HitStatus, ListEntryView, Page, ScreeningHitView, ScreeningRunResult

from . import service


def screen_client(org_id: uuid.UUID, client_id: uuid.UUID, actor: Actor) -> ScreeningRunResult:
    """Screen the client and every party in its structure (UBOs, officers, controllers) against all lists."""
    return service.screen_client(org_id, client_id, actor)


def screen_org(org_id: uuid.UUID, actor: Actor, *, reason: str = "list_update") -> ScreeningRunResult:
    """Re-screen the whole client book (job "screening.rescreen_org"); only NEW hits are raised."""
    return service.screen_org(org_id, actor, reason=reason)


def list_hits(
    org_id: uuid.UUID,
    *,
    status: HitStatus | None = "pending",
    client_id: uuid.UUID | None = None,
    list_kind: Literal["sanctions", "pep", "adverse_media"] | None = None,
    offset: int = 0,
    limit: int = 25,
) -> Page[ScreeningHitView]:
    return service.list_hits(
        org_id, status=status, client_id=client_id, list_kind=list_kind, offset=offset, limit=limit
    )


def get_hit(org_id: uuid.UUID, hit_id: uuid.UUID) -> ScreeningHitView:
    return service.get_hit(org_id, hit_id)


def review_hit(
    org_id: uuid.UUID,
    hit_id: uuid.UUID,
    decision: Literal["true_match", "false_positive", "escalate"],
    reason: str,
    actor: Actor,
) -> ScreeningHitView:
    """`reason` is required (min 10 chars). true_match on sanctions -> client blocked + critical alert;
    true_match on PEP -> EDD trigger. escalate -> creates an internal concern for the compliance officer."""
    return service.review_hit(org_id, hit_id, decision, reason, actor)


def list_versions() -> list[dict[str, object]]:
    """[{"list": "sanctions", "source": "...", "version": "2025-10-10", "entries": "1234", "loadedAt": "..."}]"""
    return service.list_versions()


def get_entry(entry_id: str) -> ListEntryView:
    return service.get_entry(entry_id)


def load_lists(*, source: str | None = None) -> dict[str, str]:
    """(Re)load list data; returns {list: version}. A new version enqueues an org-wide re-screen."""
    return service.load_lists(source=source)
