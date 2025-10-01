"""Ongoing monitoring: alerts, structure-change detection, periodic review scheduling, daily run, drift."""

from __future__ import annotations

import hashlib
import logging
from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from django.db import IntegrityError, transaction
from django.utils import timezone

from graph.common import as_uuid, audit, org_settings, publish, system_actor, user_names
from kinroot.contracts import Actor, AlertView, DomainConflict, NotFound, Page

from .models import Alert, MonitoringRun, ReviewSchedule

log = logging.getLogger(__name__)
SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}
OFFICER_ROLES = {"director", "secretary", "senior_managing_official", "partner"}
FIRST_RUN_LOOKBACK_DAYS = 90
LIVE_CHANGE_WINDOW_DAYS = 31  # a live edit dated further back is a correction to history, not a new change


def today() -> date:
    return timezone.localdate()


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    import calendar

    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


# ── Alerts ────────────────────────────────────────────────────────────────────────────────────────
def raise_alert(
    org_id: Any,
    client_id: Any,
    kind: str,
    severity: str,
    title: str,
    body: str,
    evidence: list[dict[str, str]],
    *,
    dedupe_key: str | None = None,
) -> Alert | None:
    """Create an alert once per dedupe key (re-running a check never duplicates an alert)."""
    if dedupe_key and Alert.objects.filter(org_id=org_id, dedupe_key=dedupe_key).exists():
        return None
    try:
        with transaction.atomic():
            a = Alert.objects.create(
                org_id=org_id,
                client_id=client_id,
                kind=kind,
                severity=severity,
                title=title[:300],
                body=body,
                evidence=evidence,
                dedupe_key=dedupe_key,
            )
    except IntegrityError:
        return None
    publish(
        org_id,
        "alert.raised",
        {"alertId": str(a.id), "clientId": str(client_id) if client_id else None, "kind": kind, "severity": severity},
        permission="monitoring:read",
    )
    return a


def raise_list_update_alerts(org_id: Any, hits: list[Any]) -> int:
    n = 0
    for h in hits:
        if not h.client_id:
            continue
        severity = "critical" if h.list_kind == "sanctions" else "warning"
        what = "sanctions list" if h.list_kind == "sanctions" else "politically exposed persons list"
        a = raise_alert(
            org_id,
            h.client_id,
            "list_update_hit",
            severity,
            f"New possible match on the {what}: {h.party.name}",
            f"A list update produced a possible match (score {h.score:.2f}). Review the match before continuing work.",
            [{"type": "hit", "id": str(h.id)}, {"type": "node", "id": str(h.party_id)}],
            dedupe_key=f"list_update_hit:{h.id}",
        )
        n += int(a is not None)
    return n


def _views(alerts: list[Alert]) -> list[AlertView]:
    names = user_names({a.resolved_by_id for a in alerts})
    out = []
    for a in alerts:
        out.append(
            AlertView(
                id=str(a.id),
                client_id=str(a.client_id) if a.client_id else "",
                client_name=a.client.name if a.client is not None else "Whole client book",
                kind=a.kind,  # type: ignore[arg-type]
                severity=a.severity,  # type: ignore[arg-type]
                title=a.title,
                body=a.body,
                evidence=list(a.evidence),
                status=a.status,  # type: ignore[arg-type]
                created_at=a.created_at,
                resolved_by=names.get(str(a.resolved_by_id)) if a.resolved_by_id else None,
                resolved_at=a.resolved_at,
                resolution_note=a.resolution_note or None,
            )
        )
    return out


def list_alerts(
    org_id: Any,
    *,
    status: str | None = "open",
    kind: str | None = None,
    client_id: Any = None,
    offset: int = 0,
    limit: int = 25,
) -> Page[AlertView]:
    qs = Alert.objects.filter(org_id=org_id).select_related("client")
    if status:
        qs = qs.filter(status=status)
    if kind:
        qs = qs.filter(kind=kind)
    if client_id:
        qs = qs.filter(client_id=as_uuid(client_id))
    rows = sorted(qs, key=lambda a: (SEVERITY_ORDER.get(a.severity, 3), -a.created_at.timestamp(), str(a.id)))
    return Page(items=_views(rows[offset : offset + limit]), total=len(rows))


