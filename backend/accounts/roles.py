"""Roles and permissions: the single source of truth for RBAC (mirrors docs/API_CONTRACT.md §Roles).

`/auth/me` returns `membership.permissions` from this table. Views check permissions, never role names.
SMR content is NOT granted by any role alone: `smr:read` lets an officer see the case register, and each
case additionally has an access list (tipping-off controls, ADR 0005).
"""

from __future__ import annotations

from typing import Final, Literal

Role = Literal["owner", "compliance_officer", "partner", "fee_earner", "auditor"]

ROLE_LABELS: Final[dict[str, str]] = {
    "owner": "Firm administrator",
    "compliance_officer": "AML/CTF compliance officer",
    "partner": "Partner (senior manager)",
    "fee_earner": "Fee earner",
    "auditor": "Independent reviewer",
}

ALL_PERMISSIONS: Final[tuple[str, ...]] = (
    "dashboard:read",
    "insights:read",
    "clients:read",
    "clients:write",
    "clients:onboard",
    "identity:verify",
    "graph:read",
    "graph:write",
    "resolution:read",
    "resolution:decide",
    "screening:read",
    "screening:run",
    "screening:review",
    "risk:read",
    "risk:assess",
    "risk:override",
    "methodology:manage",
    "models:read",
    "models:promote",
    "edd:manage",
    "signoff:compliance",
    "signoff:senior",
    "monitoring:read",
    "monitoring:manage",
    "concerns:raise",
    "smr:read",
    "smr:write",
    "smr:submit",
    "assistant:use",
    "audit:read",
    "training:read",
    "training:manage",
    "retention:manage",
    "org:admin",
    "members:manage",
)

_READ_CORE = {
    "dashboard:read",
    "clients:read",
    "graph:read",
    "resolution:read",
    "screening:read",
    "risk:read",
    "monitoring:read",
    "training:read",
    "models:read",
}

ROLE_PERMISSIONS: Final[dict[str, frozenset[str]]] = {
    # Practice manager / firm admin: runs the account, not the AML function. No SMR access by role.
    "owner": frozenset(
        _READ_CORE
        | {
            "insights:read",
            "clients:write",
            "concerns:raise",
            "assistant:use",
            "audit:read",
            "training:manage",
            "retention:manage",
            "org:admin",
            "members:manage",
        }
    ),
    # AML/CTF compliance officer (AU) / MLRO (UK): owns the program, decisions and reports.
    "compliance_officer": frozenset(set(ALL_PERMISSIONS) - {"signoff:senior", "org:admin", "members:manage"}),
    # Partner = senior manager approval for high-risk / PEP clients; sees insights; no SMR register by role.
    "partner": frozenset(
        _READ_CORE
        | {
            "insights:read",
            "clients:write",
            "clients:onboard",
            "identity:verify",
            "graph:write",
            "screening:run",
            "risk:assess",
            "edd:manage",
            "signoff:senior",
            "concerns:raise",
            "assistant:use",
        }
    ),
    # Fee earner: onboards clients and collects CDD; raises concerns but never sees their outcome.
    "fee_earner": frozenset(
        {
            "dashboard:read",
            "clients:read",
            "clients:write",
            "clients:onboard",
            "identity:verify",
            "graph:read",
            "graph:write",
            "screening:read",
            "screening:run",
            "risk:read",
            "edd:manage",
            "monitoring:read",
            "concerns:raise",
            "assistant:use",
            "training:read",
        }
    ),
    # Independent reviewer / internal audit: read-only across the program, including the audit trail.
    "auditor": frozenset(_READ_CORE | {"insights:read", "audit:read"}),
}


def permissions_for(role: str) -> frozenset[str]:
    return ROLE_PERMISSIONS.get(role, frozenset())


def has_permission(role: str, permission: str) -> bool:
    return permission in permissions_for(role)
