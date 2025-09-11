"""Public interface of concerns and cases (builder A) for the domain core.

Tipping-off (ADR 0005): the domain core may raise a concern but never reads cases, case access or SMR drafts.
"""

from __future__ import annotations

import uuid

from audit import api as audit
from kinroot.contracts import Actor, NotFound


def raise_concern(
    org_id: uuid.UUID, client_id: uuid.UUID | None, summary: str, details: str, actor: Actor
) -> uuid.UUID:
    """Record an internal concern for the compliance officer (e.g. an escalated screening hit). Audited as a
    restricted row. Returns the concern id."""
    from cases.models import Concern
    from clients.models import Client

    if client_id is not None and not Client.objects.filter(org_id=org_id, id=client_id).exists():
        raise NotFound("client")
    concern = Concern.objects.create(
        org_id=org_id, client_id=client_id, raised_by_id=actor.user_id, summary=summary[:300], details=details
    )
    audit.record(actor, "concern.raised", resource_type="concern", resource_id=concern.id, restricted=True)
    return concern.id