def get_alert(org_id: Any, alert_id: Any) -> AlertView:
    a = Alert.objects.filter(org_id=org_id, id=as_uuid(alert_id)).select_related("client").first()
    if a is None:
        raise NotFound("alert")
    return _views([a])[0]


def resolve_alert(org_id: Any, alert_id: Any, outcome: str, note: str, actor: Actor) -> AlertView:
    if outcome not in ("resolved", "dismissed"):
        raise ValueError("outcome must be resolved or dismissed")
    with transaction.atomic():
        a = Alert.objects.select_for_update().filter(org_id=org_id, id=as_uuid(alert_id)).first()
        if a is None:
            raise NotFound("alert")
        if a.status != "open":
            raise DomainConflict("already_decided", "This alert has already been closed.")
        a.status, a.resolution_note = outcome, (note or "").strip()
        a.resolved_by_id, a.resolved_at = actor.user_id, timezone.now()
        a.save(update_fields=["status", "resolution_note", "resolved_by", "resolved_at"])
        audit(actor, f"monitoring.alert_{outcome}", resource_type="alert", resource_id=a.id, metadata={"kind": a.kind})
    return get_alert(org_id, a.id)


# ── Structure changes ─────────────────────────────────────────────────────────────────────────────
def _classify(rel: Any) -> str:
    if rel.kind == "ownership":
        return "ownership_change"
    return "officer_change" if (rel.role or "") in OFFICER_ROLES else "ownership_change"


def _affected_clients(org_id: Any, party_ids: set[Any]) -> list[Any]:
    from clients.models import Client, ClientParty

    ids = set(ClientParty.objects.filter(org_id=org_id, party_id__in=party_ids).values_list("client_id", flat=True))
    ids |= set(Client.objects.filter(org_id=org_id, party_id__in=party_ids).values_list("id", flat=True))
    return list(Client.objects.filter(id__in=ids, status__in=["active", "blocked"]))


def _sentence(rel: Any) -> str:
    who, what = rel.from_party.name, rel.to_party.name
    ended = rel.valid_to is not None and rel.valid_to <= today()
    if rel.kind == "ownership":
        pct = f"{rel.pct:g}%" if rel.pct is not None else "an interest"
        return f"{who} {'ceased to hold' if ended else 'holds'} {pct} of {what}" + (
            f" (from {rel.valid_to:%d %b %Y})" if ended else f" (from {rel.valid_from:%d %b %Y})"
        )
    role = (rel.role or "controller").replace("_", " ")
    return f"{who} {'ceased to be' if ended else 'became'} {role} of {what}" + (
        f" ({rel.valid_to:%d %b %Y})" if ended else f" ({rel.valid_from:%d %b %Y})"
    )


def _change_day(r: Any) -> date | None:
    return r.valid_to if (r.valid_to and r.valid_to <= today()) else r.valid_from


def _raise_change_alerts(org_id: Any, rels: list[Any], *, since: date) -> int:
    """Alert on relationships that started or ended after `since` and after the client was onboarded.
    Re-pointing a relationship (a merge) keeps its dates, so it never looks like a change."""
    groups: dict[tuple[Any, str], list[Any]] = defaultdict(list)
    for r in rels:
        change_day = _change_day(r)
        if change_day is None or change_day <= since or change_day > today():
            continue
        for client in _affected_clients(org_id, {r.from_party_id, r.to_party_id}):
            if client.onboarded_on is None or change_day <= client.onboarded_on:
                continue
            groups[(client, _classify(r))].append(r)
    n = 0
    for (client, kind), items in groups.items():
        items.sort(key=lambda r: (r.valid_from, str(r.id)))
        key = hashlib.sha1(
            "|".join(sorted(f"{r.id}:{r.valid_to}" for r in items)).encode(), usedforsecurity=False
        ).hexdigest()[:16]
        title = "Ownership changed" if kind == "ownership_change" else "Officers changed"
        body = "; ".join(_sentence(r) for r in items[:6]) + "."
        a = raise_alert(
            org_id,
            client.id,
            kind,
            "warning",
            f"{title} in {client.name}'s structure",
            body,
            [{"type": "edge", "id": str(r.id)} for r in items],
            dedupe_key=f"{kind}:{client.id}:{key}",
        )
        n += int(a is not None)
    return n


