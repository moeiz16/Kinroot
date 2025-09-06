"""Audit trail: an append-only, per-organisation SHA-256 hash chain. Owner: builder A."""

from __future__ import annotations

from django.conf import settings
from django.db import models


class AuditLog(models.Model):
    id = models.BigAutoField(primary_key=True)
    org = models.ForeignKey("accounts.Organisation", null=True, on_delete=models.CASCADE, related_name="+")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    actor_name = models.CharField(max_length=200, default="System")
    actor_type = models.CharField(max_length=10, default="user")  # user | system
    action = models.CharField(max_length=80, db_index=True)
    resource_type = models.CharField(max_length=40, blank=True, default="")
    resource_id = models.CharField(max_length=64, blank=True, default="")
    metadata = models.JSONField(default=dict, blank=True)
    ip = models.CharField(max_length=64, blank=True, default="")
    user_agent = models.CharField(max_length=300, blank=True, default="")
    restricted = models.BooleanField(default=False)
    prev_hash = models.CharField(max_length=64)
    hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(db_index=True)

    class Meta:
        ordering = ["-id"]
        indexes = [
            models.Index(fields=["org", "id"]),
            models.Index(fields=["org", "resource_type", "resource_id"]),
        ]

    def __str__(self) -> str:
        return f"{self.id} {self.action}"
