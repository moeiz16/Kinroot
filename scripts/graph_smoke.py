"""Smoke test for the embedded graph engine (ADR 0001).

Builds a small ownership structure with a trust, an offshore holding company, a nominee director and a
three-company ownership cycle, then runs the portable Cypher the application relies on. Every query here is
written to also run on Neo4j; only the schema DDL is engine-specific.

Usage:  backend/.venv/bin/python scripts/graph_smoke.py ladybug|kuzu
Run each engine in its own process: both wheels register the same native types and cannot share one.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

ENGINE = sys.argv[1] if len(sys.argv) > 1 else "ladybug"

if ENGINE == "ladybug":
    import ladybug as gdb
elif ENGINE == "kuzu":
    import kuzu as gdb  # type: ignore[no-redef]
else:
    raise SystemExit(f"unknown engine {ENGINE!r}")

DDL = [
    "CREATE NODE TABLE Party(id STRING, kind STRING, name STRING, jurisdiction STRING, PRIMARY KEY(id))",
    "CREATE REL TABLE OWNS(FROM Party TO Party, id STRING, pct DOUBLE, validFrom STRING, validTo STRING)",
    "CREATE REL TABLE CONTROLS(FROM Party TO Party, id STRING, role STRING, validFrom STRING, validTo STRING)",
]

PARTIES = [
    ("p-ava", "person", "Ava Lindqvist", "AU"),
    ("p-ben", "person", "Ben Okafor", "AU"),
    ("p-nom", "person", "Nominee Director", "SC"),
    ("t-calder", "trust", "Calder Family Trust", "AU"),
    ("c-bellmere", "company", "Bellmere Holdings Pty Ltd", "AU"),
    ("c-offshore", "company", "Kestrel Ventures Ltd", "VG"),
    ("c-client", "company", "Harbour Quay Developments Pty Ltd", "AU"),
    ("c-x", "company", "Circle X Pty Ltd", "AU"),
    ("c-y", "company", "Circle Y Pty Ltd", "AU"),
    ("c-z", "company", "Circle Z Ltd", "NZ"),
]
# (id, owner, owned, pct, validFrom, validTo)
OWNS = [
    ("o1", "p-ava", "t-calder", 100.0, "2019-01-01", None),
    ("o2", "t-calder", "c-bellmere", 62.0, "2019-06-01", None),
    ("o3", "p-ben", "c-bellmere", 38.0, "2019-06-01", None),
    ("o4", "c-bellmere", "c-offshore", 80.0, "2020-03-01", None),
    ("o5", "c-offshore", "c-client", 100.0, "2021-02-01", None),
    (
        "o6",
        "p-ben",
        "c-client",
        30.0,
        "2018-01-01",
        "2021-01-31",
    ),  # ended before the onboarding date
    ("o7", "c-x", "c-y", 60.0, "2020-01-01", None),
    ("o8", "c-y", "c-z", 70.0, "2020-01-01", None),
    ("o9", "c-z", "c-x", 50.0, "2020-01-01", None),  # closes the cycle X -> Y -> Z -> X
    ("o10", "p-ava", "c-x", 50.0, "2020-01-01", None),
]
CONTROLS = [("k1", "p-nom", "c-offshore", "director", "2020-03-01", None)]

UPSERT_PARTY = (
    "MERGE (n:Party {id: $id}) "
    "ON CREATE SET n.kind = $kind, n.name = $name, n.jurisdiction = $jur "
    "ON MATCH SET n.kind = $kind, n.name = $name, n.jurisdiction = $jur"
)
UPSERT_OWNS = (
    "MATCH (a:Party {id: $a}), (b:Party {id: $b}) "
    "MERGE (a)-[r:OWNS {id: $id}]->(b) "
    "SET r.pct = $pct, r.validFrom = $vf, r.validTo = $vt"
)
UPSERT_CONTROLS = (
    "MATCH (a:Party {id: $a}), (b:Party {id: $b}) "
    "MERGE (a)-[r:CONTROLS {id: $id}]->(b) "
    "SET r.role = $role, r.validFrom = $vf, r.validTo = $vt"
)

# Ownership chains ending at the client, valid at `asOf`, bounded depth. Two portability rules learned here:
#  1. parameters cannot appear inside list predicates (ALL/NONE) on Kuzu/LadybugDB, so bind them with WITH first;
#  2. list comprehensions are not supported, so return nodes(p)/relationships(p) and normalise in Python.
UBO_PATHS = """
WITH $asOf AS asOf
MATCH p = (o:Party)-[:OWNS*1..8]->(c:Party {id: $client})
WHERE o.kind = 'person'
  AND ALL(r IN relationships(p) WHERE r.validFrom <= asOf AND coalesce(r.validTo, '9999-12-31') > asOf)
