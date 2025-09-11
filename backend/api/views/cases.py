"""Concerns, cases and SMR drafts (contract §1.12) with tipping-off controls (ADR 0005).

Every case read goes through `_case()`, which answers 404 for anyone without access, the same as an unknown id.
Every case write is a restricted audit row, and case events go only to the case audience.
"""

from __future__ import annotations

import secrets
from typing import Any

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import Membership
from api.base import ApiView, page_params, paged, parse_uuid
from audit.models import AuditLog
from cases import services as case_services
from cases.models import Case, CaseAccess, Concern, SmrDraft
from clients import services as client_services
from clients.models import Client, Party
from jobs import api as jobs_api
from kinroot.core.dates import add_business_days
from kinroot.core.errors import AppError, conflict, not_found, validation_error

CONCERN_ACK = "Thank you. Your concern has been received by the compliance officer and will be handled confidentially."
TIMELINE_LABELS = {
    "case.opened": "Case opened",
    "case.updated": "Case details updated",
    "case.closed": "Case closed without a report",
    "case.access_changed": "Access list changed",
    "smr.saved": "Report draft saved",
    "smr.submitted": "Report submitted to the regulator (demo portal)",
    "concern.linked": "Concern linked to the case",
}


def case_wire(case: Case, level: str) -> dict[str, Any]:
    smr = SmrDraft.objects.filter(case=case).first()
    smr_status = "none" if smr is None else ("submitted" if smr.submitted_at else "draft")
    full = level == "full"
    body: dict[str, Any] = {
        "id": str(case.id),
        "client_id": str(case.client_id),
        "client_name": case.client.name,
        "title": case.title,
        "status": case.status,
        "grounds": case.grounds if full else None,
        "access_level": level,
        "redacted_fields": [] if full else ["grounds", "narrative"],
        "opened_by": case.opened_by.full_name if case.opened_by_id else None,
        "opened_at": case.opened_at.isoformat(),
        "deadline_on": case.deadline_on.isoformat(),
        "smr_status": smr_status,
    }
    if full:
        body["access"] = [
            {"user_id": str(a.user_id), "full_name": a.user.full_name, "level": a.level}
            for a in CaseAccess.objects.select_related("user").filter(case=case).order_by("user__full_name")
        ]
    return body


def smr_wire(case: Case, smr: SmrDraft | None, level: str) -> dict[str, Any]:
    payload = dict(smr.payload) if smr else {}
    full = level == "full"
    return {
        "case_id": str(case.id),
        "version": smr.version if smr else 0,
        "regime": smr.regime if smr else ("UK_SAR" if case.org.country == "GB" else "AUSTRAC_SMR"),
        "suspicion_grounds": payload.get("suspicion_grounds", "") if full else None,
        "subjects": payload.get("subjects", []),
        "transactions": payload.get("transactions", []) if full else [],
        "narrative": payload.get("narrative", "") if full else None,
        "attachments": payload.get("attachments", []),
        "updated_by": smr.updated_by.full_name if smr and smr.updated_by_id else None,
        "updated_at": smr.updated_at.isoformat() if smr else None,
        "submitted_at": smr.submitted_at.isoformat() if smr and smr.submitted_at else None,
        "reference": (smr.reference or None) if smr else None,
        "redacted_fields": [] if full else ["suspicionGrounds", "narrative", "transactions"],
    }


class CaseBase(ApiView):
    def _case(self, case_id: str) -> tuple[Case, str]:
        case = (
            Case.objects.select_related("client", "opened_by", "org")
            .filter(org=self.org, id=parse_uuid(case_id, "Case"))
            .first()
        )
        level = case_services.access_level(case, self.request.user.id, self.perms) if case else None
        if case is None or level is None:
            raise not_found("Case")
        return case, level

    def _full(self, case_id: str, perm: str | None = None) -> Case:
        case, level = self._case(case_id)
        if perm and perm not in self.perms:
            raise AppError(403, "forbidden", "Forbidden", "Your role doesn't allow this action.")
        if level != "full":
            raise AppError(403, "forbidden", "Forbidden", "Your role doesn't allow this action.")
        return case

    def case_audit(self, case: Case, action: str, **metadata: Any) -> None:
        self.audit(action, resource_type="case", resource_id=case.id, metadata=metadata, restricted=True)

    def notify(self, case: Case) -> None:
        jobs_api.publish_event(
            case.org_id,
            "case.updated",
            {"caseId": str(case.id), "status": case.status},
            user_ids=case_services.audience(case),
        )


