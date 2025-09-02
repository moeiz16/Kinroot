"""Prometheus metrics. Exposed at `/metrics` (text exposition format)."""

from __future__ import annotations

from django.http import HttpRequest, HttpResponse
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

REGISTRY = CollectorRegistry(auto_describe=True)

HTTP_REQUESTS = Counter(
    "kinroot_http_requests_total", "HTTP requests", ["method", "route", "status"], registry=REGISTRY
)
HTTP_LATENCY = Histogram(
    "kinroot_http_request_seconds",
    "HTTP request latency",
    ["method", "route"],
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
    registry=REGISTRY,
)
RATE_LIMITED = Counter("kinroot_rate_limited_total", "Requests rejected by rate limits", ["scope"], registry=REGISTRY)
AUDIT_APPENDS = Counter("kinroot_audit_appends_total", "Audit records appended", ["action"], registry=REGISTRY)
JOBS = Counter("kinroot_jobs_total", "Background jobs finished", ["kind", "status"], registry=REGISTRY)
JOB_SECONDS = Histogram("kinroot_job_seconds", "Background job duration", ["kind"], registry=REGISTRY)
GRAPH_QUERIES = Histogram("kinroot_graph_query_seconds", "Graph query latency", ["query"], registry=REGISTRY)
GRAPH_SYNC_LAG = Gauge("kinroot_graph_sync_lag", "Graph outbox rows not yet applied", registry=REGISTRY)
ER_DECISIONS = Counter(
    "kinroot_er_decisions_total", "Entity-resolution decisions", ["band", "decision"], registry=REGISTRY
)
SCREENING_HITS = Counter("kinroot_screening_hits_total", "Screening hits raised", ["list"], registry=REGISTRY)
RISK_DISAGREEMENTS = Counter("kinroot_risk_disagreements_total", "Rules vs challenger disagreements", registry=REGISTRY)
ASSISTANT_ANSWERS = Counter("kinroot_assistant_answers_total", "Assistant answers", ["mode"], registry=REGISTRY)


def metrics_view(_request: HttpRequest) -> HttpResponse:
    return HttpResponse(generate_latest(REGISTRY), content_type=CONTENT_TYPE_LATEST)
