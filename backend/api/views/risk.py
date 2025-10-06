"""Risk, EDD workflow and two-stage sign-off (contract §1.10)."""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response

from api.base import ApiView, domain_errors, parse_uuid
from api.views.clients import ClientMixin, ensure_workable
from api.wire import edd_wire
from clients import services
from clients.models import Client, Document, EddCase, EddMeasure, SignOff
from jobs import api as jobs_api
from kinroot.core.errors import AppError, not_found, validation_error
from risk import api as risk_api


def sync_edd_from_risk(client: Client) -> EddCase | None:
    """Align the EDD case with the domain core's current triggers when available."""
    try:
        triggers = risk_api.edd_requirements(client.org_id, client.id)
    except NotImplementedError:
        return EddCase.objects.filter(client=client).first()
    except Exception:  # the latest assessment may not exist yet
        return EddCase.objects.filter(client=client).first()
    edd = services.sync_edd(client, triggers)
    return services.refresh_edd_status(edd)


def publish_edd(client: Client, edd: EddCase) -> None:
    jobs_api.publish_event(
        client.org_id, "edd.updated", {"clientId": str(client.id), "status": edd.status}, permission="risk:read"
    )


class ClientRiskView(ClientMixin):
    permission = "risk:read"

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        with domain_errors("Client"):
            return self.wire(risk_api.latest_assessment(self.org_id, client.id))


class RiskHistoryView(ClientMixin):
    permission = "risk:read"

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        with domain_errors("Client"):
            return self.wire(risk_api.assessment_history(self.org_id, client.id))


class AssessView(ClientMixin):
    permission = "risk:assess"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        ensure_workable(client)
        with domain_errors("Client"):
            assessment = risk_api.assess_client(self.org_id, client.id, self.actor)
        services.sync_edd(client, assessment.edd_triggers)
        return self.wire(assessment)


class OverrideIn(serializers.Serializer):
    rating = serializers.ChoiceField(choices=["low", "medium", "high"])
    reason = serializers.CharField(min_length=5, max_length=2000)


RANK = {"low": 0, "medium": 1, "high": 2}


class OverrideView(ClientMixin):
    permission = "risk:override"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        data = OverrideIn(data=request.data)
        data.is_valid(raise_exception=True)
        rating, reason = data.validated_data["rating"], data.validated_data["reason"]
        if client.rating and RANK[rating] < RANK[client.rating] and len(reason.strip()) < 20:
            raise validation_error(
                "Lowering a rating needs a fuller reason.",
                [{"field": "reason", "message": "At least 20 characters when lowering a rating."}],
            )
        with domain_errors("Client"):
            return self.wire(risk_api.override_rating(self.org_id, client.id, rating, reason, self.actor))


class DisagreementsView(ApiView):
    permission = "risk:read"

    def get(self, request: Request) -> Response:
        status = request.query_params.get("status", "open")
        status_arg = None if status == "all" else status
        if status_arg not in {None, "open", "resolved"}:
            raise validation_error("Unknown status.", [{"field": "status", "message": "Unknown status."}])
        return self.domain_page(risk_api.list_disagreements, status=status_arg)


class ResolveDisagreementIn(serializers.Serializer):
    outcome = serializers.ChoiceField(choices=["keep_rules", "override_to_challenger", "methodology_issue"])
    note = serializers.CharField(max_length=2000)


class ResolveDisagreementView(ApiView):
    permission = "risk:override"

    def post(self, request: Request, disagreement_id: str) -> Response:
        data = ResolveDisagreementIn(data=request.data)
        data.is_valid(raise_exception=True)
        with domain_errors("Disagreement"):
            return self.wire(
                risk_api.resolve_disagreement(
                    self.org_id,
                    parse_uuid(disagreement_id, "Disagreement"),
                    data.validated_data["outcome"],
                    data.validated_data["note"],
                    self.actor,
                )
            )


class MethodologyView(ApiView):
    permission = "risk:read"

    def get(self, request: Request) -> Response:
        with domain_errors():
            return self.wire(risk_api.methodology_versions(self.org_id))


class PublishMethodologyView(ApiView):
    permission = "methodology:manage"

    def post(self, request: Request, methodology_id: str) -> Response:
        with domain_errors("Methodology"):
            return self.wire(
                risk_api.publish_methodology(self.org_id, parse_uuid(methodology_id, "Methodology"), self.actor)
            )


class ModelsView(ApiView):
    permission = "models:read"

    def get(self, request: Request) -> Response:
        with domain_errors():
            return self.wire(risk_api.model_registry(self.org_id))


class PromoteIn(serializers.Serializer):
    version = serializers.CharField(max_length=60)
    note = serializers.CharField(min_length=5, max_length=2000)


class PromoteModelView(ApiView):
    permission = "models:promote"

    def post(self, request: Request, name: str) -> Response:
        if name not in {"er-matcher", "risk-challenger"}:
            raise not_found("Model")
        data = PromoteIn(data=request.data)
        data.is_valid(raise_exception=True)
        with domain_errors("Model"):
            return self.wire(
                risk_api.promote_model(name, data.validated_data["version"], self.actor, data.validated_data["note"])
            )


# ── EDD and sign-off (A-owned workflow) ───────────────────────────────────────────────────────────
class EddView(ClientMixin):
    permission = "risk:read"

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        edd = sync_edd_from_risk(client)
        return Response(edd_wire(edd, client))


class MeasureIn(serializers.Serializer):
    status = serializers.ChoiceField(choices=["done", "not_applicable", "todo"])
    note = serializers.CharField(max_length=4000, required=False, allow_blank=True, default="")
    document_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)


