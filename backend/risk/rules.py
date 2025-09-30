"""Rules methodology: the decision of record (ADR 0004).

A methodology is versioned data (`KR-RM-x.y`): rules with a factor, points, a plain-language description and a
condition over stable feature ids, plus rating bands and rating floors. The engine is a pure function, so the
same inputs and methodology always give the same score, rating and reasons.

Condition DSL: {"feature": f, "op": ">=", "value": v} | {"all": [...]} | {"any": [...]} | {"not": {...}}.
Ops: ==, !=, >=, >, <=, <, in, truthy.
"""

from __future__ import annotations

import copy
import operator
from dataclasses import dataclass
from typing import Any

OPS = {"==": operator.eq, "!=": operator.ne, ">=": operator.ge, ">": operator.gt, "<=": operator.le, "<": operator.lt}
RATING_ORDER = {"low": 0, "medium": 1, "high": 2}

# The firm's published methodology at commencement. Each rule cites the feature evidence it relies on.
BASE_RULES: list[dict[str, Any]] = [
    # customer
    {
        "code": "pep_client",
        "factor": "customer",
        "points": 40,
        "floor": "high",
        "evidence": "pep_in_structure",
        "description": "The client is a politically exposed person (confirmed screening match).",
        "condition": {"feature": "pep_client", "op": "truthy"},
    },
    {
        "code": "trust_client",
        "factor": "customer",
        "points": 20,
        "evidence": "trust_in_chain",
        "description": "The client is a trust: control and benefit are harder to verify than for a person or company.",
        "condition": {"feature": "kind_trust", "op": "truthy"},
    },
    {
        "code": "partnership_client",
        "factor": "customer",
        "points": 5,
        "evidence": None,
        "description": "The client is a partnership.",
        "condition": {"feature": "kind_partnership", "op": "truthy"},
    },
    {
        "code": "foreign_client",
        "factor": "customer",
        "points": 10,
        "evidence": None,
        "description": "The client is based outside the firm's home country.",
        "condition": {"feature": "foreign_client", "op": "truthy"},
    },
    # structure
    {
        "code": "layered_structure",
        "factor": "structure",
        "points": 10,
        "evidence": "n_layers_to_ubo",
        "description": "Three or more ownership layers sit between the client and its beneficial owners.",
        "condition": {"feature": "n_layers_to_ubo", "op": ">=", "value": 3},
    },
    {
        "code": "deep_structure",
        "factor": "structure",
        "points": 10,
        "evidence": "n_layers_to_ubo",
        "description": "Five or more ownership layers: the structure is unusually deep.",
        "condition": {"feature": "n_layers_to_ubo", "op": ">=", "value": 5},
    },
    {
        "code": "offshore_layer",
        "factor": "structure",
        "points": 20,
        "evidence": "n_offshore_entities",
        "description": "An entity in the ownership chain is registered in an offshore or secrecy jurisdiction.",
        "condition": {"feature": "n_offshore_entities", "op": ">=", "value": 1},
    },
    {
        "code": "circular_ownership",
        "factor": "structure",
        "points": 30,
        "evidence": "has_cycle",
        "description": "Ownership runs in a circle, which can obscure who ultimately owns the client.",
        "condition": {"feature": "has_cycle", "op": "truthy"},
    },
    {
        "code": "nominee_indicators",
        "factor": "structure",
        "points": 15,
        "evidence": "nominee_indicators",
        "description": "A nominee holds shares or acts as an officer in the structure.",
        "condition": {"feature": "nominee_indicators", "op": ">=", "value": 1},
    },
    {
        "code": "unexplained_ownership",
        "factor": "structure",
        "points": 20,
        "evidence": "unexplained_pct",
        "description": "At least 25% of the ownership cannot be traced to a natural person.",
        "condition": {"feature": "unexplained_pct", "op": ">=", "value": 25},
    },
    {
        "code": "partly_unexplained_ownership",
        "factor": "structure",
        "points": 10,
        "evidence": "unexplained_pct",
        "description": "Between 10% and 25% of the ownership cannot be traced to a natural person.",
        "condition": {
            "all": [
                {"feature": "unexplained_pct", "op": ">=", "value": 10},
                {"feature": "unexplained_pct", "op": "<", "value": 25},
            ]
        },
    },
    {
        "code": "officer_hub",
        "factor": "structure",
        "points": 15,
        "evidence": "max_officer_appointments",
        "description": "An officer in the structure holds ten or more appointments, a common nominee-director pattern.",
        "condition": {"feature": "max_officer_appointments", "op": ">=", "value": 10},
    },
    {
        "code": "dormant_network",
        "factor": "structure",
        "points": 10,
        "evidence": "dormant_linked_companies",
        "description": "The structure's officers are linked to five or more dormant companies.",
        "condition": {"feature": "dormant_linked_companies", "op": ">=", "value": 5},
    },
    {
        "code": "shared_address_cluster",
        "factor": "structure",
        "points": 5,
        "evidence": "shared_address_cluster_size",
        "description": "Five or more parties share a registered address with this structure.",
        "condition": {"feature": "shared_address_cluster_size", "op": ">=", "value": 5},
    },
    {
        "code": "shared_officer_with_other_clients",
        "factor": "structure",
        "points": 10,
        "evidence": "max_officer_appointments",
        "description": "An officer in this structure also appears in two or more other clients' structures.",
        "condition": {"feature": "shared_officer_cluster_size", "op": ">=", "value": 2},
    },
    {
        "code": "trust_in_chain",
        "factor": "structure",
        "points": 5,
        "evidence": "trust_in_chain",
        "description": "A trust sits in the ownership chain.",
        "condition": {
            "all": [{"feature": "trust_in_chain", "op": "truthy"}, {"not": {"feature": "kind_trust", "op": "truthy"}}]
        },
    },
    {
        "code": "recent_ownership_change",
        "factor": "structure",
        "points": 10,
        "evidence": "recent_ownership_changes_12m",
        "description": "Ownership changed in the last 12 months.",
        "condition": {"feature": "recent_ownership_changes_12m", "op": ">=", "value": 1},
    },
    {
        "code": "undisclosed_holder",
        "factor": "structure",
        "points": 30,
        "evidence": "unexplained_pct",
        "description": "An undisclosed or bearer-style holder owns part of the structure.",
        "condition": {"feature": "undisclosed_holders", "op": ">=", "value": 1},
    },
    {
        "code": "offshore_subsidiary",
        "factor": "structure",
        "points": 10,
        "evidence": "offshore_subsidiaries",
        "description": "The client holds interests in an offshore entity (it may be a layer in another structure).",
        "condition": {"feature": "offshore_subsidiaries", "op": ">=", "value": 1},
    },
    {
        "code": "recent_officer_change",
        "factor": "structure",
        "points": 10,
        "evidence": "recent_officer_changes_12m",
        "description": "Directors or other officers changed in the last 12 months.",
        "condition": {"feature": "recent_officer_changes_12m", "op": ">=", "value": 1},
    },
    {
        "code": "no_beneficial_owner",
        "factor": "structure",
        "points": 10,
        "evidence": None,
        "description": "No beneficial owner could be identified by ownership or control.",
        "condition": {
            "all": [
                {"feature": "n_ubos", "op": "==", "value": 0},
                {"not": {"feature": "kind_individual", "op": "truthy"}},
            ]
        },
    },
    # jurisdiction
    {
        "code": "high_risk_jurisdiction",
        "factor": "jurisdiction",
        "points": 25,
        "evidence": "high_risk_jurisdictions",
        "description": (
            "A party in the structure is linked to a jurisdiction under FATF call for action or increased monitoring."
        ),
        "condition": {"feature": "n_high_risk_jurisdictions", "op": ">=", "value": 1},
    },
    # screening
    {
        "code": "pep_in_structure",
        "factor": "screening",
        "points": 20,
        "evidence": "pep_in_structure",
        "description": "A politically exposed person owns or controls part of the structure.",
        "condition": {
            "all": [{"feature": "pep_in_structure", "op": "truthy"}, {"not": {"feature": "pep_client", "op": "truthy"}}]
        },
    },
    {
        "code": "sanctions_possible_match",
        "factor": "screening",
        "points": 30,
        "evidence": "sanctions_hit_in_structure",
        "description": "A possible sanctions match in the structure is awaiting review.",
        "condition": {"feature": "sanctions_possible", "op": "truthy"},
    },
    {
        "code": "sanctions_confirmed",
        "factor": "screening",
        "points": 100,
        "floor": "high",
        "evidence": "sanctions_hit_in_structure",
        "description": "A party in the structure is a confirmed sanctions match.",
        "condition": {"feature": "sanctions_confirmed", "op": "truthy"},
    },
    # service
    {
        "code": "formation_services",
        "factor": "service",
        "points": 10,
        "evidence": None,
        "description": "The firm is asked to form a company or trust, a service open to misuse for layering.",
        "condition": {"feature": "service_formation", "op": "truthy"},
    },
    {
        "code": "client_funds",
        "factor": "service",
        "points": 10,
        "evidence": None,
        "description": "The firm will hold or move client money.",
        "condition": {"feature": "service_client_funds", "op": "truthy"},
    },
    {
        "code": "property_transaction",
        "factor": "service",
        "points": 5,
        "evidence": None,
        "description": "The matter involves buying or selling real property.",
        "condition": {"feature": "service_property", "op": "truthy"},
    },
    {
        "code": "remote_overseas_property",
        "factor": "service",
        "points": 10,
        "evidence": None,
        "description": "An overseas client buying or selling property without meeting in person (a known typology).",
        "condition": {
            "all": [
                {"feature": "foreign_client", "op": "truthy"},
                {"feature": "channel_remote", "op": "truthy"},
                {"feature": "service_property", "op": "truthy"},
            ]
        },
    },
    # channel
    {
        "code": "non_face_to_face",
        "factor": "channel",
        "points": 10,
        "evidence": None,
        "description": "The client was onboarded without meeting in person.",
        "condition": {"feature": "channel_remote", "op": "truthy"},
    },
    {
        "code": "via_intermediary",
        "factor": "channel",
        "points": 5,
        "evidence": None,
        "description": "The client was introduced through an intermediary.",
        "condition": {"feature": "channel_intermediary", "op": "truthy"},
    },
]