# ── Concerns ──────────────────────────────────────────────────────────────────────────────────────
class ConcernIn(serializers.Serializer):
    client_id = serializers.UUIDField(required=False, allow_null=True)
    summary = serializers.CharField(min_length=5, max_length=300)
    details = serializers.CharField(max_length=10000, required=False, allow_blank=True, default="")


class ConcernsView(CaseBase):
    permission = ("concerns:raise", "smr:read")

    def get(self, request: Request) -> Response:
        self.require("smr:read")
        rows = Concern.objects.select_related("client", "raised_by").filter(org=self.org)
        return Response(
            [
                {
                    "id": str(c.id),
                    "client_id": str(c.client_id) if c.client_id else None,
                    "client_name": c.client.name if c.client_id else None,
                    "raised_by_name": c.raised_by.full_name if c.raised_by_id else "System",
                    "summary": c.summary,
                    "details": c.details,
                    "status": c.status,
                    "case_id": str(c.case_id) if c.case_id else None,
                    "received_at": c.created_at.isoformat(),
                }
                for c in rows
            ]
        )

    def post(self, request: Request) -> Response:
        self.require("concerns:raise")
        data = ConcernIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        if v.get("client_id") and not Client.objects.filter(org=self.org, id=v["client_id"]).exists():
            raise not_found("Client")
        concern = Concern.objects.create(
            org=self.org,
            client_id=v.get("client_id"),
            raised_by=request.user,
            summary=v["summary"],
            details=v["details"],
        )
        self.audit("concern.raised", resource_type="concern", resource_id=concern.id, restricted=True)
        return Response(
            {"id": str(concern.id), "received_at": concern.created_at.isoformat(), "message": CONCERN_ACK}, status=201
        )


class MyConcernsView(CaseBase):
    permission = "concerns:raise"

    def get(self, request: Request) -> Response:
        rows = Concern.objects.filter(org=self.org, raised_by=request.user)
        return Response(
            [{"id": str(c.id), "received_at": c.created_at.isoformat(), "status": "received"} for c in rows]
        )


# ── Cases ─────────────────────────────────────────────────────────────────────────────────────────
class CaseCreateIn(serializers.Serializer):
    client_id = serializers.UUIDField()
    title = serializers.CharField(min_length=3, max_length=200)
    grounds = serializers.CharField(min_length=10, max_length=20000)
    concern_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    terrorism_financing = serializers.BooleanField(required=False, default=False)


class CasesView(CaseBase):
    def get(self, request: Request) -> Response:
        qs = case_services.visible_cases(self.org_id, request.user.id, self.perms)
        status = request.query_params.get("status")
        if status:
            qs = qs.filter(status=status)
        page, size = page_params(request)
        total = qs.count()
        items = [
            case_wire(c, case_services.access_level(c, request.user.id, self.perms) or "summary")
            for c in qs.order_by("-opened_at")[(page - 1) * size : page * size]
        ]
        return Response(paged(items, total, page, size))

    def post(self, request: Request) -> Response:
        self.require("smr:write")
        data = CaseCreateIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        client = Client.objects.filter(org=self.org, id=v["client_id"]).first()
        if client is None:
            raise validation_error(
                "Choose a client of this firm.", [{"field": "clientId", "message": "Unknown client."}]
            )
        concerns = list(Concern.objects.filter(org=self.org, id__in=v["concern_ids"]))
        if len(concerns) != len(set(v["concern_ids"])):
            raise validation_error("Unknown concern.", [{"field": "concernIds", "message": "Unknown concern."}])
        now = timezone.now()
        today = timezone.localdate()
        deadline = add_business_days(today, 1 if v["terrorism_financing"] else 3)
        with transaction.atomic():
            case = Case.objects.create(
                org=self.org,
                client=client,
                title=v["title"],
                grounds=v["grounds"],
                opened_by=request.user,
                opened_at=now,
                deadline_on=deadline,
            )
            CaseAccess.objects.create(case=case, user=request.user, level="full", granted_by=request.user)
            for concern in concerns:
                concern.case = case
                concern.status = "linked"
                concern.save(update_fields=["case", "status", "updated_at"])
            client_services.place_hold(client, "restricted", by=request.user, source_ref=str(case.id))
            self.case_audit(case, "case.opened", concerns=len(concerns))
        case = Case.objects.select_related("client", "opened_by").get(id=case.id)
        self.notify(case)
        return Response(case_wire(case, "full"), status=201)


