"""Clients system-of-record services: structure membership, party records, merges, holds, onboarding and EDD.

Owner: builder A. Views and the seed use these; the domain core uses the narrower clients.api.
"""

from __future__ import annotations

import contextlib
import re
import unicodedata
import uuid
from collections import defaultdict
from collections.abc import Iterator
from datetime import date
from typing import Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from clients.models import Client, ClientHold, ClientParty, EddCase, EddMeasure, Party, Relationship

HOLD_MESSAGE = "This step needs the compliance officer's go-ahead."
OFFSHORE = frozenset(
    {"VG", "KY", "SC", "BS", "BM", "PA", "JE", "GG", "IM", "BZ", "MH", "WS", "VU", "LI", "MU", "AE", "CK"}
)
UBO_ROLES = frozenset({"trustee", "appointor", "protector", "significant_control", "nominee_for"})
MEASURE_LABELS = {
    "source_of_wealth": "Source of wealth established",
    "source_of_funds": "Source of funds for this matter established",
    "senior_approval": "Senior manager approval obtained",
    "ubo_verification": "Beneficial owners verified from reliable sources",
    "purpose_of_relationship": "Purpose and intended nature of the relationship recorded",
    "adverse_media_check": "Adverse media check completed",
    "enhanced_monitoring": "Enhanced ongoing monitoring set up",
}
SENIOR_TRIGGERS = frozenset({"pep", "high_rating", "high_risk_jurisdiction", "sanctions_near_match"})

_LEGAL_SUFFIXES = re.compile(
    r"\b(pty|ltd|limited|llc|inc|plc|fze|fzco|llp|lp|co|company|corp|corporation|holdings?|group|the)\b\.?"
)

_suspended = {"structure": False}


# ── Names and records ─────────────────────────────────────────────────────────────────────────────
def normalize_name(name: str) -> str:
    text = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    text = re.sub(r"[^a-z0-9 ]+", " ", text.replace("&", " and "))
    text = _LEGAL_SUFFIXES.sub(" ", text)
    return " ".join(text.split())


def format_address(address: dict[str, Any] | None) -> str | None:
    if not address:
        return None
    parts = [
        address.get("line1"),
        address.get("locality"),
        " ".join(p for p in (address.get("state") or address.get("region"), address.get("postcode")) if p),
        address.get("country"),
    ]
    text = ", ".join(p for p in parts if p)
    return text or None


def split_person_name(name: str) -> tuple[str, str]:
    bits = name.replace("Hon. ", "").split()
    if len(bits) < 2:
        return name, ""
    return " ".join(bits[:-1]), bits[-1]


# ── Structure membership (ClientParty) ────────────────────────────────────────────────────────────
@contextlib.contextmanager
def structure_sync_suspended() -> Iterator[None]:
    """Bulk loaders insert many relationships, then call rebuild_structure(org) once."""
    previous = _suspended["structure"]
    _suspended["structure"] = True
    try:
        yield
    finally:
        _suspended["structure"] = previous


def structure_sync_enabled() -> bool:
    return not _suspended["structure"]


def _upstream(org_id: uuid.UUID, root: uuid.UUID, incoming: dict[uuid.UUID, list[uuid.UUID]]) -> dict[uuid.UUID, int]:
    levels = {root: 0}
    frontier = [root]
    depth = 0
    while frontier and depth < 12:
        depth += 1
        nxt: list[uuid.UUID] = []
        for pid in frontier:
            for src in incoming.get(pid, []):
                if src not in levels:
                    levels[src] = depth
                    nxt.append(src)
        frontier = nxt
    return levels


def _incoming_map(org_id: uuid.UUID) -> dict[uuid.UUID, list[uuid.UUID]]:
    incoming: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for src, dst in Relationship.objects.filter(org_id=org_id).values_list("from_party_id", "to_party_id"):
        incoming[dst].append(src)
    return incoming


