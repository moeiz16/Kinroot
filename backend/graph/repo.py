"""Portable Cypher for the graph projection (ADR 0001 rules).

1. Parameters used inside list predicates are bound with `WITH` first (none needed here: we filter per hop).
2. No list comprehensions; scalar columns only, so results look the same on LadybugDB and Neo4j.
3. Simple paths only: multi-hop traversal is done hop by hop (`WHERE x.id IN $ids`) and paths are assembled in
   Python (graph.ownership), which is linear in edges, cycle-safe and identical on both engines.
4. Every traversal is bounded (`GRAPH_MAX_DEPTH`).
5. Dates are ISO strings; open validity is `coalesce(r.validTo, '9999-12-31')`.
Every query is anchored on an org-scoped node and filters `orgId`.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import date
from typing import Any

from .ownership import GEdge, GNode, Subgraph
from .store import GraphStore, chunked

OPEN_START = "0000-01-01"
OPEN_END = "9999-12-31"

# ── Writes ─────────────────────────────────────────────────────────────────────────────────────────
UPSERT_PARTIES = """
UNWIND $rows AS row
MERGE (n:Party {id: row.id})
SET n.orgId = row.orgId, n.kind = row.kind, n.name = row.name, n.normName = row.normName,
    n.jurisdiction = row.jurisdiction, n.identifiers = row.identifiers, n.birthDate = row.birthDate,
    n.nationality = row.nationality, n.isNominee = row.isNominee, n.dormant = row.dormant,
    n.source = row.source, n.sourceRef = row.sourceRef
"""
UPSERT_ADDRESSES = """
UNWIND $rows AS row
MERGE (a:Address {id: row.id})
SET a.orgId = row.orgId, a.label = row.label, a.postcode = row.postcode, a.country = row.country
"""
DELETE_PARTY = "MATCH (n:Party {id: $id}) DETACH DELETE n"
DELETE_OWNS = "MATCH (:Party)-[r:OWNS {id: $id}]->(:Party) DELETE r"
DELETE_CONTROLS = "MATCH (:Party)-[r:CONTROLS {id: $id}]->(:Party) DELETE r"
DELETE_PARTY_ADDRESS = "MATCH (:Party {id: $id})-[r:REGISTERED_AT]->(:Address) DELETE r"
CREATE_OWNS = """
UNWIND $rows AS row
MATCH (a:Party {id: row.fromId}), (b:Party {id: row.toId})
CREATE (a)-[:OWNS {id: row.id, orgId: row.orgId, fromId: row.fromId, toId: row.toId, pct: row.pct,
  interest: row.interest, role: row.role, nominee: row.nominee, validFrom: row.validFrom, validTo: row.validTo,
  source: row.source, sourceRef: row.sourceRef}]->(b)
"""
CREATE_CONTROLS = CREATE_OWNS.replace(":OWNS", ":CONTROLS")
# Batches without a percentage omit `pct`: an all-null column would be typed STRING by the engine's binder.
CREATE_OWNS_NOPCT = CREATE_OWNS.replace("pct: row.pct,\n  ", "")
CREATE_CONTROLS_NOPCT = CREATE_CONTROLS.replace("pct: row.pct,\n  ", "")
CREATE_REGISTERED = """
UNWIND $rows AS row
MATCH (a:Party {id: row.fromId}), (b:Address {id: row.toId})
CREATE (a)-[:REGISTERED_AT {id: row.id, orgId: row.orgId, fromId: row.fromId, toId: row.toId}]->(b)
"""
DELETE_ORG_PARTIES = "MATCH (n:Party) WHERE n.orgId = $org DETACH DELETE n"
# Ids are UUIDs, but a projection must never inherit another firm's leftovers: drop any node with these ids first.
DELETE_FOREIGN_PARTIES = "MATCH (n:Party) WHERE n.id IN $ids AND n.orgId <> $org DETACH DELETE n"
DELETE_ORG_ADDRESSES = "MATCH (n:Address) WHERE n.orgId = $org DETACH DELETE n"
DELETE_ORPHAN_ADDRESSES = """
MATCH (a:Address) WHERE a.orgId = $org AND NOT EXISTS { MATCH (:Party)-[:REGISTERED_AT]->(a) } DELETE a
"""

# ── Reads ──────────────────────────────────────────────────────────────────────────────────────────
NODE_COLUMNS = (
    "n.id AS id, n.kind AS kind, n.name AS name, n.jurisdiction AS jurisdiction, n.identifiers AS identifiers, "
    "n.birthDate AS birthDate, n.nationality AS nationality, n.isNominee AS isNominee, n.dormant AS dormant, "
    "n.source AS source, n.sourceRef AS sourceRef"
)
EDGE_COLUMNS = (
    "r.id AS id, label(r) AS label, r.fromId AS fromId, r.toId AS toId, r.pct AS pct, r.interest AS interest, "
    "r.role AS role, r.nominee AS nominee, r.validFrom AS validFrom, r.validTo AS validTo, r.source AS source, "
    "r.sourceRef AS sourceRef"
)
NODES_BY_ID = f"MATCH (n:Party) WHERE n.orgId = $org AND n.id IN $ids RETURN {NODE_COLUMNS}"

# Edges INTO the frontier (owners and controllers), valid at the end of asOf.
UPSTREAM_HOP = f"""
WITH $asOf AS asOf
MATCH (o:Party)-[r:OWNS|CONTROLS]->(n:Party)
WHERE n.orgId = $org AND r.orgId = $org AND n.id IN $ids
  AND coalesce(r.validFrom, '{OPEN_START}') <= asOf AND coalesce(r.validTo, '{OPEN_END}') > asOf
