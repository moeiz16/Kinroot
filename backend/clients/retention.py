"""Record retention: 7 years (AU, AML/CTF Act record keeping) or at least 5 (UK MLR 2017 reg 40) from the end of
the business relationship. Disposal is never automatic: a dry run lists what is due; a confirmed run anonymises
personal fields and deletes stored files, leaving the audit chain intact."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from django.db import transaction
from django.utils import timezone

from accounts.models import Organisation
from accounts.services import settings_for
from audit import api as audit
from clients.models import Client, ClientParty, Document, Party
from kinroot.contracts import Actor
from kinroot.core.dates import add_years

DISPOSED_NAME = "Disposed record"


def preview(org: Organisation, as_of: date | None = None) -> dict[str, Any]:
    as_of = as_of or timezone.localdate()
    cfg = settings_for(org)["retention"]
    years = int(cfg["years"])
    holds = {str(i) for i in cfg.get("legal_hold_client_ids", [])}
    items: list[dict[str, Any]] = []
    due = 0
    clients = Client.objects.filter(org=org, relationship_ended_on__isnull=False, anonymised_at__isnull=True)
    for client in clients.order_by("relationship_ended_on"):
        ended = client.relationship_ended_on
        assert ended is not None
        disposable = add_years(ended, years)
        held = client.legal_hold or str(client.id) in holds
        items.append(
            {
                "record_type": "client",
                "id": str(client.id),
                "label": client.name,
                "relationship_ended_on": ended.isoformat(),
                "disposable_from": disposable.isoformat(),
                "legal_hold": held,
            }
        )
        for doc in Document.objects.filter(client=client):
            items.append(
                {
                    "record_type": "document",
                    "id": str(doc.id),
                    "label": f"{doc.get_doc_type_display()} for {client.name}",
                    "relationship_ended_on": ended.isoformat(),
                    "disposable_from": disposable.isoformat(),
                    "legal_hold": held,
                }
            )
        if disposable <= as_of and not held:
            due += 1
    return {"as_of": as_of.isoformat(), "due_count": due, "items": items}


def run(org_id: uuid.UUID, *, dry_run: bool = True, actor: Actor | None = None) -> dict[str, Any]:
    org = Organisation.objects.get(id=org_id)
    data = preview(org)
    today = timezone.localdate()
    due_ids = [
        i["id"]
        for i in data["items"]
        if i["record_type"] == "client" and not i["legal_hold"] and date.fromisoformat(i["disposable_from"]) <= today
    ]
    result = {"dry_run": dry_run, "due_clients": len(due_ids), "anonymised_clients": 0, "deleted_documents": 0}
    if dry_run or not due_ids:
        return result
    with transaction.atomic():
        for client in Client.objects.filter(org_id=org_id, id__in=due_ids):
            shared = set(
                ClientParty.objects.exclude(client=client).filter(org_id=org_id).values_list("party_id", flat=True)
            )
            own = set(ClientParty.objects.filter(client=client).values_list("party_id", flat=True)) | {client.party_id}
            for party in Party.objects.filter(id__in=own - shared, kind="person"):
                party.name = DISPOSED_NAME
                party.normalized_name = ""
                party.given_names = ""
                party.family_name = ""
                party.birth_date = None
                party.address = {}
                party.save()
            for doc in Document.objects.filter(client=client):
                doc.file.delete(save=False)
                doc.delete()
                result["deleted_documents"] += 1
            client.anonymised_at = timezone.now()
            client.save(update_fields=["anonymised_at", "updated_at"])
            result["anonymised_clients"] += 1
        audit.record(
            actor or Actor(org_id=org_id, user_id=None),
            "retention.disposed",
            resource_type="org",
            resource_id=org_id,
            metadata={"clients": len(due_ids), "documents": result["deleted_documents"]},
        )
    return result
