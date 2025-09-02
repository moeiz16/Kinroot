"""RFC 7807 problem details (`application/problem+json`) for every error the API returns.

Body: `{ type, title, status, detail?, code?, errors?: [{ field, message }], requestId? }`.
Raise `AppError` (or one of the helpers) anywhere; DRF exceptions and Django 404/500/CSRF failures are
translated to the same shape.
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from django.http import HttpRequest, HttpResponse
from rest_framework import exceptions as drf
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_default_handler

from kinroot.core.logging import request_id_ctx

log = structlog.get_logger(__name__)

PROBLEM_JSON = "application/problem+json"
PROBLEM_BASE = "https://kinroot.dev/problems/"

TITLES = {
    400: "Bad request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not found",
    405: "Method not allowed",
    409: "Conflict",
    410: "Gone",
    413: "Payload too large",
    415: "Unsupported media type",
    422: "Validation failed",
    423: "Locked",
    429: "Too many requests",
    500: "Internal server error",
    503: "Service unavailable",
}


class AppError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        title: str | None = None,
        detail: str | None = None,
        *,
        errors: list[dict] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail or title or code)
        self.status = status
        self.code = code
        self.title = title or TITLES.get(status, "Error")
        self.detail = detail
        self.errors = errors
        self.headers = headers


def not_found(resource: str = "Resource") -> AppError:
    return AppError(404, "not_found", f"{resource} not found", f"{resource} not found.")


def forbidden(detail: str = "Your role doesn't allow this action.") -> AppError:
    return AppError(403, "forbidden", "Forbidden", detail)


def conflict(code: str, detail: str) -> AppError:
    return AppError(409, code, "Conflict", detail)


def validation_error(detail: str, errors: list[dict] | None = None, code: str = "validation_error") -> AppError:
    return AppError(422, code, "Validation failed", detail, errors=errors)


def problem_body(
    status: int,
    title: str,
    *,
    code: str | None = None,
    detail: str | None = None,
    errors: list[dict] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": f"{PROBLEM_BASE}{code}" if code else "about:blank",
        "title": title,
        "status": status,
    }
    if detail:
        body["detail"] = detail
    if code:
        body["code"] = code
    if errors:
        body["errors"] = errors
    rid = request_id_ctx.get()
    if rid:
        body["requestId"] = rid
    return body


def problem_response(status: int, title: str, **kwargs: Any) -> HttpResponse:
    """Plain Django response (for middleware and non-DRF views)."""
    headers = kwargs.pop("headers", None) or {}
    resp = HttpResponse(
        json.dumps(problem_body(status, title, **kwargs), separators=(",", ":")),
        status=status,
        content_type=PROBLEM_JSON,
    )
    for k, v in headers.items():
        resp[k] = v
    return resp


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def _flatten(detail: Any, prefix: str = "") -> list[dict]:
    """DRF ValidationError detail -> [{field, message}] with camelCase dotted field paths."""
    out: list[dict] = []
    if isinstance(detail, dict):
        for key, value in detail.items():
            field = "" if key == "non_field_errors" else _camel(str(key))
            path = f"{prefix}.{field}" if prefix and field else (prefix or field)
            out.extend(_flatten(value, path))
    elif isinstance(detail, list):
        for i, item in enumerate(detail):
            if isinstance(item, dict | list):
                out.extend(_flatten(item, f"{prefix}.{i}" if prefix else str(i)))
            else:
                out.append({"field": prefix or None, "message": str(item)})
    else:
        out.append({"field": prefix or None, "message": str(detail)})
    return out


def _response(status: int, title: str, headers: dict[str, str] | None = None, **kwargs: Any) -> Response:
    resp = Response(problem_body(status, title, **kwargs), status=status, headers=headers)
    resp.content_type = PROBLEM_JSON
    return resp


def problem_exception_handler(exc: Exception, context: dict) -> Response | None:
    """DRF EXCEPTION_HANDLER. Every error leaves as problem+json with a stable machine `code`."""
    if isinstance(exc, AppError):
        return _response(exc.status, exc.title, exc.headers, code=exc.code, detail=exc.detail, errors=exc.errors)
    if isinstance(exc, drf.ValidationError):
        return _response(
            422,
            "Validation failed",
            code="validation_error",
            detail="One or more fields are invalid.",
            errors=_flatten(exc.detail),
        )
    if isinstance(exc, drf.NotAuthenticated | drf.AuthenticationFailed):
        return _response(
            401,
            "Unauthorized",
            {"WWW-Authenticate": 'Session realm="kinroot"'},
            code="not_authenticated",
            detail="Please sign in.",
        )
    if isinstance(exc, drf.PermissionDenied):
        detail = str(exc.detail)
        if "CSRF" in detail:
            return _response(403, "Forbidden", code="csrf_failed", detail="Security token missing or invalid.")
        return _response(403, "Forbidden", code="forbidden", detail="Your role doesn't allow this action.")
    if isinstance(exc, drf.Throttled):
        wait = int(getattr(exc, "wait", None) or 1)
        return _response(
            429,
            "Too many requests",
            {"Retry-After": str(max(wait, 1))},
            code="rate_limited",
            detail=f"Too many requests. Please wait {max(wait, 1)} seconds and try again.",
        )
    if isinstance(exc, drf.APIException):
        default_resp = drf_default_handler(exc, context)
        status = default_resp.status_code if default_resp is not None else exc.status_code
        title = TITLES.get(status, "Error")
        code = exc.default_code if isinstance(exc.default_code, str) else title.lower().replace(" ", "_")
        api_detail = str(exc.detail) if isinstance(exc.detail, str) else None
        return _response(status, title, code=code, detail=api_detail)
    # Django's Http404 / PermissionDenied raised inside DRF views
    resp = drf_default_handler(exc, context)
    if resp is not None:
        status = resp.status_code
        title = TITLES.get(status, "Error")
        return _response(status, title, code=title.lower().replace(" ", "_"))
    log.exception("unhandled_error", error_type=type(exc).__name__)
    return _response(
        500,
        "Internal server error",
        code="internal_error",
        detail="Something went wrong on our side. The incident has been logged.",
    )


# ── Django-level handlers (urls.handler404/handler500, CSRF_FAILURE_VIEW) ──
def handler404(request: HttpRequest, exception: Exception | None = None) -> HttpResponse:
    return problem_response(404, "Not found", code="not_found", detail="No such endpoint.")


def handler500(request: HttpRequest) -> HttpResponse:
    return problem_response(
        500,
        "Internal server error",
        code="internal_error",
        detail="Something went wrong on our side. The incident has been logged.",
    )


def csrf_failure(request: HttpRequest, reason: str = "") -> HttpResponse:
    return problem_response(403, "Forbidden", code="csrf_failed", detail="Security token missing or invalid.")
