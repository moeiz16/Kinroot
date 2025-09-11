"""The job worker: claim, run, retry with backoff, lease recovery. Used by `manage.py runworker` and tests.

Claiming is a compare-and-set UPDATE (portable to SQLite); on Postgres the candidate scan uses
SELECT ... FOR UPDATE SKIP LOCKED so several workers never fight over one row.
"""

from __future__ import annotations

import os
import socket
import time
import traceback
from datetime import timedelta
from typing import Any

import structlog
from django.conf import settings
from django.db import connection, transaction
from django.db.models import F, Q
from django.utils import timezone

from jobs import api
from jobs.models import Job
from kinroot.core.metrics import JOB_SECONDS, JOBS

log = structlog.get_logger("kinroot.worker")

WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"


def _lease() -> timedelta:
    return timedelta(seconds=int(settings.KINROOT.get("JOBS_LEASE_SECONDS", 300)))


def claim_next(worker_id: str = WORKER_ID) -> Job | None:
    """Claim one runnable job: queued and due, or running with an expired lease (crashed worker)."""
    now = timezone.now()
    runnable = Q(status="queued", run_at__lte=now) | Q(status="running", locked_until__lt=now)
    for _ in range(5):
        with transaction.atomic():
            qs = Job.objects.filter(runnable).order_by("priority", "run_at")
            if connection.vendor == "postgresql":
                qs = qs.select_for_update(skip_locked=True)
            candidate = qs.only("id", "status", "locked_until").first()
            if candidate is None:
                return None
            claimed = Job.objects.filter(
                id=candidate.id, status=candidate.status, locked_until=candidate.locked_until
            ).update(
                status="running",
                locked_by=worker_id,
                locked_until=now + _lease(),
                started_at=now,
                attempts=F("attempts") + 1,
                updated_at=now,
            )
        if claimed:
            return Job.objects.get(id=candidate.id)
    return None


def _backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(300, 2 ** max(0, attempts - 1) * 5))


def run_job(job: Job) -> Job:
    reg = api.registered(job.kind)
    started = time.perf_counter()
    if reg is None:
        job.status = "failed"
        job.error = f"No handler registered for {job.kind}"
        job.finished_at = timezone.now()
        job.locked_until = None
        job.save(update_fields=["status", "error", "finished_at", "locked_until", "updated_at"])
        JOBS.labels(job.kind, "failed").inc()
        api._job_event(job)
        return job
    api._job_event(job)
    payload = dict(job.payload or {})
    payload.setdefault("jobId", str(job.id))
    try:
        result = reg.handler(payload)
    except Exception as exc:  # retried with backoff, then failed
        log.warning("job_failed", kind=job.kind, job_id=str(job.id), attempt=job.attempts, error=str(exc))
        job.error = "".join(traceback.format_exception_only(type(exc), exc)).strip()[:2000]
        job.locked_until = None
        job.locked_by = ""
        if job.attempts >= job.max_attempts:
            job.status = "failed"
            job.finished_at = timezone.now()
        else:
            job.status = "queued"
            job.run_at = timezone.now() + _backoff(job.attempts)
        job.save()
        if job.status == "failed":
            JOBS.labels(job.kind, "failed").inc()
            api._job_event(job)
        return job
    job.status = "succeeded"
    job.result = result if isinstance(result, dict) else ({} if result is None else {"value": result})
    job.progress = 100
    job.error = ""
    job.finished_at = timezone.now()
    job.locked_until = None
    job.save()
    JOBS.labels(job.kind, "succeeded").inc()
    JOB_SECONDS.labels(job.kind).observe(time.perf_counter() - started)
    api._job_event(job)
    return job


def run_pending(*, limit: int = 100, worker_id: str = WORKER_ID) -> int:
    """Run due jobs until none are left (or `limit`). Returns the number of jobs run. Used by tests and seed."""
    count = 0
    while count < limit:
        job = claim_next(worker_id)
        if job is None:
            break
        run_job(job)
        count += 1
    return count


def graph_tick() -> int:
    """Single graph writer (ADR 0002): drain the graph outbox when this process owns the graph."""
    if settings.KINROOT.get("GRAPH_WRITER") != "worker":
        return 0
    try:
        from graph import api as graph_api

        return int(graph_api.apply_pending() or 0)
    except NotImplementedError:
        return 0
    except Exception as exc:  # keep the worker alive; the next tick retries
        log.warning("graph_tick_failed", error=str(exc))
        return 0


def daily_tick(state: dict[str, Any]) -> None:
    """Enqueue `monitoring.daily` once per org per calendar day."""
    today = timezone.localdate()
    if state.get("daily") == today:
        return
    state["daily"] = today
    if api.registered("monitoring.daily") is None:
        return
    from accounts.models import Organisation

    for org_id in Organisation.objects.values_list("id", flat=True):
        api.enqueue("monitoring.daily", {}, org_id=org_id, dedupe_key=f"monitoring.daily:{org_id}:{today}")


def loop(*, once: bool = False, poll: float | None = None) -> None:
    interval = poll if poll is not None else float(settings.KINROOT.get("JOBS_POLL_SECONDS", 1.0))
    state: dict[str, Any] = {}
    log.info("worker_started", worker=WORKER_ID, kinds=api.registered_kinds())
    while True:
        graph_tick()
        daily_tick(state)
        ran = run_pending(limit=20)
        if once:
            return
        if not ran:
            time.sleep(interval)
