"""Auth: CSRF, sign-in, lockout, session expiry and refresh, sign-up, switch firm, password change."""

from __future__ import annotations

import time

import pytest
from django.contrib.sessions.models import Session
from rest_framework.test import APIClient

from accounts.models import LoginFailure, Membership, Organisation, User
from api.auth import ABS_KEY, IDLE_KEY
from audit.models import AuditLog
from tests.api.helpers import PASSWORD, csrf_client, signed_in

pytestmark = pytest.mark.django_db


def _session(api: APIClient):
    key = api.cookies["kr_session"].value
    return Session.objects.get(session_key=key)


def _set_session(api: APIClient, **values):
    from django.contrib.sessions.backends.db import SessionStore

    store = SessionStore(session_key=api.cookies["kr_session"].value)
    for k, v in values.items():
        store[k] = v
    store.save()


def test_csrf_endpoint_sets_readable_cookie():
    api = APIClient()
    resp = api.get("/api/v1/auth/csrf")
    assert resp.status_code == 204
    assert api.cookies["kr_csrf"].value
    assert not api.cookies["kr_csrf"]["httponly"]


def test_login_returns_me_with_permissions(firm):
    api = signed_in(firm["users"]["compliance_officer"])
    me = api.get("/api/v1/auth/me").json()
    assert me["user"]["email"] == "compliance_officer@harbourline.test"
    assert me["activeOrg"]["regime"]["name"] == "AML/CTF Act 2006 (Cth), Tranche 2"
    assert me["activeOrg"]["regime"]["commencement"] == "2026-07-01"
    assert "smr:read" in me["membership"]["permissions"]
    assert me["membership"]["roleLabel"] == "AML/CTF compliance officer"
    assert me["session"]["expiresAt"]
    assert me["session"]["absoluteExpiresAt"]
    assert api.cookies["kr_session"]["httponly"]


def test_login_requires_csrf(firm):
    api = APIClient(enforce_csrf_checks=True)
    resp = api.post("/api/v1/auth/login", {"email": "owner@harbourline.test", "password": PASSWORD}, format="json")
    assert resp.status_code == 403
    assert resp.json()["code"] == "csrf_failed"


def test_wrong_password_and_unknown_email_look_the_same(firm):
    api = csrf_client()
    a = api.post("/api/v1/auth/login", {"email": "owner@harbourline.test", "password": "nope-nope-nope"}, format="json")
    b = api.post("/api/v1/auth/login", {"email": "ghost@harbourline.test", "password": "nope-nope-nope"}, format="json")
    assert a.status_code == b.status_code == 401
    assert a.json()["code"] == b.json()["code"] == "invalid_credentials"
    assert a.json()["detail"] == b.json()["detail"]
    assert AuditLog.objects.filter(action="auth.login_failed").count() == 2


def test_lockout_after_five_failures(firm):
    api = csrf_client()
    for _ in range(5):
        api.post(
            "/api/v1/auth/login", {"email": "owner@harbourline.test", "password": "wrong-password!"}, format="json"
        )
    resp = api.post("/api/v1/auth/login", {"email": "owner@harbourline.test", "password": PASSWORD}, format="json")
    assert resp.status_code == 429
    assert resp.json()["code"] == "rate_limited"
    assert int(resp["Retry-After"]) > 0


def test_successful_login_clears_failures(firm):
    api = csrf_client()
    api.post("/api/v1/auth/login", {"email": "owner@harbourline.test", "password": "wrong-password!"}, format="json")
    api.post("/api/v1/auth/login", {"email": "owner@harbourline.test", "password": PASSWORD}, format="json")
    assert LoginFailure.objects.count() == 0


def test_me_requires_session():
    resp = APIClient().get("/api/v1/auth/me")
    assert resp.status_code == 401
    assert resp.json()["code"] == "not_authenticated"
    assert resp["Content-Type"] == "application/problem+json"


def test_unsafe_request_without_csrf_header_is_rejected(firm):
    api = signed_in(firm["users"]["owner"])
    api.credentials()  # drop X-CSRFToken
    resp = api.post("/api/v1/auth/logout")
    assert resp.status_code == 403
    assert resp.json()["code"] == "csrf_failed"


def test_idle_expiry_returns_session_expired(firm):
    api = signed_in(firm["users"]["owner"])
    _set_session(api, **{IDLE_KEY: int(time.time()) - 1})
    resp = api.get("/api/v1/auth/me")
    assert resp.status_code == 401
    assert resp.json()["code"] == "session_expired"
    assert api.get("/api/v1/auth/me").status_code == 401


def test_absolute_expiry_is_enforced_even_when_active(firm):
    api = signed_in(firm["users"]["owner"])
    _set_session(api, **{ABS_KEY: int(time.time()) - 1, IDLE_KEY: int(time.time()) + 600})
    assert api.get("/api/v1/auth/me").json()["code"] == "session_expired"


