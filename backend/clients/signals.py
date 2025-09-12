"""Keep ClientParty (structure membership) current when relationships change. Graph projection signals are
connected separately by the graph app (ADR 0002)."""

from __future__ import annotations

from typing import Any

from django.db.models.signals import post_delete, post_save

from clients import services
from clients.models import Client, Relationship


def _resync(org_id: Any, party_ids: list[Any]) -> None:
    if not services.structure_sync_enabled():
        return
    client_ids = services.clients_touching(org_id, party_ids)
    if client_ids:
        services.rebuild_structure(org_id, client_ids)


def on_relationship_saved(sender: Any, instance: Relationship, **_: Any) -> None:
    _resync(instance.org_id, [instance.to_party_id, instance.from_party_id])


def on_relationship_deleted(sender: Any, instance: Relationship, **_: Any) -> None:
    _resync(instance.org_id, [instance.to_party_id, instance.from_party_id])


def on_client_saved(sender: Any, instance: Client, created: bool, **_: Any) -> None:
    if created and services.structure_sync_enabled():
        services.rebuild_structure(instance.org_id, [instance.id])


def connect() -> None:
    post_save.connect(on_relationship_saved, sender=Relationship, dispatch_uid="clients.rel_saved")
    post_delete.connect(on_relationship_deleted, sender=Relationship, dispatch_uid="clients.rel_deleted")
    post_save.connect(on_client_saved, sender=Client, dispatch_uid="clients.client_saved")
