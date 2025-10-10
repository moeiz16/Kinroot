"""Investigation assistant (contract §1.13). Tipping-off: the assistant has no access to case data (ADR 0005)."""

from __future__ import annotations

from typing import Any

from django.utils import timezone
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response

from api.base import ApiView, domain_errors, parse_uuid
from api.views.graph import graphology
from assistant import api as assistant_api
from clients.models import Client
from graph import api as graph_api
from kinroot.contracts import to_wire
from kinroot.core.errors import not_found

CASE_PERMISSIONS = frozenset({"smr:read", "smr:write", "smr:submit"})


def with_graph(view: ApiView, answer: Any) -> dict[str, Any]:
    """The answer plus `graph`: the cited parties and links as one graphology payload (contract 1.13), so the
    board can draw the path without a request per party."""
    body: dict[str, Any] = view.wire(answer).data
    ids = answer.highlight or {}
    nodes, edges = list(ids.get("nodeIds") or []), list(ids.get("edgeIds") or [])
    body["graph"] = (
        graphology(graph_api.subgraph(view.org_id, nodes, edges, as_of=timezone.localtime(answer.created_at).date()))
        if nodes
        else None
    )
    return body


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
        return Response(with_graph(self, answer))


class HistoryView(ApiView):
    permission = "assistant:use"

    def get(self, request: Request) -> Response:
        raw = request.query_params.get("clientId")
        client_id = parse_uuid(raw, "Client") if raw else None
        with domain_errors():
            answers = assistant_api.history(self.org_id, self.user.id, client_id=client_id)
            return Response([with_graph(self, a) for a in answers])


class SuggestionsView(ApiView):
    permission = "assistant:use"

    def get(self, request: Request) -> Response:
        raw = request.query_params.get("clientId")
        client_id = parse_uuid(raw, "Client") if raw else None
        with domain_errors():
            return self.wire(assistant_api.suggested_questions(self.org_id, client_id))


class PinIn(serializers.Serializer):
    client_id = serializers.UUIDField()


class PinView(ApiView):
    """POST /assistant/answers/{id}/pin: the answer joins the client's dossier Timeline (contract 1.13)."""

    permission = "assistant:use"

    def post(self, request: Request, answer_id: str) -> Response:
        data = PinIn(data=request.data)
        data.is_valid(raise_exception=True)
        with domain_errors("Answer"):
            out = assistant_api.pin(
                self.org_id, parse_uuid(answer_id, "Answer"), data.validated_data["client_id"], self.actor
            )
        return Response(to_wire(out), status=201)


class PinnedView(ApiView):
    """GET /clients/{id}/pins: answers pinned to this client's dossier."""

    permission = "clients:read"

    def get(self, request: Request, client_id: str) -> Response:
        with domain_errors("Client"):
            return Response(to_wire(assistant_api.pinned(self.org_id, parse_uuid(client_id, "Client"))))
