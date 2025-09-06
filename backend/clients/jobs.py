"""Job handlers owned by the clients app: retention runs and registry imports."""

from __future__ import annotations

import uuid
from typing import Any

from jobs.api import register


def _retention(payload: dict[str, Any]) -> dict[str, Any]:
    from clients import retention
    from kinroot.contracts import Actor

    org_id = uuid.UUID(payload["orgId"])
    actor = Actor(org_id=org_id, user_id=uuid.UUID(payload["userId"]) if payload.get("userId") else None,
                  name=payload.get("userName", "System"))
    return retention.run(org_id, dry_run=bool(payload.get("dryRun", True)), actor=actor)


def _registry_import(payload: dict[str, Any]) -> dict[str, Any]:
    from clients import registry
    from clients.models import Client

    client = Client.objects.select_related("party").get(org_id=payload["orgId"], id=payload["clientId"])
    return registry.import_entry(client, payload["source"], payload["reference"])


def register_all() -> None:
    register("retention.run", max_attempts=1)(_retention)
    register("registry.import", max_attempts=2)(_registry_import)