BANDS = {"medium": 30, "high": 60}


def default_methodologies() -> list[dict[str, Any]]:
    """KR-RM-1.0 (published at commencement) and the KR-RM-1.1 draft (changes awaiting the compliance officer)."""
    v10 = {"version": "KR-RM-1.0", "status": "published", "bands": dict(BANDS), "rules": copy.deepcopy(BASE_RULES)}
    rules11 = copy.deepcopy(BASE_RULES)
    for r in rules11:
        if r["code"] == "offshore_layer":
            r["points"] = 25
        if r["code"] == "officer_hub":
            r["condition"] = {"feature": "max_officer_appointments", "op": ">=", "value": 8}
            r["description"] = (
                "An officer in the structure holds eight or more appointments, a common nominee-director pattern."
            )
    rules11.append(
        {
            "code": "offshore_and_nominee",
            "factor": "structure",
            "points": 10,
            "evidence": "nominee_indicators",
            "description": "Offshore layers combined with nominee arrangements (a typology flagged in pattern review).",
            "condition": {
                "all": [
                    {"feature": "n_offshore_entities", "op": ">=", "value": 1},
                    {"feature": "nominee_indicators", "op": ">=", "value": 1},
                ]
            },
        }
    )
    v11 = {"version": "KR-RM-1.1", "status": "draft", "bands": dict(BANDS), "rules": rules11}
    return [v10, v11]


