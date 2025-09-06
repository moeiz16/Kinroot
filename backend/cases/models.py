"""Concerns, cases and suspicious-matter report drafts (restricted; ADR 0005). Owner: builder A."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

USER = settings.AUTH_USER_MODEL


class Concern(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey("clients.Client", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    raised_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    summary = models.CharField(max_length=300)
    details = models.TextField(blank=True, default="")
    status = models.CharField(max_length=12, default="received")  # received | triaged | linked
    case = models.ForeignKey("Case", null=True, blank=True, on_delete=models.SET_NULL, related_name="concerns")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]


class Case(models.Model):
    STATUSES = [("open", "Open"), ("reported", "Reported"), ("closed_no_report", "Closed, no report")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey("clients.Client", on_delete=models.CASCADE, related_name="+")
    title = models.CharField(max_length=200)
    grounds = models.TextField()
    status = models.CharField(max_length=20, choices=STATUSES, default="open")
    opened_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    opened_at = models.DateTimeField()
    deadline_on = models.DateField()
    closed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-opened_at"]


class CaseAccess(models.Model):
    LEVELS = [("full", "Full"), ("summary", "Summary")]

    id = models.BigAutoField(primary_key=True)
    case = models.ForeignKey(Case, on_delete=models.CASCADE, related_name="access_entries")
    user = models.ForeignKey(USER, on_delete=models.CASCADE, related_name="+")
    level = models.CharField(max_length=8, choices=LEVELS)
    granted_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["case", "user"], name="uniq_case_access")]


class SmrDraft(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    case = models.OneToOneField(Case, on_delete=models.CASCADE, related_name="smr")
    version = models.IntegerField(default=1)
    regime = models.CharField(max_length=12)  # AUSTRAC_SMR | UK_SAR
    payload = models.JSONField(default=dict)  # suspicion_grounds, subjects, transactions, narrative, attachments
    submitted_at = models.DateTimeField(null=True, blank=True)
    reference = models.CharField(max_length=40, blank=True, default="")
    updated_by = models.ForeignKey(USER, null=True, on_delete=models.SET_NULL, related_name="+")
    updated_at = models.DateTimeField(auto_now=True)
