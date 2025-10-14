"""Demo clock: replay the sample firm as of a fixed day.

`KINROOT_DEMO_TODAY=2025-10-10` moves the server's idea of "today" to that date for walkthroughs and screenshots,
so seeded records, "as at" defaults, review-due dates, deadlines and the activity log all read as of that day.
The shift is a whole number of days (demo date minus the real date when the process starts), so the seed, the API
and the worker agree with each other and the time of day still advances normally. Unset (the default) means real
time. Session idle/absolute limits and cookie expiry use the real wall clock (`time.time()`) and are unaffected.

Business code calls `django.utils.timezone.now()` / `localdate()` (or `clock.now()` / `clock.today()` here); when
the demo clock is installed those return the shifted time, so there is one switch and no scattered special cases.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta

from django.utils import timezone

_real_now: Callable[[], datetime] | None = None
_offset = timedelta(0)


def now() -> datetime:
    """Current time (shifted when the demo clock is installed)."""
    return timezone.now()


def today() -> date:
    """Today's date in the configured time zone (shifted when the demo clock is installed)."""
    return timezone.localdate()


def offset() -> timedelta:
    return _offset


def install(demo_today: date | str | None) -> timedelta:
    """Shift `timezone.now()` so that `today()` is `demo_today`. Idempotent; returns the offset applied."""
    global _real_now, _offset
    if not demo_today:
        return timedelta(0)
    target = date.fromisoformat(demo_today) if isinstance(demo_today, str) else demo_today
    real = _real_now or timezone.now
    real_today = timezone.localtime(real()).date()
    _offset = timedelta(days=(target - real_today).days)
    _real_now = real
    shift = _offset

    def shifted_now() -> datetime:
        return real() + shift

    timezone.now = shifted_now
    return _offset


def uninstall() -> None:
    """Back to real time (tests)."""
    global _real_now, _offset
    if _real_now is not None:
        timezone.now = _real_now
    _real_now, _offset = None, timedelta(0)
