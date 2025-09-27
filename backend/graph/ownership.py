"""Ownership and control algorithms over an in-memory subgraph (pure Python, engine-independent).

The store layer fetches a bounded subgraph hop by hop (portable Cypher, linear in edges, cycle-safe); everything
here works on that snapshot so the same code serves the API, the risk features, the assistant and the eval.

Effective ownership (contract §1.7): the sum, over every *simple* ownership path from a person to the client,
of the product of the hop percentages. Paths never repeat a node, so cycles are never looped; the share that
flows into a cycle (or into an untraced holder) is accounted for as `unexplained_pct`, and the cycles themselves
are reported separately.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Literal

from .jurisdictions import country_name, is_offshore

EdgeKind = Literal["ownership", "control", "address"]

# Roles that make a natural person a beneficial owner through control (AU AML/CTF Rules; UK MLR reg 5/6).
UBO_CONTROL_ROLES = frozenset({"trustee", "appointor", "protector", "significant_control", "nominee_for"})
OFFICER_ROLES = frozenset({"director", "secretary"})
FALLBACK_ROLES = ("senior_managing_official", "director")
PERSON = "person"
EPS = 1e-6
MAX_PATHS_PER_OWNER = 12
MAX_WALK_STEPS = 50_000  # hard bound on path enumeration (dense or malformed graphs never hang a request)

ROLE_LABELS = {
    "director": "Director",
    "secretary": "Secretary",
    "trustee": "Trustee",
    "appointor": "Appointor",
    "protector": "Protector",
    "settlor": "Settlor",
    "beneficiary": "Beneficiary",
    "partner": "Partner",
    "nominee_for": "Nominee for",
    "significant_control": "Significant control",
    "senior_managing_official": "Senior managing official",
}


@dataclass
class GNode:
    id: str
    kind: str
    name: str
    jurisdiction: str | None = None
    identifiers: dict[str, str] = field(default_factory=dict)
    birth_date: str | None = None
    nationality: str | None = None
    is_nominee: bool = False
    dormant: bool = False
    source: str | None = None
    source_ref: str | None = None

    @property
    def is_person(self) -> bool:
        return self.kind == PERSON

    @property
    def display(self) -> str:
        if self.kind != PERSON and is_offshore(self.jurisdiction):
            return f"{self.name} ({country_name(self.jurisdiction)})"
        return self.name


@dataclass
class GEdge:
    id: str
    src: str  # owner / controller / party
    dst: str  # owned / controlled entity / address
    kind: EdgeKind
    pct: float | None = None
    interest: str | None = None
    role: str | None = None
    nominee: bool = False
    valid_from: str | None = None
    valid_to: str | None = None
    source: str | None = None
    source_ref: str | None = None

    @property
    def label(self) -> str:
        if self.kind == "ownership":
            return f"{fmt_pct(self.pct)}%" if self.pct is not None else "Owner"
        if self.kind == "control":
            return ROLE_LABELS.get(self.role or "", (self.role or "Control").replace("_", " ").capitalize())
        return "Registered at"


@dataclass
class Subgraph:
    nodes: dict[str, GNode] = field(default_factory=dict)
    edges: dict[str, GEdge] = field(default_factory=dict)
    levels: dict[str, int] = field(default_factory=dict)  # hop distance from the root(s)
    truncated: bool = False

    def add_node(self, node: GNode) -> None:
        self.nodes.setdefault(node.id, node)

    def add_edge(self, edge: GEdge) -> None:
        self.edges.setdefault(edge.id, edge)

    def in_edges(self, node_id: str, kind: str | None = None) -> list[GEdge]:
        return sorted(
            (e for e in self.edges.values() if e.dst == node_id and (kind is None or e.kind == kind)),
            key=lambda e: (-(e.pct or 0.0), e.id),
        )

    def out_edges(self, node_id: str, kind: str | None = None) -> list[GEdge]:
        return sorted(
            (e for e in self.edges.values() if e.src == node_id and (kind is None or e.kind == kind)),
            key=lambda e: (-(e.pct or 0.0), e.id),
        )

    def name(self, node_id: str) -> str:
        n = self.nodes.get(node_id)
        return n.display if n else node_id


def fmt_pct(value: float | None) -> str:
    if value is None:
        return ""
    v = round(float(value), 2)
    return f"{int(v)}" if abs(v - int(v)) < 1e-9 else f"{v:g}"


# ── Paths ──────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class OwnPath:
    """A path from an upstream party down to the focus entity (edges in owner -> owned order)."""

    node_ids: list[str]
    edges: list[GEdge]
    share: float  # 0..1 product of ownership hops (nominee pass-through counts as 100%)

    @property
    def pct(self) -> float:
        return round(self.share * 100.0, 2)


def path_sentence(sub: Subgraph, path: OwnPath) -> str:
    """'Ava Calder holds 100% of Calder Family Trust, which holds 62% of Bellmere Holdings Pty Ltd, …'."""
    parts: list[str] = []
    for i, e in enumerate(path.edges):
        subject = sub.name(e.src) if i == 0 else "which"
        target = sub.name(e.dst)
        if e.kind == "ownership":
            verb = f"holds {fmt_pct(e.pct)}% of {target}"
            if e.nominee:
                verb = f"holds {fmt_pct(e.pct)}% of {target} as a nominee"
        elif e.role == "nominee_for":
            verb = f"acts through nominee {target}"
        else:
            verb = f"is {ROLE_LABELS.get(e.role or '', 'a controller').lower()} of {target}"
        parts.append(f"{subject} {verb}")
    return ", ".join(parts) + "."


# ── UBO ────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class OwnerResult:
    party_id: str
    name: str
    kind: str
    share: float = 0.0  # 0..1
    paths: list[OwnPath] = field(default_factory=list)
    control_roles: list[str] = field(default_factory=list)
    control_paths: list[OwnPath] = field(default_factory=list)
    control_notes: list[str] = field(default_factory=list)
    fallback: bool = False
    is_ubo: bool = False

    @property
    def pct(self) -> float | None:
        return round(self.share * 100.0, 2) if self.share > EPS else None

    @property
    def via(self) -> str:
        own = self.share > EPS
        ctl = bool(self.control_roles)
        return "both" if own and ctl else ("control" if ctl else "ownership")


@dataclass
class UboComputation:
    focus_id: str
    threshold_pct: float
    owners: list[OwnerResult]
    entity_shares: dict[str, float]  # every upstream party -> effective share of the focus (0..1)
    unexplained: float  # 0..1
    cycles: list[list[str]]
    warnings: list[str]
    unknown_owner_ids: set[str]
    chain_edge_ids: set[str]
    max_layers: int  # longest simple ownership chain to a natural person (hops)

    @property
    def unexplained_pct(self) -> float:
        return round(min(1.0, max(0.0, self.unexplained)) * 100.0, 2)

    def explanation(self, sub: Subgraph, owner: OwnerResult) -> str:
        focus = sub.name(self.focus_id)
        bits: list[str] = []
        if owner.share > EPS:
            n = len(owner.paths)
            chains = (
                "a direct holding"
                if n == 1 and len(owner.paths[0].edges) == 1
                else (f"{n} ownership chain{'s' if n != 1 else ''}")
            )
            bits.append(f"{owner.name} owns {fmt_pct(owner.pct)}% of {focus} through {chains}")
        if owner.control_notes:
            joined = "; ".join(owner.control_notes)
            bits.append(("and " if bits else f"{owner.name} ") + joined)
        if owner.fallback:
            bits.append(
                f"No person owns or controls {fmt_pct(self.threshold_pct)}% of {focus}, so its senior managing "
                f"official is recorded as the beneficial owner"
            )
        text = " ".join(bits) if bits else f"{owner.name} has an interest in {focus}"
        if owner.is_ubo and owner.share > EPS and not owner.control_roles and not owner.fallback:
            text += f", at or above the {fmt_pct(self.threshold_pct)}% threshold"
        return text.rstrip(".") + "."


def _ownership_links(sub: Subgraph, node_id: str) -> list[GEdge]:
    """Upstream links that carry economic interest: ownership edges into the node plus `nominee_for`
    control edges (principal -> nominee) which pass the nominee's holdings through to the principal."""
    links = [e for e in sub.in_edges(node_id, "ownership") if (e.pct or 0) > 0]
    links += [e for e in sub.in_edges(node_id, "control") if e.role == "nominee_for"]
    return links


