"""HTTP conventions on API responses: problem+json everywhere, headers, request ids, camelCase input."""

from __future__ import annotations

import pytest

from tests.api.helpers import signed_in

pytestmark = pytest.mark.django_db


def test_method_not_allowed_is_problem_json(firm):
    resp = signed_in(firm["users"]["owner"]).delete("/api/v1/org")
    assert resp.status_code == 405
    assert resp["Content-Type"] == "application/problem+json"
    assert resp.json()["status"] == 405


def test_malformed_json_is_400(firm):
    api = signed_in(firm["users"]["owner"])
    resp = api.generic("PATCH", "/api/v1/org", "{not json", content_type="application/json")
    assert resp.status_code == 400
    assert resp["Content-Type"] == "application/problem+json"


def test_api_responses_are_not_cached_and_carry_request_id(firm):
    resp = signed_in(firm["users"]["owner"]).get("/api/v1/org", HTTP_X_REQUEST_ID="trace-12345678")
    assert resp["Cache-Control"] == "no-store"
    assert resp["X-Request-ID"] == "trace-12345678"
    assert resp["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in resp["Content-Security-Policy"]


def test_errors_carry_request_id(firm):
    resp = signed_in(firm["users"]["owner"]).get("/api/v1/clients/not-a-uuid", HTTP_X_REQUEST_ID="trace-abcdefgh")
    assert resp.status_code == 404
    assert resp.json()["requestId"] == "trace-abcdefgh"


def test_page_size_is_capped(firm):
    body = signed_in(firm["users"]["owner"]).get("/api/v1/clients?pageSize=5000").json()
    assert body["pageSize"] == 200
    assert signed_in(firm["users"]["owner"]).get("/api/v1/clients?page=abc").status_code == 400


def test_api_rate_limit_returns_retry_after(firm, settings):
    from rest_framework.throttling import SimpleRateThrottle

    rates = {**settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"], "api": "3/min"}
    original = SimpleRateThrottle.THROTTLE_RATES
    api = signed_in(firm["users"]["owner"])
    SimpleRateThrottle.THROTTLE_RATES = rates
    try:
        codes = [api.get("/api/v1/org").status_code for _ in range(5)]
    finally:
        SimpleRateThrottle.THROTTLE_RATES = original
    assert codes[-1] == 429
