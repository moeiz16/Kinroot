"""Load crafted structures (eval/fixtures/ubo_cases.json shape) straight into a graph store.

Used by the graph tests and the eval harness to check the UBO engine on the real embedded engine without
going through Django.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

from resolution.normalize import normalize_name

from .ownership import UboComputation, compute_ubo
from .repo import GraphRepo
from .store import GraphStore

CASES_PATH = Path(__file__).resolve().parents[2] / "eval" / "fixtures" / "ubo_cases.json"


def load_cases(path: Path = CASES_PATH) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    cases = data["cases"]
    by_name = {c["name"]: c for c in cases}
    out = []
    for c in cases:
        if "sameAs" in c:
            base = by_name[c["sameAs"]]
            c = {**base, **{k: v for k, v in c.items() if k != "sameAs"}}
        out.append(c)
    return out


def load_structure(store: GraphStore, org: str, case: dict[str, Any]) -> GraphRepo:
    """Write the case's parties and edges under `org` (keys are prefixed with the org so cases never clash)."""
    repo = GraphRepo(store, org, max_depth=int(case.get("maxDepth", 10)))

    def pid(key: str) -> str:
        return f"{org}:{key}"

    repo.upsert_parties(
        [
            {
                "id": pid(p["key"]),
                "orgId": org,
                "kind": p["kind"],
                "name": p["name"],
                "normName": normalize_name(p["name"], p["kind"]),
                "jurisdiction": p.get("jurisdiction", "AU" if p["kind"] != "person" else None),
                "identifiers": json.dumps(p.get("identifiers", {})),
                "birthDate": p.get("birthDate"),
                "nationality": p.get("nationality"),
                "isNominee": bool(p.get("isNominee", False)),
                "dormant": bool(p.get("dormant", False)),
                "source": "fixture",
                "sourceRef": None,
            }
            for p in case["parties"]
        ]
    )
    repo.replace_edges(
        [
            {
                "id": f"{org}:{e['id']}",
                "orgId": org,
                "fromId": pid(e["from"]),
                "toId": pid(e["to"]),
                "kind": e["kind"],
                "pct": e.get("pct"),
                "interest": e.get("interest"),
                "role": e.get("role"),
                "nominee": bool(e.get("nominee", False)),
                "validFrom": e.get("validFrom", "2019-01-01"),
                "validTo": e.get("validTo"),
                "source": "fixture",
                "sourceRef": None,
            }
            for e in case["edges"]
        ]
    )
    return repo


def run_case(store: GraphStore, org: str, case: dict[str, Any]) -> tuple[UboComputation, Any]:
    repo = load_structure(store, org, case)
    focus = f"{org}:{case['focus']}"
    sub = repo.upstream([focus], date.fromisoformat(case["asOf"]))
    return compute_ubo(sub, focus, threshold_pct=float(case.get("threshold", 25)), max_depth=repo.max_depth), sub


def check_case(result: UboComputation, case: dict[str, Any], org: str) -> list[str]:
    """Return a list of mismatches (empty = correct)."""
    exp = case["expect"]

    def key(pid: str) -> str:
        return pid.split(":", 1)[1]

    problems: list[str] = []
    got_owners = {key(o.party_id): o.pct for o in result.owners if o.pct is not None}
    for k, v in exp.get("owners", {}).items():
        if abs((got_owners.get(k) or 0.0) - v) > 0.01:
            problems.append(f"owner {k}: expected {v}%, got {got_owners.get(k)}")
    extra = set(got_owners) - set(exp.get("owners", {}))
    if extra:
        problems.append(f"unexpected owners {sorted(extra)}")
    ubos = sorted(key(o.party_id) for o in result.owners if o.is_ubo)
    if ubos != sorted(exp.get("ubos", [])):
        problems.append(f"UBOs expected {sorted(exp.get('ubos', []))}, got {ubos}")
    for k in exp.get("controlUbos", []):
        if not any(key(o.party_id) == k and o.control_roles for o in result.owners):
            problems.append(f"{k} should be a UBO through control")
    for k in exp.get("notUbos", []):
        if any(key(o.party_id) == k and o.is_ubo for o in result.owners):
            problems.append(f"{k} must not be a UBO")
    if "unexplainedPct" in exp and abs(result.unexplained_pct - exp["unexplainedPct"]) > 0.01:
        problems.append(f"unexplained expected {exp['unexplainedPct']}, got {result.unexplained_pct}")
    if "cycles" in exp and len(result.cycles) != exp["cycles"]:
        problems.append(f"cycles expected {exp['cycles']}, got {len(result.cycles)}")
    if (
        "cycleMembers" in exp
        and result.cycles
        and sorted(key(p) for p in result.cycles[0]) != sorted(exp["cycleMembers"])
    ):
        problems.append(f"cycle members {result.cycles[0]}")
    if "warnings" in exp and result.warnings != exp["warnings"]:
        problems.append(f"warnings expected {exp['warnings']}, got {result.warnings}")
    for w in exp.get("warningsInclude", []):
        if w not in result.warnings:
            problems.append(f"missing warning {w}")
    if "layers" in exp and result.max_layers != exp["layers"]:
        problems.append(f"layers expected {exp['layers']}, got {result.max_layers}")
    for k, n in exp.get("pathCounts", {}).items():
        got = next((len(o.paths) for o in result.owners if key(o.party_id) == k), 0)
        if got != n:
            problems.append(f"{k}: expected {n} paths, got {got}")
    for k in exp.get("unknownOwners", []):
        if f"{org}:{k}" not in result.unknown_owner_ids:
            problems.append(f"{k} should be flagged as an unknown owner")
    return problems