RETURN o.id AS ownerId, nodes(p) AS ns, relationships(p) AS rs, length(p) AS hops
"""

# Breadth-first upstream fetch, one hop per round trip: portable, cycle-safe and linear in edges.
UPSTREAM_HOP = """
WITH $asOf AS asOf
MATCH (o:Party)-[r:OWNS]->(c:Party)
WHERE c.id IN $ids AND r.validFrom <= asOf AND coalesce(r.validTo, '9999-12-31') > asOf
RETURN o.id AS fromId, o.kind AS fromKind, c.id AS toId, r.id AS edgeId, r.pct AS pct
"""

# Circular ownership: any company that owns itself through 2..6 hops.
CYCLES = """
MATCH p = (a:Party)-[:OWNS*2..6]->(a)
RETURN a.id AS startId, nodes(p) AS ns, length(p) AS hops
"""

# Investigation: how is X connected to Y (any relationship type, either direction), shortest first.
CONNECTION = """
MATCH p = (a:Party {id: $a})-[:OWNS|CONTROLS*1..6]-(b:Party {id: $b})
RETURN nodes(p) AS ns, relationships(p) AS rs, length(p) AS hops
ORDER BY hops
LIMIT 3
"""

# Who controls Z through a non-ownership role (nominee indicators).
CONTROLLERS = """
MATCH (p:Party)-[r:CONTROLS]->(c:Party)<-[:OWNS*1..4]-(:Party {id: $root})
RETURN DISTINCT p.id AS controllerId, r.role AS role, c.id AS companyId
"""

# Change diff: relationships that started or ended in (since, until].
CHANGES = """
MATCH (a:Party)-[r:OWNS]->(b:Party)
WHERE (r.validFrom > $since AND r.validFrom <= $until)
   OR (r.validTo IS NOT NULL AND r.validTo > $since AND r.validTo <= $until)
