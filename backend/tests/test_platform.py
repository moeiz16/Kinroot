"""Platform skeleton: probes, metrics, problem+json errors, security headers, camelCase, pagination."""

from __future__ import annotations

import json

import pytest
from django.http import Http404
from rest_framework import exceptions as drf

from kinroot.contracts import GraphEdge, to_wire
from kinroot.core.camel import camelize, snakeize
from kinroot.core.errors import AppError, problem_exception_handler
from kinroot.core.middleware import route_label

pytestmark = pytest.mark.django_db


def test_health_ok(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "kinroot-api"


def test_api_health_alias(client):
    assert client.get("/api/v1/health").status_code == 200


def test_ready_checks_database(client):
    body = client.get("/health/ready").json()
    assert body["checks"]["database"] == "ok"
    assert body["checks"]["llm"] == "offline"


def test_metrics_exposition(client):
    client.get("/health")
    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert b"kinroot_http_requests_total" in resp.content


def test_unknown_route_is_problem_json(client):
    resp = client.get("/api/v1/nope")
    assert resp.status_code == 404
    assert resp["Content-Type"] == "application/problem+json"
    body = json.loads(resp.content)
    assert body["code"] == "not_found"
    assert body["status"] == 404


def test_unknown_api_route_is_problem_json_in_debug(client, settings):
    settings.DEBUG = True
    resp = client.get("/api/v2/whatever")
    assert resp.status_code == 404
    assert resp["Content-Type"] == "application/problem+json"


def test_request_id_round_trip(client):
    resp = client.get("/health", HTTP_X_REQUEST_ID="abc12345-trace")
    assert resp["X-Request-ID"] == "abc12345-trace"
    generated = client.get("/health", HTTP_X_REQUEST_ID="bad id!")["X-Request-ID"]
    assert generated != "bad id!"
    assert len(generated) == 32


def test_security_headers(client):
    resp = client.get("/api/v1/health")
    assert resp["X-Content-Type-Options"] == "nosniff"
    assert resp["X-Frame-Options"] == "DENY"
    assert "default-src 'none'" in resp["Content-Security-Policy"]
    assert resp["Cache-Control"] == "no-store"
    assert resp["Referrer-Policy"] == "same-origin"


def _handle(exc: Exception):
    return problem_exception_handler(exc, {})


def test_app_error_rendered():
    resp = _handle(AppError(409, "already_decided", detail="Already decided."))
    assert resp.status_code == 409
    assert resp.data["code"] == "already_decided"
    assert resp.data["type"].endswith("/already_decided")


def test_validation_errors_flattened_camel():
    resp = _handle(drf.ValidationError({"full_name": ["Required."], "address": {"post_code": ["Bad."]}}))
    assert resp.status_code == 422
    fields = {e["field"] for e in resp.data["errors"]}
    assert fields == {"fullName", "address.postCode"}


def test_not_authenticated_is_401():
    resp = _handle(drf.NotAuthenticated())
    assert resp.status_code == 401
    assert resp.data["code"] == "not_authenticated"


def test_throttled_sets_retry_after():
    resp = _handle(drf.Throttled(wait=12))
    assert resp.status_code == 429
    assert resp["Retry-After"] == "12"


def test_django_404_inside_drf():
    assert _handle(Http404()).status_code == 404


def test_camel_round_trip_keeps_opaque_maps():
    data = {"risk_rating": "high", "features": {"name_jaro_winkler": 0.9}, "items": [{"valid_to": None}]}
    wire = camelize(data)
    assert wire == {
        "riskRating": "high",
        "features": {"name_jaro_winkler": 0.9},
        "items": [{"validTo": None}],
    }
    assert snakeize(wire) == data


def test_to_wire_dataclass():
    edge = GraphEdge(id="e1", source="a", target="b", kind="ownership", label="62%", pct=62.0)
    wire = camelize(to_wire(edge))
    assert wire["pct"] == 62.0
    assert wire["validFrom"] is None
    assert wire["sourceRef"] is None


def test_route_label_collapses_ids():
    assert route_label("/api/v1/clients/3f2b8a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/graph") == "/api/v1/clients/{id}/graph"