def on_structure_changed(org_id: Any, client_ids: list[Any], changed_edge_ids: list[str]) -> int:
    from clients.models import Relationship

    rels = list(
        Relationship.objects.filter(org_id=org_id, id__in=[e for e in changed_edge_ids if _is_uuid(e)]).select_related(
            "from_party", "to_party"
        )
    )
    if not rels:
        return 0
    n = _raise_change_alerts(org_id, rels, since=today() - timedelta(days=LIVE_CHANGE_WINDOW_DAYS))
    actor = system_actor(org_id)
    try:
        from risk import service as risk

        for c in _affected_clients(org_id, {r.to_party_id for r in rels} | {r.from_party_id for r in rels}):
            if c.onboarded_on and risk.latest_row(org_id, c.id) is not None:
                risk.assess_client(org_id, c.id, actor)
    except Exception:
        log.exception("re-assessment after structure change failed")
    return n


def _is_uuid(v: str) -> bool:
    try:
        as_uuid(v)
        return True
    except Exception:
        return False


def scan_structure_changes(org_id: Any, since: date, until: date) -> int:
    from django.db.models import Q

    from clients.models import Relationship

    rels = list(
        Relationship.objects.filter(org_id=org_id)
        .filter(Q(valid_from__gt=since, valid_from__lte=until) | Q(valid_to__gt=since, valid_to__lte=until))
        .select_related("from_party", "to_party")
    )
    return _raise_change_alerts(org_id, rels, since=since)


# ── Reviews ───────────────────────────────────────────────────────────────────────────────────────
def review_schedule(org_id: Any, *, due_before: date | None = None) -> list[dict[str, Any]]:
    from clients.models import Client

    qs = Client.objects.filter(
        org_id=org_id, status__in=["active", "blocked"], next_review_on__isnull=False
    ).select_related("assigned_to")
    if due_before:
        qs = qs.filter(next_review_on__lte=due_before)
    t = today()
    out = []
    for c in qs.order_by("next_review_on", "name"):
        nxt = c.next_review_on
        assert nxt is not None
        out.append(
            {
                "clientId": str(c.id),
                "clientName": c.name,
                "rating": c.rating,
                "lastReviewedOn": c.last_reviewed_on.isoformat() if c.last_reviewed_on else None,
                "nextReviewOn": nxt.isoformat(),
                "overdueDays": max(0, (t - nxt).days),
                "assignedToName": c.assigned_to.full_name if c.assigned_to is not None else None,
            }
        )
    return out


def _client(org_id: Any, client_id: Any) -> Any:
    from clients.models import Client

    c = Client.objects.filter(org_id=org_id, id=as_uuid(client_id)).first()
    if c is None:
        raise NotFound("client")
    return c


def schedule_review(org_id: Any, client_id: Any, due: date, actor: Actor) -> dict[str, Any]:
    from clients import api as clients

    c = _client(org_id, client_id)
    if due < today():
        raise ValueError("Choose a review date that is today or later.")
    row = ReviewSchedule.objects.create(org_id=org_id, client=c, due_on=due, scheduled_by_id=actor.user_id)
    clients.set_review_dates(as_uuid(org_id), c.id, next_review_on=due)
    audit(
        actor,
        "monitoring.review_scheduled",
        resource_type="client",
        resource_id=c.id,
        metadata={"dueOn": due.isoformat()},
    )
    publish(
        org_id, "review.due", {"clientId": str(c.id), "nextReviewOn": due.isoformat()}, permission="monitoring:read"
    )
    return {"id": str(row.id), "clientId": str(c.id), "dueOn": due.isoformat(), "completedOn": None}


