"""SSE delivery rules and stream framing; dashboard and insights composition."""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from django.utils import timezone

from accounts.roles import permissions_for
from api import sse
from clients.models import EddCase
from jobs import api as jobs_api
from jobs.models import Event
from tests.api.helpers import make_client_record, signed_in

pytestmark = pytest.mark.django_db


def test_scan_filters_by_permission_and_recipient(firm):
    org = firm["org"].id
    fee, co = firm["users"]["fee_earner"], firm["users"]["compliance_officer"]
    jobs_api.publish_event(org, "screening.hit", {"hitId": "h"}, permission="screening:read")
    jobs_api.publish_event(org, "resolution.candidate", {"candidateId": "c"}, permission="resolution:read")
    jobs_api.publish_event(org, "case.updated", {"caseId": "x"}, user_ids=[co.id])
    rows, cursor = sse.scan(org, fee.id, permissions_for("fee_earner"), 0)
    assert [e.name for e in rows] == ["screening.hit"]
    assert cursor == Event.objects.order_by("-id").first().id
    assert [e.name for e in sse.deliverable(org, co.id, permissions_for("compliance_officer"), 0)] == [
        "screening.hit",
        "resolution.candidate",
        "case.updated",
    ]


def test_format_event_is_camel_case(firm):
    eid = jobs_api.publish_event(firm["org"].id, "risk.assessed", {"client_id": "c1", "rating": "high"})
    text = sse.format_event(Event.objects.get(id=eid))
    assert text.startswith(f"id: {eid}\nevent: risk.assessed\ndata: ")
    assert '"clientId":"c1"' in text
    assert text.endswith("\n\n")


def _collect(response) -> str:
    async def run():
        chunks = []
        async for chunk in response.streaming_content:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        return "".join(chunks)

    return asyncio.run(run())


@pytest.mark.django_db(transaction=True)
def test_stream_headers_backlog_and_resume(firm, settings):
    settings.KINROOT = {**settings.KINROOT, "SSE_MAX_SECONDS": 0, "SSE_POLL_SECONDS": 0}
    co = firm["users"]["compliance_officer"]
    first = jobs_api.publish_event(firm["org"].id, "graph.synced", {"graphVersion": 1}, permission="graph:read")
    jobs_api.publish_event(firm["org"].id, "graph.synced", {"graphVersion": 2}, permission="graph:read")
    api = signed_in(co)
    resp = api.get("/api/v1/events/stream", HTTP_LAST_EVENT_ID=str(first))
    assert resp.status_code == 200
    assert resp["Content-Type"] == "text/event-stream"
    assert resp["Cache-Control"] == "no-cache, no-transform"
    assert resp["X-Accel-Buffering"] == "no"
    body = _collect(resp)
    assert '"graphVersion":2' in body
    assert '"graphVersion":1' not in body


def test_stream_requires_session(db):
    from rest_framework.test import APIClient

    resp = APIClient().get("/api/v1/events/stream")
    assert resp.status_code == 401
    assert resp["Content-Type"] == "application/problem+json"


def test_dashboard_counts_follow_permissions(firm):
    make_client_record(
        firm,
        "Patel Riya",
        kind="individual",
        status="active",
        rating="low",
        next_review_on=timezone.localdate() - timedelta(days=40),
    )
    make_client_record(
        firm,
        "Marlowe Fine Art Pty Ltd",
        status="active",
        rating="medium",
        next_review_on=timezone.localdate() + timedelta(days=10),
    )
    hq = make_client_record(firm, "Harbour Quay Developments Pty Ltd", status="active", rating="high")
    EddCase.objects.create(org=firm["org"], client=hq, required=True, status="awaiting_compliance")
    co = signed_in(firm["users"]["compliance_officer"]).get("/api/v1/dashboard").json()
    assert co["counts"]["clients"] == 3
    assert co["counts"]["reviewsOverdue"] == 1
    assert co["counts"]["reviewsDueSoon"] == 1
    assert co["counts"]["awaitingSignoff"] == 1
    assert co["counts"]["highRisk"] == 1
    assert co["ratingMix"] == {"low": 1, "medium": 1, "high": 1}
    assert co["regime"]["daysToCommencement"] == (timezone.datetime(2026, 7, 1).date() - timezone.localdate()).days
    assert any(t["kind"] == "signoff" for t in co["fileTray"])
    assert len(co["fileTray"]) <= 6
    # every slip links to a route the web app serves, and subtitles use plain words, not codes
    for slip in co["fileTray"]:
        assert slip["href"].startswith(("/clients/", "/screening/", "/fuse/", "/alerts/")), slip["href"]
        assert "_" not in slip["subtitle"] and "%" not in slip["subtitle"]
    signoff = next(t for t in co["fileTray"] if t["kind"] == "signoff")
    assert signoff["href"] == f"/clients/{hq.id}/risk"
    fee = signed_in(firm["users"]["fee_earner"]).get("/api/v1/dashboard").json()
    assert "awaitingSignoff" in fee["counts"]
    assert "mergeQueue" not in fee["counts"]
    assert not any(t["kind"] == "signoff" for t in fee["fileTray"])


def test_recent_activity_scoped_to_audit_permission(firm):
    co = signed_in(firm["users"]["compliance_officer"])
    co.post(
        "/api/v1/clients",
        {
            "kind": "company",
            "name": "Bellmere Holdings Pty Ltd",
            "jurisdiction": "AU",
            "services": ["company_formation"],
            "channel": "remote",
        },
        format="json",
    )
    owner_feed = signed_in(firm["users"]["owner"]).get("/api/v1/dashboard").json()["recentActivity"]
    assert owner_feed[0]["label"] == "Started onboarding Bellmere Holdings Pty Ltd"
    fee_feed = signed_in(firm["users"]["fee_earner"]).get("/api/v1/dashboard").json()["recentActivity"]
    assert fee_feed == []


def test_insights_shape(firm):
    make_client_record(
        firm,
        "Patel Riya",
        kind="individual",
        status="active",
        rating="low",
        next_review_on=timezone.localdate() - timedelta(days=40),
    )
    rows = signed_in(firm["users"]["auditor"]).get("/api/v1/insights").json()
    overdue = next(r for r in rows if r["id"] == "reviews-overdue")
    assert overdue["tone"] == "risk"
    assert overdue["metric"]["value"] == 1
    assert signed_in(firm["users"]["fee_earner"]).get("/api/v1/insights").status_code == 403