def test_refresh_rotates_session_key_and_extends_idle(firm):
    api = signed_in(firm["users"]["owner"])
    before = api.cookies["kr_session"].value
    _set_session(api, **{IDLE_KEY: int(time.time()) + 60})
    resp = api.post("/api/v1/auth/refresh")
    assert resp.status_code == 200
    assert api.cookies["kr_session"].value != before
    body = resp.json()
    assert body["expiresAt"] < body["absoluteExpiresAt"]
    assert _session(api).get_decoded()[IDLE_KEY] > int(time.time()) + 25 * 60


def test_logout_ends_session(firm):
    api = signed_in(firm["users"]["owner"])
    assert api.post("/api/v1/auth/logout").status_code == 204
    assert api.get("/api/v1/auth/me").status_code == 401


def test_signup_creates_firm_and_owner(db):
    api = csrf_client()
    resp = api.post(
        "/api/v1/auth/signup",
        {
            "email": "New@Firm.test",
            "password": "Correct-Horse-Battery-9",
            "fullName": "Nina Park",
            "firmName": "Park Legal",
            "country": "AU",
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["user"]["email"] == "new@firm.test"
    assert body["membership"]["role"] == "owner"
    org = Organisation.objects.get(name="Park Legal")
    assert org.settings["retention"]["years"] == 7
    assert Membership.objects.get(org=org).role == "owner"


def test_signup_rejects_weak_password(db):
    api = csrf_client()
    resp = api.post(
        "/api/v1/auth/signup",
        {"email": "a@b.test", "password": "password123", "fullName": "A B", "firmName": "AB", "country": "GB"},
        format="json",
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "weak_password"
    assert not User.objects.filter(email="a@b.test").exists()


def test_signup_duplicate_email_conflicts(firm):
    api = csrf_client()
    resp = api.post(
        "/api/v1/auth/signup",
        {
            "email": "owner@harbourline.test",
            "password": "Correct-Horse-Battery-9",
            "fullName": "X",
            "firmName": "Y",
            "country": "AU",
        },
        format="json",
    )
    assert resp.status_code == 409


def test_signup_validation_errors_are_field_level(db):
    resp = csrf_client().post("/api/v1/auth/signup", {"email": "not-an-email", "country": "US"}, format="json")
    assert resp.status_code == 422
    fields = {e["field"] for e in resp.json()["errors"]}
    assert {"email", "password", "fullName", "firmName", "country"} <= fields


def test_switch_org(firm, other_firm):
    user = firm["users"]["compliance_officer"]
    Membership.objects.create(org=other_firm["org"], user=user, role="auditor")
    api = signed_in(user)
    resp = api.post("/api/v1/auth/switch-org", {"orgId": str(other_firm["org"].id)}, format="json")
    assert resp.status_code == 200
    assert resp.json()["activeOrg"]["id"] == str(other_firm["org"].id)
    assert resp.json()["membership"]["role"] == "auditor"
    assert len(resp.json()["orgs"]) == 2


def test_switch_to_non_member_org_is_404(firm, other_firm):
    api = signed_in(firm["users"]["owner"])
    resp = api.post("/api/v1/auth/switch-org", {"orgId": str(other_firm["org"].id)}, format="json")
    assert resp.status_code == 404


def test_password_change_ends_other_sessions(firm):
    user = firm["users"]["partner"]
    first = signed_in(user)
    second = signed_in(user)
    resp = first.post(
        "/api/v1/auth/password", {"currentPassword": PASSWORD, "newPassword": "Another-Long-Phrase-77"}, format="json"
    )
    assert resp.status_code == 204
    assert first.get("/api/v1/auth/me").status_code == 200
    assert second.get("/api/v1/auth/me").status_code == 401


def test_password_change_checks_current(firm):
    api = signed_in(firm["users"]["partner"])
    resp = api.post(
        "/api/v1/auth/password", {"currentPassword": "wrong", "newPassword": "Another-Long-Phrase-77"}, format="json"
    )
    assert resp.status_code == 422


def test_auth_rate_limit(firm):
    from rest_framework.throttling import SimpleRateThrottle

    original = SimpleRateThrottle.THROTTLE_RATES
    SimpleRateThrottle.THROTTLE_RATES = {**original, "auth": "3/min"}
    try:
        api = csrf_client()
        codes = [
            api.post(
                "/api/v1/auth/login", {"email": f"x{i}@y.test", "password": "zzzzzzzzzzzz"}, format="json"
            ).status_code
            for i in range(4)
        ]
    finally:
        SimpleRateThrottle.THROTTLE_RATES = original
    assert codes[-1] == 429


def test_production_hasher_is_argon2id():
    from django.contrib.auth.hashers import Argon2PasswordHasher

    from kinroot import settings as configured

    assert configured.PASSWORD_HASHERS[0].endswith("Argon2PasswordHasher")
    hasher = Argon2PasswordHasher()
    encoded = hasher.encode("Kinroot-demo-2025!", hasher.salt())
    assert encoded.startswith("argon2$argon2id$")
    assert hasher.verify("Kinroot-demo-2025!", encoded)