RETURN r.id AS edgeId, a.id AS fromId, b.id AS toId, r.validFrom AS validFrom, r.validTo AS validTo
ORDER BY edgeId
"""


def rows(conn, query: str, params: dict | None = None) -> list[dict]:
    res = conn.execute(query, params or {})
    cols = res.get_column_names()
    out = []
    while res.has_next():
        out.append(dict(zip(cols, res.get_next(), strict=True)))
    return out


def ids(items: list[dict]) -> list[str]:
    """Normalise engine path elements (LadybugDB `_LABEL`, Kuzu `_label`, Neo4j objects) to their `id`."""
    return [item["id"] for item in items]


def is_simple(node_ids: list[str], *, closed: bool = False) -> bool:
    """Engines differ on walk vs trail semantics; the app keeps only simple paths (no repeated node)."""
    body = node_ids[:-1] if closed else node_ids
    return len(set(body)) == len(body)


def effective_pct(pcts: list[float]) -> float:
    eff = 1.0
    for p in pcts:
        eff *= p / 100.0
    return round(eff * 100.0, 2)


def ubo_by_bfs(conn, client: str, as_of: str, max_depth: int = 10) -> dict[str, float]:
    """Fetch the upstream subgraph hop by hop, then sum effective ownership over simple paths in Python."""
    edges: dict[str, list[tuple[str, float]]] = {}
    kinds: dict[str, str] = {}
    frontier, seen = {client}, {client}
    for _ in range(max_depth):
        if not frontier:
            break
        hop = rows(conn, UPSTREAM_HOP, {"ids": sorted(frontier), "asOf": as_of})
        frontier = set()
        for r in hop:
            edges.setdefault(r["toId"], []).append((r["fromId"], r["pct"]))
            kinds[r["fromId"]] = r["fromKind"]
            if r["fromId"] not in seen:
                seen.add(r["fromId"])
                frontier.add(r["fromId"])
    totals: dict[str, float] = {}

    def walk(node: str, share: float, path: set[str]) -> None:
        for owner, pct in edges.get(node, []):
            if owner in path:  # circular ownership: stop, it is reported separately
                continue
            s = share * pct / 100.0
            if kinds.get(owner) == "person":
                totals[owner] = totals.get(owner, 0.0) + s
            else:
                walk(owner, s, path | {owner})

    walk(client, 1.0, {client})
    return {k: round(v * 100.0, 2) for k, v in sorted(totals.items())}


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix=f"kinroot-{ENGINE}-"))
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    try:
        t0 = time.perf_counter()
        db = gdb.Database(str(tmp / "graph.db"))
        conn = gdb.Connection(db)
        print(f"engine={ENGINE} version={getattr(gdb, '__version__', '?')} path={tmp}")
        for stmt in DDL:
            conn.execute(stmt)
        for pid, kind, name, jur in PARTIES:
            conn.execute(UPSERT_PARTY, {"id": pid, "kind": kind, "name": name, "jur": jur})
        # upsert twice: MERGE must stay idempotent
        for _ in range(2):
            for eid, a, b, pct, vf, vt in OWNS:
                conn.execute(
                    UPSERT_OWNS,
                    {"id": eid, "a": a, "b": b, "pct": pct, "vf": vf, "vt": vt},
                )
            for eid, a, b, role, vf, vt in CONTROLS:
                conn.execute(
                    UPSERT_CONTROLS,
                    {"id": eid, "a": a, "b": b, "role": role, "vf": vf, "vt": vt},
                )
        n_nodes = rows(conn, "MATCH (n:Party) RETURN count(n) AS n")[0]["n"]
        n_edges = rows(conn, "MATCH ()-[r:OWNS]->() RETURN count(r) AS n")[0]["n"]
        check(
            "create nodes/edges idempotently",
            n_nodes == len(PARTIES) and n_edges == len(OWNS),
            f"{n_nodes} nodes, {n_edges} OWNS edges",
        )

        ubo = [
            r for r in rows(conn, UBO_PATHS, {"client": "c-client", "asOf": "2021-06-30"}) if is_simple(ids(r["ns"]))
        ]
        eff = {r["ownerId"]: effective_pct([e["pct"] for e in r["rs"]]) for r in ubo}
        check(
            "variable-length UBO paths (asOf 2021-06-30)",
            eff == {"p-ava": 49.6, "p-ben": 30.4},
            f"{eff} via {[ids(r['ns']) for r in ubo]}",
        )

        ubo_old = rows(conn, UBO_PATHS, {"client": "c-client", "asOf": "2020-06-30"})
        check(
            "point-in-time filter (asOf 2020-06-30: Ben's direct 30% only)",
            [(r["ownerId"], r["hops"]) for r in ubo_old] == [("p-ben", 1)],
            str([(r["ownerId"], [e["pct"] for e in r["rs"]]) for r in ubo_old]),
        )

        bfs = ubo_by_bfs(conn, "c-client", "2021-06-30")
        check("BFS subgraph + Python effective ownership agrees", bfs == eff, str(bfs))

        cyc_all = rows(conn, CYCLES)
        cyc = [r for r in cyc_all if is_simple(ids(r["ns"]), closed=True)]
        starts = sorted({r["startId"] for r in cyc})
        check(
            "circular ownership detected and query terminates",
            starts == ["c-x", "c-y", "c-z"] and all(r["hops"] == 3 for r in cyc),
            f"{len(cyc_all)} raw paths -> {len(cyc)} simple cycles, starts={starts}",
        )

        bfs_cycle = ubo_by_bfs(conn, "c-y", "2022-01-01")
        check(
            "UBO through a cycle is finite and cycle-safe",
            bfs_cycle == {"p-ava": 30.0},
            f"{bfs_cycle} (Ava 50% of X, X 60% of Y)",
        )

        con = rows(conn, CONNECTION, {"a": "p-nom", "b": "p-ava"})
        check(
            "undirected multi-type connection path",
            bool(con) and con[0]["hops"] == 4,
            f"{ids(con[0]['ns'])} via {ids(con[0]['rs'])}" if con else "none",
        )

        ctl = rows(conn, CONTROLLERS, {"root": "c-bellmere"})
        check(
            "controllers via non-ownership role",
            [r["controllerId"] for r in ctl] == ["p-nom"],
            str(ctl),
        )

        chg = rows(conn, CHANGES, {"since": "2020-12-31", "until": "2021-12-31"})
        check(
            "change diff between two dates",
            [r["edgeId"] for r in chg] == ["o5", "o6"],
            str(chg),
        )

        print(f"elapsed {time.perf_counter() - t0:.2f}s")
        conn.close() if hasattr(conn, "close") else None
        db.close() if hasattr(db, "close") else None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("RESULT:", "OK" if not failures else f"{len(failures)} failed: {failures}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