RETURN {EDGE_COLUMNS}
"""
# Edges OUT of the frontier (what the frontier owns or controls).
DOWNSTREAM_HOP = f"""
WITH $asOf AS asOf
MATCH (n:Party)-[r:OWNS|CONTROLS]->(o:Party)
WHERE n.orgId = $org AND r.orgId = $org AND n.id IN $ids
  AND coalesce(r.validFrom, '{OPEN_START}') <= asOf AND coalesce(r.validTo, '{OPEN_END}') > asOf
RETURN {EDGE_COLUMNS}
"""
# Officers of the frontier (any control edge out of a frontier party), used for officer appointments.
APPOINTMENT_COUNTS = f"""
WITH $asOf AS asOf
MATCH (n:Party)-[r:CONTROLS]->(c:Party)
WHERE n.orgId = $org AND r.orgId = $org AND n.id IN $ids AND r.role IN $roles
  AND coalesce(r.validFrom, '{OPEN_START}') <= asOf AND coalesce(r.validTo, '{OPEN_END}') > asOf
RETURN n.id AS partyId, count(r) AS appointments, sum(CASE WHEN c.dormant THEN 1 ELSE 0 END) AS dormant
"""
ADDRESSES_OF = """
MATCH (n:Party)-[r:REGISTERED_AT]->(a:Address)
WHERE n.orgId = $org AND n.id IN $ids
RETURN n.id AS partyId, r.id AS edgeId, a.id AS addressId, a.label AS label, a.postcode AS postcode,
       a.country AS country
"""
ADDRESS_MEMBERS = """
MATCH (n:Party)-[r:REGISTERED_AT]->(a:Address)
WHERE a.orgId = $org AND a.id IN $ids
RETURN n.id AS partyId, r.id AS edgeId, a.id AS addressId, a.label AS label, a.postcode AS postcode,
       a.country AS country
"""
ORG_ADDRESS_SIZES = """
MATCH (n:Party)-[:REGISTERED_AT]->(a:Address)
WHERE a.orgId = $org
RETURN a.id AS addressId, a.label AS label, count(n) AS members
ORDER BY members DESC
"""
ORG_OFFICER_SIZES = f"""
WITH $asOf AS asOf
MATCH (p:Party)-[r:CONTROLS]->(c:Party)
WHERE p.orgId = $org AND r.orgId = $org AND r.role IN $roles
  AND coalesce(r.validFrom, '{OPEN_START}') <= asOf AND coalesce(r.validTo, '{OPEN_END}') > asOf
RETURN p.id AS partyId, count(r) AS appointments
ORDER BY appointments DESC
"""
ORG_NOMINEE_EDGES = f"""
WITH $asOf AS asOf
MATCH (p:Party)-[r:OWNS|CONTROLS]->(c:Party)
WHERE p.orgId = $org AND r.orgId = $org AND (r.nominee = true OR p.isNominee = true OR r.role = 'nominee_for')
  AND coalesce(r.validFrom, '{OPEN_START}') <= asOf AND coalesce(r.validTo, '{OPEN_END}') > asOf
