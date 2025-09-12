"""Builders shared by the API tests (no network, no graph engine: domain calls are faked per test)."""

from __future__ import annotations

from datetime import date
from typing import Any

from rest_framework.test import APIClient

from accounts.models import Membership, Organisation, User
from accounts.services import default_settings
from clients.models import Client, Party, Relationship
from clients.services import normalize_name, rebuild_structure

PASSWORD = "Kinroot-test-2025!"
ROLES = ("owner", "compliance_officer", "partner", "fee_earner", "auditor")


def make_firm(name: str, country: str, *, domain: str) -> dict[str, Any]:
    org = Organisation.objects.create(
        name=name, slug=domain.split(".")[0], country=country, settings=default_settings(country)
    )
    users = {}
    for role in ROLES:
        user = User.objects.create_user(
            f"{role}@{domain}", PASSWORD, full_name=f"{role.replace('_', ' ').title()} {name.split()[0]}"
        )
        Membership.objects.create(org=org, user=user, role=role)
        users[role] = user
    return {"org": org, "users": users}


def csrf_client() -> APIClient:
    api = APIClient(enforce_csrf_checks=True)
    api.get("/api/v1/auth/csrf")
    token = api.cookies["kr_csrf"].value
    api.credentials(HTTP_X_CSRFTOKEN=token)
    return api


def signed_in(user: User) -> APIClient:
    api = csrf_client()
    resp = api.post("/api/v1/auth/login", {"email": user.email, "password": PASSWORD}, format="json")
    assert resp.status_code == 200, resp.content
    # the session key rotates on login and so does the CSRF token
    api.credentials(HTTP_X_CSRFTOKEN=api.cookies["kr_csrf"].value)
    return api


def make_party(org: Organisation, name: str, kind: str = "person", **fields: Any) -> Party:
    return Party.objects.create(org=org, kind=kind, name=name, normalized_name=normalize_name(name), **fields)


def link(
    org: Organisation,
    src: Party,
    dst: Party,
    kind: str = "ownership",
    *,
    pct: float | None = None,
    role: str = "",
    since: date = date(2020, 1, 1),
    **fields: Any,
) -> Relationship:
    return Relationship.objects.create(
        org=org,
        from_party=src,
        to_party=dst,
        kind=kind,
        pct=pct if kind == "ownership" else None,
        role=role,
        valid_from=since,
        **fields,
    )


def make_client_record(
    firm: dict[str, Any],
    name: str,
    *,
    kind: str = "company",
    status: str = "onboarding",
    assigned: str = "fee_earner",
    **fields: Any,
) -> Client:
    org = firm["org"]
    party_kind = "person" if kind == "individual" else kind
    party = make_party(org, name, party_kind, jurisdiction="AU")
    client = Client.objects.create(
        org=org,
        kind=kind,
        name=name,
        party=party,
        jurisdiction="AU",
        services=["conveyancing"],
        channel="face_to_face",
        status=status,
        assigned_to=firm["users"][assigned],
        **fields,
    )
    rebuild_structure(org.id, [client.id])
    return client
