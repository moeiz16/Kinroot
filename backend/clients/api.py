"""Public interface of the clients system of record (builder A) used by the domain core.

Party and Relationship rows are the truth; the graph app projects them (signals -> graph outbox).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from django.db import transaction

from audit import api as audit
from clients import services
from clients.models import Client, Consent, Document, Party, Relationship, VerificationCheck
from kinroot.contracts import Actor, NotFound, PartyRecord
from kinroot.core.dates import add_months


def _party_record(p: Party) -> PartyRecord:
    return PartyRecord(
        id=str(p.id),
        kind=p.kind,  # type: ignore[arg-type]
        name=p.name,
        birth_date=p.birth_date,
        nationality=p.nationality or None,
        jurisdiction=p.jurisdiction or None,
        identifiers=dict(p.identifiers or {}),
        address=services.format_address(p.address),
        source=p.source,
        source_ref=p.source_ref or None,
    )


def party_records(
    org_id: uuid.UUID, *, party_ids: list[uuid.UUID] | None = None, active_only: bool = True
) -> list[PartyRecord]:
    """Parties as resolution/screening inputs (merged-away parties excluded when active_only)."""
    qs = services.active_parties(org_id, party_ids)
    if active_only:
        qs = qs.filter(merged_into__isnull=True)
    return [_party_record(p) for p in qs.order_by("created_at", "id")]


def client_party_ids(org_id: uuid.UUID, client_id: uuid.UUID) -> list[uuid.UUID]:
    """The client's own party plus every party linked into its structure (for screening scope)."""
    try:
        return services.structure_party_ids(org_id, client_id)
    except Client.DoesNotExist as exc:
        raise NotFound("client") from exc


_MOVABLE = (
    ("rel_from", Relationship, "from_party_id"),
    ("rel_to", Relationship, "to_party_id"),
    ("documents", Document, "party_id"),
    ("verifications", VerificationCheck, "party_id"),
    ("consents", Consent, "party_id"),
    ("clients", Client, "party_id"),
)


def merge_parties(org_id: uuid.UUID, survivor_id: uuid.UUID, merged_ids: list[uuid.UUID], actor: Actor) -> None:
    """Re-point relationships, documents and hits to the survivor; mark merged parties `merged_into`;
    keep source records for split. Audited ("party.merged"). Triggers graph sync via signals.

    Screening hits and other domain rows that reference parties are re-pointed by their owning app."""
    with transaction.atomic():
        survivor = Party.objects.filter(org_id=org_id, id=survivor_id).first()
        if survivor is None:
            raise NotFound("party")
        merged = list(Party.objects.filter(org_id=org_id, id__in=merged_ids).exclude(id=survivor_id))
        if len(merged) != len({m for m in merged_ids if m != survivor_id}):
            raise NotFound("party")
        touched: set[uuid.UUID] = {survivor.id}
        for party in merged:
            moves: dict[str, list[str]] = {}
            for key, model, field in _MOVABLE:
                ids = list(model.objects.filter(org_id=org_id, **{field: party.id}).values_list("id", flat=True))
                moves[key] = [str(i) for i in ids]
                for obj in model.objects.filter(id__in=ids):
                    setattr(obj, field, survivor.id)
                    obj.save()
            party.merge_moves = moves
            party.merged_into = survivor
            party.save(update_fields=["merge_moves", "merged_into", "updated_at"])
            touched.add(party.id)
        audit.record(
            actor,
            "party.merged",
            resource_type="party",
            resource_id=survivor.id,
            metadata={"mergedIds": [str(m.id) for m in merged]},
        )
        services.rebuild_structure(org_id, services.clients_touching(org_id, list(touched)) or None)


def split_party(
    org_id: uuid.UUID, survivor_id: uuid.UUID, record_ids: list[uuid.UUID], actor: Actor
) -> list[uuid.UUID]:
    """Reverse a merge for the given source records; returns the restored party ids. Audited ("party.split")."""
    restored: list[uuid.UUID] = []
    with transaction.atomic():
        if not Party.objects.filter(org_id=org_id, id=survivor_id).exists():
            raise NotFound("party")
        for party in Party.objects.filter(org_id=org_id, id__in=record_ids, merged_into_id=survivor_id):
            for key, model, field in _MOVABLE:
                ids = (party.merge_moves or {}).get(key, [])
                for obj in model.objects.filter(org_id=org_id, id__in=ids, **{field: survivor_id}):
                    setattr(obj, field, party.id)
                    obj.save()
            party.merged_into = None
            party.merge_moves = {}
            party.save(update_fields=["merge_moves", "merged_into", "updated_at"])
            restored.append(party.id)
        if not restored:
            raise NotFound("party")
        audit.record(
            actor,
            "party.split",
            resource_type="party",
            resource_id=survivor_id,
            metadata={"restoredIds": [str(r) for r in restored]},
        )
        services.rebuild_structure(org_id)
    return restored


def set_client_rating(
    org_id: uuid.UUID,
    client_id: uuid.UUID,
    rating: str,
    assessed_on: date,
    *,
    source: str = "rules",
    edd_triggers: list[Any] | None = None,
) -> None:
    """Cache the decision-of-record rating on the client (list views, constellation, review frequency).

    `source` is "rules" or "override". When `edd_triggers` is given the EDD workflow is aligned with them.
    The next review date is filled from the org's review months only when none is scheduled yet."""
    from accounts.services import review_months

    client = Client.objects.select_related("org").filter(org_id=org_id, id=client_id).first()
    if client is None:
        raise NotFound("client")
    if rating not in {"low", "medium", "high"}:
        raise ValueError("rating must be low, medium or high")
    client.rating = rating
    client.rating_source = source
    fields = ["rating", "rating_source", "updated_at"]
    if client.next_review_on is None:
        client.next_review_on = add_months(assessed_on, review_months(client.org, rating))
        fields.append("next_review_on")
    client.save(update_fields=fields)
    if edd_triggers is not None:
        services.sync_edd(client, edd_triggers)
    services.maybe_activate(client)


def set_review_dates(
    org_id: uuid.UUID,
    client_id: uuid.UUID,
    *,
    last_reviewed_on: date | None = None,
    next_review_on: date | None = None,
) -> None:
    """Move the client's review dates (monitoring.schedule_review and completed reviews)."""
    updates: dict[str, Any] = {}
    if last_reviewed_on is not None:
        updates["last_reviewed_on"] = last_reviewed_on
    if next_review_on is not None:
        updates["next_review_on"] = next_review_on
    if not Client.objects.filter(org_id=org_id, id=client_id).exists():
        raise NotFound("client")
    if updates:
        Client.objects.filter(org_id=org_id, id=client_id).update(**updates)


def block_client(org_id: uuid.UUID, client_id: uuid.UUID, reason_code: str, actor: Actor) -> None:
    """Stop onboarding / further work (e.g. confirmed sanctions match). Neutral wording to fee earners."""
    client = Client.objects.filter(org_id=org_id, id=client_id).first()
    if client is None:
        raise NotFound("client")
    if client.status == "blocked":
        return
    client.status = "blocked"
    client.blocked_reason = reason_code[:40]
    client.save(update_fields=["status", "blocked_reason", "updated_at"])
    audit.record(
        actor, "client.blocked", resource_type="client", resource_id=client.id, metadata={"reason": reason_code}
    )
