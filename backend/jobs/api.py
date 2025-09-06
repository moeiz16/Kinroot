"""Public interface of the DB-backed job queue and the event outbox (builder A).

Worker: `python manage.py runworker` claims jobs atomically (UPDATE ... WHERE status='queued' compare-and-set
on SQLite; SELECT ... FOR UPDATE SKIP LOCKED on Postgres), runs the registered handler, retries with
exponential backoff (max_attempts), and leases jobs (JOBS_LEASE_SECONDS) so crashed workers are recovered.
Events are rows in jobs.Event; the SSE endpoint tails them, so the worker process can notify browsers.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from django.utils import timezone

JobHandler = Callable[[dict[str, Any]], dict[str, Any] | None]


@dataclass(frozen=True)
class Registration:
    kind: str
    handler: JobHandler
    max_attempts: int
    timeout_s: int


_REGISTRY: dict[str, Registration] = {}


def register(kind: str, *, max_attempts: int = 3, timeout_s: int = 300) -> Callable[[JobHandler], JobHandler]:
    """Decorator: register a handler for a job kind, e.g. @register("screening.rescreen_org").
    Handlers receive the payload dict (which always includes "orgId") and return an optional result dict."""

    def deco(fn: JobHandler) -> JobHandler:
        _REGISTRY[kind] = Registration(kind, fn, max_attempts, timeout_s)
        return fn

    return deco


def registered(kind: str) -> Registration | None:
    return _REGISTRY.get(kind)


def registered_kinds() -> list[str]:
    return sorted(_REGISTRY)


def enqueue(
    kind: str,
    payload: dict[str, Any],
    *,
    org_id: uuid.UUID | None,
    run_at: datetime | None = None,
    dedupe_key: str | None = None,
    priority: int = 100,
    created_by: uuid.UUID | None = None,
) -> uuid.UUID:
    """Insert a job in the caller's transaction (visible to the worker on commit). A queued job with the same
    dedupe_key is reused. Returns the job id (exposed as GET /api/v1/jobs/{id})."""
    from jobs.models import Job

    if dedupe_key:
        existing = Job.objects.filter(dedupe_key=dedupe_key, status="queued").only("id").first()
        if existing:
            return existing.id
    body = dict(payload)
    if org_id is not None:
        body.setdefault("orgId", str(org_id))
    reg = _REGISTRY.get(kind)
    job = Job.objects.create(
        org_id=org_id,
        kind=kind,
        payload=body,
        run_at=run_at or timezone.now(),
        dedupe_key=dedupe_key,
        priority=priority,
        max_attempts=reg.max_attempts if reg else 3,
        created_by_id=created_by,
    )
    return job.id


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
    from jobs.models import Event
    from kinroot.contracts import to_wire

    row = Event.objects.create(
        org_id=org_id,
        name=event,
        data=to_wire(data),
        permission=permission,
        user_ids=[str(u) for u in user_ids] if user_ids is not None else None,
    )
    return int(row.id)


def set_progress(job_id: uuid.UUID | str, progress: int) -> None:
    """Optional: handlers may report progress (payload carries "jobId")."""
    from jobs.models import Job

    pct = max(0, min(100, int(progress)))
    Job.objects.filter(id=job_id).update(progress=pct, updated_at=timezone.now())
    job = Job.objects.filter(id=job_id).only("org_id", "kind", "status", "created_by_id").first()
    if job and job.org_id:
        _job_event(job, progress=pct)


def _job_event(job: Any, *, progress: int | None = None) -> None:
    if not job.org_id:
        return
    publish_event(
        job.org_id,
        "job.updated",
        {"jobId": str(job.id), "kind": job.kind, "status": job.status, "progress": job.progress if progress is None else progress},
        user_ids=[job.created_by_id] if job.created_by_id else None,
    )