class CasePatchIn(serializers.Serializer):
    title = serializers.CharField(min_length=3, max_length=200, required=False)
    grounds = serializers.CharField(min_length=10, max_length=20000, required=False)
    status = serializers.ChoiceField(choices=["open", "closed_no_report"], required=False)


class CaseView(CaseBase):
    def get(self, request: Request, case_id: str) -> Response:
        case, level = self._case(case_id)
        return Response(case_wire(case, level))

    def patch(self, request: Request, case_id: str) -> Response:
        case = self._full(case_id, "smr:write")
        data = CasePatchIn(data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        if v.get("status") and case.status == "reported":
            raise AppError(422, "invalid_transition", "Validation failed", "A reported case can't change status.")
        with transaction.atomic():
            for key, value in v.items():
                setattr(case, key, value)
            if v.get("status") == "closed_no_report":
                case.closed_at = timezone.now()
                client_services.release_holds(case.client, by=request.user, note="Case closed", source_ref=str(case.id))
            case.save()
            self.case_audit(
                case, "case.closed" if v.get("status") == "closed_no_report" else "case.updated", fields=sorted(v)
            )
        self.notify(case)
        return Response(case_wire(case, "full"))


class AccessEntryIn(serializers.Serializer):
    user_id = serializers.UUIDField()
    level = serializers.ChoiceField(choices=["full", "summary"])


class AccessIn(serializers.Serializer):
    entries = AccessEntryIn(many=True)


class CaseAccessView(CaseBase):
    def put(self, request: Request, case_id: str) -> Response:
        case = self._full(case_id, "smr:write")
        data = AccessIn(data=request.data)
        data.is_valid(raise_exception=True)
        entries = {e["user_id"]: e["level"] for e in data.validated_data["entries"]}
        members = set(
            Membership.objects.filter(org=self.org, user_id__in=list(entries)).values_list("user_id", flat=True)
        )
        if members != set(entries):
            raise validation_error("Choose members of this firm.", [{"field": "entries", "message": "Unknown member."}])
        entries[request.user.id] = "full"  # the officer making the change keeps full access
        with transaction.atomic():
            CaseAccess.objects.filter(case=case).exclude(user_id__in=list(entries)).delete()
            for user_id, level in entries.items():
                CaseAccess.objects.update_or_create(
                    case=case, user_id=user_id, defaults={"level": level, "granted_by": request.user}
                )
            self.case_audit(case, "case.access_changed", entries=len(entries))
        self.notify(case)
        return Response(case_wire(case, "full"))


class SubjectIn(serializers.Serializer):
    party_id = serializers.UUIDField()
    name = serializers.CharField(max_length=300, required=False, allow_blank=True)
    role = serializers.CharField(max_length=100)


class TransactionIn(serializers.Serializer):
    date = serializers.DateField()
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, min_value=0)
    currency = serializers.RegexField(r"^[A-Z]{3}$")
    description = serializers.CharField(max_length=500)


class SmrIn(serializers.Serializer):
    version = serializers.IntegerField(min_value=0)
    suspicion_grounds = serializers.CharField(max_length=20000, required=False, allow_blank=True)
    subjects = SubjectIn(many=True, required=False)
    transactions = TransactionIn(many=True, required=False)
    narrative = serializers.CharField(max_length=50000, required=False, allow_blank=True)
    attachments = serializers.ListField(child=serializers.CharField(max_length=100), required=False, max_length=50)


