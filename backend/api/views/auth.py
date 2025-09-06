"""Auth: CSRF cookie, sign-up, sign-in with lockout, sign-out, refresh, me, switch firm, change password."""

from __future__ import annotations

import random
from datetime import timedelta
from typing import Any

from django.contrib.auth import authenticate, logout, password_validation, update_session_auth_hash
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import LoginFailure, Membership, Organisation, User
from accounts.roles import ROLE_LABELS
from accounts.services import default_settings, membership_wire, org_wire, unique_slug
from api.auth import ORG_KEY, enforce_csrf, refresh_session, session_info, start_session
from api.base import ApiView, active_membership, client_ip
from audit import api as audit
from kinroot.contracts import Actor
from kinroot.core.errors import AppError, conflict, not_found, validation_error

LOCK_WINDOW = timedelta(minutes=15)
LOCK_THRESHOLD = 5
AVATAR_COLORS = ["#2F6B5E", "#8A5A2B", "#4B5A8C", "#7A3E5C", "#3F6E8C", "#6B6B2F", "#9C4A3A", "#4E7A4A"]


def user_wire(user: User) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "email": user.email,
        "full_name": user.full_name,
        "avatar_color": user.avatar_color,
        "created_at": user.created_at.isoformat(),
    }


def me_payload(request: Any) -> dict[str, Any]:
    user = request.user
    membership = active_membership(request)
    orgs = [
        {
            "id": str(m.org_id),
            "name": m.org.name,
            "slug": m.org.slug,
            "country": m.org.country,
            "role": m.role,
            "role_label": ROLE_LABELS.get(m.role, m.role),
        }
        for m in Membership.objects.select_related("org").filter(user=user).order_by("org__name")
    ]
    return {
        "user": user_wire(user),
        "active_org": org_wire(membership.org) if membership else None,
        "membership": membership_wire(membership) if membership else None,
        "orgs": orgs,
        "session": session_info(request),
    }


def validate_password(password: str, user: User | None = None) -> None:
    try:
        password_validation.validate_password(password, user)
    except DjangoValidationError as exc:
        raise validation_error(
            "Choose a stronger password.",
            [{"field": "password", "message": m} for m in exc.messages],
            code="weak_password",
        ) from exc


def _actor_for(user: User | None, org_id: Any, request: Any) -> Actor:
    return Actor(
        org_id=org_id,
        user_id=user.id if user else None,
        name=user.full_name if user else "Anonymous",
        ip=client_ip(request),
    )


class PublicView(ApiView):
    permission_classes = [AllowAny]
    require_org = False


class CsrfView(PublicView):
    throttle_scope = "auth"

    def get(self, request: Request) -> Response:
        from django.middleware.csrf import get_token

        get_token(request._request)
        return Response(status=204)


class SignupIn(serializers.Serializer):
    email = serializers.EmailField(max_length=254)
    password = serializers.CharField(max_length=128, trim_whitespace=False)
    full_name = serializers.CharField(max_length=200)
    firm_name = serializers.CharField(max_length=200)
    country = serializers.ChoiceField(choices=["AU", "GB"])


class SignupView(PublicView):
    throttle_scope = "auth"

    def post(self, request: Request) -> Response:
        enforce_csrf(request)
        data = SignupIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        email = v["email"].lower()
        if User.objects.filter(email=email).exists():
            raise conflict("conflict", "An account with this email already exists. Try signing in.")
        probe = User(email=email, full_name=v["full_name"])
        validate_password(v["password"], probe)
        with transaction.atomic():
            user = User.objects.create_user(
                email,
                v["password"],
                full_name=v["full_name"],
                avatar_color=random.choice(AVATAR_COLORS),  # noqa: S311
            )
            org = Organisation.objects.create(
                name=v["firm_name"],
                slug=unique_slug(v["firm_name"]),
                country=v["country"],
                sector="legal",
                settings=default_settings(v["country"]),
            )
            Membership.objects.create(org=org, user=user, role="owner")
            audit.record(_actor_for(user, org.id, request), "auth.signed_up", resource_type="org", resource_id=org.id)
        start_session(request._request, user)
        request._request.session[ORG_KEY] = str(org.id)
        request._request.user = user
        return Response(me_payload(request._request), status=201)


