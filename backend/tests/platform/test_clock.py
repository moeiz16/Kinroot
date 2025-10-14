"""Demo clock: KINROOT_DEMO_TODAY replays the server as of a fixed day; unset means real time."""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.utils import timezone

from kinroot import clock


@pytest.fixture(autouse=True)
def _restore():
    yield
    clock.uninstall()


def test_unset_means_real_time():
    assert clock.install(None) == timedelta(0)
    assert clock.today() == timezone.localdate()
    assert clock.offset() == timedelta(0)


def test_demo_day_shifts_today_and_now_by_whole_days():
    real_now = timezone.now()
    off = clock.install("2025-10-10")
    assert clock.today() == date(2025, 10, 10)
    assert timezone.localdate() == date(2025, 10, 10)  # business code using Django's helpers follows the clock
    assert off.seconds == 0 and off.microseconds == 0  # time of day stays real
    assert abs((timezone.now() - real_now) - off) < timedelta(seconds=5)
    assert clock.install(date(2025, 10, 10)) == off  # idempotent


def test_uninstall_returns_to_real_time():
    clock.install("2025-10-10")
    clock.uninstall()
    assert timezone.localdate() != date(2025, 10, 10) or date.today() == date(2025, 10, 10)


@pytest.mark.django_db
def test_records_and_review_dates_follow_the_demo_day():
    """Seed-style records made under the demo clock are dated as of that day."""
    from audit.models import AuditLog

    clock.install("2025-10-10")
    from tests.domain.builder import World

    w = World("Clock Firm")
    w.person("p", "Pat Lee")
    w.company("c", "Lee Co Pty Ltd")
    w.own("p", "c", 100)
    c = w.client("c", "c")
    assert timezone.localtime(c.created_at).date() == date(2025, 10, 10)
    from audit.api import record

    record(w.actor("co"), "settings.updated")
    assert timezone.localtime(AuditLog.objects.latest("id").created_at).date() == date(2025, 10, 10)
