"""DB-backed job queue and the SSE event outbox. Owner: builder A."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class Job(models.Model):
    STATUSES = [("queued", "Queued"), ("running", "Running"), ("succeeded", "Succeeded"), ("failed", "Failed")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=60, db_index=True)
    payload = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=10, choices=STATUSES, default="queued")
    priority = models.IntegerField(default=100)  # lower runs first
    run_at = models.DateTimeField(db_index=True)
    attempts = models.IntegerField(default=0)
    max_attempts = models.IntegerField(default=3)
    locked_by = models.CharField(max_length=80, blank=True, default="")
    locked_until = models.DateTimeField(null=True, blank=True)
    dedupe_key = models.CharField(max_length=200, null=True, blank=True)  # noqa: DJ001
    result = models.JSONField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    progress = models.IntegerField(default=0)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["priority", "run_at"]
        indexes = [models.Index(fields=["status", "run_at"]), models.Index(fields=["dedupe_key", "status"])]

    def __str__(self) -> str:
        return f"{self.kind} {self.id} ({self.status})"


class Event(models.Model):
    """One SSE event. The auto id is the SSE `id:` so clients resume with Last-Event-ID."""

    id = models.BigAutoField(primary_key=True)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=60)
    data = models.JSONField(default=dict)
    permission = models.CharField(max_length=40, null=True, blank=True)  # noqa: DJ001
    user_ids = models.JSONField(null=True, blank=True)  # restricted delivery (case events): list of user id strings
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["id"]
        indexes = [models.Index(fields=["org", "id"])]

    def __str__(self) -> str:
        return f"{self.id} {self.name}"
