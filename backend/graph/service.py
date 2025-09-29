"""Graph read services: turn bounded subgraphs + ownership algorithms into the contract shapes.

Structure lives in the graph; per-client decoration (client ids, cached ratings, screening flags, merge counts)
comes from the relational system of record at read time, so a rating change never needs a graph write.
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, cast

from django.utils import timezone
from rapidfuzz import fuzz

from kinroot.contracts import (
    BeneficialOwner,
    Cluster,
    ConnectionResult,
    EdgeChange,
    GraphDiff,
    GraphEdge,
    GraphFeatures,
    GraphNode,
    GraphPath,
    GraphView,
    NotFound,
    PathHop,
    ThreadEntry,
    ThreadResult,
    UboResult,
)
from resolution.normalize import clean

from . import sync
from .common import kinroot_setting
from .jurisdictions import is_high_risk, is_offshore
from .ownership import (
    OFFICER_ROLES,
    ROLE_LABELS,
    GEdge,
    GNode,
    OwnPath,
    Subgraph,
    UboComputation,
    compute_ubo,
    downstream_reach,
    fmt_pct,
    path_sentence,
    shortest_paths,
)
from .repo import GraphRepo

log = logging.getLogger(__name__)
NODE_CAP = 400
CONNECTION_FRONTIER_CAP = 3000


def today() -> date:
    return timezone.localdate()


def threshold_for(org_id: Any, override: float | None = None) -> float:
    if override is not None:
        return float(override)
    try:
        from accounts.services import org_settings

        return float(org_settings(org_id)["ubo"]["threshold_pct"])
    except Exception:
        return float(kinroot_setting("UBO_THRESHOLD_PCT", 25.0))


def fmt_date(value: str | date | None) -> str:
    if not value:
        return ""
    d = value if isinstance(value, date) else date.fromisoformat(str(value)[:10])
    return f"{d.day} {d.strftime('%b')} {d.year}"


def _d(value: str | None) -> date | None:
    if not value or value.startswith("0000"):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


# ── Relational decoration ──────────────────────────────────────────────────────────────────────────
@dataclass
class Decor:
    clients_by_party: dict[str, tuple[str, str | None, str]] = field(default_factory=dict)  # pid -> (cid, rating, name)
    hit_flags: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    merged_counts: dict[str, int] = field(default_factory=dict)


def _client_or_404(org_id: Any, client_id: Any) -> Any:
    from clients.models import Client

    try:
        return Client.objects.get(org_id=org_id, id=client_id)
    except (Client.DoesNotExist, ValueError, TypeError) as exc:
        raise NotFound("client") from exc


def _party_or_404(org_id: Any, party_id: Any) -> Any:
    from clients.models import Party

    try:
        p = Party.objects.get(org_id=org_id, id=party_id)
    except (Party.DoesNotExist, ValueError, TypeError) as exc:
        raise NotFound("party") from exc
    if p.merged_into_id:  # a merged-away record resolves to its survivor
        return _party_or_404(org_id, p.merged_into_id)
    return p


def decorate(org_id: Any, party_ids: set[str]) -> Decor:
    from clients.models import Client, Party

    out = Decor()
    ids = [i for i in party_ids if not i.startswith("addr:")]
    for c in Client.objects.filter(org_id=org_id, party_id__in=ids).only("id", "party_id", "rating", "name"):
        out.clients_by_party[str(c.party_id)] = (str(c.id), c.rating, c.name)
    try:
        from screening.models import ScreeningHit

        hits = ScreeningHit.objects.filter(org_id=org_id, party_id__in=ids).exclude(status="false_positive")
        for pid, list_kind, status in hits.values_list("party_id", "list_kind", "status"):
            if list_kind == "pep" and status == "true_match":
                out.hit_flags[str(pid)].add("pep")
            elif list_kind == "sanctions":
                out.hit_flags[str(pid)].add("sanctions_hit")
    except Exception:  # screening tables absent during early migrations
        log.debug("screening flags unavailable", exc_info=True)
    from django.db.models import Count

    for row in (
        Party.objects.filter(org_id=org_id, merged_into_id__in=ids).values("merged_into_id").annotate(n=Count("id"))
    ):
        out.merged_counts[str(row["merged_into_id"])] = row["n"]
    return out


def to_node(n: GNode, sub: Subgraph, decor: Decor, *, ubo: UboComputation | None = None) -> GraphNode:
    flags: list[str] = []
    client = decor.clients_by_party.get(n.id)
    if client:
        flags.append("client")
    if ubo is not None and any(o.party_id == n.id and o.is_ubo for o in ubo.owners):
        flags.append("ubo")
    flags += sorted(decor.hit_flags.get(n.id, set()))
    if n.is_nominee or any(e.nominee and (e.src == n.id) for e in sub.edges.values()):
        flags.append("nominee")
    if n.kind not in ("person", "address") and is_offshore(n.jurisdiction):
        flags.append("offshore")
    if n.kind != "address" and is_high_risk(n.jurisdiction):
        flags.append("high_risk_jurisdiction")
    if n.dormant:
        flags.append("dormant")
    if ubo is not None and n.id in ubo.unknown_owner_ids:
        flags.append("unknown_owner")
    if ubo is not None and any(n.id in c for c in ubo.cycles):
        flags.append("circular")
    merged = decor.merged_counts.get(n.id, 0)
    if merged:
        flags.append("merged")
    eff = None
    if ubo is not None and n.id in ubo.entity_shares and n.id != ubo.focus_id:
        eff = round(ubo.entity_shares[n.id] * 100.0, 2) or None
    return GraphNode(
        id=n.id,
        kind=n.kind,  # type: ignore[arg-type]
        label=n.name,
        jurisdiction=n.jurisdiction,
        identifiers=dict(n.identifiers or {}),
        flags=flags,  # type: ignore[arg-type]
        client_id=client[0] if client else None,
        risk_rating=client[1] if client else None,  # type: ignore[arg-type]
        level=sub.levels.get(n.id),
        effective_pct=eff,
        merged_count=merged,
    )


def to_edge(e: GEdge) -> GraphEdge:
    return GraphEdge(
        id=e.id,
        source=e.src,
        target=e.dst,
        kind=e.kind,
        label=e.label,
        pct=round(e.pct, 2) if e.pct is not None and e.kind == "ownership" else None,
        interest=e.interest,  # type: ignore[arg-type]
        role=e.role if e.kind == "control" else None,  # type: ignore[arg-type]
        nominee=e.nominee,
        valid_from=_d(e.valid_from),
        valid_to=_d(e.valid_to),
        source_ref=e.source_ref or e.source,
    )


def to_path(sub: Subgraph, p: OwnPath, *, ownership: bool = True) -> GraphPath:
    hops = [
        PathHop(
            edge_id=e.id,
            from_id=e.src,
            to_id=e.dst,
            kind=e.kind,
            pct=e.pct if e.kind == "ownership" else None,
            role=cast(Any, e.role),
        )
        for e in p.edges
    ]
    eff = p.pct if ownership and all(e.kind == "ownership" or e.role == "nominee_for" for e in p.edges) else None
    return GraphPath(node_ids=list(p.node_ids), hops=hops, effective_pct=eff, sentence=path_sentence(sub, p))


def _view(
    focus: str | None, as_of: date, sub: Subgraph, decor: Decor, depth: int, org_id: Any, ubo: UboComputation | None
) -> GraphView:
    nodes = sorted(sub.nodes.values(), key=lambda n: (sub.levels.get(n.id, 99), n.name))
    truncated = sub.truncated
    if len(nodes) > NODE_CAP:
        nodes, truncated = nodes[:NODE_CAP], True
    keep = {n.id for n in nodes}
    edges = [e for e in sub.edges.values() if e.src in keep and e.dst in keep]
    return GraphView(
        focus_id=focus,
        as_of=as_of,
        nodes=[to_node(n, sub, decor, ubo=ubo) for n in nodes],
        edges=[to_edge(e) for e in sorted(edges, key=lambda e: e.id)],
        depth=depth,
        truncated=truncated,
        graph_version=sync.current_version(org_id),
    )


# ── Client structure ──────────────────────────────────────────────────────────────────────────────
@dataclass
class Structure:
    client: Any
    party_id: str
    as_of: date
    sub: Subgraph
    ubo: UboComputation
    repo: GraphRepo


def structure(
    org_id: Any,
    client_id: Any,
    *,
    as_of: date | None = None,
    depth: int | None = None,
    threshold_pct: float | None = None,
) -> Structure:
    client = _client_or_404(org_id, client_id)
    as_of = as_of or today()
    repo = sync.read_repo(org_id)
    pid = str(client.party_id)
    sub = repo.upstream([pid], as_of, depth=depth)
    if pid not in sub.nodes:  # projection lagging behind (worker mode): show the client party alone
        sub.nodes[pid] = GNode(pid, "company" if client.kind != "individual" else "person", client.name)
    ubo = compute_ubo(sub, pid, threshold_pct=threshold_for(org_id, threshold_pct), max_depth=repo.max_depth)
    return Structure(client, pid, as_of, sub, ubo, repo)


def client_graph(org_id: Any, client_id: Any, *, as_of: date | None = None, depth: int = 6) -> GraphView:
    st = structure(org_id, client_id, as_of=as_of, depth=depth)
    st.repo.add_addresses(st.sub)
    decor = decorate(org_id, set(st.sub.nodes))
    return _view(st.party_id, st.as_of, st.sub, decor, depth, org_id, st.ubo)


def party_graph(org_id: Any, party_id: Any, *, as_of: date | None = None, depth: int = 2) -> GraphView:
    p = _party_or_404(org_id, party_id)
    as_of = as_of or today()
    repo = sync.read_repo(org_id)
    pid = str(p.id)
    sub = repo.neighbourhood([pid], as_of, depth=max(1, min(depth, 4)))
    if pid not in sub.nodes:
        sub.nodes[pid] = GNode(pid, p.kind, p.name, p.jurisdiction or None)
    repo.add_addresses(sub, [pid, *[n for n, lvl in sub.levels.items() if lvl <= 1]])
    decor = decorate(org_id, set(sub.nodes))
    return _view(pid, as_of, sub, decor, depth, org_id, None)


def beneficial_owners(
    org_id: Any, client_id: Any, *, as_of: date | None = None, threshold_pct: float | None = None
) -> UboResult:
    st = structure(org_id, client_id, as_of=as_of, threshold_pct=threshold_pct)
    return ubo_result(st)


def ubo_result(st: Structure) -> UboResult:
    owners: list[BeneficialOwner] = []
    for o in st.ubo.owners:
        paths = [to_path(st.sub, p) for p in o.paths] + [to_path(st.sub, p, ownership=False) for p in o.control_paths]
        owners.append(
            BeneficialOwner(
                party_id=o.party_id,
                name=o.name,
                kind=o.kind,  # type: ignore[arg-type]
                effective_pct=o.pct,
                via=o.via,  # type: ignore[arg-type]
                control_roles=list(o.control_roles),  # type: ignore[arg-type]
                is_ubo=o.is_ubo,
                paths=paths,
                explanation=st.ubo.explanation(st.sub, o),
            )
        )
    return UboResult(
        client_id=str(st.client.id),
        as_of=st.as_of,
        threshold_pct=st.ubo.threshold_pct,
        owners=owners,
        unexplained_pct=st.ubo.unexplained_pct,
        cycles=st.ubo.cycles,
        warnings=st.ubo.warnings,
        computed_at=timezone.now(),
    )


# ── Pull the thread ───────────────────────────────────────────────────────────────────────────────
def pull_thread(org_id: Any, party_id: Any, *, as_of: date | None = None) -> ThreadResult:
    from clients.models import Client

    p = _party_or_404(org_id, party_id)
    as_of = as_of or today()
    repo = sync.read_repo(org_id)
    pid = str(p.id)
    sub = repo.downstream([pid], as_of)
    if pid not in sub.nodes:
        sub.nodes[pid] = GNode(pid, p.kind, p.name)
    clients = {
        str(c.party_id): c
        for c in Client.objects.filter(org_id=org_id, party_id__in=list(sub.nodes)).exclude(party_id=p.id)
    }
    hits = downstream_reach(sub, pid, set(clients), max_depth=repo.max_depth)
    entries: list[ThreadEntry] = []
    node_ids: set[str] = {pid}
    edge_ids: set[str] = set()
    for target, h in sorted(hits.items(), key=lambda kv: (-kv[1].share, clients[kv[0]].name)):
        c = clients[target]
        paths = [to_path(sub, path) for path in h.paths]
        for path in h.paths:
            node_ids.update(path.node_ids)
            edge_ids.update(e.id for e in path.edges)
        entries.append(
            ThreadEntry(
                client_id=str(c.id),
                client_name=c.name,
                effective_pct=round(h.share * 100, 2) if h.share > 1e-9 else None,
                roles=list(h.roles),  # type: ignore[arg-type]
                paths=paths,
            )
        )
    return ThreadResult(
        party_id=pid, as_of=as_of, entries=entries, node_ids=sorted(node_ids), edge_ids=sorted(edge_ids)
    )


# ── Diff ──────────────────────────────────────────────────────────────────────────────────────────
def _edge_sentence(sub: Subgraph, e: GEdge, change: str, *, before: GEdge | None = None) -> str:
    src, dst = sub.name(e.src), sub.name(e.dst)
    if change == "added":
        when = f" on {fmt_date(e.valid_from)}" if _d(e.valid_from) else ""
        if e.kind == "ownership":
            return f"{src} became a {fmt_pct(e.pct)}% owner of {dst}{when}"
        return f"{src} became {ROLE_LABELS.get(e.role or '', 'a controller').lower()} of {dst}{when}"
    if change == "removed":
        when = f" on {fmt_date(e.valid_to)}" if _d(e.valid_to) else ""
        if e.kind == "ownership":
            return f"{src} ceased to hold {fmt_pct(e.pct)}% of {dst}{when}"
        return f"{src} ceased to be {ROLE_LABELS.get(e.role or '', 'a controller').lower()} of {dst}{when}"
    assert before is not None
    when = f" on {fmt_date(e.valid_from)}" if _d(e.valid_from) else ""
    if e.kind == "ownership":
        return f"{src}'s holding in {dst} changed from {fmt_pct(before.pct)}% to {fmt_pct(e.pct)}%{when}"
    return f"{src}'s role in {dst} changed from {before.label.lower()} to {e.label.lower()}{when}"


def graph_diff(org_id: Any, client_id: Any, from_date: date, to_date: date) -> GraphDiff:
    if from_date > to_date:
        raise ValueError("`from` must be on or before `to`.")
    client = _client_or_404(org_id, client_id)
    repo = sync.read_repo(org_id)
    pid = str(client.party_id)
    a = repo.upstream([pid], from_date)
    b = repo.upstream([pid], to_date)
    names = Subgraph(nodes={**a.nodes, **b.nodes})
    added = {k: e for k, e in b.edges.items() if k not in a.edges}
    removed = {k: e for k, e in a.edges.items() if k not in b.edges}
    changed: list[EdgeChange] = []
    summary: list[str] = []
    for rk, old in list(removed.items()):
        match = next(
            (
                (ak, new)
                for ak, new in added.items()
                if (new.src, new.dst, new.kind) == (old.src, old.dst, old.kind)
                and (new.kind == "ownership" or new.role != old.role or new.pct != old.pct)
            ),
            None,
        )
        if match is None:
            continue
        ak, new = match
        fields = [f for f in ("pct", "role", "interest", "nominee") if getattr(old, f) != getattr(new, f)]
        if not fields:
            continue
        changed.append(EdgeChange(before=to_edge(old), after=to_edge(new), fields=fields))
        summary.append(_edge_sentence(names, new, "changed", before=old))
        removed.pop(rk)
        added.pop(ak)
    summary = [
        *(_edge_sentence(names, e, "added") for e in sorted(added.values(), key=lambda e: (e.valid_from or "", e.id))),
        *(
            _edge_sentence(names, e, "removed")
            for e in sorted(removed.values(), key=lambda e: (e.valid_to or "", e.id))
        ),
        *summary,
    ]
    decor = decorate(org_id, set(names.nodes))
    nodes_added = [to_node(n, b, decor) for k, n in b.nodes.items() if k not in a.nodes]
    nodes_removed = [to_node(n, a, decor) for k, n in a.nodes.items() if k not in b.nodes]
    if not summary:
        summary = [f"No ownership or control changes between {fmt_date(from_date)} and {fmt_date(to_date)}"]
    return GraphDiff(
        client_id=str(client.id),
        from_date=from_date,
        to_date=to_date,
        added=[to_edge(e) for e in added.values()],
        removed=[to_edge(e) for e in removed.values()],
        changed=changed,
        nodes_added=nodes_added,
        nodes_removed=nodes_removed,
        summary=summary,
    )


# ── Connection ────────────────────────────────────────────────────────────────────────────────────
def _hop_sentence(names: dict[str, str], e: GEdge) -> str:
    src, dst = names.get(e.src, e.src), names.get(e.dst, e.dst)
    if e.kind == "ownership":
        return f"{src} holds {fmt_pct(e.pct)}% of {dst}"
    if e.kind == "control":
        return f"{src} is {ROLE_LABELS.get(e.role or '', 'a controller').lower()} of {dst}"
    return f"{src} is registered at {dst}"


def connection(
    org_id: Any, from_party_id: Any, to_party_id: Any, *, as_of: date | None = None, max_hops: int = 6
) -> ConnectionResult:
    a = _party_or_404(org_id, from_party_id)
    b = _party_or_404(org_id, to_party_id)
    as_of = as_of or today()
    src, dst = str(a.id), str(b.id)
    if src == dst:
        return ConnectionResult(from_id=src, to_id=dst, found=True, paths=[])
    repo = sync.read_repo(org_id)
    max_hops = max(1, min(int(max_hops), repo.max_depth))
    adjacency: dict[str, list[tuple[str, GEdge]]] = defaultdict(list)
    seen_edges: set[str] = set()
    expanded: set[str] = set()
    frontier = {src}
    for _ in range(max_hops):
        todo = sorted(frontier - expanded)
        if not todo or len(expanded) > CONNECTION_FRONTIER_CAP:
            break
        expanded |= set(todo)
        nxt: set[str] = set()
        for e in repo.neighbours_any(todo, as_of):
            if e.id in seen_edges:
                continue
            seen_edges.add(e.id)
            adjacency[e.src].append((e.dst, e))
            adjacency[e.dst].append((e.src, e))
            nxt |= {e.src, e.dst}
        if dst in nxt:
            break
        frontier = nxt
    raw = shortest_paths(adjacency, src, dst, max_hops=max_hops, limit=3)
    node_ids = {src} | {n for p in raw for n, _ in p}
    party_names = {k: v.display for k, v in repo.nodes(node_ids).items()}
    for p in raw:
        for _, e in p:
            if e.kind == "address":
                party_names.setdefault(e.dst, "a shared address")
    paths: list[GraphPath] = []
    for p in raw:
        nodes = [src] + [n for n, _ in p]
        edges = [e for _, e in p]
        hops = [
            PathHop(
                edge_id=e.id,
                from_id=e.src,
                to_id=e.dst,
                kind=e.kind,
                pct=e.pct if e.kind == "ownership" else None,
                role=cast(Any, e.role),
            )
            for e in edges
        ]
        eff = None
        if edges and all(e.kind == "ownership" for e in edges):
            directed = all(e.src == nodes[i] for i, e in enumerate(edges)) or all(
                e.dst == nodes[i] for i, e in enumerate(edges)
            )
            if directed:
                prod = 1.0
                for e in edges:
                    prod *= (e.pct or 0) / 100.0
                eff = round(prod * 100, 2)
        sentence = "; ".join(_hop_sentence(party_names, e) for e in edges) + "."
        paths.append(GraphPath(node_ids=nodes, hops=hops, effective_pct=eff, sentence=sentence))
    return ConnectionResult(from_id=src, to_id=dst, found=bool(paths), paths=paths)


# ── Clusters ──────────────────────────────────────────────────────────────────────────────────────
def _clients_for(org_id: Any, party_ids: set[str]) -> list[str]:
    from clients.models import Client, ClientParty

    ids = [i for i in party_ids if not i.startswith("addr:")]
    out = set(map(str, ClientParty.objects.filter(org_id=org_id, party_id__in=ids).values_list("client_id", flat=True)))
    out |= set(map(str, Client.objects.filter(org_id=org_id, party_id__in=ids).values_list("id", flat=True)))
    return sorted(out)


def clusters(org_id: Any, *, kinds: list[str] | None = None, min_size: int = 3) -> list[Cluster]:
    kinds = kinds or ["shared_officer", "shared_address", "nominee"]
    repo = sync.read_repo(org_id)
    as_of = today()
    out: list[Cluster] = []
    if "shared_officer" in kinds:
        officer_roles = sorted(OFFICER_ROLES)
        for officer_id, n in repo.officer_sizes(as_of, officer_roles):
            if n < min_size:
                continue
            sub = repo.downstream([officer_id], as_of, depth=1)
            companies = sorted({e.dst for e in sub.edges.values() if e.kind == "control" and e.role in OFFICER_ROLES})
            name = sub.name(officer_id)
            all_director = all(
                e.role == "director" for e in sub.edges.values() if e.kind == "control" and e.dst in companies
            )
            dormant = sum(1 for c in companies if sub.nodes.get(c) and sub.nodes[c].dormant)
            label = f"{name} {'directs' if all_director else 'holds officer roles in'} {len(companies)} companies"
            reason = "One officer appears across many companies" + (f", {dormant} of them dormant" if dormant else "")
            members = {officer_id, *companies}
            out.append(
                Cluster(
                    f"cl:shared_officer:{officer_id}",
                    "shared_officer",
                    label,
                    reason,
                    sorted(members),
                    _clients_for(org_id, members),
                    len(companies),
                )
            )
    if "shared_address" in kinds:
        for address_id, label, n in repo.address_sizes():
            if n < min_size:
                continue
            members = {r["partyId"] for r in repo.address_members([address_id])}
            out.append(
                Cluster(
                    f"cl:shared_address:{address_id}",
                    "shared_address",
                    f"{n} parties registered at {label}",
                    "Several parties use the same registered address",
                    sorted(members | {address_id}),
                    _clients_for(org_id, members),
                    n,
                )
            )
    if "nominee" in kinds:
        groups: dict[str, set[str]] = defaultdict(set)
        for e in repo.nominee_edges(as_of):
            anchor = e.dst if e.role == "nominee_for" else e.src
            groups[anchor] |= {e.src, e.dst}
        names = repo.nodes(groups)
        for anchor, members in groups.items():
            size = len(members) - 1
            if size < max(1, min_size - 1):
                continue
            nm = names[anchor].name if anchor in names else anchor
            out.append(
                Cluster(
                    f"cl:nominee:{anchor}",
                    "nominee",
                    f"{nm} acts as a nominee for {size} {'entity' if size == 1 else 'entities'}",
                    "Nominee arrangements can hide the real controller",
                    sorted(members),
                    _clients_for(org_id, members),
                    size,
                )
            )
    out.sort(key=lambda c: (-len(c.client_ids), -c.size, c.id))
    return out


# ── Constellation ─────────────────────────────────────────────────────────────────────────────────
def constellation(org_id: Any) -> GraphView:
    from clients.models import Client

    as_of = today()
    repo = sync.read_repo(org_id)
    clients = list(Client.objects.filter(org_id=org_id).exclude(status="exited").order_by("name"))
    membership: dict[str, dict[str, str]] = defaultdict(dict)  # party/address -> {client party id: relation}
    nodes: dict[str, GNode] = {}
    for c in clients:
        cp = str(c.party_id)
        sub = repo.upstream([cp], as_of, depth=6)
        repo.add_addresses(sub)
        nodes.update(sub.nodes)
        for e in sub.edges.values():
            if e.kind == "address":
                membership[e.dst].setdefault(cp, "address")
            elif e.src != cp:
                rel = "ownership" if e.kind == "ownership" else "control"
                if membership[e.src].get(cp) != "ownership":
                    membership[e.src][cp] = rel
        if cp not in nodes:
            nodes[cp] = GNode(cp, "company" if c.kind != "individual" else "person", c.name)
    client_party_ids = {str(c.party_id) for c in clients}
    labels: dict[str, str] = {}
    sub = Subgraph()
    for cp in client_party_ids:
        sub.add_node(nodes[cp])
        sub.levels[cp] = 0
    for shared, rels in membership.items():
        if len(rels) < 2 and shared not in client_party_ids:
            continue
        if shared not in client_party_ids:
            sub.add_node(nodes[shared])
            sub.levels[shared] = 1
        for cp, rel in rels.items():
            if cp == shared:
                continue
            kind = "address" if rel == "address" else rel
            label = {"ownership": "Shared owner", "control": "Shared officer", "address": "Shared address"}[rel]
            src, dst = (cp, shared) if kind == "address" else (shared, cp)
            e = GEdge(f"cx:{src}:{dst}", src, dst, kind, source_ref="derived")  # type: ignore[arg-type]
            sub.add_edge(e)
            labels[e.id] = label
    decor = decorate(org_id, set(sub.nodes))
    view = _view(None, as_of, sub, decor, 1, org_id, None)
    for edge in view.edges:
        edge.label = labels.get(edge.id, edge.label)
    return view


# ── Search ────────────────────────────────────────────────────────────────────────────────────────
def search(org_id: Any, q: str, *, limit: int = 10) -> list[GraphNode]:
    q = (q or "").strip()
    if not q:
        return []
    limit = max(1, min(int(limit), 50))
    repo = sync.read_repo(org_id)
    needle = clean(q)
    found = {n.id: n for n in repo.search(needle, limit * 3)} if needle else {}
    if len(found) < limit and len(needle) >= 3:
        scored = []
        for row in repo.party_names():
            s = fuzz.WRatio(needle, row.get("normName") or clean(row.get("name")))
            if s >= 80 and row["id"] not in found:
                scored.append((s, row["id"]))
        scored.sort(reverse=True)
        found.update(repo.nodes([pid for _, pid in scored[: limit * 2]]))
    decor = decorate(org_id, set(found))
    sub = Subgraph(nodes=found)

    def rank(n: GNode) -> tuple[int, float, str]:
        return (0 if n.id in decor.clients_by_party else 1, -fuzz.WRatio(needle, clean(n.name)), n.name)

    return [to_node(n, sub, decor) for n in sorted(found.values(), key=rank)[:limit]]


# ── Risk features ─────────────────────────────────────────────────────────────────────────────────
@dataclass
class FeatureBundle:
    features: GraphFeatures
    evidence: dict[str, list[dict[str, str]]]  # feature id -> [{"type": "edge"|"node", "id": ...}]
    structure: Structure


def feature_bundle(org_id: Any, client_id: Any, *, as_of: date | None = None) -> FeatureBundle:
    st = structure(org_id, client_id, as_of=as_of)
    sub, ubo, repo = st.sub, st.ubo, st.repo
    ev: dict[str, list[dict[str, str]]] = defaultdict(list)
    entity_ids = [n.id for n in sub.nodes.values() if n.kind != "person"]
    offshore = [n for n in sub.nodes.values() if n.kind not in ("person", "address") and is_offshore(n.jurisdiction)]
    for n in offshore:
        ev["n_offshore_entities"] += [{"type": "node", "id": n.id}] + [
            {"type": "edge", "id": e.id} for e in sub.out_edges(n.id, "ownership")
        ]
    risky = sorted(
        {n.jurisdiction for n in sub.nodes.values() if n.jurisdiction and is_high_risk(n.jurisdiction)}
        | ({str(st.client.jurisdiction)} if is_high_risk(st.client.jurisdiction) else set())
    )
    for n in sub.nodes.values():
        if is_high_risk(n.jurisdiction):
            ev["high_risk_jurisdictions"].append({"type": "node", "id": n.id})
    for cyc in ubo.cycles:
        cyc_set = set(cyc)
        ev["has_cycle"] += [
            {"type": "edge", "id": e.id}
            for e in sub.edges.values()
            if e.kind == "ownership" and e.src in cyc_set and e.dst in cyc_set
        ]
    nominee_edges = [e for e in sub.edges.values() if e.nominee or e.role == "nominee_for"]
    nominee_nodes = [n for n in sub.nodes.values() if n.is_nominee]
    ev["nominee_indicators"] = [{"type": "edge", "id": e.id} for e in nominee_edges] + [
        {"type": "node", "id": n.id} for n in nominee_nodes
    ]
    officers = {e.src for e in sub.edges.values() if e.kind == "control" and e.role in OFFICER_ROLES}
    counts = repo.appointment_counts(officers, st.as_of, sorted(OFFICER_ROLES)) if officers else {}
    max_app = max((c for c, _ in counts.values()), default=0)
    top_officer = max(counts, key=lambda k: counts[k][0]) if counts else None
    if top_officer and max_app >= 2:
        ev["max_officer_appointments"].append({"type": "node", "id": top_officer})
    dormant_linked = sum(d for _, d in counts.values()) + sum(
        1 for n in sub.nodes.values() if n.dormant and n.id != st.party_id
    )
    for edge_id in ubo.chain_edge_ids:
        ev["n_layers_to_ubo"].append({"type": "edge", "id": edge_id})
    for pid in ubo.unknown_owner_ids:
        ev["unexplained_pct"].append({"type": "node", "id": pid})
    trust_nodes = [n for n in sub.nodes.values() if n.kind == "trust" and n.id != st.party_id]
    ev["trust_in_chain"] = [{"type": "node", "id": n.id} for n in trust_nodes]
    # shared clusters touching the structure
    addresses = repo.addresses_of(list(sub.nodes))
    address_ids = {r["addressId"] for r in addresses}
    members = repo.address_members(address_ids) if address_ids else []
    per_address: dict[str, int] = defaultdict(int)
    for r in members:
        per_address[r["addressId"]] += 1
    shared_addr = max(per_address.values(), default=0)
    if shared_addr >= 2:
        top_addr = max(per_address, key=lambda k: per_address[k])
        ev["shared_address_cluster_size"].append({"type": "node", "id": top_addr})
    shared_addr = shared_addr if shared_addr >= 2 else 0
    shared_officer_clients = 0
    if officers:
        others = set(_clients_for(org_id, set(officers)))
        down = repo.downstream(sorted(officers), st.as_of, depth=1)
        others |= set(_clients_for(org_id, set(down.nodes)))
        others.discard(str(st.client.id))
        shared_officer_clients = len(others)
    # screening facts
    pep = sanctions = False
    try:
        from screening.models import ScreeningHit

        hits = ScreeningHit.objects.filter(org_id=org_id, party_id__in=list(sub.nodes)).exclude(status="false_positive")
        for hid, list_kind, status in hits.values_list("id", "list_kind", "status"):
            if list_kind == "pep" and status == "true_match":
                pep = True
                ev["pep_in_structure"].append({"type": "hit", "id": str(hid)})
            if list_kind == "sanctions":
                sanctions = True
                ev["sanctions_hit_in_structure"].append({"type": "hit", "id": str(hid)})
    except Exception:
        log.debug("screening facts unavailable", exc_info=True)
    # ownership changes in the last 12 months
    since = st.as_of - timedelta(days=365)
    recent = []
    for e in repo.edges_any_time(list(sub.nodes)):
        if e.kind != "ownership":
            continue
        vf, vt = _d(e.valid_from), _d(e.valid_to)
        if (vf and since < vf <= st.as_of) or (vt and since < vt <= st.as_of):
            recent.append(e)
    ev["recent_ownership_changes_12m"] = [{"type": "edge", "id": e.id} for e in recent]
    layers = ubo.max_layers or max((lvl for nid, lvl in sub.levels.items() if nid in ubo.entity_shares), default=0)
    feats = GraphFeatures(
        client_id=str(st.client.id),
        as_of=st.as_of,
        n_layers_to_ubo=int(layers),
        n_ubos=sum(1 for o in ubo.owners if o.is_ubo),
        unexplained_pct=ubo.unexplained_pct,
        has_cycle=bool(ubo.cycles),
        n_offshore_entities=len(offshore),
        high_risk_jurisdictions=risky,
        trust_in_chain=bool(trust_nodes) or (st.client.kind == "trust" and len(entity_ids) > 1),
        nominee_indicators=len({e.id for e in nominee_edges}) + len(nominee_nodes),
        max_officer_appointments=int(max_app),
        dormant_linked_companies=int(dormant_linked),
        shared_officer_cluster_size=int(shared_officer_clients),
        shared_address_cluster_size=int(shared_addr),
        pep_in_structure=pep,
        sanctions_hit_in_structure=sanctions,
        recent_ownership_changes_12m=len(recent),
    )
    return FeatureBundle(feats, dict(ev), st)


def graph_features(org_id: Any, client_id: Any, *, as_of: date | None = None) -> GraphFeatures:
    return feature_bundle(org_id, client_id, as_of=as_of).features


def changes_since(org_id: Any, client_id: Any, since: date, until: date | None = None) -> GraphDiff:
    return graph_diff(org_id, client_id, since, until or today())


def uuid_or_none(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None
