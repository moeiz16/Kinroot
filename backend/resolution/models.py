"""Entity resolution models. Owner: builder B. See docs/API_CONTRACT.md Part 2 and ADR 0003.

A candidate is an ordered pair (left.id < right.id) of parties with the matcher's score frozen at scoring time;
decided candidates double as labelled training pairs. Merges are recorded so they can be split again.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class MatchCandidate(models.Model):
    STATUSES = [
        ("pending", "Pending"),
        ("merged", "Merged"),
        ("auto_merged", "Auto-merged"),
        ("not_match", "Not a match"),
        ("deferred", "Deferred"),
    ]
    BANDS = [("auto_merge", "Auto-merge"), ("review", "Review"), ("reject", "Reject")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    left = models.ForeignKey("clients.Party", on_delete=models.CASCADE, related_name="+")
    right = models.ForeignKey("clients.Party", on_delete=models.CASCADE, related_name="+")
    probability = models.FloatField()
    band = models.CharField(max_length=12, choices=BANDS)
    fs_weight = models.FloatField()
    fs_probability = models.FloatField()
    features = models.JSONField(default=dict)
    reasons = models.JSONField(default=list)
    model_version = models.CharField(max_length=40)
    origin = models.CharField(max_length=10, default="blocking")  # blocking | manual
    status = models.CharField(max_length=12, choices=STATUSES, default="pending")
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    decided_at = models.DateTimeField(null=True, blank=True)
    note = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-probability", "id"]
        constraints = [models.UniqueConstraint(fields=["left", "right"], name="uniq_match_pair")]
        indexes = [models.Index(fields=["org", "status", "band"])]

    def __str__(self) -> str:
        return str(f"{self.left_id}~{self.right_id} ({self.band})")


class MergeRecord(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    survivor = models.ForeignKey("clients.Party", on_delete=models.CASCADE, related_name="+")
    merged = models.ForeignKey("clients.Party", on_delete=models.CASCADE, related_name="+")
    candidate = models.ForeignKey(
        MatchCandidate, null=True, blank=True, on_delete=models.SET_NULL, related_name="merges"
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    actor_name = models.CharField(max_length=200, default="System")
    created_at = models.DateTimeField(auto_now_add=True)
    undone_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return str(f"{self.merged_id}->{self.survivor_id}")
