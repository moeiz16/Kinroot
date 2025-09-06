"""Small calendar helpers (no extra dependency)."""

from __future__ import annotations

import calendar
from datetime import date, timedelta


def add_months(d: date, months: int) -> date:
    """Same day `months` later, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb)."""
    total = d.month - 1 + months
    year, month = d.year + total // 12, total % 12 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def add_years(d: date, years: int) -> date:
    return add_months(d, 12 * years)


def add_business_days(d: date, days: int) -> date:
    """Mon-Fri business days (public holidays are not modelled)."""
    out = d
    while days > 0:
        out += timedelta(days=1)
        if out.weekday() < 5:
            days -= 1
    return out
