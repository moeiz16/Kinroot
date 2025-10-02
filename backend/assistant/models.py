"""Investigation assistant models. Owner: builder B. See docs/API_CONTRACT.md Part 2."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class AssistantExchange(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey("accounts.Organisation", on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    client = models.ForeignKey("clients.Client", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    question = models.CharField(max_length=500)
    answer = models.TextField()
    citations = models.JSONField(default=list)
    steps = models.JSONField(default=list)
    highlight = models.JSONField(default=dict)
    mode = models.CharField(max_length=8, default="offline")
    grounded = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["org", "user", "created_at"])]

    def __str__(self) -> str:
        return str(self.question[:60])
