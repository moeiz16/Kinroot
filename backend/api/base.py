"""Base view: active organisation, permission checks (accounts/roles.py), domain-error mapping, paging."""

from __future__ import annotations

import contextlib
import math
import uuid
from collections.abc import Callable, Iterator
from datetime import date
from typing import Any

from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import Membership, Organisation
from accounts.roles import permissions_for
from api.auth import ORG_KEY
from kinroot.contracts import Actor, DomainConflict, NotFound, to_wire
from kinroot.core.errors import AppError, conflict, forbidden, not_found, validation_error

MAX_PAGE_SIZE = 200


def client_ip(request: Any) -> str:
    return (request.META.get("REMOTE_ADDR") or "")[:64]


def active_membership(request: Any) -> Membership | None:
    user = request.user
    if not user or not user.is_authenticated:
        return None
    org_id = request.session.get(ORG_KEY)
    qs = Membership.objects.select_related("org").filter(user=user)
    m = qs.filter(org_id=org_id).first() if org_id else None
    if m is None:
        m = qs.order_by("joined_at").first()
        if m is not None:
            request.session[ORG_KEY] = str(m.org_id)
    return m


@contextlib.contextmanager
def domain_errors(resource: str = "Resource") -> Iterator[None]:
    """Map domain-core exceptions to problem+json (contract Part 3)."""
    try:
        yield
    except NotFound as exc:
        raise not_found(resource) from exc
    except DomainConflict as exc:
        raise conflict(exc.code, exc.detail) from exc
    except NotImplementedError as exc:
        raise AppError(
            503,
            "unavailable",
            "Service unavailable",
            "This part of Kinroot is still starting up.",
            headers={"Retry-After": "30"},
        ) from exc
    except ValueError as exc:
        raise validation_error(str(exc)) from exc


def parse_uuid(value: Any, resource: str = "Resource") -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError) as exc:
        raise not_found(resource) from exc


def parse_date(value: str | None, field: str = "asOf") -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise AppError(400, "bad_request", "Bad request", f"{field} must be a date (YYYY-MM-DD).") from exc


def page_params(request: Request) -> tuple[int, int]:
    try:
        page = max(1, int(request.query_params.get("page", 1)))
        size = int(request.query_params.get("pageSize", 25))
    except ValueError as exc:
        raise AppError(400, "bad_request", "Bad request", "page and pageSize must be numbers.") from exc
    return page, max(1, min(size, MAX_PAGE_SIZE))


def paged(items: list[Any], total: int, page: int, size: int) -> dict[str, Any]:
    return {
        "items": items,
        "page": page,
        "page_size": size,
        "total": total,
        "total_pages": max(1, math.ceil(total / size)) if size else 1,
    }


class ApiView(APIView):
    """`permission`: a permission string, or a tuple meaning any-of. `require_org`: a membership is required."""

    permission: str | tuple[str, ...] | None = None
    require_org = True

    def initial(self, request: Request, *args: Any, **kwargs: Any) -> None:
        super().initial(request, *args, **kwargs)
        self.membership = active_membership(request) if request.user else None
        self.org: Organisation | None = self.membership.org if self.membership else None
        self.perms: frozenset[str] = permissions_for(self.membership.role) if self.membership else frozenset()
        if self.require_org and self.membership is None:
            raise forbidden("You're not a member of a firm yet.")
        needed = self.permission
        if needed:
            options = (needed,) if isinstance(needed, str) else needed
            if not any(p in self.perms for p in options):
                raise forbidden()

    # helpers ---------------------------------------------------------------------------------
    @property
    def org_id(self) -> uuid.UUID:
        assert self.org is not None
        return self.org.id

    @property
    def actor(self) -> Actor:
        user = self.request.user
        return Actor(org_id=self.org_id, user_id=user.id, name=user.full_name, ip=client_ip(self.request))

    def has(self, perm: str) -> bool:
        return perm in self.perms

    def require(self, perm: str | tuple[str, ...]) -> None:
        options = (perm,) if isinstance(perm, str) else perm
        if not any(p in self.perms for p in options):
            raise forbidden()

    def audit(self, action: str, **kwargs: Any) -> int:
        from audit import api as audit

        return audit.record(self.actor, action, user_agent=self.request.META.get("HTTP_USER_AGENT", ""), **kwargs)

    def domain_page(self, fn: Callable[..., Any], **kwargs: Any) -> Response:
        page, size = page_params(self.request)
        with domain_errors():
            result = fn(self.org_id, offset=(page - 1) * size, limit=size, **kwargs)
        return Response(paged(to_wire(result.items), result.total, page, size))

    def wire(self, obj: Any, status: int = 200) -> Response:
        return Response(to_wire(obj), status=status)
