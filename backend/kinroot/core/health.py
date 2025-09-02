"""Liveness and readiness probes (plain Django views: no auth, no throttling)."""

from __future__ import annotations

import time

from django.conf import settings
from django.db import connection
from django.http import HttpRequest, JsonResponse

from kinroot import __version__

_STARTED = time.time()


def health(_request: HttpRequest) -> JsonResponse:
    return JsonResponse(
        {
            "status": "ok",
            "service": "kinroot-api",
            "version": __version__,
            "uptimeS": int(time.time() - _STARTED),
        }
    )


def ready(_request: HttpRequest) -> JsonResponse:
    """Database reachable and graph configured. The graph store registers a richer check once implemented."""
    checks: dict[str, str] = {}
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT 1")
        checks["database"] = "ok"
    except Exception:  # pragma: no cover - exercised only when the DB is down
        checks["database"] = "error"
    checks["graphBackend"] = str(settings.KINROOT["GRAPH_BACKEND"])
    checks["llm"] = "offline" if settings.KINROOT["LLM_FAKE"] else "cloud"
    ok = checks["database"] == "ok"
    return JsonResponse({"status": "ok" if ok else "degraded", "checks": checks}, status=200 if ok else 503)