def _link_share(e: GEdge) -> float:
    if e.kind == "control":  # nominee_for pass-through
        return 1.0
    return max(0.0, float(e.pct or 0.0)) / 100.0


def find_cycles(sub: Subgraph, *, max_len: int = 8) -> list[list[str]]:
    """Simple ownership cycles (each a list of party ids, rotated to start at the smallest id)."""
    adj: dict[str, list[str]] = defaultdict(list)
    for e in sub.edges.values():
        if e.kind == "ownership" and e.src in sub.nodes and e.dst in sub.nodes and e.dst not in adj[e.src]:
            adj[e.src].append(e.dst)
    seen: set[tuple[str, ...]] = set()
    out: list[list[str]] = []
    steps = 0
    for start in sorted(adj):
        stack: list[tuple[str, list[str]]] = [(start, [start])]
        while stack and steps < MAX_WALK_STEPS:
            steps += 1
            node, path = stack.pop()
            for nxt in sorted(set(adj.get(node, []))):
                if nxt == start and len(path) >= 2:
                    i = path.index(min(path))
                    canon = tuple(path[i:] + path[:i])
                    if canon not in seen:
                        seen.add(canon)
                        out.append(list(canon))
                elif nxt not in path and nxt > start and len(path) < max_len:
                    stack.append((nxt, [*path, nxt]))
    return sorted(out, key=lambda c: (len(c), c))


