"""DB-backed job queue: enqueue, dedupe, run, retry with backoff, failure, lease recovery, events."""

from __future__ import annotations

from datetime import timedelta

import pytest
from django.utils import timezone

from jobs import api as jobs_api
from jobs import worker
from jobs.models import Event, Job

pytestmark = pytest.mark.django_db

CALLS: list[dict] = []


@pytest.fixture(autouse=True)
def handlers():
    CALLS.clear()

    @jobs_api.register("test.ok")
    def ok(payload):
        CALLS.append(payload)
        jobs_api.set_progress(payload["jobId"], 50)
        return {"done": True}

    @jobs_api.register("test.flaky", max_attempts=3)
    def flaky(payload):
        CALLS.append(payload)
        raise RuntimeError("temporary outage")

    yield
    jobs_api._REGISTRY.pop("test.ok", None)
    jobs_api._REGISTRY.pop("test.flaky", None)


def test_enqueue_adds_org_id(firm):
    job_id = jobs_api.enqueue("test.ok", {"x": 1}, org_id=firm["org"].id)
    job = Job.objects.get(id=job_id)
    assert job.status == "queued"
    assert job.payload == {"x": 1, "orgId": str(firm["org"].id)}


def test_dedupe_reuses_queued_job(firm):
    a = jobs_api.enqueue("test.ok", {}, org_id=firm["org"].id, dedupe_key="k1")
    b = jobs_api.enqueue("test.ok", {}, org_id=firm["org"].id, dedupe_key="k1")
    assert a == b
    assert Job.objects.count() == 1


def test_run_pending_succeeds_and_reports(firm):
    user = firm["users"]["fee_earner"]
    job_id = jobs_api.enqueue("test.ok", {}, org_id=firm["org"].id, created_by=user.id)
    assert worker.run_pending() == 1
    job = Job.objects.get(id=job_id)
    assert job.status == "succeeded"
    assert job.result == {"done": True}
    assert job.progress == 100
    assert CALLS[0]["jobId"] == str(job_id)
    events = list(Event.objects.filter(name="job.updated"))
    assert {e.data["status"] for e in events} >= {"running", "succeeded"}
    assert all(e.user_ids == [str(user.id)] for e in events)


def test_failure_retries_with_backoff(firm):
    job_id = jobs_api.enqueue("test.flaky", {}, org_id=firm["org"].id)
    worker.run_pending()
    job = Job.objects.get(id=job_id)
    assert job.status == "queued"
    assert job.attempts == 1
    assert job.run_at > timezone.now()
    assert "temporary outage" in job.error


def test_failure_is_final_after_max_attempts(firm):
    job_id = jobs_api.enqueue("test.flaky", {}, org_id=firm["org"].id)
    for _ in range(3):
        Job.objects.filter(id=job_id).update(run_at=timezone.now() - timedelta(seconds=1))
        worker.run_pending()
    job = Job.objects.get(id=job_id)
    assert job.status == "failed"
    assert job.attempts == 3
    assert job.finished_at is not None


def test_unknown_kind_fails_cleanly(firm):
    job_id = jobs_api.enqueue("nobody.handles", {}, org_id=firm["org"].id)
    worker.run_pending()
    job = Job.objects.get(id=job_id)
    assert job.status == "failed"
    assert "No handler" in job.error


def test_expired_lease_is_recovered(firm):
    job_id = jobs_api.enqueue("test.ok", {}, org_id=firm["org"].id)
    Job.objects.filter(id=job_id).update(
        status="running", locked_by="dead:1", locked_until=timezone.now() - timedelta(seconds=5)
    )
    assert worker.run_pending() == 1
    assert Job.objects.get(id=job_id).status == "succeeded"


def test_active_lease_is_not_stolen(firm):
    job_id = jobs_api.enqueue("test.ok", {}, org_id=firm["org"].id)
    Job.objects.filter(id=job_id).update(status="running", locked_until=timezone.now() + timedelta(minutes=5))
    assert worker.run_pending() == 0


def test_future_jobs_wait(firm):
    jobs_api.enqueue("test.ok", {}, org_id=firm["org"].id, run_at=timezone.now() + timedelta(hours=1))
    assert worker.run_pending() == 0


def test_priority_order(firm):
    low = jobs_api.enqueue("test.ok", {"n": "low"}, org_id=firm["org"].id, priority=200)
    high = jobs_api.enqueue("test.ok", {"n": "high"}, org_id=firm["org"].id, priority=10)
    worker.run_pending()
    assert [c["n"] for c in CALLS] == ["high", "low"]
    assert Job.objects.get(id=high).finished_at <= Job.objects.get(id=low).finished_at


def test_publish_event_restricts_delivery(firm):
    user = firm["users"]["compliance_officer"]
    eid = jobs_api.publish_event(firm["org"].id, "case.updated", {"case_id": "c"}, user_ids=[user.id])
    event = Event.objects.get(id=eid)
    assert event.user_ids == [str(user.id)]
    assert event.permission is None


def test_daily_tick_enqueues_once_per_day(firm):
    jobs_api.register("monitoring.daily")(lambda payload: None)
    state: dict = {}
    worker.daily_tick(state)
    worker.daily_tick(state)
    assert Job.objects.filter(kind="monitoring.daily").count() == 1


def test_graph_tick_is_noop_when_inline(settings):
    settings.KINROOT = {**settings.KINROOT, "GRAPH_WRITER": "inline"}
    assert worker.graph_tick() == 0
