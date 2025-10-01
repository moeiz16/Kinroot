"""Monitoring models. Owner: builder B. See docs/API_CONTRACT.md Part 2."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class Alert(models.Model):
    STATUSES = [("open", "Open"), ("resolved", "Resolved"), ("dismissed", "Dismissed")]
    SEVERITIES = [("info", "Info"), ("warning", "Warning"), ("critical", "Critical")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey("clients.Client", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    kind = models.CharField(max_length=20)
    severity = models.CharField(max_length=8, choices=SEVERITIES, default="warning")
    title = models.CharField(max_length=300)
    body = models.TextField(blank=True, default="")
    evidence = models.JSONField(default=list)
    status = models.CharField(max_length=10, choices=STATUSES, default="open")
    dedupe_key = models.CharField(max_length=200, null=True, blank=True)  # noqa: DJ001 - NULL = no dedupe (unique)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolution_note = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["org", "dedupe_key"], name="uniq_alert_dedupe")]
        indexes = [models.Index(fields=["org", "status", "kind"])]

    def __str__(self) -> str:
        return str(self.title)


class ReviewSchedule(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey("clients.Client", on_delete=models.CASCADE, related_name="+")
    due_on = models.DateField()
    completed_on = models.DateField(null=True, blank=True)
    completed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    note = models.TextField(blank=True, default="")
    scheduled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["due_on"]

    def __str__(self) -> str:
        return str(f"{self.client_id}@{self.due_on}")


class MonitoringRun(models.Model):
    id = models.BigAutoField(primary_key=True)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    ran_on = models.DateField()
    counts = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return str(f"{self.org_id}@{self.ran_on}")