def compute_ubo(sub: Subgraph, focus_id: str, *, threshold_pct: float = 25.0, max_depth: int = 10) -> UboComputation:
    owners: dict[str, OwnerResult] = {}
    entity_shares: dict[str, float] = defaultdict(float)
    unknown: set[str] = set()
    warnings: set[str] = set()
    chain_edges: set[str] = set()
    unexplained = 0.0
    max_layers = 0
    over_allocated = False

    def owner(pid: str) -> OwnerResult:
        if pid not in owners:
            n = sub.nodes.get(pid)
            owners[pid] = OwnerResult(pid, n.name if n else pid, n.kind if n else "other")
        return owners[pid]

    def is_nominee_person(pid: str) -> bool:
        return any(e.role == "nominee_for" for e in sub.in_edges(pid, "control"))

    steps = 0

    # DFS over simple upstream paths. `trail` holds edges from the current node down to the focus.
    def walk(node_id: str, share: float, visited: frozenset[str], trail: list[GEdge], depth: int) -> None:
        nonlocal unexplained, max_layers, over_allocated, steps
        steps += 1
        if steps > MAX_WALK_STEPS:
            warnings.add("depth_limit")
            unexplained += share
            return
        node = sub.nodes.get(node_id)
        if node is None:
            unexplained += share
            return
        if node_id != focus_id:
            entity_shares[node_id] += share
        if node.is_person and not is_nominee_person(node_id):
            if node_id == focus_id:
                return
            o = owner(node_id)
            o.share += share
            path_edges = list(reversed(trail))
            node_ids = [path_edges[0].src] + [e.dst for e in path_edges]
            if len(o.paths) < MAX_PATHS_PER_OWNER:
                o.paths.append(OwnPath(node_ids, path_edges, share))
            chain_edges.update(e.id for e in trail)
            max_layers = max(max_layers, len([e for e in trail if e.kind == "ownership"]))
            return
        links = _ownership_links(sub, node_id)
        if node.kind == "other":
            unknown.add(node_id)
            unexplained += share
            chain_edges.update(e.id for e in trail)
            return
        if not links:
            if node_id != focus_id:
                unknown.add(node_id)
                unexplained += share
                chain_edges.update(e.id for e in trail)
            return
        own_total = sum(_link_share(e) for e in links if e.kind == "ownership")
        has_pass_through = any(e.kind == "control" for e in links)
        if own_total > 1.0 + 1e-4:
            over_allocated = True
        if not has_pass_through and own_total < 1.0 - 1e-4:
            unknown.add(node_id)
            unexplained += share * (1.0 - own_total)
        if depth >= max_depth:
            warnings.add("depth_limit")
            unexplained += share * min(1.0, own_total)
            return
        norm = own_total if own_total > 1.0 else 1.0  # over-allocated: scale so shares never exceed 100%
        for e in links:
            hop = 1.0 if e.kind == "control" else _link_share(e) / norm
            if e.src in visited:
                warnings.add("circular_ownership")
                unexplained += share * hop
                chain_edges.add(e.id)
                continue
            if e.nominee or (sub.nodes.get(e.src) and sub.nodes[e.src].is_nominee):
                warnings.add("nominee_in_chain")
            walk(e.src, share * hop, visited | {e.src}, [*trail, e], depth + 1)

    walk(focus_id, 1.0, frozenset({focus_id}), [], 0)
    if over_allocated:
        warnings.add("over_allocated")
    if unknown:
        warnings.add("unknown_owner")
    if sub.truncated:
        warnings.add("depth_limit")

    # ── Control ────────────────────────────────────────────────────────────────────────────────────
    threshold = threshold_pct / 100.0
    controlled = {focus_id} | {
        pid
        for pid, s in entity_shares.items()
        if pid in sub.nodes
        and not sub.nodes[pid].is_person
        and (s + EPS >= threshold or sub.nodes[pid].kind == "trust")
    }

    def add_control(pid: str, role: str, target: str, note: str, edges: list[GEdge]) -> None:
        o = owner(pid)
        if role not in o.control_roles:
            o.control_roles.append(role)
        if note not in o.control_notes:
            o.control_notes.append(note)
        node_ids = [edges[0].src] + [e.dst for e in edges]
        o.control_paths.append(OwnPath(node_ids, edges, 0.0))
        chain_edges.update(e.id for e in edges)

    for target in sorted(controlled):
        for e in sub.in_edges(target, "control"):
            if e.role not in UBO_CONTROL_ROLES or e.role == "nominee_for":
                continue
            if e.nominee:
                warnings.add("nominee_in_chain")
            ctl = sub.nodes.get(e.src)
            if ctl is None:
                continue
            role_label = ROLE_LABELS.get(e.role or "", e.role or "").lower()
            if ctl.is_person:
                principals = [p for p in sub.in_edges(ctl.id, "control") if p.role == "nominee_for"]
                if principals:
                    warnings.add("nominee_in_chain")
                    for p in principals:
                        add_control(
                            p.src,
                            "nominee_for",
                            target,
                            f"controls {sub.name(target)} through nominee {ctl.name} ({role_label})",
                            [p, e],
                        )
                else:
                    add_control(
                        ctl.id, e.role or "significant_control", target, f"is {role_label} of {sub.name(target)}", [e]
                    )
            else:
                # corporate controller (e.g. a corporate trustee): its directors and controllers control too
                for d in sub.in_edges(ctl.id, "control"):
                    dn = sub.nodes.get(d.src)
                    if dn is None or not dn.is_person or d.role not in OFFICER_ROLES | UBO_CONTROL_ROLES:
                        continue
                    if d.nominee or dn.is_nominee:
                        warnings.add("nominee_in_chain")
                    add_control(
                        dn.id,
                        d.role or "director",
                        target,
                        f"is {ROLE_LABELS.get(d.role or '', 'director').lower()} of {ctl.name}, "
                        f"the {role_label} of {sub.name(target)}",
                        [d, e],
                    )
    # nominee officers anywhere in the chain are an indicator even when they are not UBOs
    for target in controlled:
        for e in sub.in_edges(target, "control"):
            src = sub.nodes.get(e.src)
            if e.nominee or (src is not None and src.is_nominee):
                warnings.add("nominee_in_chain")

    for o in owners.values():
        o.is_ubo = (o.share + EPS >= threshold) or bool(o.control_roles)

    if not any(o.is_ubo for o in owners.values()):
        for role in FALLBACK_ROLES:
            officials = [e for e in sub.in_edges(focus_id, "control") if e.role == role]
            officials = [e for e in officials if sub.nodes.get(e.src) and sub.nodes[e.src].is_person]
            if officials:
                for e in officials:
                    o = owner(e.src)
                    o.fallback = True
                    o.is_ubo = True
                    if "senior_managing_official" not in o.control_roles:
                        o.control_roles.append("senior_managing_official")
                    o.control_paths.append(OwnPath([e.src, e.dst], [e], 0.0))
                    chain_edges.add(e.id)
                break

    people = [o for o in owners.values() if o.kind == PERSON or o.share > EPS or o.control_roles]
    people = [o for o in people if o.share > EPS or o.control_roles or o.fallback]
    people.sort(key=lambda o: (not o.is_ubo, -o.share, o.name))
    for o in people:
        o.paths.sort(key=lambda p: (-p.share, len(p.edges)))

    cycles = [c for c in find_cycles(sub) if set(c) & (set(entity_shares) | {focus_id})]
    if cycles:
        warnings.add("circular_ownership")
    order = ["circular_ownership", "unknown_owner", "depth_limit", "over_allocated", "nominee_in_chain"]
    return UboComputation(
        focus_id=focus_id,
        threshold_pct=threshold_pct,
        owners=people,
        entity_shares=dict(entity_shares),
        unexplained=unexplained,
        cycles=cycles,
        warnings=[w for w in order if w in warnings],
        unknown_owner_ids=unknown,
        chain_edge_ids=chain_edges,
        max_layers=max_layers,
    )


