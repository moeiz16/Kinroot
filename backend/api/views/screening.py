"""Screening (contract §1.9)."""

from __future__ import annotations

from typing import Any, cast

from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response

from api.base import ApiView, domain_errors, page_params, paged, parse_uuid
from api.views.clients import ClientMixin, enqueue_if_registered, ensure_workable
from api.views.org import job_wire
from jobs.models import Job
from kinroot.contracts import ScreeningHitView, to_wire
from kinroot.core.errors import AppError, validation_error
from screening import api as screening_api

DECIDED = {"true_match", "false_positive"}


def hit_out(hit: ScreeningHitView, can_review: bool) -> dict[str, Any]:
    body = to_wire(hit)
    if not can_review and hit.status not in DECIDED:
        body["review_reason"] = None
        body["reviewed_by"] = None
    return body


class ScreenClientView(ClientMixin):
    permission = "screening:run"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        ensure_workable(client)
        job_id = enqueue_if_registered(
            "screening.client",
            {"clientId": str(client.id)},
            org_id=self.org_id,
            user_id=self.user.id,
            dedupe_key=f"screening.client:{client.id}",
            priority=50,
        )
        if job_id is None:
            raise AppError(
                503,
                "unavailable",
                "Service unavailable",
                "Screening is starting up. Try again shortly.",
                headers={"Retry-After": "30"},
            )
        self.audit("screening.requested", resource_type="client", resource_id=client.id)
        return Response(job_wire(Job.objects.get(id=job_id)), status=202)


class HitsView(ApiView):
    permission = "screening:read"

    def get(self, request: Request) -> Response:
        p = request.query_params
        status = p.get("status", "pending")
        status_arg = None if status == "all" else status
        if status_arg not in {None, "pending", "true_match", "false_positive", "escalated"}:
            raise validation_error("Unknown status.", [{"field": "status", "message": "Unknown status."}])
        list_kind = p.get("list") or None
        if list_kind not in {None, "sanctions", "pep", "adverse_media"}:
            raise validation_error("Unknown list.", [{"field": "list", "message": "Unknown list."}])
        client_id = parse_uuid(p["clientId"], "Client") if p.get("clientId") else None
        page, size = page_params(request)
        with domain_errors():
            result = screening_api.list_hits(
                self.org_id,
                status=cast(Any, status_arg),
                client_id=client_id,
                list_kind=cast(Any, list_kind),
                offset=(page - 1) * size,
                limit=size,
            )
        can_review = self.has("screening:review")
        return Response(paged([hit_out(h, can_review) for h in result.items], result.total, page, size))


class HitView(ApiView):
    permission = "screening:read"

    def get(self, request: Request, hit_id: str) -> Response:
        with domain_errors("Screening match"):
            hit = screening_api.get_hit(self.org_id, parse_uuid(hit_id, "Screening match"))
        return Response(hit_out(hit, self.has("screening:review")))


class ReviewIn(serializers.Serializer):
    decision = serializers.ChoiceField(choices=["true_match", "false_positive", "escalate"])
    reason = serializers.CharField(min_length=10, max_length=2000)


class ReviewView(ApiView):
    permission = "screening:review"

    def post(self, request: Request, hit_id: str) -> Response:
        data = ReviewIn(data=request.data)
        data.is_valid(raise_exception=True)
        with domain_errors("Screening match"):
            hit = screening_api.review_hit(
                self.org_id,
                parse_uuid(hit_id, "Screening match"),
                data.validated_data["decision"],
                data.validated_data["reason"],
                self.actor,
            )
        from clients import services
        from clients.models import Client

        client = Client.objects.filter(org=self.org, id=hit.client_id).first()
        if client is not None:
            services.maybe_activate(client)
        return Response(hit_out(hit, True))


class ListsView(ApiView):
    permission = "screening:read"

    def get(self, request: Request) -> Response:
        with domain_errors():
            return self.wire(screening_api.list_versions())


class RescreenView(ApiView):
    permission = "monitoring:manage"

    def post(self, request: Request) -> Response:
        job_id = enqueue_if_registered(
            "screening.rescreen_org",
            {"reason": "manual"},
            org_id=self.org_id,
            user_id=self.user.id,
            dedupe_key=f"screening.rescreen_org:{self.org_id}",
        )
        if job_id is None:
            raise AppError(
                503,
                "unavailable",
                "Service unavailable",
                "Screening is starting up. Try again shortly.",
                headers={"Retry-After": "30"},
            )
        self.audit("screening.rescreen_requested", resource_type="org", resource_id=self.org_id)
        return Response(job_wire(Job.objects.get(id=job_id)), status=202)