class MeasureView(ClientMixin):
    permission = "edd:manage"

    def post(self, request: Request, client_id: str, key: str) -> Response:
        client = self.get_client(client_id)
        ensure_workable(client)
        edd = EddCase.objects.filter(client=client).first() or sync_edd_from_risk(client)
        measure = EddMeasure.objects.filter(edd=edd, key=key).first() if edd else None
        if edd is None or measure is None:
            raise not_found("Measure")
        if key == "senior_approval":
            raise AppError(
                422, "invalid_transition", "Validation failed", "Senior approval is recorded through the sign-off step."
            )
        if edd.status in {"awaiting_senior", "approved"}:
            raise AppError(
                422,
                "invalid_transition",
                "Validation failed",
                "This file is with the approvers. Ask the compliance officer to reopen it.",
            )
        data = MeasureIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        if v["status"] == "not_applicable" and len(v["note"].strip()) < 10:
            raise validation_error(
                "Explain why this measure doesn't apply.", [{"field": "note", "message": "At least 10 characters."}]
            )
        doc_ids = [str(d) for d in v["document_ids"]]
        if doc_ids and Document.objects.filter(client=client, id__in=doc_ids).count() != len(set(doc_ids)):
            raise validation_error("Unknown document.", [{"field": "documentIds", "message": "Unknown document."}])
        with transaction.atomic():
            measure.status = v["status"]
            measure.note = v["note"]
            measure.document_ids = doc_ids
            measure.completed_by = self.user if v["status"] != "todo" else None
            measure.completed_at = timezone.now() if v["status"] != "todo" else None
            measure.save()
            if edd.status == "rejected":
                edd.signoffs.update(superseded=True)
                edd.status = "in_progress"
                edd.save(update_fields=["status", "updated_at"])
            services.refresh_edd_status(edd)
            self.audit(
                "edd.measure_updated",
                resource_type="client",
                resource_id=client.id,
                metadata={"measure": key, "status": v["status"]},
            )
        edd.refresh_from_db()
        publish_edd(client, edd)
        return Response(edd_wire(edd, client))


class SignoffIn(serializers.Serializer):
    stage = serializers.ChoiceField(choices=["compliance", "senior"])
    decision = serializers.ChoiceField(choices=["approve", "reject"])
    note = serializers.CharField(max_length=4000, required=False, allow_blank=True, default="")


class SignoffView(ClientMixin):
    permission = ("signoff:compliance", "signoff:senior")

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        ensure_workable(client)
        data = SignoffIn(data=request.data)
        data.is_valid(raise_exception=True)
        stage, decision, note = (
            data.validated_data["stage"],
            data.validated_data["decision"],
            data.validated_data["note"],
        )
        self.require(f"signoff:{stage}")
        edd = EddCase.objects.filter(client=client).first()
        expected = {"compliance": "awaiting_compliance", "senior": "awaiting_senior"}[stage]
        if edd is None or edd.status != expected:
            raise AppError(422, "invalid_transition", "Validation failed", "This file isn't waiting for that sign-off.")
        if stage == "senior" and client.assigned_to_id == self.user.id:
            raise AppError(403, "forbidden", "Forbidden", "A partner can't approve their own client's file.")
        if decision == "reject" and len(note.strip()) < 10:
            raise validation_error(
                "Give the reason for rejecting.", [{"field": "note", "message": "At least 10 characters."}]
            )
        with transaction.atomic():
            SignOff.objects.create(
                org=self.org, edd=edd, stage=stage, decision=decision, note=note, by=self.user, at=timezone.now()
            )
            if decision == "reject":
                edd.status = "rejected"
            elif stage == "compliance":
                edd.status = "awaiting_senior" if services.needs_senior(edd) else "approved"
            else:
                edd.status = "approved"
                edd.measures.filter(key="senior_approval").update(
                    status="done", completed_by=self.user, completed_at=timezone.now(), note=note
                )
            edd.save(update_fields=["status", "updated_at"])
            self.audit(
                f"edd.signoff_{decision}", resource_type="client", resource_id=client.id, metadata={"stage": stage}
            )
        if edd.status == "approved":
            services.maybe_activate(client)
        publish_edd(client, edd)
        return Response(edd_wire(edd, client))


class SignoffQueueView(ApiView):
    permission = ("signoff:compliance", "signoff:senior")

    def get(self, request: Request) -> Response:
        stage = request.query_params.get("stage")
        stages = [s for s in ("compliance", "senior") if self.has(f"signoff:{s}") and (stage in (None, "", s))]
        statuses = {"compliance": "awaiting_compliance", "senior": "awaiting_senior"}
        out: list[dict[str, Any]] = []
        for s in stages:
            for edd in EddCase.objects.select_related("client").filter(org=self.org, status=statuses[s]):
                last = edd.signoffs.filter(superseded=False).order_by("-at").first()
                measure_done = edd.measures.exclude(completed_at=None).order_by("-completed_at").first()
                waiting = last.at if last else (measure_done.completed_at if measure_done else edd.updated_at)
                out.append(
                    {
                        "client_id": str(edd.client_id),
                        "client_name": edd.client.name,
                        "stage": s,
                        "rating": edd.client.rating,
                        "triggers": edd.triggers or [],
                        "waiting_since": waiting.isoformat() if waiting else None,
                        "own_client": edd.client.assigned_to_id == self.user.id,
                    }
                )
        out.sort(key=lambda r: r["waiting_since"])
        return Response(out)