# ── Downstream ("pull the thread") ────────────────────────────────────────────────────────────────
@dataclass
class ThreadHit:
    target_id: str
    share: float
    roles: list[str]
    paths: list[OwnPath]


def downstream_reach(sub: Subgraph, source_id: str, targets: set[str], *, max_depth: int = 8) -> dict[str, ThreadHit]:
    """Every target reachable from `source_id` along directed ownership/control edges (simple paths).
    Share sums pure-ownership paths only; roles are the control roles held along the paths."""
    hits: dict[str, ThreadHit] = {}

    steps = 0

    def walk(node_id: str, share: float | None, visited: frozenset[str], trail: list[GEdge]) -> None:
        nonlocal steps
        steps += 1
        if steps > MAX_WALK_STEPS:
            return
        if node_id in targets and trail:
            h = hits.setdefault(node_id, ThreadHit(node_id, 0.0, [], []))
            if share is not None:
                h.share += share
            first = trail[0]  # the party's own role on this path (not roles held further down the chain)
            if first.kind == "control" and first.role and first.role not in h.roles:
                h.roles.append(first.role)
            if len(h.paths) < MAX_PATHS_PER_OWNER:
                h.paths.append(OwnPath([trail[0].src] + [e.dst for e in trail], list(trail), share or 0.0))
        if len(trail) >= max_depth:
            return
        for e in sub.out_edges(node_id):
            if e.kind == "address" or e.dst in visited:
                continue
            ownership_hop = e.kind == "ownership" and share is not None
            nxt = share * max(0.0, float(e.pct or 0.0)) / 100.0 if ownership_hop and share is not None else None
            walk(e.dst, nxt, visited | {e.dst}, [*trail, e])

    walk(source_id, 1.0, frozenset({source_id}), [])
    for h in hits.values():
        h.paths.sort(key=lambda p: (len(p.edges), -p.share))
    return hits


