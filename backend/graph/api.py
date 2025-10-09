"""Public interface of the graph app (builder B). The ONLY graph module other apps import.

Implementation notes (ADR 0001, 0002):
- Django (clients.Party / clients.Relationship) is the system of record; the graph is a projection.
- Writes reach the graph through the transactional outbox (graph.GraphOutbox rows written by post_save /
  post_delete signals on Party and Relationship, connected in GraphConfig.ready()). Bulk inserts bypass
  signals, so bulk loaders (seed, imports) call `rebuild_org` afterwards.
- One writer: the job worker (GRAPH_WRITER=worker) drains the outbox; the API opens the store read-only and
  reopens when `graph_version` moves. Tests, seed and single-process runs use GRAPH_WRITER=inline.
- Queries are portable Cypher (also valid on Neo4j): bind parameters used inside list predicates with WITH,
  no list comprehensions, return nodes(p)/relationships(p) and normalise in Python, keep simple paths only.
- Effective ownership = sum over simple ownership paths of the product of pcts; cycles never loop.
"""

from __future__ import annotations

import uuid
from datetime import date

from kinroot.contracts import (
    Cluster,
    ConnectionResult,
    GraphDiff,
    GraphFeatures,
    GraphNode,
    GraphView,
    SyncStatus,
    ThreadResult,
    UboResult,
)

from . import service, sync


def client_graph(org_id: uuid.UUID, client_id: uuid.UUID, *, as_of: date | None = None, depth: int = 6) -> GraphView:
    """Ownership + control structure around a client (upstream to owners, plus officers and addresses).

    Nodes carry `level` (hops from the client) and `effective_pct`; UBO nodes carry flag "ubo".
    `as_of=None` means today. Raises NotFound.
    """
    return service.client_graph(org_id, client_id, as_of=as_of, depth=depth)


def party_graph(org_id: uuid.UUID, party_id: uuid.UUID, *, as_of: date | None = None, depth: int = 2) -> GraphView:
    """Neighbourhood of any party (both directions), for expanding a node on the canvas."""
    return service.party_graph(org_id, party_id, as_of=as_of, depth=depth)


def subgraph(org_id: uuid.UUID, node_ids: list[str], edge_ids: list[str], *, as_of: date | None = None) -> GraphView:
    """Just these parties and links, for drawing an assistant answer's cited path without one call per party."""
    return service.subgraph(org_id, node_ids, edge_ids, as_of=as_of)


def beneficial_owners(
    org_id: uuid.UUID, client_id: uuid.UUID, *, as_of: date | None = None, threshold_pct: float | None = None
) -> UboResult:
    """UBOs at `as_of` (default today) with every path and a plain-language explanation.

    threshold defaults to settings.KINROOT["UBO_THRESHOLD_PCT"] (25). Control roles (trustee, appointor,
    director of a corporate trustee, significant control, nominee_for) make a person a UBO regardless of %.
    """
    return service.beneficial_owners(org_id, client_id, as_of=as_of, threshold_pct=threshold_pct)


def pull_thread(org_id: uuid.UUID, party_id: uuid.UUID, *, as_of: date | None = None) -> ThreadResult:
    """Every client this party owns or controls (directly or indirectly) with paths and effective %."""
    return service.pull_thread(org_id, party_id, as_of=as_of)


def graph_diff(org_id: uuid.UUID, client_id: uuid.UUID, from_date: date, to_date: date) -> GraphDiff:
    """Edges/nodes in the client's structure added, removed or changed between two dates."""
    return service.graph_diff(org_id, client_id, from_date, to_date)


def connection(
    org_id: uuid.UUID,
    from_party_id: uuid.UUID,
    to_party_id: uuid.UUID,
    *,
    as_of: date | None = None,
    max_hops: int = 6,
) -> ConnectionResult:
    """Shortest relationship paths between two parties, any edge type, either direction (max 3 paths)."""
    return service.connection(org_id, from_party_id, to_party_id, as_of=as_of, max_hops=max_hops)


def clusters(org_id: uuid.UUID, *, kinds: list[str] | None = None, min_size: int = 3) -> list[Cluster]:
    """Shared-officer, shared-address and nominee clusters across the whole client book."""
    return service.clusters(org_id, kinds=kinds, min_size=min_size)


def constellation(org_id: uuid.UUID) -> GraphView:
    """The client book as one network: client nodes (flag "client", risk_rating set) joined through shared
    owners, officers and addresses (intermediate parties included only when shared by >= 2 clients)."""
    return service.constellation(org_id)


def search(org_id: uuid.UUID, q: str, *, limit: int = 10) -> list[GraphNode]:
    """Name / identifier search over parties (normalised, fuzzy), clients first."""
    return service.search(org_id, q, limit=limit)


def graph_features(org_id: uuid.UUID, client_id: uuid.UUID, *, as_of: date | None = None) -> GraphFeatures:
    """Structure features consumed by risk rules and the challenger (stable names; see contracts)."""
    return service.graph_features(org_id, client_id, as_of=as_of)


def rebuild_org(org_id: uuid.UUID) -> int:
    """Re-project every Party/Relationship of the org into the graph. Returns nodes + edges written."""
    return sync.rebuild_org(org_id)


def apply_pending(limit: int = 500) -> int:
    """Drain the outbox in sequence order (worker job "graph.sync"). Returns rows applied."""
    return sync.apply_pending(limit)


def sync_status(org_id: uuid.UUID) -> SyncStatus:
    version, pending, last = sync.status(org_id)
    return SyncStatus(graph_version=version, pending=pending, last_applied_at=last)
