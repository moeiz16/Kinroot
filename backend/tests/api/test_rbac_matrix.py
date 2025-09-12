"""The role x permission matrix enforced at the HTTP layer (contract §1.3)."""

from __future__ import annotations

import pytest

from accounts.roles import ROLE_PERMISSIONS
from tests.api.helpers import signed_in

pytestmark = pytest.mark.django_db

# (method, path, permission that gates it) for endpoints whose gate fires before any lookup or domain call
GATES = [
    ("get", "/api/v1/insights", "insights:read"),
    ("get", "/api/v1/audit", "audit:read"),
    ("get", "/api/v1/audit/verify", "audit:read"),
    ("get", "/api/v1/org/invitations", "members:manage"),
    ("get", "/api/v1/settings/retention/preview", "retention:manage"),
    ("get", "/api/v1/resolution/thresholds", "resolution:read"),
    ("get", "/api/v1/models", "models:read"),
    ("post", "/api/v1/screening/rescreen", "monitoring:manage"),
    ("get", "/api/v1/registry/search?source=au_abr&q=a", "clients:onboard"),
    ("post", "/api/v1/assistant/ask", "assistant:use"),
    ("post", "/api/v1/concerns/mine", "concerns:raise"),
    ("patch", "/api/v1/org", "org:admin"),
]


@pytest.mark.parametrize("role", list(ROLE_PERMISSIONS))
def test_gates_follow_the_matrix(firm, role):
    api = signed_in(firm["users"][role])
    perms = ROLE_PERMISSIONS[role]
    for method, path, perm in GATES:
        resp = getattr(api, method)(path, {}, format="json") if method != "get" else api.get(path)
        if perm in perms:
            assert resp.status_code != 403, (role, path)
        else:
            assert resp.status_code == 403, (role, path, resp.status_code)
            assert resp.json()["detail"] == "Your role doesn't allow this action."


@pytest.mark.parametrize("role", list(ROLE_PERMISSIONS))
def test_me_lists_exactly_the_role_permissions(firm, role):
    me = signed_in(firm["users"][role]).get("/api/v1/auth/me").json()
    assert set(me["membership"]["permissions"]) == set(ROLE_PERMISSIONS[role])


def test_user_without_membership_is_forbidden(db):
    from accounts.models import User
    from tests.api.helpers import PASSWORD

    user = User.objects.create_user("loner@x.test", PASSWORD, full_name="Lone User")
    api = signed_in(user)
    assert api.get("/api/v1/auth/me").json()["activeOrg"] is None
    assert api.get("/api/v1/clients").status_code == 403
