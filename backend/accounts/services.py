"""Account services: organisation settings with defaults, regimes, slugs, membership lookups. Owner: builder A."""

from __future__ import annotations

import copy
import uuid
from datetime import date
from typing import Any

from django.utils.text import slugify

from accounts.models import Membership, Organisation
from accounts.roles import ROLE_LABELS, permissions_for

REGIMES: dict[str, dict[str, Any]] = {
    "AU": {"name": "AML/CTF Act 2006 (Cth), Tranche 2", "commencement": "2026-07-01"},
    "GB": {"name": "UK MLR 2017", "commencement": None},
}
RESIDENCY = {"AU": "AU", "GB": "UK"}
MIN_RETENTION_YEARS = {"AU": 7, "GB": 5}

DEFAULT_SETTINGS: dict[str, Any] = {
    "retention": {"years": 7, "trigger": "relationship_end", "legal_hold_client_ids": []},
    "reviews": {"high_months": 12, "medium_months": 24, "low_months": 36},
    "screening": {"auto_rescreen_on_list_update": True, "fuzzy_threshold": 0.82},
    "ubo": {"threshold_pct": 25},
    "resolution": {"auto_merge_enabled": True},
    "notifications": {
        "critical_alerts": "immediate",
        "review_reminder_days": 30,
        "signoff_requests": True,
        "weekly_digest": True,
        "digest_day": "monday",
    },
}


def default_settings(_country: str = "AU") -> dict[str, Any]:
    return copy.deepcopy(DEFAULT_SETTINGS)


def _merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in (over or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def settings_for(org: Organisation) -> dict[str, Any]:
    """OrgSettings (snake_case keys) = defaults for the org's country merged with stored overrides."""
    return _merge(default_settings(org.country), org.settings or {})


def org_settings(org_id: uuid.UUID) -> dict[str, Any]:
    """Read-only settings for the domain core (UBO threshold, review months, screening threshold...)."""
    org = Organisation.objects.get(id=org_id)
    return settings_for(org)


def review_months(org: Organisation, rating: str | None) -> int:
    reviews = settings_for(org)["reviews"]
    return int(reviews.get(f"{rating or 'low'}_months", 36))


def unique_slug(name: str) -> str:
    base = slugify(name)[:60] or "firm"
    slug, n = base, 2
    while Organisation.objects.filter(slug=slug).exists():
        slug = f"{base}-{n}"
        n += 1
    return slug


def org_wire(org: Organisation) -> dict[str, Any]:
    return {
        "id": str(org.id),
        "name": org.name,
        "slug": org.slug,
        "country": org.country,
        "abn": org.abn,
        "address": org.address,
        "sector": org.sector,
        "regime": REGIMES.get(org.country, REGIMES["AU"]),
        "data_residency": RESIDENCY.get(org.country, "AU"),
        "created_at": org.created_at.isoformat(),
    }


def membership_wire(m: Membership) -> dict[str, Any]:
    return {
        "role": m.role,
        "role_label": ROLE_LABELS.get(m.role, m.role),
        "permissions": sorted(permissions_for(m.role)),
    }


def days_until(target: str | None, today: date) -> int | None:
    if not target:
        return None
    return (date.fromisoformat(target) - today).days
