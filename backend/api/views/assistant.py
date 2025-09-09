"""Investigation assistant (contract §1.13). Tipping-off: the assistant has no access to case data (ADR 0005)."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response

from api.base import ApiView, domain_errors, parse_uuid
from assistant import api as assistant_api
from clients.models import Client
from kinroot.core.errors import not_found

CASE_PERMISSIONS = frozenset({"smr:read", "smr:write", "smr:submit"})


class AskIn(serializers.Serializer):
    question = serializers.CharField(min_length=3, max_length=500)
    client_id = serializers.UUIDField(required=False, allow_null=True)
    as_of = serializers.DateField(required=False, allow_null=True)


class AskView(ApiView):
    permission = "assistant:use"
    throttle_scope = "assistant"

    def post(self, request: Request) -> Response:
        data = AskIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        if v.get("client_id") and not Client.objects.filter(org=self.org, id=v["client_id"]).exists():
            raise not_found("Client")
        with domain_errors("Client"):
            answer = assistant_api.ask(
                self.org_id,
                v["question"],
                self.actor,
                permissions=frozenset(self.perms - CASE_PERMISSIONS),
                client_id=v.get("client_id"),
                as_of=v.get("as_of"),
            )
        return self.wire(answer)


class HistoryView(ApiView):
    permission = "assistant:use"

    def get(self, request: Request) -> Response:
        raw = request.query_params.get("clientId")
        client_id = parse_uuid(raw, "Client") if raw else None
        with domain_errors():
            return self.wire(assistant_api.history(self.org_id, request.user.id, client_id=client_id))


class SuggestionsView(ApiView):
    permission = "assistant:use"

    def get(self, request: Request) -> Response:
        raw = request.query_params.get("clientId")
        client_id = parse_uuid(raw, "Client") if raw else None
        with domain_errors():
            return self.wire(assistant_api.suggested_questions(self.org_id, client_id))