class SmrView(CaseBase):
    def get(self, request: Request, case_id: str) -> Response:
        case, level = self._case(case_id)
        return Response(smr_wire(case, SmrDraft.objects.filter(case=case).first(), level))

    def put(self, request: Request, case_id: str) -> Response:
        case = self._full(case_id, "smr:write")
        data = SmrIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        with transaction.atomic():
            smr = SmrDraft.objects.select_for_update().filter(case=case).first()
            current = smr.version if smr else 0
            if v["version"] != current:
                raise conflict("stale_version", "Someone else saved this draft. Reload to see their changes.")
            if smr and smr.submitted_at:
                raise conflict("conflict", "This report has already been submitted.")
            payload = dict(smr.payload) if smr else {}
            if "subjects" in v:
                ids = [s["party_id"] for s in v["subjects"]]
                names = dict(Party.objects.filter(org=self.org, id__in=ids).values_list("id", "name"))
                if len(names) != len(set(ids)):
                    raise validation_error("Unknown subject.", [{"field": "subjects", "message": "Unknown party."}])
                payload["subjects"] = [
                    {"party_id": str(s["party_id"]), "name": names[s["party_id"]], "role": s["role"]}
                    for s in v["subjects"]
                ]
            if "transactions" in v:
                payload["transactions"] = [
                    {
                        "date": t["date"].isoformat(),
                        "amount": str(t["amount"]),
                        "currency": t["currency"],
                        "description": t["description"],
                    }
                    for t in v["transactions"]
                ]
            for key in ("suspicion_grounds", "narrative", "attachments"):
                if key in v:
                    payload[key] = v[key]
            if smr is None:
                smr = SmrDraft(case=case, regime="UK_SAR" if self.org.country == "GB" else "AUSTRAC_SMR")
            smr.payload = payload
            smr.version = current + 1
            smr.updated_by = request.user
            smr.save()
            self.case_audit(case, "smr.saved", version=smr.version)
        self.notify(case)
        return Response(smr_wire(case, smr, "full"))


class SmrSubmitView(CaseBase):
    def post(self, request: Request, case_id: str) -> Response:
        case = self._full(case_id, "smr:submit")
        smr = SmrDraft.objects.filter(case=case).first()
        if smr is not None and smr.submitted_at:
            raise conflict("conflict", "This report has already been submitted.")
        payload = smr.payload if smr else {}
        missing = [
            {"field": f, "message": "Required before submitting."}
            for f, key in (
                ("suspicionGrounds", "suspicion_grounds"),
                ("narrative", "narrative"),
                ("subjects", "subjects"),
            )
            if not payload.get(key)
        ]
        if smr is None or missing:
            raise validation_error(
                "Complete the report before submitting.", missing or [{"field": "narrative", "message": "Required."}]
            )
        with transaction.atomic():
            smr.submitted_at = timezone.now()
            smr.reference = f"DEMO-SMR-{secrets.token_hex(4).upper()}"
            smr.save(update_fields=["submitted_at", "reference", "updated_at"])
            case.status = "reported"
            case.save(update_fields=["status", "updated_at"])
            self.case_audit(case, "smr.submitted", reference=smr.reference)
        self.notify(case)
        return Response({"reference": smr.reference, "submitted_at": smr.submitted_at.isoformat()})


class TimelineView(CaseBase):
    def get(self, request: Request, case_id: str) -> Response:
        case, _level = self._case(case_id)
        rows = AuditLog.objects.filter(org=self.org, resource_type="case", resource_id=str(case.id)).order_by("id")
        return Response(
            [
                {
                    "at": r.created_at.isoformat(),
                    "actor_name": r.actor_name,
                    "action": r.action,
                    "label": TIMELINE_LABELS.get(r.action, r.action.replace(".", " ").replace("_", " ").capitalize()),
                }
                for r in rows
            ]
        )
