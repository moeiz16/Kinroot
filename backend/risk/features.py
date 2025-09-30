"""Risk inputs: one flat dict of stable feature ids, shared by the rules, the challenger and the drift monitor.

Protected attributes (nationality, sex, age) are never features. `foreign_client` is the client's place of
residence or registration relative to the firm (an AML/CTF jurisdiction factor), not a person's nationality.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from typing import Any

# Order matters: this is the challenger's input vector.
ML_FEATURES: tuple[str, ...] = (
    "kind_individual",
    "kind_company",
    "kind_trust",
    "kind_partnership",
    "foreign_client",
    "service_formation",
    "service_client_funds",
    "service_property",
    "n_services",
    "channel_remote",
    "channel_intermediary",
    "n_layers_to_ubo",
    "n_ubos",
    "unexplained_pct",
    "has_cycle",
    "n_offshore_entities",
    "n_high_risk_jurisdictions",
    "trust_in_chain",
    "nominee_indicators",
    "max_officer_appointments",
    "dormant_linked_companies",
    "shared_officer_cluster_size",
    "shared_address_cluster_size",
    "pep_client",
    "pep_in_structure",
    "sanctions_possible",
    "sanctions_confirmed",
    "recent_ownership_changes_12m",
)

FEATURE_LABELS = {
    "kind_individual": "Client is an individual",
    "kind_company": "Client is a company",
    "kind_trust": "Client is a trust",
    "kind_partnership": "Client is a partnership",
    "foreign_client": "Client based overseas",
    "service_formation": "Company or trust formation",
    "service_client_funds": "Handling client money",
    "service_property": "Property transaction",
    "n_services": "Number of services",
    "channel_remote": "Onboarded remotely",
    "channel_intermediary": "Introduced by an intermediary",
    "n_layers_to_ubo": "Ownership layers",
    "n_ubos": "Number of beneficial owners",
    "unexplained_pct": "Ownership not traced to a person",
    "has_cycle": "Circular ownership",
    "n_offshore_entities": "Offshore entities in the structure",
    "n_high_risk_jurisdictions": "High-risk jurisdictions",
    "trust_in_chain": "Trust in the chain",
    "nominee_indicators": "Nominee arrangements",
    "max_officer_appointments": "Officer appointments elsewhere",
    "dormant_linked_companies": "Links to dormant companies",
    "shared_officer_cluster_size": "Officers shared with other clients",
    "shared_address_cluster_size": "Shared registered address",
    "pep_client": "Client is a politically exposed person",
    "pep_in_structure": "Politically exposed person in the structure",
    "sanctions_possible": "Possible sanctions match",
    "sanctions_confirmed": "Confirmed sanctions match",
    "recent_ownership_changes_12m": "Recent ownership changes",
}

FORMATION = {"company_formation", "trust_formation"}
PROPERTY = {"conveyancing", "property_transaction", "real_estate_sale"}


def build(client: Any, graph_features: Any, *, home_country: str, screening: dict[str, bool]) -> dict[str, Any]:
    gf = asdict(graph_features) if not isinstance(graph_features, dict) else dict(graph_features)
    services = set(client.services or [])
    f: dict[str, Any] = {
        "kind_individual": int(client.kind == "individual"),
        "kind_company": int(client.kind == "company"),
        "kind_trust": int(client.kind == "trust"),
        "kind_partnership": int(client.kind == "partnership"),
        "foreign_client": int(bool(client.jurisdiction) and client.jurisdiction.upper() != home_country.upper()),
        "service_formation": int(bool(services & FORMATION)),
        "service_client_funds": int("managing_client_funds" in services),
        "service_property": int(bool(services & PROPERTY)),
        "n_services": len(services),
        "channel_remote": int(client.channel == "remote"),
        "channel_intermediary": int(client.channel == "intermediary"),
        "n_layers_to_ubo": int(gf["n_layers_to_ubo"]),
        "n_ubos": int(gf["n_ubos"]),
        "unexplained_pct": float(gf["unexplained_pct"]),
        "has_cycle": int(bool(gf["has_cycle"])),
        "n_offshore_entities": int(gf["n_offshore_entities"]),
        "n_high_risk_jurisdictions": len(gf["high_risk_jurisdictions"]),
        "high_risk_jurisdictions": list(gf["high_risk_jurisdictions"]),
        "trust_in_chain": int(bool(gf["trust_in_chain"])),
        "nominee_indicators": int(gf["nominee_indicators"]),
        "max_officer_appointments": int(gf["max_officer_appointments"]),
        "dormant_linked_companies": int(gf["dormant_linked_companies"]),
        "shared_officer_cluster_size": int(gf["shared_officer_cluster_size"]),
        "shared_address_cluster_size": int(gf["shared_address_cluster_size"]),
        "pep_client": int(screening.get("pep_client", False)),
        "pep_in_structure": int(bool(gf["pep_in_structure"])),
        "sanctions_possible": int(screening.get("sanctions_possible", False)),
        "sanctions_confirmed": int(screening.get("sanctions_confirmed", False)),
        "recent_ownership_changes_12m": int(gf["recent_ownership_changes_12m"]),
    }
    return f


def vector(f: dict[str, Any]) -> list[float]:
    return [float(f.get(k, 0) or 0) for k in ML_FEATURES]


def inputs_hash(features: dict[str, Any], methodology_version: str, model_version: str | None) -> str:
    payload = json.dumps({"f": features, "m": methodology_version, "c": model_version}, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


# ── EDD triggers ──────────────────────────────────────────────────────────────────────────────────
TRIGGERS: dict[str, tuple[str, list[str]]] = {
    "pep": (
        "A politically exposed person is the client or sits in the structure.",
        ["source_of_wealth", "source_of_funds", "senior_approval", "enhanced_monitoring"],
    ),
    "sanctions_near_match": (
        "A possible sanctions match must be resolved before the matter proceeds.",
        ["ubo_verification", "adverse_media_check"],
    ),
    "high_risk_jurisdiction": (
        "The structure connects to a high-risk jurisdiction.",
        ["source_of_funds", "purpose_of_relationship", "senior_approval"],
    ),
    "complex_structure": (
        "The ownership structure is complex (layers, trusts or offshore entities).",
        ["ubo_verification", "purpose_of_relationship"],
    ),
    "circular_ownership": ("Ownership runs in a circle.", ["ubo_verification", "purpose_of_relationship"]),
    "unknown_owner": ("Part of the ownership cannot be traced to a person.", ["ubo_verification"]),
    "nominee": ("Nominee arrangements appear in the structure.", ["ubo_verification", "adverse_media_check"]),
    "high_rating": (
        "The client is rated high risk.",
        ["source_of_funds", "purpose_of_relationship", "senior_approval", "enhanced_monitoring"],
    ),
}


def edd_triggers(features: dict[str, Any], rating: str) -> list[dict[str, Any]]:
    codes: list[str] = []
    if features.get("pep_client") or features.get("pep_in_structure"):
        codes.append("pep")
    if features.get("sanctions_possible") or features.get("sanctions_confirmed"):
        codes.append("sanctions_near_match")
    if features.get("n_high_risk_jurisdictions", 0) >= 1:
        codes.append("high_risk_jurisdiction")
    complex_ = features.get("n_layers_to_ubo", 0) >= 3 or (
        features.get("trust_in_chain") and features.get("n_offshore_entities", 0) >= 1
    )
    if complex_:
        codes.append("complex_structure")
    if features.get("has_cycle"):
        codes.append("circular_ownership")
    if features.get("unexplained_pct", 0) >= 25:
        codes.append("unknown_owner")
    if features.get("nominee_indicators", 0) >= 1:
        codes.append("nominee")
    if rating == "high":
        codes.append("high_rating")
    return [{"code": c, "message": TRIGGERS[c][0], "measures": list(TRIGGERS[c][1])} for c in codes]
