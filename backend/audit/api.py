"""Public interface of the audit trail (builder A). Every app records sensitive actions through `record`.

Per-organisation hash chain: hash = sha256(prev_hash || canonical_json(row)); verify_chain detects edits or
deletions. Keep personal data out of `metadata` (ids, references and field names only).
"""

from __future__ import annotations

import uuid
from typing import Any

from kinroot.contracts import Actor


def record(
    actor: Actor,
    action: str,
    *,
    resource_type: str | None = None,
    resource_id: Any = None,
    metadata: dict[str, Any] | None = None,
    restricted: bool = False,
) -> int:
    """Append one audit row in the caller's transaction; returns its id.

    `restricted=True` rows (SMR/case actions) are only listed to users with `smr:read`; they still take part
    in the org's hash chain, so the chain stays verifiable by auditors without exposing the content.
    Action names: "<area>.<verb>", e.g. "screening.hit_reviewed", "resolution.merged", "risk.overridden".
    """
    raise NotImplementedError


def verify_chain(org_id: uuid.UUID) -> dict[str, Any]:
    """{"valid": bool, "checked": int, "brokenAt": int | None}"""
    raise NotImplementedError
