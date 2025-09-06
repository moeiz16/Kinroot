"""Session authentication with idle and absolute expiry (contract §1.2).

Login sets `abs_exp` (12 h) and `idle_exp` (30 min) in the server-side session; `/auth/refresh` rotates the
session key and moves `idle_exp`. Past either limit the session is flushed and the API answers
`401 session_expired`, so the web app can tell an expired session from a missing one.
"""

from __future__ import annotations

import time
from typing import Any

from django.conf import settings
from django.contrib.auth import login
from rest_framework.authentication import CSRFCheck, SessionAuthentication
from rest_framework.request import Request

ABS_KEY = "kr_abs_exp"
IDLE_KEY = "kr_idle_exp"
ORG_KEY = "kr_org"


def idle_seconds() -> int:
    return int(settings.SESSION_IDLE_MINUTES) * 60


def absolute_seconds() -> int:
    return int(settings.SESSION_ABSOLUTE_HOURS) * 3600


def start_session(request: Any, user: Any) -> None:
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    now = int(time.time())
    request.session[ABS_KEY] = now + absolute_seconds()
    request.session[IDLE_KEY] = now + idle_seconds()
    request.session.set_expiry(absolute_seconds())


def refresh_session(request: Any) -> dict[str, int]:
    request.session.cycle_key()
    now = int(time.time())
    abs_exp = int(request.session.get(ABS_KEY, now + absolute_seconds()))
    request.session[IDLE_KEY] = min(now + idle_seconds(), abs_exp)
    request.session.set_expiry(max(abs_exp - now, 1))
    return session_info(request)


def session_info(request: Any) -> dict[str, Any]:
    from datetime import UTC, datetime

    now = int(time.time())
    abs_exp = int(request.session.get(ABS_KEY, now))
    idle_exp = int(request.session.get(IDLE_KEY, now))
    return {
        "expires_at": datetime.fromtimestamp(min(idle_exp, abs_exp), UTC).isoformat(),
        "absolute_expires_at": datetime.fromtimestamp(abs_exp, UTC).isoformat(),
    }


def check_session(django_request: Any) -> None:
    """Raise 401 session_expired when the idle or absolute limit has passed."""
    from kinroot.core.errors import AppError

    session = django_request.session
    now = time.time()
    abs_exp = session.get(ABS_KEY)
    idle_exp = session.get(IDLE_KEY)
    if abs_exp is None or idle_exp is None or now > float(abs_exp) or now > float(idle_exp):
        session.flush()
        raise AppError(
            401,
            "session_expired",
            "Session expired",
            "Your session has ended. Please sign in again.",
            headers={"WWW-Authenticate": 'Session realm="kinroot"'},
        )


class KinrootSessionAuthentication(SessionAuthentication):
    def authenticate(self, request: Request) -> tuple[Any, None] | None:
        user = getattr(request._request, "user", None)
        if not user or not user.is_active:
            return None
        check_session(request._request)
        self.enforce_csrf(request)
        return (user, None)

    def authenticate_header(self, request: Request) -> str:
        return 'Session realm="kinroot"'


def enforce_csrf(request: Request) -> None:
    """CSRF for unauthenticated unsafe requests too (login, signup, invitation accept)."""

    def dummy_get_response(_req: Any) -> None:  # pragma: no cover - never called
        return None

    from kinroot.core.errors import AppError

    check = CSRFCheck(dummy_get_response)
    check.process_request(request._request)
    reason = check.process_view(request._request, None, (), {})
    if reason:
        raise AppError(403, "csrf_failed", "Forbidden", "Security token missing or invalid.")
