"""Entity resolution queue (contract §1.8)."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response

from api.base import ApiView, domain_errors, parse_uuid
from clients.models import Party
from kinroot.core.errors import not_found, validation_error
from resolution import api as resolution_api

STATUSES = {"pending", "merged", "auto_merged", "not_match", "deferred"}
BANDS = {"auto_merge", "review", "reject"}


class CandidatesView(ApiView):
    permission = "resolution:read"

    def get(self, request: Request) -> Response:
        p = request.query_params
        status = p.get("status", "pending")
        status_arg = None if status == "all" else status
        if status_arg is not None and status_arg not in STATUSES:
            raise validation_error("Unknown status.", [{"field": "status", "message": "Unknown status."}])
        band = p.get("band") or None
        if band is not None and band not in BANDS:
            raise validation_error("Unknown band.", [{"field": "band", "message": "Unknown band."}])
        client_id = parse_uuid(p["clientId"], "Client") if p.get("clientId") else None
        return self.domain_page(resolution_api.list_candidates, status=status_arg, band=band, client_id=client_id)


class CandidateView(ApiView):
    permission = "resolution:read"

    def get(self, request: Request, candidate_id: str) -> Response:
        with domain_errors("Match"):
            return self.wire(resolution_api.get_candidate(self.org_id, parse_uuid(candidate_id, "Match")))


class DecisionIn(serializers.Serializer):
    decision = serializers.ChoiceField(choices=["merge", "not_match", "defer"])
    note = serializers.CharField(max_length=1000, required=False, allow_blank=True, default="")


class DecisionView(ApiView):
    permission = "resolution:decide"

    def post(self, request: Request, candidate_id: str) -> Response:
        data = DecisionIn(data=request.data)
        data.is_valid(raise_exception=True)
        with domain_errors("Match"):
            outcome = resolution_api.decide(
                self.org_id,
                parse_uuid(candidate_id, "Match"),
                data.validated_data["decision"],
                self.actor,
                data.validated_data["note"],
            )
        return self.wire(outcome)


class ProposeIn(serializers.Serializer):
    left_id = serializers.UUIDField()
    right_id = serializers.UUIDField()


class ProposeView(ApiView):
    permission = "graph:write"

    def post(self, request: Request) -> Response:
        data = ProposeIn(data=request.data)
        data.is_valid(raise_exception=True)
        left, right = data.validated_data["left_id"], data.validated_data["right_id"]
        if left == right:
            raise validation_error("Choose two different records.", [{"field": "rightId", "message": "Same record."}])
        if Party.objects.filter(org=self.org, id__in=[left, right]).count() != 2:
            raise not_found("Party")
        with domain_errors("Party"):
            return self.wire(resolution_api.propose_merge(self.org_id, left, right, self.actor), status=201)


class SplitIn(serializers.Serializer):
    record_ids = serializers.ListField(child=serializers.UUIDField(), min_length=1, max_length=50)
    note = serializers.CharField(max_length=1000)


class SplitView(ApiView):
    permission = "resolution:decide"

    def post(self, request: Request, party_id: str) -> Response:
        data = SplitIn(data=request.data)
        data.is_valid(raise_exception=True)
        with domain_errors("Party"):
            outcome = resolution_api.split(
                self.org_id,
                parse_uuid(party_id, "Party"),
                data.validated_data["record_ids"],
                self.actor,
                data.validated_data["note"],
            )
        return self.wire(outcome)


class ThresholdsView(ApiView):
    permission = "resolution:read"

    def get(self, request: Request) -> Response:
        with domain_errors():
            return self.wire(resolution_api.thresholds())


class StatsView(ApiView):
    permission = "resolution:read"

    def get(self, request: Request) -> Response:
        with domain_errors():
            return self.wire(resolution_api.queue_stats(self.org_id))
