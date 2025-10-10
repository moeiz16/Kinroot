"""Clients and onboarding (contract §1.6): the system of record, CDD evidence, submit, holds and exit."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import date, timedelta
from typing import Any, cast

import structlog
from django.conf import settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.db.models import Q
from django.http import FileResponse
from django.utils import timezone
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.models import Membership
from accounts.services import settings_for
from api.base import ApiView, page_params, paged, parse_uuid
from api.views.org import job_wire
from api.wire import (
    client_wire,
    consent_wire,
    document_wire,
    identifiers_in,
    party_wire,
    relationship_wire,
    verification_wire,
)
from clients import onboarding, registry, services
from clients.models import (
    Client,
    ClientHold,
    ClientParty,
    Communication,
    Consent,
    Document,
    Party,
    Relationship,
    VerificationCheck,
)
from jobs import api as jobs_api
from jobs.models import Job
from kinroot.contracts import to_wire
from kinroot.core.dates import add_years
from kinroot.core.errors import AppError, conflict, not_found, validation_error

log = structlog.get_logger(__name__)

SERVICES = [
    "conveyancing",
    "company_formation",
    "trust_formation",
    "property_transaction",
    "managing_client_funds",
    "tax_advice",
    "audit",
    "real_estate_sale",
    "other",
]
CHANNELS = ["face_to_face", "remote", "intermediary"]
PARTY_KINDS = ["person", "company", "trust", "partnership", "other"]
CONTROL_ROLES = [
    "director",
    "secretary",
    "trustee",
    "appointor",
    "protector",
    "settlor",
    "beneficiary",
    "partner",
    "nominee_for",
    "significant_control",
    "senior_managing_official",
]
INTERESTS = ["shares", "units", "partnership", "trust_entitlement", "voting_rights"]
ID_DOC_TYPES = {"passport", "drivers_licence", "birth_certificate"}
ENTITY_DOC_TYPES = {"company_extract", "trust_deed"}
MAGIC = {"pdf": (b"%PDF",), "png": (b"\x89PNG\r\n\x1a\n",), "jpg": (b"\xff\xd8\xff",)}
CONTENT_TYPES = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg"}


def held() -> AppError:
    return AppError(409, "action_held", "Conflict", services.HOLD_MESSAGE)


def blocked() -> AppError:
    return AppError(
        423, "client_blocked", "Locked", "Work on this client is paused. Please contact your compliance officer."
    )


def screening_flags(org_id: uuid.UUID, client_ids: list[uuid.UUID] | None = None) -> dict[str, set[str]]:
    """pep (confirmed PEP hit) and sanctions_review (pending sanctions hit) per client, from screening."""
    out: dict[str, set[str]] = {}
    try:
        from screening import api as screening_api

        for status, list_kind, flag in (("true_match", "pep", "pep"), ("pending", "sanctions", "sanctions_review")):
            page = screening_api.list_hits(org_id, status=cast(Any, status), list_kind=cast(Any, list_kind), limit=1000)
            for hit in page.items:
                out.setdefault(str(hit.client_id), set()).add(flag)
    except NotImplementedError:
        pass
    except Exception as exc:  # flags are auxiliary: a screening outage must not hide the client list
        log.warning("screening_flags_unavailable", error=type(exc).__name__)
    return out


def wire_client(c: Client, flags: dict[str, set[str]] | None = None) -> dict[str, Any]:
    f = flags if flags is not None else screening_flags(c.org_id)
    return client_wire(c, extra_flags=sorted(f.get(str(c.id), set())))


def ensure_workable(client: Client) -> None:
    if client.status == "blocked":
        raise blocked()


def enqueue_if_registered(
    kind: str,
    payload: dict[str, Any],
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID | None,
    dedupe_key: str | None = None,
    priority: int = 100,
) -> uuid.UUID | None:
    if jobs_api.registered(kind) is None:
        return None
    return jobs_api.enqueue(kind, payload, org_id=org_id, dedupe_key=dedupe_key, priority=priority, created_by=user_id)


class ClientMixin(ApiView):
    def get_client(self, client_id: str) -> Client:
        client = (
            Client.objects.select_related("assigned_to", "party")
            .filter(org=self.org, id=parse_uuid(client_id, "Client"))
            .first()
        )
        if client is None:
            raise not_found("Client")
        return client

    def get_party(self, party_id: Any, *, field: str | None = None) -> Party:
        try:
            pid = uuid.UUID(str(party_id))
        except (TypeError, ValueError):
            pid = None
        party = Party.objects.filter(org=self.org, id=pid).first() if pid else None
        if party is None:
            if field:
                raise validation_error("Unknown party.", [{"field": field, "message": "Choose a party in this firm."}])
            raise not_found("Party")
        return party


# ── Clients ───────────────────────────────────────────────────────────────────────────────────────
class AddressIn(serializers.Serializer):
    line1 = serializers.CharField(max_length=200, required=False, allow_blank=True)
    locality = serializers.CharField(max_length=100, required=False, allow_blank=True)
    state = serializers.CharField(max_length=60, required=False, allow_blank=True)
    postcode = serializers.CharField(max_length=12, required=False, allow_blank=True)
    country = serializers.RegexField(r"^[A-Z]{2}$", required=False, allow_blank=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs.get("country") == "AU" and attrs.get("postcode") and not attrs["postcode"].isdigit():
            raise serializers.ValidationError({"postcode": "Enter a 4-digit postcode."})
        if attrs.get("country") == "AU" and attrs.get("postcode") and len(attrs["postcode"]) != 4:
            raise serializers.ValidationError({"postcode": "Enter a 4-digit postcode."})
        return {k: v for k, v in attrs.items() if v}


class IdentifiersIn(serializers.Serializer):
    acn = serializers.RegexField(r"^\d{3} ?\d{3} ?\d{3}$", required=False)
    abn = serializers.RegexField(r"^\d{2} ?\d{3} ?\d{3} ?\d{3}$", required=False)
    uk_company_number = serializers.RegexField(r"^[A-Z0-9]{8}$", required=False)
    trust_deed_date = serializers.DateField(required=False)


class PersonIn(serializers.Serializer):
    given_names = serializers.CharField(max_length=200)
    family_name = serializers.CharField(max_length=200)
    birth_date = serializers.DateField()
    nationality = serializers.RegexField(r"^[A-Z]{2}$", required=False)
    address = AddressIn(required=False)


class ClientCreateIn(serializers.Serializer):
    kind = serializers.ChoiceField(choices=["individual", "company", "trust", "partnership"])
    name = serializers.CharField(max_length=300, required=False)
    jurisdiction = serializers.RegexField(r"^[A-Z]{2}$")
    services = serializers.ListField(child=serializers.ChoiceField(choices=SERVICES), min_length=1, max_length=9)
    channel = serializers.ChoiceField(choices=CHANNELS)
    matter_reference = serializers.CharField(max_length=80, required=False, allow_blank=True)
    assigned_to_id = serializers.UUIDField(required=False, allow_null=True)
    identifiers = IdentifiersIn(required=False)
    person = PersonIn(required=False)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["kind"] == "individual" and not attrs.get("person"):
            raise serializers.ValidationError({"person": "Enter the client's name and date of birth."})
        if attrs["kind"] != "individual" and not attrs.get("name"):
            raise serializers.ValidationError({"name": "Enter the client's name."})
        if attrs.get("person") and attrs["person"]["birth_date"] > timezone.localdate():
            raise serializers.ValidationError({"person": {"birth_date": "Date of birth is in the future."}})
        return attrs


class ClientPatchIn(serializers.Serializer):
    name = serializers.CharField(max_length=300, required=False)
    services = serializers.ListField(child=serializers.ChoiceField(choices=SERVICES), min_length=1, required=False)
    channel = serializers.ChoiceField(choices=CHANNELS, required=False)
    assigned_to_id = serializers.UUIDField(required=False, allow_null=True)
    matter_reference = serializers.CharField(max_length=80, required=False, allow_blank=True)


def _member_or_422(org: Any, user_id: Any) -> None:
    if user_id and not Membership.objects.filter(org=org, user_id=user_id).exists():
        raise validation_error("Choose a member of this firm.", [{"field": "assignedToId", "message": "Not a member."}])


class ClientsView(ClientMixin):
    permission = "clients:read"

    def get(self, request: Request) -> Response:
        qs = Client.objects.select_related("assigned_to").filter(org=self.org)
        p = request.query_params
        if q := p.get("q", "").strip():
            qs = qs.filter(services.q_name(q))
        if kind := p.get("kind"):
            qs = qs.filter(kind=kind)
        if rating := p.get("rating"):
            qs = qs.filter(rating=rating)
        if status := p.get("status"):
            qs = qs.filter(status=status)
        if p.get("reviewDue") == "true":
            qs = qs.filter(next_review_on__isnull=False, next_review_on__lte=timezone.localdate() + timedelta(days=30))
        if p.get("assignedTo") == "me":
            qs = qs.filter(assigned_to=self.user)
        page, size = page_params(request)
        total = qs.count()
        flags = screening_flags(self.org_id)
        items = [wire_client(c, flags) for c in qs.order_by("name")[(page - 1) * size : page * size]]
        return Response(paged(items, total, page, size))

    def post(self, request: Request) -> Response:
        self.require("clients:onboard")
        data = ClientCreateIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        _member_or_422(self.org, v.get("assigned_to_id"))
        ids = identifiers_in(v.get("identifiers"))
        with transaction.atomic():
            if v["kind"] == "individual":
                person = v["person"]
                name = v.get("name") or f"{person['given_names']} {person['family_name']}"
                party = Party.objects.create(
                    org=self.org,
                    kind="person",
                    name=name,
                    normalized_name=services.normalize_name(name),
                    given_names=person["given_names"],
                    family_name=person["family_name"],
                    birth_date=person["birth_date"],
                    nationality=person.get("nationality", ""),
                    jurisdiction=v["jurisdiction"],
                    address=dict(person.get("address") or {}),
                )
            else:
                name = v["name"]
                party = Party.objects.create(
                    org=self.org,
                    kind=v["kind"],
                    name=name,
                    normalized_name=services.normalize_name(name),
                    jurisdiction=v["jurisdiction"],
                    identifiers=ids,
                )
            client = Client.objects.create(
                org=self.org,
                kind=v["kind"],
                name=name,
                party=party,
                jurisdiction=v["jurisdiction"],
                services=v["services"],
                channel=v["channel"],
                matter_reference=v.get("matter_reference", ""),
                assigned_to_id=v.get("assigned_to_id") or self.user.id,
            )
            self.audit("client.created", resource_type="client", resource_id=client.id, metadata={"kind": client.kind})
            enqueue_if_registered(
                "resolution.find_candidates", {"partyIds": [str(party.id)]}, org_id=self.org_id, user_id=self.user.id
            )
        client = self.get_client(str(client.id))
        return Response(wire_client(client, {}), status=201)


class ClientView(ClientMixin):
    permission = "clients:read"

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        if client.kind != "individual":
            try:
                from graph import api as graph_api

                ubo = graph_api.beneficial_owners(self.org_id, client.id)
                count = sum(1 for o in ubo.owners if o.is_ubo)
                if count != client.ubo_count:
                    Client.objects.filter(id=client.id).update(ubo_count=count)
                    client.ubo_count = count
            except Exception:  # noqa: S110 - the cached count stays when the graph is unavailable
                pass
        elif client.ubo_count != 1:
            Client.objects.filter(id=client.id).update(ubo_count=1)
            client.ubo_count = 1
        return Response(wire_client(client))

    def patch(self, request: Request, client_id: str) -> Response:
        self.require("clients:write")
        client = self.get_client(client_id)
        ensure_workable(client)
        data = ClientPatchIn(data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        if "assigned_to_id" in v:
            _member_or_422(self.org, v["assigned_to_id"])
        for key, value in v.items():
            setattr(client, key, value if value is not None or key == "assigned_to_id" else getattr(client, key))
        client.save()
        if "name" in v and client.party.name != v["name"]:
            client.party.name = v["name"]
            client.party.normalized_name = services.normalize_name(v["name"])
            client.party.save()
        self.audit("client.updated", resource_type="client", resource_id=client.id, metadata={"fields": sorted(v)})
        return Response(wire_client(self.get_client(client_id)))


# ── Parties and relationships ─────────────────────────────────────────────────────────────────────
class PartyIn(serializers.Serializer):
    kind = serializers.ChoiceField(choices=PARTY_KINDS)
    name = serializers.CharField(max_length=300)
    birth_date = serializers.DateField(required=False, allow_null=True)
    nationality = serializers.RegexField(r"^[A-Z]{2}$", required=False, allow_blank=True)
    jurisdiction = serializers.RegexField(r"^[A-Z]{2}$", required=False, allow_blank=True)
    identifiers = IdentifiersIn(required=False)
    address = AddressIn(required=False)
    is_nominee = serializers.BooleanField(required=False)


def _apply_party(party: Party, v: dict[str, Any]) -> None:
    for key in ("kind", "name", "birth_date", "nationality", "jurisdiction", "is_nominee"):
        if key in v:
            setattr(party, key, v[key] if v[key] is not None or key == "birth_date" else "")
    if "identifiers" in v:
        party.identifiers = identifiers_in(v["identifiers"])
    if "address" in v:
        party.address = dict(v["address"] or {})
    party.normalized_name = services.normalize_name(party.name)
    if party.kind == "person":
        party.given_names, party.family_name = services.split_person_name(party.name)


class ClientPartiesView(ClientMixin):
    permission = "clients:read"

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        ids = services.structure_party_ids(self.org_id, client.id)
        parties = {p.id: p for p in Party.objects.filter(org=self.org, id__in=ids)}
        return Response([party_wire(parties[i]) for i in ids if i in parties])

    def post(self, request: Request, client_id: str) -> Response:
        self.require("graph:write")
        client = self.get_client(client_id)
        ensure_workable(client)
        data = PartyIn(data=request.data)
        data.is_valid(raise_exception=True)
        party = Party(org=self.org, source="manual")
        _apply_party(party, data.validated_data)
        with transaction.atomic():
            party.save()
            ClientParty.objects.get_or_create(org=self.org, client=client, party=party, defaults={"level": 1})
            self.audit(
                "party.created",
                resource_type="party",
                resource_id=party.id,
                metadata={"clientId": str(client.id), "kind": party.kind},
            )
            enqueue_if_registered(
                "resolution.find_candidates", {"partyIds": [str(party.id)]}, org_id=self.org_id, user_id=self.user.id
            )
        return Response(party_wire(party), status=201)


class PartyView(ClientMixin):
    permission = "clients:read"

    def get(self, request: Request, party_id: str) -> Response:
        party = self.get_party(party_id)
        from clients import api as clients_api

        records = clients_api.party_records(
            self.org_id,
            party_ids=list(Party.objects.filter(org=self.org, merged_into=party).values_list("id", flat=True)),
            active_only=False,
        )
        client_ids = set(ClientParty.objects.filter(org=self.org, party=party).values_list("client_id", flat=True))
        clients = Client.objects.filter(Q(id__in=client_ids) | Q(party=party), org=self.org).order_by("name")
        from kinroot.contracts import to_wire

        body = party_wire(party)
        body["source_records"] = to_wire(records)
        body["clients"] = [{"id": str(c.id), "name": c.name} for c in clients]
        return Response(body)

    def patch(self, request: Request, party_id: str) -> Response:
        self.require("graph:write")
        party = self.get_party(party_id)
        if party.merged_into_id:
            raise conflict("conflict", "This record was merged into another party. Edit that party instead.")
        data = PartyIn(data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        _apply_party(party, data.validated_data)
        party.save()
        self.audit(
            "party.updated",
            resource_type="party",
            resource_id=party.id,
            metadata={"fields": sorted(data.validated_data)},
        )
        return Response(party_wire(party))


class RelationshipIn(serializers.Serializer):
    from_party_id = serializers.UUIDField()
    to_party_id = serializers.UUIDField()
    kind = serializers.ChoiceField(choices=["ownership", "control"])
    pct = serializers.FloatField(required=False, allow_null=True)
    interest = serializers.ChoiceField(choices=INTERESTS, required=False, allow_null=True)
    role = serializers.ChoiceField(choices=CONTROL_ROLES, required=False, allow_null=True)
    nominee = serializers.BooleanField(required=False, default=False)
    valid_from = serializers.DateField()
    valid_to = serializers.DateField(required=False, allow_null=True)
    evidence_note = serializers.CharField(max_length=500, required=False, allow_blank=True)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["from_party_id"] == attrs["to_party_id"]:
            raise serializers.ValidationError({"to_party_id": "A party cannot own or control itself."})
        if attrs["kind"] == "ownership":
            pct = attrs.get("pct")
            if pct is None or not (0 < pct <= 100):
                raise serializers.ValidationError({"pct": "Enter a percentage above 0 and up to 100."})
            attrs["role"] = None
        else:
            if not attrs.get("role"):
                raise serializers.ValidationError({"role": "Choose the control role."})
            attrs["pct"] = None
        if attrs.get("valid_to") and attrs["valid_to"] < attrs["valid_from"]:
            raise serializers.ValidationError({"valid_to": "The end date is before the start date."})
        return attrs


class RelationshipPatchIn(serializers.Serializer):
    pct = serializers.FloatField(required=False, allow_null=True)
    role = serializers.ChoiceField(choices=CONTROL_ROLES, required=False, allow_null=True)
    valid_from = serializers.DateField(required=False)
    valid_to = serializers.DateField(required=False, allow_null=True)
    evidence_note = serializers.CharField(max_length=500, required=False, allow_blank=True)


def check_allocation(
    org: Any, to_party_id: Any, pct: float, start: date, end: date | None, exclude_id: Any = None
) -> None:
    """Ownership into one entity may not exceed 100% at any point of overlapping validity."""
    far = date.max
    existing = Relationship.objects.filter(org=org, to_party_id=to_party_id, kind="ownership").exclude(id=exclude_id)
    spans = [(r.valid_from, r.valid_to or far, r.pct or 0.0) for r in existing]
    end_ = end or far
    points = {start} | {s for s, _, _ in spans if start <= s <= end_}
    for point in points:
        total = pct + sum(p for s, e, p in spans if s <= point <= e)
        if total > 100.0001:
            raise AppError(
                422,
                "over_allocated",
                "Validation failed",
                f"Ownership of this entity would total {total:g}% on {point.isoformat()}.",
                errors=[{"field": "pct", "message": "Total ownership cannot exceed 100%."}],
            )


class RelationshipsView(ClientMixin):
    permission = "graph:write"

    def post(self, request: Request) -> Response:
        data = RelationshipIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        src = self.get_party(v["from_party_id"], field="fromPartyId")
        dst = self.get_party(v["to_party_id"], field="toPartyId")
        if v["kind"] == "ownership":
            check_allocation(self.org, dst.id, v["pct"], v["valid_from"], v.get("valid_to"))
        with transaction.atomic():
            rel = Relationship.objects.create(
                org=self.org,
                from_party=src,
                to_party=dst,
                kind=v["kind"],
                pct=v.get("pct"),
                interest=v.get("interest") or ("shares" if v["kind"] == "ownership" else ""),
                role=v.get("role") or "",
                nominee=v.get("nominee", False),
                valid_from=v["valid_from"],
                valid_to=v.get("valid_to"),
                source="manual",
                source_ref="manual",
                evidence_note=v.get("evidence_note", ""),
            )
            self.audit(
                "relationship.created",
                resource_type="relationship",
                resource_id=rel.id,
                metadata={"kind": rel.kind, "fromPartyId": str(src.id), "toPartyId": str(dst.id)},
            )
        return Response(relationship_wire(rel), status=201)


class RelationshipView(ClientMixin):
    permission = "graph:write"

    def _rel(self, rel_id: str) -> Relationship:
        rel = Relationship.objects.filter(org=self.org, id=parse_uuid(rel_id, "Relationship")).first()
        if rel is None:
            raise not_found("Relationship")
        return rel

    def patch(self, request: Request, rel_id: str) -> Response:
        rel = self._rel(rel_id)
        data = RelationshipPatchIn(data=request.data, partial=True)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        if "pct" in v and rel.kind == "ownership" and (v["pct"] is None or not (0 < v["pct"] <= 100)):
            raise validation_error(
                "Enter a percentage above 0 and up to 100.", [{"field": "pct", "message": "Out of range."}]
            )
        if "role" in v and rel.kind == "control" and not v["role"]:
            raise validation_error("Choose the control role.", [{"field": "role", "message": "Required."}])
        for key, value in v.items():
            if key == "pct" and rel.kind != "ownership":
                continue
            if key == "role" and rel.kind != "control":
                continue
            setattr(rel, key, value if value is not None or key in {"valid_to", "pct"} else "")
        if rel.valid_to and rel.valid_to < rel.valid_from:
            raise validation_error(
                "The end date is before the start date.", [{"field": "validTo", "message": "Before start."}]
            )
        if rel.kind == "ownership":
            check_allocation(self.org, rel.to_party_id, rel.pct or 0, rel.valid_from, rel.valid_to, exclude_id=rel.id)
        rel.save()
        self.audit(
            "relationship.ended" if v.get("valid_to") else "relationship.updated",
            resource_type="relationship",
            resource_id=rel.id,
            metadata={"fields": sorted(v)},
        )
        return Response(relationship_wire(rel))

    def delete(self, request: Request, rel_id: str) -> Response:
        rel = self._rel(rel_id)
        reason = str((request.data or {}).get("reason", "")).strip() if isinstance(request.data, dict) else ""
        if len(reason) < 5:
            raise validation_error(
                "Deleting is only for data-entry mistakes; give a reason, or end the relationship instead.",
                [{"field": "reason", "message": "Enter a reason (at least 5 characters)."}],
            )
        self.audit(
            "relationship.deleted",
            resource_type="relationship",
            resource_id=rel.id,
            metadata={"reason": reason[:300], "kind": rel.kind},
        )
        rel.delete()
        return Response(status=204)


# ── Registry ──────────────────────────────────────────────────────────────────────────────────────
class RegistrySearchView(ClientMixin):
    permission = "clients:onboard"

    def get(self, request: Request) -> Response:
        source = request.query_params.get("source", "au_abr")
        q = request.query_params.get("q", "").strip()
        if source not in {"uk_ch", "au_abr"}:
            raise validation_error("Choose a registry.", [{"field": "source", "message": "uk_ch or au_abr."}])
        if len(q) < 2:
            return Response([])
        return Response(registry.search(source, q))


class RegistryImportIn(serializers.Serializer):
    source = serializers.ChoiceField(choices=["uk_ch", "au_abr"])  # type: ignore[assignment]
    reference = serializers.CharField(max_length=40)


class RegistryImportView(ClientMixin):
    permission = "graph:write"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        ensure_workable(client)
        data = RegistryImportIn(data=request.data)
        data.is_valid(raise_exception=True)
        try:
            result = registry.import_entry(client, data.validated_data["source"], data.validated_data["reference"])
        except LookupError as exc:
            raise not_found("Registry entry") from exc
        self.audit(
            "registry.imported",
            resource_type="client",
            resource_id=client.id,
            metadata={"source": data.validated_data["source"], "reference": data.validated_data["reference"], **result},
        )
        job_id = enqueue_if_registered(
            "resolution.find_candidates", {"clientId": str(client.id)}, org_id=self.org_id, user_id=self.user.id
        )
        return Response({**result, "job": job_wire(Job.objects.get(id=job_id)) if job_id else None}, status=201)


# ── Onboarding, documents, verification, consent ──────────────────────────────────────────────────
class OnboardingView(ClientMixin):
    permission = "clients:read"

    def get(self, request: Request, client_id: str) -> Response:
        return Response(onboarding.build_checklist(self.get_client(client_id)))


def _sniff(head: bytes) -> str | None:
    for ext, sigs in MAGIC.items():
        if any(head.startswith(sig) for sig in sigs):
            return ext
    return None


class DocumentsView(ClientMixin):
    permission = "clients:read"

    def get_throttles(self) -> list[Any]:
        self.throttle_scope = "upload" if self.request.method == "POST" else "api"
        return super().get_throttles()

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        docs = Document.objects.select_related("uploaded_by").filter(org=self.org, client=client)
        return Response([document_wire(d) for d in docs])

    def post(self, request: Request, client_id: str) -> Response:
        self.require("identity:verify")
        client = self.get_client(client_id)
        ensure_workable(client)
        upload = request.FILES.get("file")
        party_id = request.data.get("partyId") or request.data.get("party_id")
        doc_type = request.data.get("docType") or request.data.get("doc_type")
        if upload is None:
            raise validation_error("Choose a file to upload.", [{"field": "file", "message": "Required."}])
        if doc_type not in dict(Document.DOC_TYPES):
            raise validation_error(
                "Choose the document type.", [{"field": "docType", "message": "Unknown document type."}]
            )
        party = self.get_party(party_id, field="partyId")
        if party.id not in services.structure_party_ids(self.org_id, client.id):
            raise validation_error(
                "That party is not in this client's structure.", [{"field": "partyId", "message": "Not in structure."}]
            )
        max_bytes = int(settings.MAX_UPLOAD_MB) * 1024 * 1024
        if upload.size > max_bytes:
            raise AppError(
                413, "payload_too_large", "Payload too large", f"Files can be up to {settings.MAX_UPLOAD_MB} MB."
            )
        content = upload.read()
        ext = _sniff(content[:16])
        if ext is None:
            raise AppError(415, "unsupported_media_type", "Unsupported media type", "Upload a PDF, PNG or JPG file.")
        digest = hashlib.sha256(content).hexdigest()
        doc = Document(
            org=self.org,
            client=client,
            party=party,
            doc_type=doc_type,
            file_name=str(upload.name)[:200],
            content_type=CONTENT_TYPES[ext],
            sha256=digest,
            size=len(content),
            uploaded_by=self.user,
        )
        doc.file.save(f"{uuid.uuid4().hex}.{ext}", ContentFile(content), save=False)
        doc.save()
        self.audit(
            "document.uploaded",
            resource_type="document",
            resource_id=doc.id,
            metadata={"clientId": str(client.id), "docType": doc_type, "sha256": digest},
        )
        return Response(document_wire(doc), status=201)


class DocumentFileView(ClientMixin):
    permission = "clients:read"

    def get(self, request: Request, document_id: str) -> Any:
        doc = Document.objects.filter(org=self.org, id=parse_uuid(document_id, "Document")).first()
        if doc is None or not doc.file:
            raise not_found("Document")
        self.audit("document.downloaded", resource_type="document", resource_id=doc.id)
        resp = FileResponse(
            doc.file.open("rb"), as_attachment=True, filename=doc.file_name, content_type=doc.content_type
        )
        resp["Cache-Control"] = "no-store"
        return resp


class VerificationIn(serializers.Serializer):
    party_id = serializers.UUIDField()
    method = serializers.ChoiceField(choices=["document", "electronic"])
    document_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)


class VerificationView(ClientMixin):
    permission = "clients:read"

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        return Response([verification_wire(v) for v in VerificationCheck.objects.filter(org=self.org, client=client)])

    def post(self, request: Request, client_id: str) -> Response:
        self.require("identity:verify")
        client = self.get_client(client_id)
        ensure_workable(client)
        data = VerificationIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        party = self.get_party(v["party_id"], field="partyId")
        if party.id not in services.structure_party_ids(self.org_id, client.id):
            raise validation_error(
                "That party is not in this client's structure.", [{"field": "partyId", "message": "Not in structure."}]
            )
        sources: list[dict[str, Any]]
        if v["method"] == "document":
            docs = list(Document.objects.filter(org=self.org, client=client, party=party, id__in=v["document_ids"]))
            if not docs or len(docs) != len(set(v["document_ids"])):
                raise validation_error(
                    "Choose documents uploaded for this person.",
                    [{"field": "documentIds", "message": "Unknown document."}],
                )
            primary = ID_DOC_TYPES if party.kind == "person" else ENTITY_DOC_TYPES
            result = "verified" if any(d.doc_type in primary for d in docs) else "partial"
            sources = [
                {
                    "name": "Document Verification Service (demo)",
                    "matched": ["name", "birthDate", "documentNumber"] if result == "verified" else ["name"],
                }
            ]
        elif party.kind != "person":
            # an entity is checked against its register; consent is a person's, so it is not asked for here
            ids = party.identifiers or {}
            result = "verified" if any(ids.get(k) for k in ("acn", "abn", "uk_company_number")) else "partial"
            matched = ["name", "identifier"] if result == "verified" else ["name"]
            sources = [{"name": "Company register (demo)", "matched": matched}]
        else:
            if not Consent.objects.filter(org=self.org, party=party, purpose="electronic_check").exists():
                raise validation_error(
                    "Record the person's consent to an electronic check first.",
                    [{"field": "partyId", "message": "Consent missing."}],
                )
            complete = bool(party.birth_date and party.address)
            result = "verified" if complete else "partial"
            sources = [
                {"name": "Credit header (demo)", "matched": ["name", "address"] if party.address else ["name"]},
                {"name": "Electoral roll (demo)", "matched": ["name", "birthDate"] if party.birth_date else ["name"]},
            ]
        check = VerificationCheck.objects.create(
            org=self.org,
            client=client,
            party=party,
            method=v["method"],
            result=result,
            sources=sources,
            document_ids=[str(d) for d in v["document_ids"]],
            reference=f"MOCK-DVS-{secrets.token_hex(4).upper()}",
            checked_by=self.user,
            checked_at=timezone.now(),
        )
        self.audit(
            "identity.verified",
            resource_type="party",
            resource_id=party.id,
            metadata={
                "clientId": str(client.id),
                "method": check.method,
                "result": result,
                "reference": check.reference,
            },
        )
        services.maybe_activate(client)
        return Response(verification_wire(check), status=201)


class ConsentIn(serializers.Serializer):
    party_id = serializers.UUIDField()
    purpose = serializers.ChoiceField(choices=["identity_verification", "electronic_check"])
    given_on = serializers.DateField()
    method = serializers.CharField(max_length=60)


class ConsentView(ClientMixin):
    permission = "clients:read"

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        consents = Consent.objects.select_related("recorded_by").filter(org=self.org, client=client)
        return Response([consent_wire(c) for c in consents])

    def post(self, request: Request, client_id: str) -> Response:
        self.require("clients:onboard")
        client = self.get_client(client_id)
        ensure_workable(client)
        data = ConsentIn(data=request.data)
        data.is_valid(raise_exception=True)
        v = data.validated_data
        party = self.get_party(v["party_id"], field="partyId")
        if v["given_on"] > timezone.localdate():
            raise validation_error(
                "The consent date is in the future.", [{"field": "givenOn", "message": "Future date."}]
            )
        consent = Consent.objects.create(
            org=self.org,
            client=client,
            party=party,
            purpose=v["purpose"],
            given_on=v["given_on"],
            method=v["method"],
            recorded_by=self.user,
        )
        self.audit(
            "consent.recorded",
            resource_type="party",
            resource_id=party.id,
            metadata={"clientId": str(client.id), "purpose": consent.purpose},
        )
        return Response(consent_wire(consent), status=201)


# ── Submit, communications, exit, holds ───────────────────────────────────────────────────────────
class SubmitView(ClientMixin):
    permission = "clients:onboard"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        ensure_workable(client)
        if client.status != "onboarding" or client.submitted_at is not None:
            raise AppError(422, "invalid_transition", "Validation failed", "This client has already been submitted.")
        checklist = onboarding.build_checklist(client)
        missing = onboarding.missing_for_submit(checklist)
        if missing:
            raise AppError(
                422,
                "invalid_transition",
                "Validation failed",
                "Finish the onboarding checklist before submitting.",
                errors=missing,
            )
        client.submitted_at = timezone.now()
        client.save(update_fields=["submitted_at", "updated_at"])
        job_ids = [
            j
            for j in (
                enqueue_if_registered(
                    "screening.client",
                    {"clientId": str(client.id)},
                    org_id=self.org_id,
                    user_id=self.user.id,
                    dedupe_key=f"screening.client:{client.id}",
                    priority=50,
                ),
                enqueue_if_registered(
                    "risk.assess_client",
                    {"clientId": str(client.id)},
                    org_id=self.org_id,
                    user_id=self.user.id,
                    dedupe_key=f"risk.assess_client:{client.id}",
                    priority=60,
                ),
            )
            if j
        ]
        self.audit("client.submitted", resource_type="client", resource_id=client.id)
        jobs = [job_wire(j) for j in Job.objects.filter(id__in=job_ids).order_by("priority")]
        return Response({"client": wire_client(client), "jobs": jobs}, status=202)


class CommunicationIn(serializers.Serializer):
    kind = serializers.ChoiceField(choices=["information_request", "exit_notice"])
    message = serializers.CharField(max_length=5000)


class CommunicationsView(ClientMixin):
    permission = "clients:write"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        ensure_workable(client)
        data = CommunicationIn(data=request.data)
        data.is_valid(raise_exception=True)
        if client.status == "exited":
            raise conflict("conflict", "This client relationship has ended.")
        hold = services.active_hold(client)
        comm = Communication.objects.create(
            org=self.org,
            client=client,
            kind=data.validated_data["kind"],
            message=data.validated_data["message"],
            status="held" if hold else "sent",
            held_reason_code=hold.reason_code if hold else "",
            sent_by=self.user,
        )
        self.audit(
            "communication.held" if hold else "communication.sent",
            resource_type="client",
            resource_id=client.id,
            metadata={"kind": comm.kind, "communicationId": str(comm.id)},
        )
        if hold:
            raise held()
        return Response({"id": str(comm.id), "status": "sent"}, status=202)


class ExitIn(serializers.Serializer):
    reason = serializers.CharField(max_length=500)


class ExitView(ClientMixin):
    permission = "clients:write"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        ensure_workable(client)
        data = ExitIn(data=request.data)
        data.is_valid(raise_exception=True)
        if client.status == "exited":
            raise conflict("conflict", "This client relationship has already ended.")
        if services.active_hold(client):
            self.audit("client.exit_held", resource_type="client", resource_id=client.id)
            raise held()
        today = timezone.localdate()
        years = int(settings_for(self.org)["retention"]["years"])
        with transaction.atomic():
            client.status = "exited"
            client.relationship_ended_on = today
            client.exit_reason = data.validated_data["reason"]
            client.save()
            Document.objects.filter(client=client).update(retain_until=add_years(today, years))
            self.audit("client.exited", resource_type="client", resource_id=client.id)
        return Response(wire_client(self.get_client(client_id)))


class HoldIn(serializers.Serializer):
    note = serializers.CharField(max_length=1000)


class HoldsView(ClientMixin):
    """Compliance officer places a hold on client-facing steps (same neutral wording as every other hold), and
    sees the active ones. Only the compliance officer reads this list, so the reason may be shown."""

    permission = "signoff:compliance"

    def get(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        rows = ClientHold.objects.filter(client=client, released_at__isnull=True).select_related("placed_by")
        holds = [
            {
                "id": str(h.id),
                "reason": "restricted" if h.reason_code == "restricted" else "manual",
                "note": h.note,
                "placed_by_name": h.placed_by.full_name if h.placed_by else "Kinroot",
                "placed_at": h.created_at,
            }
            for h in rows.order_by("created_at")
        ]
        return Response(to_wire({"active": bool(holds), "holds": holds}))

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        data = HoldIn(data=request.data)
        data.is_valid(raise_exception=True)
        hold = services.place_hold(client, "manual", by=self.user, note=data.validated_data["note"])
        self.audit("hold.placed", resource_type="client", resource_id=client.id, restricted=True)
        return Response({"id": str(hold.id), "active": True}, status=201)


class HoldReleaseView(ClientMixin):
    permission = "signoff:compliance"

    def post(self, request: Request, client_id: str) -> Response:
        client = self.get_client(client_id)
        data = HoldIn(data=request.data)
        data.is_valid(raise_exception=True)
        released = services.release_holds(client, by=self.user, note=data.validated_data["note"])
        self.audit(
            "hold.released",
            resource_type="client",
            resource_id=client.id,
            restricted=True,
            metadata={"released": released},
        )
        return Response({"released": released})
