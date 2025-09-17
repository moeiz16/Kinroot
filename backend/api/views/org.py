"""Organisation, members, invitations, settings, retention and the training register (contract §1.4)."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import date, timedelta
from typing import Any

from django.conf import settings as dj_settings
from django.db import transaction
from django.db.models import Min
from django.utils import timezone
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import Invitation, Membership, TrainingRecord, User
from accounts.roles import ROLE_LABELS, ROLE_PERMISSIONS
from accounts.services import MIN_RETENTION_YEARS, org_wire, settings_for
from api.auth import ORG_KEY, enforce_csrf, start_session
from api.base import ApiView, parse_date, parse_uuid
from api.views.auth import me_payload, validate_password
from audit import api as audit
from clients.models import Client
from jobs import api as jobs_api
from jobs.models import Job
from kinroot.contracts import Actor
from kinroot.core.dates import add_years
from kinroot.core.errors import AppError, conflict, forbidden, not_found, validation_error

INVITE_DAYS = 7
DUE_SOON_DAYS = 30


def token_hash(token: str) -> str:
    return hmac.new(dj_settings.SECRET_KEY.encode(), token.encode(), hashlib.sha256).hexdigest()


def invitation_wire(inv: Invitation) -> dict[str, Any]:
    return {
        "id": str(inv.id),
        "email": inv.email,
        "role": inv.role,
        "role_label": ROLE_LABELS.get(inv.role, inv.role),
        "expires_at": inv.expires_at.isoformat(),
        "accepted_at": inv.accepted_at.isoformat() if inv.accepted_at else None,
        "created_at": inv.created_at.isoformat(),
    }


def member_wire(m: Membership, due: date | None) -> dict[str, Any]:
    return {
        "id": str(m.id),
        "user_id": str(m.user_id),
        "full_name": m.user.full_name,
        "email": m.user.email,
        "role": m.role,
        "role_label": ROLE_LABELS.get(m.role, m.role),
        "status": "active",
        "joined_at": m.joined_at.isoformat(),
        "training_due_on": due.isoformat() if due else None,
    }


def job_wire(job: Job) -> dict[str, Any]:
    return {
        "id": str(job.id),
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "result": job.result,
        "error": job.error or None,
        "created_at": job.created_at.isoformat(),
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


# ── Organisation ──────────────────────────────────────────────────────────────────────────────────
class OrgPatchIn(serializers.Serializer):
    name = serializers.CharField(max_length=200, required=False)
    abn = serializers.RegexField(r"^[0-9 ]{0,20}$", required=False, allow_blank=True)
    address = serializers.CharField(max_length=300, required=False, allow_blank=True)
    country = serializers.ChoiceField(choices=["AU", "GB"], required=False)
    sector = serializers.ChoiceField(
        choices=["legal", "accounting", "conveyancing", "real_estate", "dealer"], required=False
    )


class OrgView(ApiView):
    def get(self, request: Request) -> Response:
        return Response(org_wire(self.org))

    def patch(self, request: Request) -> Response:
        self.require("org:admin")
        data = OrgPatchIn(data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        org = self.org
        for key, value in data.validated_data.items():
            setattr(org, key, value)
        org.save()
        self.audit(
            "org.updated", resource_type="org", resource_id=org.id, metadata={"fields": sorted(data.validated_data)}
        )
        return Response(org_wire(org))


# ── Members ───────────────────────────────────────────────────────────────────────────────────────
class MembersView(ApiView):
    def get(self, request: Request) -> Response:
        dues = dict(
            TrainingRecord.objects.filter(org=self.org)
            .values("user_id")
            .annotate(d=Min("due_on"))
            .values_list("user_id", "d")
        )
        members = Membership.objects.select_related("user").filter(org=self.org).order_by("user__full_name")
        return Response([member_wire(m, dues.get(m.user_id)) for m in members])


class MemberPatchIn(serializers.Serializer):
    role = serializers.ChoiceField(choices=list(ROLE_PERMISSIONS))


class MemberView(ApiView):
    permission = "members:manage"

    def _member(self, member_id: str) -> Membership:
        m = Membership.objects.select_related("user").filter(org=self.org, id=parse_uuid(member_id, "Member")).first()
        if m is None:
            raise not_found("Member")
        return m

    def _last_owner(self, m: Membership) -> bool:
        return m.role == "owner" and Membership.objects.filter(org=self.org, role="owner").count() <= 1

    def patch(self, request: Request, member_id: str) -> Response:
        m = self._member(member_id)
        data = MemberPatchIn(data=request.data)
        data.is_valid(raise_exception=True)
        role = data.validated_data["role"]
        if role != "owner" and self._last_owner(m):
            raise conflict("conflict", "A firm needs at least one administrator.")
        previous = m.role
        m.role = role
        m.save(update_fields=["role", "updated_at"])
        self.audit(
            "member.role_changed", resource_type="membership", resource_id=m.id, metadata={"from": previous, "to": role}
        )
        due = TrainingRecord.objects.filter(org=self.org, user=m.user).aggregate(d=Min("due_on"))["d"]
        return Response(member_wire(m, due))

    def delete(self, request: Request, member_id: str) -> Response:
        m = self._member(member_id)
        if self._last_owner(m):
            raise conflict("conflict", "A firm needs at least one administrator.")
        self.audit("member.removed", resource_type="membership", resource_id=m.id, metadata={"role": m.role})
        m.delete()
        return Response(status=204)


# ── Invitations ───────────────────────────────────────────────────────────────────────────────────
class InvitationIn(serializers.Serializer):
    email = serializers.EmailField(max_length=254)
    role = serializers.ChoiceField(choices=list(ROLE_PERMISSIONS))


class InvitationsView(ApiView):
    permission = "members:manage"
    throttle_scope = "invitation"

    def get(self, request: Request) -> Response:
        qs = Invitation.objects.filter(org=self.org, revoked_at__isnull=True, accepted_at__isnull=True)
        return Response([invitation_wire(i) for i in qs])

    def post(self, request: Request) -> Response:
        data = InvitationIn(data=request.data)
        data.is_valid(raise_exception=True)
        email = data.validated_data["email"].lower()
        if Membership.objects.filter(org=self.org, user__email=email).exists():
            raise conflict("conflict", "This person is already a member of the firm.")
        token = secrets.token_urlsafe(32)
        inv = Invitation.objects.create(
            org=self.org,
            email=email,
            role=data.validated_data["role"],
            token_hash=token_hash(token),
            expires_at=timezone.now() + timedelta(days=INVITE_DAYS),
            invited_by=self.user,
        )
        self.audit("invitation.created", resource_type="invitation", resource_id=inv.id, metadata={"role": inv.role})
        return Response(
            {"invitation": invitation_wire(inv), "invite_url": f"{dj_settings.WEB_ORIGIN}/invite/{token}"}, status=201
        )


class InvitationView(ApiView):
    permission = "members:manage"

    def delete(self, request: Request, invitation_id: str) -> Response:
        inv = Invitation.objects.filter(
            org=self.org, id=parse_uuid(invitation_id, "Invitation"), revoked_at__isnull=True
        ).first()
        if inv is None:
            raise not_found("Invitation")
        inv.revoked_at = timezone.now()
        inv.save(update_fields=["revoked_at", "updated_at"])
        self.audit("invitation.revoked", resource_type="invitation", resource_id=inv.id)
        return Response(status=204)


def _open_invitation(token: str) -> Invitation:
    inv = Invitation.objects.select_related("org").filter(token_hash=token_hash(token)).first()
    if inv is None or inv.revoked_at or inv.accepted_at:
        raise not_found("Invitation")
    if inv.expires_at < timezone.now():
        raise AppError(410, "expired", "Gone", "This invitation has expired. Ask your firm for a new one.")
    return inv


class PublicInvitationView(ApiView):
    permission_classes = [AllowAny]
    require_org = False
    throttle_scope = "invitation"

    def get(self, request: Request, token: str) -> Response:
        inv = _open_invitation(token)
        return Response(
            {
                "org_name": inv.org.name,
                "email": inv.email,
                "role": inv.role,
                "role_label": ROLE_LABELS.get(inv.role, inv.role),
                "expires_at": inv.expires_at.isoformat(),
            }
        )


class AcceptIn(serializers.Serializer):
    full_name = serializers.CharField(max_length=200, required=False)
    password = serializers.CharField(max_length=128, required=False, trim_whitespace=False)


class AcceptInvitationView(ApiView):
    permission_classes = [AllowAny]
    require_org = False
    throttle_scope = "auth"

    def post(self, request: Request, token: str) -> Response:
        enforce_csrf(request)
        inv = _open_invitation(token)
        data = AcceptIn(data=request.data)
        data.is_valid(raise_exception=True)
        signed_in = self.user is not None and self.user.is_authenticated
        with transaction.atomic():
            if signed_in:
                user = self.user
                if user.email.lower() != inv.email.lower():
                    raise conflict("conflict", "This invitation was sent to a different email address.")
            else:
                if User.objects.filter(email=inv.email).exists():
                    raise conflict("conflict", "You already have an account. Sign in, then open the invitation again.")
                full_name = data.validated_data.get("full_name")
                password = data.validated_data.get("password")
                errors = []
                if not full_name:
                    errors.append({"field": "fullName", "message": "Enter your name."})
                if not password:
                    errors.append({"field": "password", "message": "Choose a password."})
                if errors:
                    raise validation_error("One or more fields are invalid.", errors)
                validate_password(password, User(email=inv.email, full_name=full_name))
                user = User.objects.create_user(inv.email, password, full_name=full_name)
            Membership.objects.get_or_create(org=inv.org, user=user, defaults={"role": inv.role})
            inv.accepted_at = timezone.now()
            inv.save(update_fields=["accepted_at", "updated_at"])
            audit.record(
                Actor(org_id=inv.org_id, user_id=user.id, name=user.full_name),
                "invitation.accepted",
                resource_type="invitation",
                resource_id=inv.id,
                metadata={"role": inv.role},
            )
        if not signed_in:
            start_session(request._request, user)
            request._request.user = user
        request._request.session[ORG_KEY] = str(inv.org_id)
        return Response(me_payload(request._request))


# ── Settings ──────────────────────────────────────────────────────────────────────────────────────
SECTION_PERMS: dict[str, tuple[str, ...]] = {
    "retention": ("org:admin", "retention:manage"),
    "reviews": ("org:admin", "methodology:manage"),
    "screening": ("org:admin", "methodology:manage"),
    "ubo": ("org:admin", "methodology:manage"),
    "resolution": ("org:admin", "methodology:manage"),
    "notifications": ("org:admin", "methodology:manage"),
}


class RetentionIn(serializers.Serializer):
    years = serializers.IntegerField(min_value=1, max_value=30, required=False)
    trigger = serializers.ChoiceField(choices=["relationship_end"], required=False)
    legal_hold_client_ids = serializers.ListField(child=serializers.UUIDField(), required=False, max_length=500)


class ReviewsIn(serializers.Serializer):
    high_months = serializers.IntegerField(min_value=1, max_value=60, required=False)
    medium_months = serializers.IntegerField(min_value=1, max_value=60, required=False)
    low_months = serializers.IntegerField(min_value=1, max_value=60, required=False)


class ScreeningIn(serializers.Serializer):
    auto_rescreen_on_list_update = serializers.BooleanField(required=False)
    fuzzy_threshold = serializers.FloatField(min_value=0.5, max_value=0.99, required=False)


class UboIn(serializers.Serializer):
    threshold_pct = serializers.FloatField(min_value=10, max_value=50, required=False)


class ResolutionIn(serializers.Serializer):
    auto_merge_enabled = serializers.BooleanField(required=False)


class NotificationsIn(serializers.Serializer):
    critical_alerts = serializers.ChoiceField(choices=["immediate", "daily", "off"], required=False)
    review_reminder_days = serializers.IntegerField(min_value=0, max_value=120, required=False)
    signoff_requests = serializers.BooleanField(required=False)
    weekly_digest = serializers.BooleanField(required=False)
    digest_day = serializers.ChoiceField(
        choices=["monday", "tuesday", "wednesday", "thursday", "friday"], required=False
    )


class SettingsIn(serializers.Serializer):
    retention = RetentionIn(required=False)
    reviews = ReviewsIn(required=False)
    screening = ScreeningIn(required=False)
    ubo = UboIn(required=False)
    resolution = ResolutionIn(required=False)
    notifications = NotificationsIn(required=False)


class SettingsView(ApiView):
    def get(self, request: Request) -> Response:
        return Response(settings_for(self.org))

    def patch(self, request: Request) -> Response:
        if not isinstance(request.data, dict) or not request.data:
            raise validation_error("Send at least one settings section.")
        unknown = set(request.data) - set(SECTION_PERMS)
        if unknown:
            raise validation_error(
                "Unknown settings section.", [{"field": k, "message": "Unknown section."} for k in sorted(unknown)]
            )
        for section in request.data:
            if not any(p in self.perms for p in SECTION_PERMS[section]):
                raise forbidden()
        data = SettingsIn(data=request.data)
        data.is_valid(raise_exception=True)
        clean = data.validated_data
        org = self.org
        if "retention" in clean:
            ret = dict(clean["retention"])
            minimum = MIN_RETENTION_YEARS.get(org.country, 7)
            if "years" in ret and ret["years"] < minimum:
                raise validation_error(
                    f"Records must be kept for at least {minimum} years.",
                    [{"field": "retention.years", "message": f"Minimum is {minimum} years for this firm."}],
                )
            if "legal_hold_client_ids" in ret:
                ids = [str(i) for i in ret["legal_hold_client_ids"]]
                if Client.objects.filter(org=org, id__in=ids).count() != len(set(ids)):
                    raise validation_error(
                        "Unknown client.", [{"field": "retention.legalHoldClientIds", "message": "Unknown client."}]
                    )
                ret["legal_hold_client_ids"] = ids
            clean = {**clean, "retention": ret}
        stored = dict(org.settings or {})
        for section, values in clean.items():
            merged = dict(stored.get(section) or {})
            merged.update(values)
            stored[section] = merged
        org.settings = stored
        org.save(update_fields=["settings", "updated_at"])
        self.audit(
            "settings.updated",
            resource_type="org",
            resource_id=org.id,
            metadata={"sections": sorted(clean), "fields": sorted(f"{s}.{k}" for s, v in clean.items() for k in v)},
        )
        return Response(settings_for(org))


class RetentionPreviewView(ApiView):
    permission = "retention:manage"

    def get(self, request: Request) -> Response:
        from clients import retention

        return Response(retention.preview(self.org, parse_date(request.query_params.get("asOf"))))


class RetentionRunIn(serializers.Serializer):
    dry_run = serializers.BooleanField(default=True)


class RetentionRunView(ApiView):
    permission = "retention:manage"

    def post(self, request: Request) -> Response:
        data = RetentionRunIn(data=request.data or {})
        data.is_valid(raise_exception=True)
        dry = data.validated_data["dry_run"]
        job_id = jobs_api.enqueue(
            "retention.run",
            {"dryRun": dry, "userId": str(self.user.id), "userName": self.user.full_name},
            org_id=self.org_id,
            created_by=self.user.id,
        )
        self.audit("retention.run_requested", resource_type="job", resource_id=job_id, metadata={"dryRun": dry})
        return Response(job_wire(Job.objects.get(id=job_id)), status=202)


# ── Training register ─────────────────────────────────────────────────────────────────────────────
def training_wire(r: TrainingRecord, today: date) -> dict[str, Any]:
    status = (
        "overdue"
        if r.due_on < today
        else ("due_soon" if r.due_on <= today + timedelta(days=DUE_SOON_DAYS) else "current")
    )
    return {
        "id": str(r.id),
        "user_id": str(r.user_id),
        "full_name": r.user.full_name,
        "course": r.course,
        "completed_on": r.completed_on.isoformat(),
        "due_on": r.due_on.isoformat(),
        "status": status,
        "evidence_note": r.evidence_note or None,
    }


class TrainingIn(serializers.Serializer):
    user_id = serializers.UUIDField()
    course = serializers.CharField(max_length=200)
    completed_on = serializers.DateField()
    evidence_note = serializers.CharField(max_length=500, required=False, allow_blank=True)


class TrainingView(ApiView):
    permission = "training:read"

    def get(self, request: Request) -> Response:
        today = timezone.localdate()
        qs = TrainingRecord.objects.select_related("user").filter(org=self.org)
        return Response([training_wire(r, today) for r in qs.order_by("due_on")])

    def post(self, request: Request) -> Response:
        self.require("training:manage")
        data = TrainingIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        if not Membership.objects.filter(org=self.org, user_id=v["user_id"]).exists():
            raise validation_error("Choose a member of this firm.", [{"field": "userId", "message": "Not a member."}])
        if v["completed_on"] > timezone.localdate():
            raise validation_error(
                "Completion date can't be in the future.",
                [{"field": "completedOn", "message": "Date is in the future."}],
            )
        record = TrainingRecord.objects.create(
            org=self.org,
            user_id=v["user_id"],
            course=v["course"],
            completed_on=v["completed_on"],
            due_on=add_years(v["completed_on"], 1),
            evidence_note=v.get("evidence_note", ""),
        )
        self.audit("training.recorded", resource_type="training", resource_id=record.id)
        record = TrainingRecord.objects.select_related("user").get(id=record.id)
        return Response(training_wire(record, timezone.localdate()), status=201)