def evaluate(cond: dict[str, Any], f: dict[str, Any]) -> bool:
    if "all" in cond:
        return all(evaluate(c, f) for c in cond["all"])
    if "any" in cond:
        return any(evaluate(c, f) for c in cond["any"])
    if "not" in cond:
        return not evaluate(cond["not"], f)
    value = f.get(cond["feature"])
    op = cond["op"]
    if op == "truthy":
        return bool(value)
    if op == "in":
        return value in cond["value"]
    if value is None:
        return False
    return bool(OPS[op](value, cond["value"]))


@dataclass
class RuleHit:
    code: str
    factor: str
    points: int
    message: str
    evidence_key: str | None
    floor: str | None


@dataclass
class RulesResult:
    score: int
    rating: str
    hits: list[RuleHit]
    raw_points: int


def rate(score: int, bands: dict[str, int]) -> str:
    if score >= bands["high"]:
        return "high"
    return "medium" if score >= bands["medium"] else "low"


def apply(methodology: dict[str, Any], features: dict[str, Any]) -> RulesResult:
    hits: list[RuleHit] = []
    for r in methodology["rules"]:
        if evaluate(r["condition"], features):
            hits.append(
                RuleHit(r["code"], r["factor"], int(r["points"]), r["description"], r.get("evidence"), r.get("floor"))
            )
    raw = sum(h.points for h in hits)
    score = min(100, raw)
    rating = rate(score, methodology["bands"])
    for h in hits:
        if h.floor and RATING_ORDER[h.floor] > RATING_ORDER[rating]:
            rating = h.floor
    hits.sort(key=lambda h: (-h.points, h.code))
    return RulesResult(score=score, rating=rating, hits=hits, raw_points=raw)
