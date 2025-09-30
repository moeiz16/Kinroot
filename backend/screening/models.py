"""Screening models. Owner: builder B. See docs/API_CONTRACT.md Part 2.

List data is global reference data (not tenant data): `ListVersion` rows are immutable snapshots, one current
version per source. Hits and runs are tenant data.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class ListVersion(models.Model):
    id = models.BigAutoField(primary_key=True)
    list_kind = models.CharField(max_length=14)  # sanctions | pep | adverse_media
    source = models.CharField(max_length=80)  # "bundled-sample" | "opensanctions:au_dfat_sanctions"
    version = models.CharField(max_length=40)
    title = models.CharField(max_length=200, blank=True, default="")
    licence = models.CharField(max_length=80, blank=True, default="")
    entries = models.IntegerField(default=0)
    loaded_at = models.DateTimeField(auto_now_add=True)
    is_sample = models.BooleanField(default=False)
    is_current = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["source", "list_kind", "version"], name="uniq_list_version")]

    def __str__(self) -> str:
        return str(f"{self.source}:{self.list_kind}@{self.version}")


class ListEntry(models.Model):
    id = models.BigAutoField(primary_key=True)
    version = models.ForeignKey(ListVersion, on_delete=models.CASCADE, related_name="items")
    entry_id = models.CharField(max_length=120, db_index=True)
    list_kind = models.CharField(max_length=14)
    schema = models.CharField(max_length=20, default="Person")  # Person | Organization | Company | LegalEntity
    name = models.CharField(max_length=300)
    aliases = models.JSONField(default=list)
    birth_date = models.CharField(max_length=10, blank=True, default="")
    countries = models.JSONField(default=list)
    programs = models.JSONField(default=list)
    identifiers = models.JSONField(default=dict)
    url = models.URLField(blank=True, default="")

    def __str__(self) -> str:
        return str(self.name)


class ScreeningRun(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey("clients.Client", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    reason = models.CharField(max_length=30, default="manual")
    list_versions = models.JSONField(default=dict)
    screened = models.IntegerField(default=0)
    new_hits = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return str(f"run {self.id}")


class ScreeningHit(models.Model):
    STATUSES = [
        ("pending", "Pending"),
        ("true_match", "True match"),
        ("false_positive", "False positive"),
        ("escalated", "Escalated"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    client = models.ForeignKey("clients.Client", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    party = models.ForeignKey("clients.Party", on_delete=models.CASCADE, related_name="+")
    entry = models.ForeignKey(ListEntry, null=True, on_delete=models.SET_NULL, related_name="+")
    entry_key = models.CharField(max_length=120)  # list entry id (stable across list versions)
    list_kind = models.CharField(max_length=14)
    score = models.FloatField()
    reasons = models.JSONField(default=list)
    status = models.CharField(max_length=16, choices=STATUSES, default="pending")
    run = models.ForeignKey(ScreeningRun, null=True, blank=True, on_delete=models.SET_NULL, related_name="hits")
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_reason = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-score", "-created_at"]
        constraints = [models.UniqueConstraint(fields=["party", "entry_key"], name="uniq_hit_party_entry")]
        indexes = [models.Index(fields=["org", "status"])]

    def __str__(self) -> str:
        return str(f"{self.party_id}~{self.entry_key}")
