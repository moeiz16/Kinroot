"""Company registry search and import (ABN Lookup mock for AU, Companies House PSC shape for the UK).

Offline by default: AU entries come from the bundled fictional mock; UK entries from the bundled fictional
structure plus, when downloaded, the Companies House PSC sample in data/companies_house/ (looked up by company
number only, since the sample carries no company names).
"""

from __future__ import annotations

import functools
import json
import re
from datetime import date
from pathlib import Path
from typing import Any

from django.conf import settings
from django.db import transaction

from clients import services
from clients.models import Client, Party, Relationship

DATA = Path(__file__).resolve().parent / "data"
NATURE_PCT = {
    "ownership-of-shares-25-to-50-percent": 25.0,
    "ownership-of-shares-50-to-75-percent": 50.0,
    "ownership-of-shares-75-to-100-percent": 75.0,
    "ownership-of-shares-more-than-25-percent-registered-overseas-entity": 25.0,
}
CONTROL_NATURES = ("right-to-appoint-and-remove-directors", "significant-influence-or-control")


@functools.cache
def _bundled(source: str) -> list[dict[str, Any]]:
    name = "au_registry_mock.json" if source == "au_abr" else "uk_structure_sample.json"
    return json.loads((DATA / name).read_text(encoding="utf-8"))["entries"]


def _ch_sample_path() -> Path:
    return Path(settings.DATA_DIR) / "companies_house" / "psc_structures.jsonl"


def _ch_lookup(number: str) -> dict[str, Any] | None:
    path = _ch_sample_path()
    if not path.is_file():
        return None
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            if f'"{number}"' not in line:
                continue
            row = json.loads(line)
            if row.get("companyNumber") != number:
                continue
            pscs = []
            for psc in row.get("pscs", []):
                data = psc.get("data", {})
                if "ceased_on" in data:
                    continue
                dob = data.get("date_of_birth") or {}
                pscs.append(
                    {
                        "name": data.get("name", "Unnamed"),
                        "kind": data.get("kind", ""),
                        "registrationNumber": (data.get("identification") or {}).get("registration_number"),
                        "birthDate": f"{dob['year']}-{dob['month']:02d}" if dob.get("year") else None,
                        "nationality": None,
                        "natures": data.get("natures_of_control", []),
                        "notifiedOn": data.get("notified_on"),
                    }
                )
            return {
                "reference": number,
                "name": f"Company no. {number}",
                "kind": "company",
                "jurisdiction": "GB",
                "status": "active",
                "identifiers": {"ukCompanyNumber": number},
                "address": None,
                "officers": [],
                "pscs": pscs,
                "parents": {},
                "sample": False,
            }
    return None


def search(source: str, q: str, *, limit: int = 10) -> list[dict[str, Any]]:
    if source not in {"au_abr", "uk_ch"}:
        raise ValueError("source must be uk_ch or au_abr")
    needle = q.strip().lower()
    digits = re.sub(r"\D", "", q)
    hits: list[dict[str, Any]] = []
    for entry in _bundled(source):
        ids = "".join(re.sub(r"\D", "", v) for v in entry.get("identifiers", {}).values())
        if (needle and needle in entry["name"].lower()) or (len(digits) >= 3 and digits in ids):
            hits.append(_hit(source, entry, sample=True))
    if source == "uk_ch" and len(digits) == 8 and not hits:
        found = _ch_lookup(digits)
        if found:
            hits.append(_hit(source, found, sample=False))
    return hits[:limit]


def _hit(source: str, entry: dict[str, Any], *, sample: bool) -> dict[str, Any]:
    return {
        "source": source,
        "reference": entry["reference"],
        "name": entry["name"],
        "kind": entry["kind"],
        "jurisdiction": entry["jurisdiction"],
        "status": entry["status"],
        "address": services.format_address(entry.get("address")),
        "sample": sample,
    }


def get_entry(source: str, reference: str) -> dict[str, Any] | None:
    for entry in _bundled(source):
        if entry["reference"] == reference:
            return entry
    if source == "uk_ch":
        return _ch_lookup(reference)
    return None


def _birth(value: str | None) -> date | None:
    if not value:
        return None
    parts = value.split("-")
    try:
        return date(int(parts[0]), int(parts[1]) if len(parts) > 1 else 1, int(parts[2]) if len(parts) > 2 else 1)
    except (ValueError, IndexError):
        return None


