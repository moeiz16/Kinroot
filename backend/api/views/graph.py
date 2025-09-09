"""Graph endpoints (contract §1.7): graphology payloads and graph analyses from graph.api."""

from __future__ import annotations

import dataclasses
from typing import Any

from rest_framework.request import Request
from rest_framework.response import Response

from api.base import ApiView, domain_errors, parse_date, parse_uuid
from clients.models import Client, Party
from graph import api as graph_api
from kinroot.contracts import GraphView, to_wire
from kinroot.core.camel import camelize
from kinroot.core.errors import AppError, not_found


def _int(request: Request, name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(request.query_params.get(name, default))
    except ValueError as exc:
        raise AppError(400, "bad_request", "Bad request", f"{name} must be a number.") from exc
    return max(lo, min(hi, value))


def graphology(view: GraphView) -> dict[str, Any]:
    """GraphView -> graphology serialisation. `attributes` maps are opaque to the renderer, so camelCase here."""
    nodes = []
    for n in view.nodes:
        attrs = camelize(to_wire({f.name: getattr(n, f.name) for f in dataclasses.fields(n) if f.name != "id"}))
        attrs["identifiers"] = dict(n.identifiers or {})
        nodes.append({"key": n.id, "attributes": attrs})
    edges = []
    for e in view.edges:
        attrs = camelize(
            to_wire(
                {f.name: getattr(e, f.name) for f in dataclasses.fields(e) if f.name not in {"id", "source", "target"}}
            )
        )
        edges.append({"key": e.id, "source": e.source, "target": e.target, "attributes": attrs})
    return {
        "attributes": {
            "focusId": view.focus_id,
            "asOf": view.as_of.isoformat(),
            "depth": view.depth,
            "truncated": view.truncated,
            "graphVersion": view.graph_version,
        },
        "nodes": nodes,
        "edges": edges,
    }


class GraphBase(ApiView):
    permission = "graph:read"

    def client_id(self, raw: str) -> Any:
        cid = parse_uuid(raw, "Client")
        if not Client.objects.filter(org=self.org, id=cid).exists():
            raise not_found("Client")
        return cid

    def party_id(self, raw: str | None, resource: str = "Party") -> Any:
        pid = parse_uuid(raw, resource)
        if not Party.objects.filter(org=self.org, id=pid).exists():
            raise not_found(resource)
        return pid


class ClientGraphView(GraphBase):
    def get(self, request: Request, client_id: str) -> Response:
        cid = self.client_id(client_id)
        with domain_errors("Client"):
            view = graph_api.client_graph(
                self.org_id,
                cid,
                as_of=parse_date(request.query_params.get("asOf")),
                depth=_int(request, "depth", 6, 1, 10),
            )
        return Response(graphology(view))


class PartyGraphView(GraphBase):
    def get(self, request: Request, party_id: str) -> Response:
        pid = self.party_id(party_id)
        with domain_errors("Party"):
            view = graph_api.party_graph(
                self.org_id,
                pid,
                as_of=parse_date(request.query_params.get("asOf")),
                depth=_int(request, "depth", 2, 1, 4),
            )
        return Response(graphology(view))


class UboView(GraphBase):
    def get(self, request: Request, client_id: str) -> Response:
        cid = self.client_id(client_id)
        with domain_errors("Client"):
            result = graph_api.beneficial_owners(self.org_id, cid, as_of=parse_date(request.query_params.get("asOf")))
        count = sum(1 for o in result.owners if o.is_ubo)
        Client.objects.filter(id=cid).exclude(ubo_count=count).update(ubo_count=count)
        return self.wire(result)


class DiffView(GraphBase):
    def get(self, request: Request, client_id: str) -> Response:
        cid = self.client_id(client_id)
        start = parse_date(request.query_params.get("from"), "from")
        end = parse_date(request.query_params.get("to"), "to")
        if start is None or end is None:
            raise AppError(400, "bad_request", "Bad request", "from and to are required dates.")
        if start > end:
            start, end = end, start
        with domain_errors("Client"):
            return self.wire(graph_api.graph_diff(self.org_id, cid, start, end))


class ThreadView(GraphBase):
    def get(self, request: Request, party_id: str) -> Response:
        pid = self.party_id(party_id)
        with domain_errors("Party"):
            return self.wire(
                graph_api.pull_thread(self.org_id, pid, as_of=parse_date(request.query_params.get("asOf")))
            )


class ConnectionView(GraphBase):
    def get(self, request: Request) -> Response:
        src = self.party_id(request.query_params.get("from"))
        dst = self.party_id(request.query_params.get("to"))
        with domain_errors("Party"):
            return self.wire(
                graph_api.connection(self.org_id, src, dst, as_of=parse_date(request.query_params.get("asOf")))
            )


class SearchView(GraphBase):
    def get(self, request: Request) -> Response:
        q = request.query_params.get("q", "").strip()
        if len(q) < 2:
            return Response([])
        with domain_errors():
            return self.wire(graph_api.search(self.org_id, q[:100], limit=_int(request, "limit", 10, 1, 50)))


class ClustersView(GraphBase):
    def get(self, request: Request) -> Response:
        kind = request.query_params.get("kind")
        kinds = [kind] if kind in {"shared_officer", "shared_address", "nominee"} else None
        with domain_errors():
            return self.wire(graph_api.clusters(self.org_id, kinds=kinds))


class ConstellationView(GraphBase):
    def get(self, request: Request) -> Response:
        with domain_errors():
            return Response(graphology(graph_api.constellation(self.org_id)))


class GraphStatusView(GraphBase):
    def get(self, request: Request) -> Response:
        with domain_errors():
            return self.wire(graph_api.sync_status(self.org_id))
