"""Risk models. Owner: builder B. See docs/API_CONTRACT.md Part 2 and ADR 0004."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

USER = settings.AUTH_USER_MODEL


class RiskMethodology(models.Model):
    STATUSES = [("draft", "Draft"), ("published", "Published"), ("retired", "Retired")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    version = models.CharField(max_length=20)
    status = models.CharField(max_length=10, choices=STATUSES, default="draft")
    bands = models.JSONField(default=dict)
    rules = models.JSONField(default=list)
    published_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    published_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["org", "version"], name="uniq_methodology_version")]

    def __str__(self) -> str:
        return str(self.version)


class RiskAssessment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey("clients.Client", on_delete=models.CASCADE, related_name="+")
    methodology = models.ForeignKey(RiskMethodology, on_delete=models.PROTECT, related_name="assessments")
    score = models.IntegerField()
    rating = models.CharField(max_length=6)
    reasons = models.JSONField(default=list)
    features = models.JSONField(default=dict)
    challenger = models.JSONField(null=True, blank=True)
    edd_triggers = models.JSONField(default=list)
    inputs_hash = models.CharField(max_length=64, db_index=True)
    override = models.JSONField(null=True, blank=True)
    assessed_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["org", "client", "created_at"])]

    def __str__(self) -> str:
        return str(f"{self.client_id}:{self.rating}")


class Disagreement(models.Model):
    STATUSES = [("open", "Open"), ("resolved", "Resolved")]
    OUTCOMES = [
        ("keep_rules", "Keep rules"),
        ("override_to_challenger", "Override to challenger"),
        ("methodology_issue", "Methodology issue"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey("clients.Client", on_delete=models.CASCADE, related_name="+")
    assessment = models.ForeignKey(RiskAssessment, on_delete=models.CASCADE, related_name="disagreements")
    rules_rating = models.CharField(max_length=6)
    challenger_rating = models.CharField(max_length=6)
    probability_high = models.FloatField()
    reasons = models.JSONField(default=list)
    status = models.CharField(max_length=10, choices=STATUSES, default="open")
    outcome = models.CharField(max_length=24, choices=OUTCOMES, blank=True, default="")
    note = models.TextField(blank=True, default="")
    resolved_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return str(f"{self.client_id}:{self.rules_rating}/{self.challenger_rating}")


class ModelPromotion(models.Model):
    """Champion/challenger sign-off history. MLflow keeps the runs and metrics; this is the firm's approval."""

    id = models.BigAutoField(primary_key=True)
    model_name = models.CharField(max_length=40)  # er-matcher | risk-challenger
    version = models.CharField(max_length=40)
    stage = models.CharField(max_length=12, default="champion")
    org = models.ForeignKey("accounts.Organisation", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    promoted_by = models.ForeignKey(USER, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    promoted_by_name = models.CharField(max_length=200, default="")
    note = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return str(f"{self.model_name}:{self.version}")
