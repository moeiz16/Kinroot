"""The onboarding checklist (contract §1.6 `Onboarding`).

Before submit: identity and consent for each natural person who must be identified, the structure confirmed and
beneficial owners identified. After submit: screening clear, risk assessed, EDD complete and sign-off (when
required). The client becomes active when every required item is done.
"""

from __future__ import annotations

from typing import Any

import structlog

from clients import services
from clients.models import Client, ClientParty, Consent, Party, Relationship, VerificationCheck

log = structlog.get_logger(__name__)

PRE_SUBMIT = ("identity_", "consent_", "structure_confirmed", "ubos_identified")


def _ubo_people(client: Client) -> tuple[list[Party], bool]:
    """Natural persons to identify, and whether beneficial owners are identified.

    Uses the UBO engine when available; otherwise falls back to people with direct ownership >= the
    threshold or a UBO-making control role anywhere in the structure."""
    if client.kind == "individual":
        return [client.party], True
    try:
        from graph import api as graph_api

        result = graph_api.beneficial_owners(client.org_id, client.id)
        ubo_ids = [o.party_id for o in result.owners if o.is_ubo and o.kind == "person"]
        found = list(Party.objects.filter(org_id=client.org_id, id__in=ubo_ids))
        if client.ubo_count != len(ubo_ids):
            Client.objects.filter(id=client.id).update(ubo_count=len(ubo_ids))
            client.ubo_count = len(ubo_ids)
        return found, bool(ubo_ids)
    except Exception as exc:  # the graph may be rebuilding (or not built yet): use the relational structure
        log.debug("ubo_fallback", client_id=str(client.id), error=type(exc).__name__)
    ids = set(ClientParty.objects.filter(client_id=client.id).values_list("party_id", flat=True))
    rels = Relationship.objects.filter(
        org_id=client.org_id, to_party_id__in=ids | {client.party_id}, valid_to__isnull=True, from_party__kind="person"
    ).select_related("from_party")
    people: dict[Any, Party] = {}
    for rel in rels:
        if (rel.kind == "ownership" and (rel.pct or 0) >= 25) or (
            rel.kind == "control" and rel.role in services.UBO_ROLES | {"senior_managing_official"}
        ):
            people[rel.from_party_id] = rel.from_party
    return list(people.values()), bool(people)


def _screening_state(client: Client) -> tuple[bool, bool]:
    """(ran, clear): screening ran for this client and nothing is pending or confirmed on a sanctions list."""
    try:
        from screening import api as screening_api

        pending = screening_api.list_hits(client.org_id, status="pending", client_id=client.id, limit=1).total
        confirmed = screening_api.list_hits(
            client.org_id, status="true_match", client_id=client.id, list_kind="sanctions", limit=1
        ).total
        return True, pending == 0 and confirmed == 0
    except NotImplementedError:
        return client.submitted_at is not None, client.submitted_at is not None
    except Exception as exc:  # screening unavailable: the item stays open rather than passing silently
        log.warning("screening_state_unavailable", client_id=str(client.id), error=type(exc).__name__)
        return False, False


def _risk_assessed(client: Client) -> bool:
    return client.rating is not None


def build_checklist(client: Client) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    people, ubos_ok = _ubo_people(client)
    base = f"/board/clients/{client.id}"
    verified = set(
        VerificationCheck.objects.filter(
            org_id=client.org_id, party_id__in=[p.id for p in people], result="verified"
        ).values_list("party_id", flat=True)
    )
    consented = set(
        Consent.objects.filter(org_id=client.org_id, party_id__in=[p.id for p in people]).values_list(
            "party_id", flat=True
        )
    )
    for person in people:
        items.append(
            {
                "key": f"identity_{person.id}",
                "label": f"Verify identity: {person.name}",
                "done": person.id in verified,
                "required": True,
                "party_id": str(person.id),
                "href": f"{base}/identity?party={person.id}",
            }
        )
        items.append(
            {
                "key": f"consent_{person.id}",
                "label": f"Record consent to identity checks: {person.name}",
                "done": person.id in consented,
                "required": True,
                "party_id": str(person.id),
                "href": f"{base}/identity?party={person.id}",
            }
        )
    is_entity = client.kind != "individual"
    has_structure = (
        not is_entity or Relationship.objects.filter(org_id=client.org_id, to_party_id=client.party_id).exists()
    )
    items.append(
        {
            "key": "structure_confirmed",
            "label": "Ownership and control structure recorded",
            "done": has_structure,
            "required": is_entity,
            "href": f"{base}/structure",
        }
    )
    items.append(
        {
            "key": "ubos_identified",
            "label": "Beneficial owners identified",
            "done": ubos_ok,
            "required": True,
            "href": f"{base}/structure",
        }
    )
    submitted = client.submitted_at is not None or client.status != "onboarding"
    ran, clear = _screening_state(client) if submitted else (False, False)
    items.append(
        {
            "key": "screening_clear",
            "label": "Sanctions and PEP screening reviewed",
            "done": submitted and ran and clear,
            "required": True,
            "href": f"{base}/screening",
        }
    )
    items.append(
        {
            "key": "risk_assessed",
            "label": "Risk assessed under the firm's methodology",
            "done": submitted and _risk_assessed(client),
            "required": True,
            "href": f"{base}/risk",
        }
    )
    edd = getattr(client, "edd", None) if hasattr(client, "edd") else None
    if client.edd_required or (edd is not None and edd.required):
        status = edd.status if edd is not None else "in_progress"
        items.append(
            {
                "key": "edd_complete",
                "label": "Enhanced due diligence measures complete",
                "done": status in {"awaiting_compliance", "awaiting_senior", "approved"},
                "required": True,
                "href": f"{base}/edd",
            }
        )
        items.append(
            {
                "key": "signoff",
                "label": "Compliance and senior sign-off",
                "done": status == "approved",
                "required": True,
                "href": f"{base}/edd",
            }
        )
    pre = [i for i in items if i["required"] and i["key"].startswith(PRE_SUBMIT)]
    return {
        "client_id": str(client.id),
        "status": client.status,
        "items": items,
        "can_submit": client.status == "onboarding" and client.submitted_at is None and all(i["done"] for i in pre),
    }


def missing_for_submit(checklist: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"field": i["key"], "message": i["label"]}
        for i in checklist["items"]
        if i["required"] and not i["done"] and i["key"].startswith(PRE_SUBMIT)
    ]