def rebuild_structure(org_id: uuid.UUID, client_ids: list[uuid.UUID] | None = None) -> int:
    """Recompute ClientParty rows (all validity periods, so history and diffs stay in scope)."""
    incoming = _incoming_map(org_id)
    clients = Client.objects.filter(org_id=org_id)
    if client_ids is not None:
        clients = clients.filter(id__in=client_ids)
    written = 0
    with transaction.atomic():
        for client in clients.only("id", "party_id"):
            levels = _upstream(org_id, client.party_id, incoming)
            ClientParty.objects.filter(client_id=client.id).delete()
            ClientParty.objects.bulk_create(
                [
                    ClientParty(org_id=org_id, client_id=client.id, party_id=pid, level=lvl)
                    for pid, lvl in levels.items()
                ]
            )
            written += len(levels)
    return written


def clients_touching(org_id: uuid.UUID, party_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    linked = set(ClientParty.objects.filter(org_id=org_id, party_id__in=party_ids).values_list("client_id", flat=True))
    linked |= set(Client.objects.filter(org_id=org_id, party_id__in=party_ids).values_list("id", flat=True))
    return list(linked)


def structure_party_ids(org_id: uuid.UUID, client_id: uuid.UUID) -> list[uuid.UUID]:
    client = Client.objects.only("party_id").get(org_id=org_id, id=client_id)
    ids = list(ClientParty.objects.filter(org_id=org_id, client_id=client_id).values_list("party_id", flat=True))
    if client.party_id not in ids:
        ids.insert(0, client.party_id)
    return ids


def structure_summary(client: Client) -> dict[str, int]:
    links = list(ClientParty.objects.filter(client_id=client.id).values_list("level", flat=True))
    return {"parties": max(len(links), 1), "layers": max(links, default=0), "ubos": client.ubo_count or 0}


def has_cycle(org_id: uuid.UUID, party_ids: set[uuid.UUID]) -> bool:
    edges: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for src, dst in Relationship.objects.filter(
        org_id=org_id, kind="ownership", from_party_id__in=party_ids, to_party_id__in=party_ids, valid_to__isnull=True
    ).values_list("from_party_id", "to_party_id"):
        edges[src].append(dst)
    state: dict[uuid.UUID, int] = {}

    def visit(node: uuid.UUID) -> bool:
        state[node] = 1
        for nxt in edges.get(node, []):
            if state.get(nxt) == 1 or (nxt not in state and visit(nxt)):
                return True
        state[node] = 2
        return False

    return any(node not in state and visit(node) for node in list(edges))


def structure_flags(client: Client) -> list[str]:
    ids = set(ClientParty.objects.filter(client_id=client.id).values_list("party_id", flat=True)) | {client.party_id}
    parties = Party.objects.filter(id__in=ids)
    flags: list[str] = []
    if parties.filter(jurisdiction__in=OFFSHORE).exists():
        flags.append("offshore")
    if has_cycle(client.org_id, ids):
        flags.append("circular")
    if (
        parties.filter(is_nominee=True).exists()
        or Relationship.objects.filter(
            org_id=client.org_id, to_party_id__in=ids, nominee=True, valid_to__isnull=True
        ).exists()
    ):
        flags.append("nominee")
    if client.next_review_on and client.next_review_on < timezone.localdate() and client.status == "active":
        flags.append("review_overdue")
    return flags


# ── Holds (tipping-off safe: one neutral wording for every reason) ────────────────────────────────
def active_hold(client: Client) -> ClientHold | None:
    return ClientHold.objects.filter(client_id=client.id, released_at__isnull=True).first()


def place_hold(client: Client, reason_code: str, *, by: Any = None, note: str = "", source_ref: str = "") -> ClientHold:
    return ClientHold.objects.create(
        org_id=client.org_id, client=client, reason_code=reason_code, placed_by=by, note=note, source_ref=source_ref
    )


def release_holds(client: Client, *, by: Any = None, note: str = "", source_ref: str | None = None) -> int:
    qs = ClientHold.objects.filter(client_id=client.id, released_at__isnull=True)
    if source_ref is not None:
        qs = qs.filter(source_ref=source_ref)
    return qs.update(released_at=timezone.now(), released_by=by, release_note=note)


# ── EDD workflow ──────────────────────────────────────────────────────────────────────────────────
def _trigger_dict(trigger: Any) -> dict[str, Any]:
    if isinstance(trigger, dict):
        return {
            "code": trigger.get("code"),
            "message": trigger.get("message", ""),
            "measures": list(trigger.get("measures", [])),
        }
    return {"code": trigger.code, "message": trigger.message, "measures": list(trigger.measures)}


def ensure_edd(client: Client) -> EddCase:
    edd, _ = EddCase.objects.get_or_create(client=client, defaults={"org_id": client.org_id})
    return edd


def sync_edd(client: Client, triggers: list[Any]) -> EddCase:
    """Align the EDD case with the current triggers (from the latest assessment and screening)."""
    edd = ensure_edd(client)
    trig = [_trigger_dict(t) for t in triggers]
    keys: list[str] = []
    for t in trig:
        for key in t["measures"]:
            if key not in keys:
                keys.append(key)
    if any(t["code"] in SENIOR_TRIGGERS for t in trig) and "senior_approval" not in keys:
        keys.append("senior_approval")
    existing = set(edd.measures.values_list("key", flat=True))
    new_keys = [k for k in keys if k not in existing]
    for key in new_keys:
        EddMeasure.objects.create(org_id=client.org_id, edd=edd, key=key)
    edd.triggers = trig
    edd.required = bool(trig)
    if not edd.required:
        if edd.status in {"in_progress", "not_required"}:
            edd.status = "not_required"
    elif edd.status == "not_required" or (new_keys and edd.status in {"approved", "rejected"}):
        edd.signoffs.update(superseded=True)
        edd.status = "in_progress"
    edd.save()
    if client.edd_required != edd.required:
        Client.objects.filter(id=client.id).update(edd_required=edd.required)
        client.edd_required = edd.required
    return edd


def needs_senior(edd: EddCase) -> bool:
    return (
        any(t.get("code") in SENIOR_TRIGGERS for t in edd.triggers or [])
        or edd.measures.filter(key="senior_approval").exists()
    )


def measures_complete(edd: EddCase) -> bool:
    return not edd.measures.exclude(key="senior_approval").filter(status="todo").exists()


def refresh_edd_status(edd: EddCase) -> EddCase:
    if not edd.required or edd.status in {"approved", "rejected", "awaiting_senior"}:
        return edd
    complete = measures_complete(edd)
    if complete and edd.status == "in_progress":
        edd.status = "awaiting_compliance"
        edd.save(update_fields=["status", "updated_at"])
    elif not complete and edd.status == "awaiting_compliance":
        edd.status = "in_progress"
        edd.save(update_fields=["status", "updated_at"])
    return edd


# ── Onboarding → active ───────────────────────────────────────────────────────────────────────────
def maybe_activate(client: Client, checklist: dict[str, Any] | None = None) -> bool:
    """Move an onboarding client to active once every required checklist item is done."""
    if client.status != "onboarding" or client.submitted_at is None:
        return False
    from clients.onboarding import build_checklist

    data = checklist or build_checklist(client)
    if all(item["done"] for item in data["items"] if item["required"]):
        today = timezone.localdate()
        Client.objects.filter(id=client.id).update(status="active", onboarded_on=today)
        client.status = "active"
        client.onboarded_on = today
        return True
    return False


def active_parties(org_id: uuid.UUID, party_ids: list[uuid.UUID] | None = None) -> Any:
    qs = Party.objects.filter(org_id=org_id)
    if party_ids is not None:
        qs = qs.filter(id__in=party_ids)
    return qs


def today() -> date:
    return timezone.localdate()


def q_name(q: str) -> Q:
    return (
        Q(name__icontains=q) | Q(party__normalized_name__icontains=normalize_name(q)) | Q(matter_reference__icontains=q)
    )