# ── Connection (undirected shortest simple paths) ─────────────────────────────────────────────────
def shortest_paths(
    adjacency: dict[str, list[tuple[str, GEdge]]], source: str, target: str, *, max_hops: int = 6, limit: int = 3
) -> list[list[tuple[str, GEdge]]]:
    """BFS layers with multi-parent bookkeeping, then enumerate up to `limit` shortest simple paths.
    Returns paths as [(node_id, edge_used_to_reach_it), ...] excluding the source."""
    if source == target:
        return []
    parents: dict[str, list[tuple[str, GEdge]]] = defaultdict(list)
    dist = {source: 0}
    frontier = [source]
    found = False
    for d in range(1, max_hops + 1):
        nxt: list[str] = []
        for node in frontier:
            for nb, edge in adjacency.get(node, []):
                if nb not in dist:
                    dist[nb] = d
                    nxt.append(nb)
                if dist.get(nb) == d:
                    parents[nb].append((node, edge))
        if target in dist:
            found = True
            break
        frontier = sorted(set(nxt))
        if not frontier:
            break
    if not found:
        return []
    out: list[list[tuple[str, GEdge]]] = []

    def back(node: str, acc: list[tuple[str, GEdge]]) -> None:
        if len(out) >= limit:
            return
        if node == source:
            out.append(list(reversed(acc)))
            return
        for parent, edge in sorted(parents[node], key=lambda pe: (pe[1].kind != "ownership", pe[1].id)):
            if any(parent == n for n, _ in acc):
                continue
            back(parent, [*acc, (node, edge)])

    back(target, [])
    return out
