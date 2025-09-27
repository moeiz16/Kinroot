"""Graph models. Owner: builder B. See docs/API_CONTRACT.md Part 2 and ADR 0002.

`GraphOutbox` is the transactional outbox: rows are written by signals on clients.Party / clients.Relationship
inside the same database transaction, and drained in sequence order by the single graph writer.
"""

from __future__ import annotations

from django.db import models


class GraphOutbox(models.Model):
    ENTITIES = [("party", "Party"), ("relationship", "Relationship")]
    OPS = [("upsert", "Upsert"), ("delete", "Delete")]

    seq = models.BigAutoField(primary_key=True)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    entity = models.CharField(max_length=12, choices=ENTITIES)
    entity_id = models.UUIDField()
    op = models.CharField(max_length=6, choices=OPS)
    payload = models.JSONField(default=dict, blank=True)  # last known endpoints (for deletes)
    created_at = models.DateTimeField(auto_now_add=True)
    applied_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        ordering = ["seq"]
        indexes = [models.Index(fields=["applied_at", "seq"])]

    def __str__(self) -> str:
        return str(f"{self.entity}:{self.entity_id}:{self.op}")


class GraphSyncState(models.Model):
    org = models.OneToOneField("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    graph_version = models.BigIntegerField(default=0)
    last_applied_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return str(f"graph v{self.graph_version}")