class _Importer:
    def __init__(self, client: Client, source: str, reference: str) -> None:
        self.client = client
        self.org_id = client.org_id
        self.source = source
        self.reference = reference
        self.parties_created = 0
        self.relationships_created = 0
        self.today = services.today()

    def party(self, name: str, kind: str, **fields: Any) -> Party:
        ident = fields.get("identifiers") or {}
        existing = None
        for key, value in ident.items():
            existing = Party.objects.filter(org_id=self.org_id, merged_into__isnull=True, **{f"identifiers__{key}": value}).first()
            if existing:
                break
        if existing is None:
            existing = Party.objects.filter(
                org_id=self.org_id, merged_into__isnull=True, kind=kind, normalized_name=services.normalize_name(name),
                birth_date=fields.get("birth_date"),
            ).first()
        if existing:
            return existing
        given, family = services.split_person_name(name) if kind == "person" else ("", "")
        self.parties_created += 1
        return Party.objects.create(
            org_id=self.org_id,
            kind=kind,
            name=name,
            normalized_name=services.normalize_name(name),
            given_names=given,
            family_name=family,
            source=self.source,
            source_ref=f"{self.source}:{self.reference}",
            **fields,
        )

    def link(self, src: Party, dst: Party, kind: str, *, pct: float | None = None, role: str = "", interest: str = "",
             valid_from: date | None = None, note: str = "") -> None:
        if Relationship.objects.filter(
            org_id=self.org_id, from_party=src, to_party=dst, kind=kind, role=role, valid_to__isnull=True
        ).exists():
            return
        Relationship.objects.create(
            org_id=self.org_id, from_party=src, to_party=dst, kind=kind, pct=pct, role=role, interest=interest,
            valid_from=valid_from or self.today, source=self.source, source_ref=f"{self.source}:{self.reference}{note}",
        )
        self.relationships_created += 1

    def run(self, entry: dict[str, Any]) -> None:
        client_party = self.client.party
        if self.client.kind == "company":
            company = client_party
            if not company.identifiers:
                company.identifiers = entry.get("identifiers", {})
                company.jurisdiction = company.jurisdiction or entry["jurisdiction"]
                if entry.get("address") and not company.address:
                    company.address = entry["address"]
                company.save()
        else:
            company = self.party(entry["name"], "company", jurisdiction=entry["jurisdiction"],
                                 identifiers=entry.get("identifiers", {}), address=entry.get("address") or {})
        for officer in entry.get("officers", []):
            person = self.party(officer["name"], "person", birth_date=_birth(officer.get("birthDate")),
                                jurisdiction=entry["jurisdiction"])
            self.link(person, company, "control", role=officer["role"])
        for owner in entry.get("owners", []):
            kind = owner.get("kind", "person")
            holder = self.party(owner["name"], kind, jurisdiction=entry["jurisdiction"])
            self.link(holder, company, "ownership", pct=float(owner["pct"]), interest=owner.get("interest", "shares"))
        self._pscs(company, entry.get("pscs", []), entry.get("parents", {}), entry["jurisdiction"])

    def _pscs(self, company: Party, pscs: list[dict[str, Any]], parents: dict[str, Any], jurisdiction: str, depth: int = 0) -> None:
        for psc in pscs:
            corporate = psc["kind"].startswith("corporate") or psc["kind"].startswith("legal-person")
            reg = psc.get("registrationNumber")
            holder = self.party(
                psc["name"],
                "company" if corporate else "person",
                birth_date=_birth(psc.get("birthDate")),
                nationality=(psc.get("nationality") or "")[:2],
                jurisdiction=psc.get("jurisdiction") or jurisdiction,
                identifiers={"ukCompanyNumber": reg} if corporate and reg else {},
            )
            since = _birth(psc.get("notifiedOn")) if psc.get("notifiedOn") else None
            natures = psc.get("natures", [])
            pct = max((NATURE_PCT[n] for n in natures if n in NATURE_PCT), default=None)
            band = next((n for n in natures if n in NATURE_PCT), "")
            if pct is not None:
                self.link(holder, company, "ownership", pct=pct, interest="shares", valid_from=since, note=f"#{band}")
            if any(n in CONTROL_NATURES for n in natures) or (pct is None and natures):
                self.link(holder, company, "control", role="significant_control", valid_from=since)
            if corporate and reg and reg in parents and depth < 4:
                self._pscs(holder, parents[reg].get("pscs", []), {}, jurisdiction, depth + 1)


def import_entry(client: Client, source: str, reference: str) -> dict[str, int]:
    entry = get_entry(source, reference)
    if entry is None:
        raise LookupError("registry entry not found")
    importer = _Importer(client, source, reference)
    with transaction.atomic():
        importer.run(entry)
    services.rebuild_structure(client.org_id, [client.id])
    return {"parties_created": importer.parties_created, "relationships_created": importer.relationships_created}
