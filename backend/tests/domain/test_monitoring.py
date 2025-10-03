"""Monitoring: review scheduling, review-due and structure-change alerts, idempotent daily runs."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from clients.models import Client
from graph import api as graph_api
from kinroot.contracts import DomainConflict
from monitoring import api as monitoring
from monitoring.models import Alert

pytestmark = pytest.mark.django_db


def today():
    return timezone.localdate()


@pytest.fixture
def book(world):
    world.person("o", "Olga Owner")
    world.company("c", "Watched Co Pty Ltd")
    world.own("o", "c", 100, since="2018-01-01")
    world.client(
        "c", "c", onboarded=today() - timedelta(days=400), rating="low", next_review_on=today() - timedelta(days=40)
    )
    return world


def test_overdue_review_raises_one_alert(book):
    assert monitoring.run_daily(book.org_id)["reviewAlerts"] == 1
    assert monitoring.run_daily(book.org_id)["reviewAlerts"] == 0
    alerts = monitoring.list_alerts(book.org_id, kind="review_due")
    assert (
        alerts.total == 1 and "overdue" in alerts.items[0].title and alerts.items[0].client_name == "Watched Co Pty Ltd"
    )


def test_recent_ownership_change_after_onboarding_alerts(book):
    book.person("n", "New Holder")
    book.own("n", "c", 30, since=(today() - timedelta(days=5)).isoformat())
    graph_api.apply_pending()  # the worker (or on_commit in inline mode) drains the outbox
    assert Alert.objects.filter(org=book.org, kind="ownership_change").count() == 1
    a = Alert.objects.get(org=book.org, kind="ownership_change")
    assert a.evidence == [{"type": "edge", "id": str(book.r["n>c"].id)}] and "New Holder holds 30%" in a.body


def test_historic_edit_and_merge_repoint_do_not_alert(book):
    from clients import api as clients

    book.person("o2", "Olga Owner")
    book.own("o2", "c", 10, since="2018-01-01")
    graph_api.apply_pending()
    assert not Alert.objects.filter(org=book.org, kind="ownership_change").exists()
    clients.merge_parties(book.org_id, book.p["o"].id, [book.p["o2"].id], book.actor())
    graph_api.apply_pending()
    assert not Alert.objects.filter(org=book.org, kind="ownership_change").exists()


def test_officer_change_is_classified(book):
    book.person("d", "Dana Director")
    book.control("d", "c", "director", since=(today() - timedelta(days=3)).isoformat())
    graph_api.apply_pending()
    assert Alert.objects.filter(org=book.org, kind="officer_change").exists()


def test_daily_scan_catches_changes_dated_inside_the_window(book):
    from clients.models import Relationship

    rel = Relationship.objects.create(
        org=book.org,
        from_party=book.p["o"],
        to_party=book.p["c"],
        kind="control",
        role="secretary",
        valid_from=today() - timedelta(days=60),
    )
    Alert.objects.filter(org=book.org).delete()
    counts = monitoring.run_daily(book.org_id)
    assert counts["structureAlerts"] == 1
    assert Alert.objects.get(org=book.org, kind="officer_change").evidence[0]["id"] == str(rel.id)


def test_resolve_alert_once(book):
    monitoring.run_daily(book.org_id)
    a = monitoring.list_alerts(book.org_id).items[0]
    out = monitoring.resolve_alert(book.org_id, a.id, "dismissed", "Handled at the client meeting", book.actor("co"))
    assert out.status == "dismissed" and out.resolved_by == "Co"
    with pytest.raises(DomainConflict):
        monitoring.resolve_alert(book.org_id, a.id, "resolved", "", book.actor("co"))
    assert monitoring.list_alerts(book.org_id).total == 0


def test_schedule_and_complete_review(book):
    due = today() + timedelta(days=20)
    monitoring.schedule_review(book.org_id, book.c["c"].id, due, book.actor("co"))
    assert Client.objects.get(id=book.c["c"].id).next_review_on == due
    with pytest.raises(ValueError):
        monitoring.schedule_review(book.org_id, book.c["c"].id, today() - timedelta(days=1), book.actor("co"))
    monitoring.run_daily(book.org_id)
    out = monitoring.complete_review(book.org_id, book.c["c"].id, book.actor("co"), "All documents current")
    c = Client.objects.get(id=book.c["c"].id)
    assert c.last_reviewed_on == today() and out["nextReviewOn"] == c.next_review_on.isoformat()
    assert c.next_review_on.year == today().year + 3


def test_review_schedule_lists_overdue_days(book):
    rows = monitoring.review_schedule(book.org_id)
    assert rows[0]["overdueDays"] == 40 and rows[0]["clientName"] == "Watched Co Pty Ltd"
    assert monitoring.review_schedule(book.org_id, due_before=today() - timedelta(days=100)) == []


def test_alerts_ordered_by_severity(book):
    from monitoring.service import raise_alert

    raise_alert(book.org_id, book.c["c"].id, "risk_change", "info", "Info", "", [], dedupe_key="i")
    raise_alert(book.org_id, book.c["c"].id, "list_update_hit", "critical", "Critical", "", [], dedupe_key="c")
    raise_alert(book.org_id, book.c["c"].id, "risk_change", "info", "Info again", "", [], dedupe_key="i")
    items = monitoring.list_alerts(book.org_id).items
    assert [a.severity for a in items][:2] == ["critical", "info"] and len(items) == 2
