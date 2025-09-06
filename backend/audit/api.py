"""Public interface of the audit trail (builder A). Every app records sensitive actions through `record`.

Per-organisation hash chain: hash = sha256(prev_hash || canonical_json(row)); verify_chain detects edits or
deletions. Keep personal data out of `metadata` (ids, references and field names only).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from django.db import transaction
from django.utils import timezone

from kinroot.contracts import Actor
from kinroot.core.metrics import AUDIT_APPENDS

GENESIS = "0" * 64


def _canonical(row: dict[str, Any]) -> str:
    return json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)


def _row_payload(entry: Any) -> dict[str, Any]:
    return {
        "org": str(entry.org_id) if entry.org_id else None,
        "actor": str(entry.actor_id) if entry.actor_id else None,
        "actorType": entry.actor_type,
        "action": entry.action,
        "resourceType": entry.resource_type,
        "resourceId": entry.resource_id,
        "metadata": entry.metadata,
        "restricted": entry.restricted,
        "createdAt": entry.created_at.isoformat(),
    }


def compute_hash(prev_hash: str, entry: Any) -> str:
    return hashlib.sha256((prev_hash + _canonical(_row_payload(entry))).encode()).hexdigest()


def record(
    actor: Actor,
    action: str,
    *,
    resource_type: str | None = None,
    resource_id: Any = None,
    metadata: dict[str, Any] | None = None,
    restricted: bool = False,
    user_agent: str = "",
) -> int:
    """Append one audit row in the caller's transaction; returns its id.

    `restricted=True` rows (SMR/case actions) are only listed to users with `smr:read`; they still take part
    in the org's hash chain, so the chain stays verifiable by auditors without exposing the content.
    Action names: "<area>.<verb>", e.g. "screening.hit_reviewed", "resolution.merged", "risk.overridden".
    """
    from audit.models import AuditLog

    org_id = actor.org_id
    with transaction.atomic():
        qs = AuditLog.objects.filter(org_id=org_id) if org_id else AuditLog.objects.filter(org__isnull=True)
        last = qs.select_for_update().order_by("-id").only("hash").first()
        prev = last.hash if last else GENESIS
        entry = AuditLog(
            org_id=org_id,
            actor_id=actor.user_id,
            actor_name=actor.name or "System",
            actor_type="user" if actor.user_id else "system",
            action=action,
            resource_type=resource_type or "",
            resource_id=str(resource_id) if resource_id is not None else "",
            metadata=json.loads(_canonical(metadata or {})),
            ip=actor.ip or "",
            user_agent=(user_agent or "")[:300],
            restricted=restricted,
            prev_hash=prev,
            created_at=timezone.now(),
        )
        entry.hash = compute_hash(prev, entry)
        entry.save()
    AUDIT_APPENDS.labels(action).inc()
    return int(entry.id)


def verify_chain(org_id: uuid.UUID) -> dict[str, Any]:
    """{"valid": bool, "checked": int, "brokenAt": int | None}"""
    from audit.models import AuditLog

    prev = GENESIS
    checked = 0
    for entry in AuditLog.objects.filter(org_id=org_id).order_by("id").iterator(chunk_size=500):
        if entry.prev_hash != prev or compute_hash(prev, entry) != entry.hash:
            return {"valid": False, "checked": checked, "brokenAt": entry.id}
        prev = entry.hash
        checked += 1
    return {"valid": True, "checked": checked, "brokenAt": None}