class LoginIn(serializers.Serializer):
    email = serializers.CharField(max_length=254)
    password = serializers.CharField(max_length=128, trim_whitespace=False)


class LoginView(PublicView):
    throttle_scope = "auth"

    def post(self, request: Request) -> Response:
        enforce_csrf(request)
        data = LoginIn(data=request.data)
        data.is_valid(raise_exception=True)
        email = data.validated_data["email"].strip().lower()
        since = timezone.now() - LOCK_WINDOW
        failures = LoginFailure.objects.filter(email=email, created_at__gte=since).order_by("created_at")
        if failures.count() >= LOCK_THRESHOLD:
            first = failures.first()
            assert first is not None
            wait = max(1, int((first.created_at + LOCK_WINDOW - timezone.now()).total_seconds()))
            raise AppError(
                429,
                "rate_limited",
                "Too many requests",
                "Too many sign-in attempts. Please wait and try again.",
                headers={"Retry-After": str(wait)},
            )
        user = authenticate(request._request, username=email, password=data.validated_data["password"])
        if user is None or not user.is_active:
            LoginFailure.objects.create(email=email, ip=client_ip(request))
            known = User.objects.filter(email=email).first()
            org_id = Membership.objects.filter(user=known).values_list("org_id", flat=True).first() if known else None
            audit.record(
                _actor_for(known, org_id, request),
                "auth.login_failed",
                resource_type="user",
                resource_id=known.id if known else None,
            )
            raise AppError(401, "invalid_credentials", "Unauthorized", "Email or password is incorrect.")
        LoginFailure.objects.filter(email=email).delete()
        start_session(request._request, user)
        membership = active_membership(request._request)
        audit.record(
            _actor_for(user, membership.org_id if membership else None, request),
            "auth.login",
            resource_type="user",
            resource_id=user.id,
        )
        return Response(me_payload(request._request))


class LogoutView(ApiView):
    require_org = False

    def post(self, request: Request) -> Response:
        membership = self.membership
        audit.record(
            _actor_for(request.user, membership.org_id if membership else None, request),
            "auth.logout",
            resource_type="user",
            resource_id=request.user.id,
        )
        logout(request._request)
        return Response(status=204)


class RefreshView(ApiView):
    require_org = False
    throttle_scope = "auth"

    def post(self, request: Request) -> Response:
        return Response(refresh_session(request._request))


class MeView(ApiView):
    require_org = False

    def get(self, request: Request) -> Response:
        return Response(me_payload(request._request))


class SwitchOrgIn(serializers.Serializer):
    org_id = serializers.UUIDField()


class SwitchOrgView(ApiView):
    require_org = False

    def post(self, request: Request) -> Response:
        data = SwitchOrgIn(data=request.data)
        data.is_valid(raise_exception=True)
        org_id = data.validated_data["org_id"]
        if not Membership.objects.filter(user=request.user, org_id=org_id).exists():
            raise not_found("Firm")
        request._request.session[ORG_KEY] = str(org_id)
        audit.record(
            _actor_for(request.user, org_id, request), "auth.switched_org", resource_type="org", resource_id=org_id
        )
        return Response(me_payload(request._request))


class PasswordIn(serializers.Serializer):
    current_password = serializers.CharField(max_length=128, trim_whitespace=False)
    new_password = serializers.CharField(max_length=128, trim_whitespace=False)


class PasswordView(ApiView):
    require_org = False
    throttle_scope = "auth"

    def post(self, request: Request) -> Response:
        data = PasswordIn(data=request.data)
        data.is_valid(raise_exception=True)
        user = request.user
        if not user.check_password(data.validated_data["current_password"]):
            raise validation_error(
                "Your current password is incorrect.", [{"field": "currentPassword", "message": "Incorrect password."}]
            )
        validate_password(data.validated_data["new_password"], user)
        user.set_password(data.validated_data["new_password"])
        user.save(update_fields=["password"])
        update_session_auth_hash(request._request, user)  # this session stays; every other session ends
        membership = self.membership
        audit.record(
            _actor_for(user, membership.org_id if membership else None, request),
            "auth.password_changed",
            resource_type="user",
            resource_id=user.id,
        )
        return Response(status=204)
