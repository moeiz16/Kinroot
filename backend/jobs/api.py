"""Public interface of the DB-backed job queue and the event outbox (builder A).

Worker: `python manage.py runworker` claims jobs atomically (UPDATE ... WHERE status='queued' compare-and-set
on SQLite; SELECT ... FOR UPDATE SKIP LOCKED on Postgres), runs the registered handler, retries with
exponential backoff (max_attempts), and leases jobs (JOBS_LEASE_SECONDS) so crashed workers are recovered.
Events are rows in jobs.Event; the SSE endpoint tails them, so the worker process can notify browsers.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Any

JobHandler = Callable[[dict[str, Any]], dict[str, Any] | None]


def register(kind: str, *, max_attempts: int = 3, timeout_s: int = 300) -> Callable[[JobHandler], JobHandler]:
    """Decorator: register a handler for a job kind, e.g. @register("screening.rescreen_org").
    Handlers receive the payload dict (which always includes "orgId") and return an optional result dict."""
    raise NotImplementedError


def enqueue(
    kind: str,
    payload: dict[str, Any],
    *,
    org_id: uuid.UUID | None,
    run_at: datetime | None = None,
    dedupe_key: str | None = None,
    priority: int = 100,
) -> uuid.UUID:
    """Insert a job in the caller's transaction (visible to the worker on commit). A queued job with the same
    dedupe_key is reused. Returns the job id (exposed as GET /api/v1/jobs/{id})."""
    raise NotImplementedError


def publish_event(
    org_id: uuid.UUID,
    event: str,
    data: dict[str, Any],
    *,
    permission: str | None = None,
    user_ids: list[uuid.UUID] | None = None,
) -> int:
    """Append an SSE event row. `permission` limits delivery to members holding it; `user_ids` limits it to
    named users (restricted case events). Event names are listed in docs/API_CONTRACT.md §SSE."""
    raise NotImplementedError
