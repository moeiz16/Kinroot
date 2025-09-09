"""Wire shapes (snake_case; the renderer camelizes) for A-owned records (contract §1.6, §1.10)."""

from __future__ import annotations

from typing import Any

from clients import services
from clients.models import (
    Client,
    Consent,
    Document,
    EddCase,
    Party,
    Relationship,
    VerificationCheck,
)

_ID_KEYS = {"acn": "acn", "abn": "abn", "uk_company_number": "ukCompanyNumber", "ukCompanyNumber": "ukCompanyNumber"}


def _iso(value: Any) -> str | None:
    return value.isoformat() if value else None


def identifiers_out(ids: dict[str, Any] | None) -> dict[str, Any]:
    return {_ID_KEYS.get(k, k): v for k, v in (ids or {}).items() if v}


def identifiers_in(ids: dict[str, Any] | None) -> dict[str, Any]:
    """Incoming keys are snakeized by the parser (uk_company_number); store the contract spelling."""
    out = {}
    for k, v in (ids or {}).items():
        if v in (None, ""):
            continue
        out[_ID_KEYS.get(k, k)] = str(v).strip()
    return out


def party_wire(p: Party) -> dict[str, Any]:
    return {
        "id": str(p.id),
        "kind": p.kind,
        "name": p.name,
        "birth_date": _iso(p.birth_date),
        "nationality": p.nationality or None,
        "jurisdiction": p.jurisdiction or None,
        "identifiers": identifiers_out(p.identifiers),
        "address": p.address or None,
        "is_nominee": p.is_nominee,
        "dormant": p.dormant,
        "source": p.source,
        "source_ref": p.source_ref or None,
        "merged_into": str(p.merged_into_id) if p.merged_into_id else None,
        "created_at": _iso(p.created_at),
    }


def relationship_wire(r: Relationship) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "from_party_id": str(r.from_party_id),
        "to_party_id": str(r.to_party_id),
        "kind": r.kind,
        "pct": r.pct,
        "interest": r.interest or None,
        "role": r.role or None,
        "nominee": r.nominee,
        "valid_from": _iso(r.valid_from),
        "valid_to": _iso(r.valid_to),
        "source": r.source,
        "source_ref": r.source_ref or None,
        "evidence_note": r.evidence_note or None,
        "created_at": _iso(r.created_at),
    }


def client_wire(c: Client, *, extra_flags: list[str] | None = None) -> dict[str, Any]:
    flags = services.structure_flags(c) + [f for f in (extra_flags or []) if f]
    order = ["pep", "sanctions_review", "offshore", "circular", "nominee", "review_overdue"]
    return {
        "id": str(c.id),
        "kind": c.kind,
        "name": c.name,
        "status": c.status,
        "jurisdiction": c.jurisdiction,
        "party_id": str(c.party_id),
        "services": list(c.services or []),
        "channel": c.channel,
        "matter_reference": c.matter_reference or None,
        "assigned_to": {"id": str(c.assigned_to_id), "full_name": c.assigned_to.full_name}
        if c.assigned_to_id
        else None,
        "rating": c.rating,
        "rating_source": c.rating_source,
        "edd_required": c.edd_required,
        "next_review_on": _iso(c.next_review_on),
        "last_reviewed_on": _iso(c.last_reviewed_on),
        "onboarded_on": _iso(c.onboarded_on),
        "relationship_ended_on": _iso(c.relationship_ended_on),
        "structure": services.structure_summary(c),
        "flags": [f for f in order if f in set(flags)],
        "sample": c.seed_key is not None,
        "created_at": _iso(c.created_at),
        "updated_at": _iso(c.updated_at),
    }


def document_wire(d: Document) -> dict[str, Any]:
    return {
        "id": str(d.id),
        "party_id": str(d.party_id),
        "doc_type": d.doc_type,
        "file_name": d.file_name,
        "size_bytes": d.size,
        "sha256": d.sha256,
        "uploaded_by": d.uploaded_by.full_name if d.uploaded_by_id else None,
        "uploaded_at": _iso(d.created_at),
        "retain_until": _iso(d.retain_until),
    }


def verification_wire(v: VerificationCheck) -> dict[str, Any]:
    return {
        "id": str(v.id),
        "party_id": str(v.party_id),
        "method": v.method,
        "result": v.result,
        "sources": v.sources,
        "reference": v.reference,
        "checked_at": _iso(v.checked_at),
        "demo": True,
    }


def consent_wire(c: Consent) -> dict[str, Any]:
    return {
        "id": str(c.id),
        "party_id": str(c.party_id),
        "purpose": c.purpose,
        "given_on": _iso(c.given_on),
        "method": c.method,
        "recorded_by": c.recorded_by.full_name if c.recorded_by_id else None,
    }


def edd_wire(edd: EddCase | None, client: Client) -> dict[str, Any]:
    if edd is None:
        return {
            "client_id": str(client.id),
            "required": False,
            "triggers": [],
            "measures": [],
            "signoffs": [],
            "status": "not_required",
        }
    measures = []
    for m in edd.measures.select_related("completed_by").order_by("key"):
        measures.append(
            {
                "key": m.key,
                "label": services.MEASURE_LABELS.get(m.key, m.key.replace("_", " ").capitalize()),
                "status": m.status,
                "note": m.note or None,
                "document_ids": list(m.document_ids or []),
                "completed_by": m.completed_by.full_name if m.completed_by_id else None,
                "completed_at": _iso(m.completed_at),
            }
        )
    order = list(services.MEASURE_LABELS)
    measures.sort(key=lambda m: order.index(m["key"]) if m["key"] in order else 99)
    signoffs = [
        {
            "stage": s.stage,
            "decision": s.decision,
            "note": s.note or None,
            "by_name": s.by.full_name if s.by_id else None,
            "at": _iso(s.at),
        }
        for s in edd.signoffs.select_related("by").filter(superseded=False).order_by("at")
    ]
    return {
        "client_id": str(client.id),
        "required": edd.required,
        "triggers": edd.triggers or [],
        "measures": measures,
        "signoffs": signoffs,
        "status": edd.status,
    }