RETURN {EDGE_COLUMNS}
"""
SEARCH_PARTIES = f"""
MATCH (n:Party)
WHERE n.orgId = $org AND (n.normName CONTAINS $q OR lower(n.name) CONTAINS $q OR n.identifiers CONTAINS $q)
RETURN {NODE_COLUMNS}
LIMIT $limit
"""
ORG_PARTY_NAMES = (
    "MATCH (n:Party) WHERE n.orgId = $org RETURN n.id AS id, n.name AS name, n.normName AS normName, n.kind AS kind"
)
# All edges (any validity) touching a set of parties: for "as at" diffs and change scans.
EDGES_TOUCHING_ANY_TIME = f"""
MATCH (a:Party)-[r:OWNS|CONTROLS]->(b:Party)
WHERE a.orgId = $org AND r.orgId = $org AND (a.id IN $ids OR b.id IN $ids)
RETURN {EDGE_COLUMNS}
"""
EDGES_CHANGED_BETWEEN = f"""
MATCH (a:Party)-[r:OWNS|CONTROLS]->(b:Party)
WHERE a.orgId = $org AND r.orgId = $org
  AND ((r.validFrom > $since AND r.validFrom <= $until)
       OR (r.validTo IS NOT NULL AND r.validTo > $since AND r.validTo <= $until))
