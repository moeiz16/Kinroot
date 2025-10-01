"""Public interface of ongoing monitoring (builder B).

Jobs registered by this app: "monitoring.daily" (review-due alerts, drift check), "screening.rescreen_org"
on list updates, "monitoring.structure_changed" (from graph sync when a client's structure changes).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Literal

from kinroot.contracts import Actor, AlertKind, AlertView, Page

from . import service


def list_alerts(
    org_id: uuid.UUID,
    *,
    status: Literal["open", "resolved", "dismissed"] | None = "open",
    kind: AlertKind | None = None,
    client_id: uuid.UUID | None = None,
    offset: int = 0,
    limit: int = 25,
) -> Page[AlertView]:
    return service.list_alerts(org_id, status=status, kind=kind, client_id=client_id, offset=offset, limit=limit)


def get_alert(org_id: uuid.UUID, alert_id: uuid.UUID) -> AlertView:
    return service.get_alert(org_id, alert_id)


def resolve_alert(
    org_id: uuid.UUID, alert_id: uuid.UUID, outcome: Literal["resolved", "dismissed"], note: str, actor: Actor
) -> AlertView:
    return service.resolve_alert(org_id, alert_id, outcome, note, actor)


def review_schedule(org_id: uuid.UUID, *, due_before: date | None = None) -> list[dict]:
    """[{clientId, clientName, rating, lastReviewedAt, nextReviewAt, overdueDays, assignedToName}]
    Frequency by rating: high 12 months, medium 24, low 36 (org settings can tighten)."""
    return service.review_schedule(org_id, due_before=due_before)


def schedule_review(org_id: uuid.UUID, client_id: uuid.UUID, due: date, actor: Actor) -> dict:
    return service.schedule_review(org_id, client_id, due, actor)


def run_daily(org_id: uuid.UUID) -> dict[str, int]:
    """Raise review-due alerts, run drift (PSI) checks; returns counts."""
    return service.run_daily(org_id)


def on_structure_changed(org_id: uuid.UUID, client_ids: list[uuid.UUID], changed_edge_ids: list[str]) -> int:
    """Called by graph sync: raise ownership/officer/address change alerts and re-assess risk."""
    return service.on_structure_changed(org_id, client_ids, changed_edge_ids)


def complete_review(org_id: uuid.UUID, client_id: uuid.UUID, actor: Actor, note: str = "") -> dict:
    """Record a completed periodic review (POST /clients/{id}/review with completed=true); schedules the next
    review from the client's rating and closes open review-due alerts."""
    return service.complete_review(org_id, client_id, actor, note)
