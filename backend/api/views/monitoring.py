"""Ongoing monitoring (contract §1.11)."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.services import review_months
from api.base import ApiView, domain_errors, parse_date, parse_uuid
from api.views.clients import ClientMixin
from audit import api as audit_api
from clients import api as clients_api
from kinroot.core.dates import add_months
from kinroot.core.errors import validation_error
from monitoring import api as monitoring_api

ALERT_KINDS = {
    "list_update_hit",
    "ownership_change",
    "officer_change",
    "address_change",
    "risk_change",
    "review_due",
    "model_drift",
}


class AlertsView(ApiView):
    permission = "monitoring:read"

    def get(self, request: Request) -> Response:
        p = request.query_params
        status = p.get("status", "open")
        status_arg = None if status == "all" else status
        if status_arg not in {None, "open", "resolved", "dismissed"}:
            raise validation_error("Unknown status.", [{"field": "status", "message": "Unknown status."}])
        kind = p.get("kind") or None
        if kind is not None and kind not in ALERT_KINDS:
            raise validation_error("Unknown alert kind.", [{"field": "kind", "message": "Unknown kind."}])
        client_id = parse_uuid(p["clientId"], "Client") if p.get("clientId") else None
        return self.domain_page(monitoring_api.list_alerts, status=status_arg, kind=kind, client_id=client_id)


class AlertView(ApiView):
    permission = "monitoring:read"

    def get(self, request: Request, alert_id: str) -> Response:
        with domain_errors("Alert"):
            return self.wire(monitoring_api.get_alert(self.org_id, parse_uuid(alert_id, "Alert")))


class ResolveAlertIn(serializers.Serializer):
    outcome = serializers.ChoiceField(choices=["resolved", "dismissed"])
    note = serializers.CharField(min_length=5, max_length=2000)


class ResolveAlertView(ApiView):
    permission = "monitoring:manage"

    def post(self, request: Request, alert_id: str) -> Response:
        data = ResolveAlertIn(data=request.data)
        data.is_valid(raise_exception=True)
        with domain_errors("Alert"):
            return self.wire(
                monitoring_api.resolve_alert(
                    self.org_id,
                    parse_uuid(alert_id, "Alert"),
                    data.validated_data["outcome"],
                    data.validated_data["note"],
                    self.actor,
                )
            )


class ReviewsView(ApiView):
    permission = "monitoring:read"

    def get(self, request: Request) -> Response:
        with domain_errors():
            return self.wire(
                monitoring_api.review_schedule(
                    self.org_id, due_before=parse_date(request.query_params.get("dueBefore"), "dueBefore")
                )
            )


class ClientReviewIn(serializers.Serializer):
    due_on = serializers.DateField(required=False)
    completed = serializers.BooleanField(required=False, default=False)
    note = serializers.CharField(max_length=4000, required=False, allow_blank=True, default="")

    def validate(self, attrs: dict) -> dict:
        if not attrs.get("completed") and not attrs.get("due_on"):
            raise serializers.ValidationError({"due_on": "Choose a review date, or record a completed review."})
        if attrs.get("completed") and len(attrs.get("note", "").strip()) < 10:
            raise serializers.ValidationError({"note": "Summarise the review (at least 10 characters)."})
        return attrs


class ClientReviewView(ClientMixin):
    permission = "monitoring:manage"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        data = ClientReviewIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        from django.utils import timezone

        today = timezone.localdate()
        if v["completed"] and v.get("due_on") is None and hasattr(monitoring_api, "complete_review"):
            with domain_errors("Client"):
                result = monitoring_api.complete_review(self.org_id, client.id, self.actor, v["note"])
            return self.wire(result)
        if v["completed"]:
            due = v.get("due_on") or add_months(today, review_months(self.org, client.rating))
            clients_api.set_review_dates(self.org_id, client.id, last_reviewed_on=today, next_review_on=due)
            audit_api.record(
                self.actor,
                "review.completed",
                resource_type="client",
                resource_id=client.id,
                metadata={"nextReviewOn": due.isoformat()},
            )
        else:
            due = v["due_on"]
            if due < today:
                raise validation_error(
                    "Choose a date from today.", [{"field": "dueOn", "message": "Date is in the past."}]
                )
        with domain_errors("Client"):
            result = monitoring_api.schedule_review(self.org_id, client.id, due, self.actor)
        return self.wire(result)