def complete_review(org_id: Any, client_id: Any, actor: Actor, note: str = "") -> dict[str, Any]:
    """Record a completed periodic review and schedule the next one from the client's rating."""
    from clients import api as clients

    c = _client(org_id, client_id)
    t = today()
    months = int(org_settings(org_id).get("reviews", {}).get(f"{c.rating or 'low'}_months", 36))
    nxt = add_months(t, months)
    open_row = (
        ReviewSchedule.objects.filter(org_id=org_id, client=c, completed_on__isnull=True).order_by("due_on").first()
    )
    if open_row is None:
        open_row = ReviewSchedule.objects.create(org_id=org_id, client=c, due_on=c.next_review_on or t)
    open_row.completed_on, open_row.completed_by_id, open_row.note = t, actor.user_id, (note or "").strip()
    open_row.save(update_fields=["completed_on", "completed_by", "note"])
    ReviewSchedule.objects.create(org_id=org_id, client=c, due_on=nxt)
    clients.set_review_dates(as_uuid(org_id), c.id, last_reviewed_on=t, next_review_on=nxt)
    Alert.objects.filter(org_id=org_id, client=c, kind="review_due", status="open").update(
        status="resolved", resolved_by_id=actor.user_id, resolved_at=timezone.now(), resolution_note="Review completed"
    )
    audit(
        actor,
        "monitoring.review_completed",
        resource_type="client",
        resource_id=c.id,
        metadata={"nextReviewOn": nxt.isoformat()},
    )
    return {
        "id": str(open_row.id),
        "clientId": str(c.id),
        "completedOn": t.isoformat(),
        "nextReviewOn": nxt.isoformat(),
    }


def review_due_alerts(org_id: Any) -> int:
    from clients.models import Client

    t = today()
    n = 0
    for c in Client.objects.filter(org_id=org_id, status="active", next_review_on__lt=t):
        due = c.next_review_on
        assert due is not None
        days = (t - due).days
        a = raise_alert(
            org_id,
            c.id,
            "review_due",
            "warning" if c.rating == "high" or days > 30 else "info",
            f"Periodic review overdue for {c.name}",
            f"The {c.rating or 'scheduled'}-risk review was due on {due:%d %b %Y} ({days} days ago).",
            [],
            dedupe_key=f"review_due:{c.id}:{due.isoformat()}",
        )
        if a is not None:
            n += 1
            publish(
                org_id,
                "review.due",
                {"clientId": str(c.id), "nextReviewOn": due.isoformat()},
                permission="monitoring:read",
            )
    return n


# ── Daily run ─────────────────────────────────────────────────────────────────────────────────────
def run_daily(org_id: Any) -> dict[str, int]:
    t = today()
    last = MonitoringRun.objects.filter(org_id=org_id).order_by("-ran_on", "-id").first()
    since = last.ran_on if last else t - timedelta(days=FIRST_RUN_LOOKBACK_DAYS)
    counts = {"reviewAlerts": review_due_alerts(org_id), "structureAlerts": scan_structure_changes(org_id, since, t)}
    # re-screen when a list version appeared since the last run (the loader also enqueues this)
    counts["rescreenNewHits"] = 0
    try:
        from screening import service as screening
        from screening.models import ListVersion

        if last is not None and ListVersion.objects.filter(is_current=True, loaded_at__date__gt=last.ran_on).exists():
            counts["rescreenNewHits"] = screening.screen_org(
                org_id, system_actor(org_id), reason="list_update"
            ).new_hits
    except Exception:
        log.exception("daily re-screen failed")
    counts["driftAlerts"] = 0
    try:
        from risk.service import drift

        d = drift()
        if d["status"] == "drift":
            a = raise_alert(
                org_id,
                None,
                "model_drift",
                "warning",
                "Second-opinion check needs recalibration",
                "The client book has shifted away from the data the second-opinion check learned from "
                f"(stability index {d['psi']:.2f}).",
                [],
                dedupe_key=f"model_drift:{t.isocalendar()[0]}-{t.isocalendar()[1]}",
            )
            counts["driftAlerts"] = int(a is not None)
    except Exception:
        log.exception("drift check failed")
    MonitoringRun.objects.create(org_id=org_id, ran_on=t, counts=counts)
    return counts
