from datetime import date

from kinroot.core.dates import add_business_days, add_months, add_years


def test_add_months_clamps_to_month_end():
    assert add_months(date(2025, 1, 31), 1) == date(2025, 2, 28)
    assert add_months(date(2024, 1, 31), 1) == date(2024, 2, 29)
    assert add_months(date(2025, 11, 15), 3) == date(2026, 2, 15)


def test_add_years_from_leap_day():
    assert add_years(date(2024, 2, 29), 7) == date(2031, 2, 28)


def test_business_days_skip_weekends():
    friday = date(2025, 10, 10)
    assert add_business_days(friday, 1) == date(2025, 10, 13)
    assert add_business_days(friday, 3) == date(2025, 10, 15)
