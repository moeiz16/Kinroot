"""Need-to-know access to cases (ADR 0005).

The compliance officer (`smr:read`) sees every case in full. Anyone else needs an entry on the case's access
list; `summary` entries get the redaction treatment. Everyone else gets 404, exactly like an unknown id.
"""

from __future__ import annotations

import uuid
from typing import Any

from cases.models import Case, CaseAccess

REDACTED_FOR_SUMMARY = ["grounds", "narrative", "suspicionGrounds", "transactions"]


def access_level(case: Case, user_id: uuid.UUID, perms: frozenset[str]) -> str | None:
    if "smr:read" in perms:
        return "full"
    entry = CaseAccess.objects.filter(case=case, user_id=user_id).only("level").first()
    return entry.level if entry else None


def visible_cases(org_id: uuid.UUID, user_id: uuid.UUID, perms: frozenset[str]) -> Any:
    qs = Case.objects.select_related("client", "opened_by").filter(org_id=org_id)
    if "smr:read" in perms:
        return qs
    return qs.filter(access_entries__user_id=user_id)


def audience(case: Case) -> list[uuid.UUID]:
    """Users who may receive case events: the access list plus every compliance officer of the firm."""
    from accounts.models import Membership
    from accounts.roles import ROLE_PERMISSIONS

    officer_roles = [r for r, p in ROLE_PERMISSIONS.items() if "smr:read" in p]
    ids = set(CaseAccess.objects.filter(case=case).values_list("user_id", flat=True))
    ids |= set(Membership.objects.filter(org_id=case.org_id, role__in=officer_roles).values_list("user_id", flat=True))
    return sorted(ids, key=str)


def open_case_client_ids(org_id: uuid.UUID) -> set[uuid.UUID]:
    return set(Case.objects.filter(org_id=org_id, status="open").values_list("client_id", flat=True))