RETURN {EDGE_COLUMNS}
"""
COUNT_ORG = "MATCH (n:Party) WHERE n.orgId = $org RETURN count(n) AS n"


def iso(d: date | str | None) -> str | None:
    if d is None:
        return None
    return d if isinstance(d, str) else d.isoformat()


def node_from_row(row: dict[str, Any]) -> GNode:
    ident = row.get("identifiers")
    if isinstance(ident, str) and ident:
        try:
            ident = json.loads(ident)
        except ValueError:
            ident = {}
    return GNode(
        id=row["id"],
        kind=row.get("kind") or "other",
        name=row.get("name") or "",
        jurisdiction=row.get("jurisdiction"),
        identifiers=ident or {},
        birth_date=row.get("birthDate"),
        nationality=row.get("nationality"),
        is_nominee=bool(row.get("isNominee")),
        dormant=bool(row.get("dormant")),
        source=row.get("source"),
        source_ref=row.get("sourceRef"),
    )


def edge_from_row(row: dict[str, Any]) -> GEdge:
    label = (row.get("label") or "").upper()
    kind = "ownership" if label == "OWNS" else "control"
    pct = row.get("pct")
    return GEdge(
        id=row["id"],
        src=row["fromId"],
        dst=row["toId"],
        kind=kind,  # type: ignore[arg-type]
        pct=float(pct) if pct is not None else None,
        interest=row.get("interest"),
        role=row.get("role"),
        nominee=bool(row.get("nominee")),
        valid_from=row.get("validFrom"),
        valid_to=row.get("validTo"),
        source=row.get("source"),
        source_ref=row.get("sourceRef"),
    )


def address_node(row: dict[str, Any]) -> GNode:
    return GNode(
        id=row["addressId"], kind="address", name=row.get("label") or "Address", jurisdiction=row.get("country")
    )


def address_edge(row: dict[str, Any]) -> GEdge:
    return GEdge(id=row["edgeId"], src=row["partyId"], dst=row["addressId"], kind="address")


class GraphRepo:
    """Read/write helpers over one store, scoped to one organisation."""

    def __init__(self, store: GraphStore, org_id: str, *, max_depth: int = 10) -> None:
        self.store = store
        self.org = str(org_id)
        self.max_depth = max_depth

    # reads
    def nodes(self, ids: Iterable[str]) -> dict[str, GNode]:
        ids = sorted({str(i) for i in ids if not str(i).startswith("addr:")})
        out: dict[str, GNode] = {}
        for batch in chunked(ids, 500):
            for row in self.store.query(NODES_BY_ID, {"org": self.org, "ids": batch}):
                n = node_from_row(row)
                out[n.id] = n
        return out

    def _hop(self, query: str, ids: list[str], as_of: date) -> list[GEdge]:
        edges: list[GEdge] = []
        for batch in chunked(sorted(ids), 500):
            rows = self.store.query(query, {"org": self.org, "ids": batch, "asOf": iso(as_of)})
            edges.extend(edge_from_row(r) for r in rows)
        return edges

    def upstream(self, root_ids: Iterable[str], as_of: date, *, depth: int | None = None) -> Subgraph:
        """Owners and controllers of the roots, transitively (bounded), valid at `as_of`."""
        return self._expand(root_ids, as_of, depth, directions=("up",))

    def downstream(self, root_ids: Iterable[str], as_of: date, *, depth: int | None = None) -> Subgraph:
        return self._expand(root_ids, as_of, depth, directions=("down",))

    def neighbourhood(self, root_ids: Iterable[str], as_of: date, *, depth: int = 2) -> Subgraph:
        return self._expand(root_ids, as_of, depth, directions=("up", "down"))

    def _expand(self, root_ids: Iterable[str], as_of: date, depth: int | None, directions: tuple[str, ...]) -> Subgraph:
        depth = min(depth or self.max_depth, self.max_depth)
        roots = {str(r) for r in root_ids}
        sub = Subgraph()
        sub.levels = dict.fromkeys(roots, 0)
        frontier = set(roots)
        for level in range(1, depth + 1):
            if not frontier:
                break
            new_edges: list[GEdge] = []
            if "up" in directions:
                new_edges += self._hop(UPSTREAM_HOP, list(frontier), as_of)
            if "down" in directions:
                new_edges += self._hop(DOWNSTREAM_HOP, list(frontier), as_of)
            nxt: set[str] = set()
            for e in new_edges:
                sub.add_edge(e)
                for end in (e.src, e.dst):
                    if end not in sub.levels:
                        sub.levels[end] = level
                        nxt.add(end)
            frontier = nxt
        else:
            if frontier:
                # one more probe: is there anything beyond the depth limit?
                probe: list[GEdge] = []
                if "up" in directions:
                    probe += self._hop(UPSTREAM_HOP, list(frontier), as_of)
                if "down" in directions:
                    probe += self._hop(DOWNSTREAM_HOP, list(frontier), as_of)
                sub.truncated = any(e.src not in sub.levels or e.dst not in sub.levels for e in probe)
        for node in self.nodes(sub.levels).values():
            sub.add_node(node)
        # edges to parties no longer projected (merged away) are dropped
        sub.edges = {k: e for k, e in sub.edges.items() if e.src in sub.nodes and e.dst in sub.nodes}
        return sub

    def add_addresses(self, sub: Subgraph, party_ids: Iterable[str] | None = None) -> None:
        ids = [i for i in (party_ids if party_ids is not None else list(sub.nodes)) if not str(i).startswith("addr:")]
        for batch in chunked(sorted(set(ids)), 500):
            for row in self.store.query(ADDRESSES_OF, {"org": self.org, "ids": batch}):
                sub.add_node(address_node(row))
                sub.add_edge(address_edge(row))
                sub.levels.setdefault(row["addressId"], sub.levels.get(row["partyId"], 0) + 1)

    def addresses_of(self, party_ids: Iterable[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for batch in chunked(sorted({str(i) for i in party_ids}), 500):
            out += self.store.query(ADDRESSES_OF, {"org": self.org, "ids": batch})
        return out

    def address_members(self, address_ids: Iterable[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for batch in chunked(sorted({str(i) for i in address_ids}), 500):
            out += self.store.query(ADDRESS_MEMBERS, {"org": self.org, "ids": batch})
        return out

    def neighbours_any(self, ids: list[str], as_of: date) -> list[GEdge]:
        """Undirected one-hop edges for the frontier, including shared addresses (for connection search)."""
        party_ids = [i for i in ids if not i.startswith("addr:")]
        addr_ids = [i for i in ids if i.startswith("addr:")]
        edges = self._hop(UPSTREAM_HOP, party_ids, as_of) + self._hop(DOWNSTREAM_HOP, party_ids, as_of)
        if party_ids:
            edges += [address_edge(r) for r in self.addresses_of(party_ids)]
        if addr_ids:
            edges += [address_edge(r) for r in self.address_members(addr_ids)]
        return edges

    def appointment_counts(self, party_ids: Iterable[str], as_of: date, roles: list[str]) -> dict[str, tuple[int, int]]:
        out: dict[str, tuple[int, int]] = {}
        for batch in chunked(sorted({str(i) for i in party_ids}), 500):
            for r in self.store.query(
                APPOINTMENT_COUNTS, {"org": self.org, "ids": batch, "asOf": iso(as_of), "roles": roles}
            ):
                out[r["partyId"]] = (int(r["appointments"]), int(r["dormant"] or 0))
        return out

    def officer_sizes(self, as_of: date, roles: list[str]) -> list[tuple[str, int]]:
        rows = self.store.query(ORG_OFFICER_SIZES, {"org": self.org, "asOf": iso(as_of), "roles": roles})
        return [(r["partyId"], int(r["appointments"])) for r in rows]

    def address_sizes(self) -> list[tuple[str, str, int]]:
        rows = self.store.query(ORG_ADDRESS_SIZES, {"org": self.org})
        return [(r["addressId"], r["label"], int(r["members"])) for r in rows]

    def nominee_edges(self, as_of: date) -> list[GEdge]:
        return [edge_from_row(r) for r in self.store.query(ORG_NOMINEE_EDGES, {"org": self.org, "asOf": iso(as_of)})]

    def edges_any_time(self, ids: Iterable[str]) -> list[GEdge]:
        out: list[GEdge] = []
        for batch in chunked(sorted({str(i) for i in ids}), 500):
            out += [
                edge_from_row(r) for r in self.store.query(EDGES_TOUCHING_ANY_TIME, {"org": self.org, "ids": batch})
            ]
        return out

    def edges_changed_between(self, since: date, until: date) -> list[GEdge]:
        rows = self.store.query(EDGES_CHANGED_BETWEEN, {"org": self.org, "since": iso(since), "until": iso(until)})
        return [edge_from_row(r) for r in rows]

    def search(self, q: str, limit: int) -> list[GNode]:
        rows = self.store.query(SEARCH_PARTIES, {"org": self.org, "q": q.lower(), "limit": int(limit)})
        return [node_from_row(r) for r in rows]

    def party_names(self) -> list[dict[str, Any]]:
        return self.store.query(ORG_PARTY_NAMES, {"org": self.org})

    def count(self) -> int:
        rows = self.store.query(COUNT_ORG, {"org": self.org})
        return int(rows[0]["n"]) if rows else 0

    # writes
    def upsert_parties(self, rows: list[dict[str, Any]]) -> int:
        for batch in chunked(rows, 500):
            self.store.execute(DELETE_FOREIGN_PARTIES, {"ids": [r["id"] for r in batch], "org": self.org})
            self.store.execute(UPSERT_PARTIES, {"rows": batch})
        return len(rows)

    def delete_party(self, party_id: str) -> None:
        self.store.execute(DELETE_PARTY, {"id": str(party_id)})

    def replace_edges(self, rows: list[dict[str, Any]]) -> int:
        """Idempotent edge upsert: delete by id (endpoints may have moved after a merge), then create."""
        for row in rows:
            self.delete_edge(row["id"])
        groups = {
            (CREATE_OWNS, True): [r for r in rows if r["kind"] == "ownership" and r.get("pct") is not None],
            (CREATE_OWNS_NOPCT, False): [r for r in rows if r["kind"] == "ownership" and r.get("pct") is None],
            (CREATE_CONTROLS, True): [r for r in rows if r["kind"] == "control" and r.get("pct") is not None],
            (CREATE_CONTROLS_NOPCT, False): [r for r in rows if r["kind"] == "control" and r.get("pct") is None],
        }
        for (query, with_pct), group in groups.items():
            for batch in chunked(group, 500):
                params = [_edge_params(r) for r in batch]
                if not with_pct:
                    for p in params:
                        p.pop("pct", None)
                self.store.execute(query, {"rows": params})
        return len(rows)

    def delete_edge(self, edge_id: str) -> None:
        self.store.execute(DELETE_OWNS, {"id": str(edge_id)})
        self.store.execute(DELETE_CONTROLS, {"id": str(edge_id)})

    def set_addresses(self, links: list[dict[str, Any]]) -> int:
        """links: [{partyId, address: {id, label, postcode, country} | None}] -> replace each party's address."""
        for link in links:
            self.store.execute(DELETE_PARTY_ADDRESS, {"id": link["partyId"]})
        addresses = {link["address"]["id"]: link["address"] for link in links if link.get("address")}
        rows = [{**a, "orgId": self.org} for a in addresses.values()]
        for batch in chunked(rows, 500):
            self.store.execute(UPSERT_ADDRESSES, {"rows": batch})
        rel = [
            {"id": f"ra:{link['partyId']}", "orgId": self.org, "fromId": link["partyId"], "toId": link["address"]["id"]}
            for link in links
            if link.get("address")
        ]
        for batch in chunked(rel, 500):
            self.store.execute(CREATE_REGISTERED, {"rows": batch})
        return len(rel)

    def prune_addresses(self) -> None:
        self.store.execute(DELETE_ORPHAN_ADDRESSES, {"org": self.org})

    def clear(self) -> None:
        self.store.execute(DELETE_ORG_PARTIES, {"org": self.org})
        self.store.execute(DELETE_ORG_ADDRESSES, {"org": self.org})


def _edge_params(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": r["id"],
        "orgId": r["orgId"],
        "fromId": r["fromId"],
        "toId": r["toId"],
        "pct": float(r["pct"]) if r.get("pct") is not None else None,
        "interest": r.get("interest"),
        "role": r.get("role"),
        "nominee": bool(r.get("nominee")),
        "validFrom": r.get("validFrom") or OPEN_START,
        "validTo": r.get("validTo"),
        "source": r.get("source"),
        "sourceRef": r.get("sourceRef"),
    }
