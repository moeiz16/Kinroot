// Ownership-graph calculations for the offline fixture adapter. These mirror what the API's graph module does
// (traversal, compounded ownership, cycles, diffs, connections) so the web app behaves the same without a server.
import type {
  Address,
  BeneficialOwner,
  Client,
  Cluster,
  ConnectionResult,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphNodeAttributes,
  GraphPath,
  GraphPayload,
  NodeFlag,
  PartyKind,
  PathHop,
  Relationship,
  ThreadResult,
  UboResult,
  UboWarning,
} from "../types";

export type WKind = PartyKind | "stack";
export interface WParty {
  id: string;
  kind: WKind;
  name: string;
  birthDate?: string;
  nationality?: string;
  jurisdiction?: string;
  identifiers: { acn?: string; abn?: string; ukCompanyNumber?: string; passport?: string };
  address?: Address | string;
  isNominee: boolean;
  dormant?: boolean;
  source: "manual" | "uk_ch" | "au_abr" | "seed" | "import";
  sourceRef?: string;
  mergedInto: string | null;
  createdAt: string;
  flags: NodeFlag[];
  count?: number;
  sub?: string;
}
export interface WorldGraph {
  parties: Record<string, WParty>;
  rels: Relationship[];
  clients: Client[];
  addressLinks: { partyId: string; addressId: string }[];
}

export const isActive = (r: Relationship, asOf: string) => r.validFrom <= asOf && (r.validTo === null || r.validTo > asOf);
const pctLabel = (p: number) => `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
const round2 = (n: number) => Math.round(n * 100) / 100;

function relsInto(g: WorldGraph, asOf: string): Map<string, Relationship[]> {
  const m = new Map<string, Relationship[]>();
  for (const r of g.rels) {
    if (!isActive(r, asOf)) continue;
    if (g.parties[r.fromPartyId]?.mergedInto || g.parties[r.toPartyId]?.mergedInto) continue;
    const list = m.get(r.toPartyId) ?? [];
    list.push(r);
    m.set(r.toPartyId, list);
  }
  return m;
}

/** Breadth-first walk from a client's party up through everyone who owns or controls it. */
export function structure(g: WorldGraph, rootId: string, asOf: string, depth = 6): { levels: Map<string, number>; edges: Relationship[]; truncated: boolean } {
  const into = relsInto(g, asOf);
  const levels = new Map<string, number>([[rootId, 0]]);
  const edges: Relationship[] = [];
  const seenEdge = new Set<string>();
  let frontier = [rootId];
  let truncated = false;
  for (let lvl = 1; frontier.length; lvl++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const r of into.get(id) ?? []) {
        if (lvl > depth) {
          truncated = true;
          continue;
        }
        if (!seenEdge.has(r.id)) {
          seenEdge.add(r.id);
          edges.push(r);
        }
        if (!levels.has(r.fromPartyId)) {
          levels.set(r.fromPartyId, lvl);
          next.push(r.fromPartyId);
        }
      }
    }
    frontier = next;
  }
  return { levels, edges, truncated };
}

function nodeAttrs(g: WorldGraph, p: WParty, level: number, extra: Partial<GraphNodeAttributes> = {}): GraphNodeAttributes {
  const client = g.clients.find((c) => c.partyId === p.id);
  const flags = new Set<NodeFlag>(p.flags);
  if (client) flags.add("client");
  if (p.isNominee) flags.add("nominee");
  if (p.dormant) flags.add("dormant");
  return {
    label: p.name,
    kind: p.kind === "stack" ? "stack" : p.kind,
    jurisdiction: p.jurisdiction ?? null,
    identifiers: p.identifiers,
    flags: [...flags],
    clientId: client?.id ?? null,
    riskRating: client?.rating ?? null,
    level,
    effectivePct: null,
    mergedCount: Object.values(g.parties).filter((x) => x.mergedInto === p.id).length,
    ...(p.count ? { count: p.count } : {}),
    ...(p.sub ? { sub: p.sub } : {}),
    ...extra,
  };
}

function edgeAttrs(r: Relationship): GraphEdge {
  return {
    id: r.id,
    source: r.fromPartyId,
    target: r.toPartyId,
    kind: r.kind,
    label: r.kind === "ownership" ? (r.pct != null ? pctLabel(r.pct) : "?%") : (r.role ?? "Controls"),
    pct: r.pct ?? null,
    interest: r.interest ?? null,
    role: r.role ?? null,
    nominee: r.nominee,
    validFrom: r.validFrom,
    validTo: r.validTo,
    sourceRef: r.sourceRef ?? r.source,
  };
}
export const toGraphEdge = edgeAttrs;

export function toPayload(nodes: GraphNode[], edges: GraphEdge[], attrs: Partial<GraphPayload["attributes"]> & { asOf: string }): GraphPayload {
  return {
    attributes: { focusId: null, depth: 6, truncated: false, graphVersion: 418, ...attrs },
    nodes: nodes.map(({ id, ...a }) => ({ key: id, attributes: a })),
    edges: edges.map(({ id, source, target, ...a }) => ({ key: id, source, target, attributes: a })),
  };
}

export function clientGraph(g: WorldGraph, client: Client, asOf: string, depth = 6): GraphPayload {
  const s = structure(g, client.partyId, asOf, depth);
  const ubo = beneficialOwners(g, client, asOf, 25);
  const uboIds = new Set(ubo.owners.filter((o) => o.isUbo).map((o) => o.partyId));
  const cyc = new Set(ubo.cycles.flat());
  const nodes: GraphNode[] = [...s.levels.entries()].map(([id, level]) => {
    const p = g.parties[id]!;
    const owner = ubo.owners.find((o) => o.partyId === id);
    const a = nodeAttrs(g, p, level, { effectivePct: owner?.effectivePct ?? null });
    if (uboIds.has(id)) a.flags = [...new Set([...a.flags, "ubo" as NodeFlag])];
    if (cyc.has(id)) a.flags = [...new Set([...a.flags, "circular" as NodeFlag])];
    return { id, ...a };
  });
  const edges = s.edges.map(edgeAttrs);
  // Like the API: an entity whose recorded shareholdings fall short of 100% gets an "Unknown shareholders" group.
  for (const n of [...nodes]) {
    if (!n.flags.includes("unknown_owner") || n.kind === "person" || n.kind === "address") continue;
    const own = edges.filter((e) => e.target === n.id && e.kind === "ownership");
    const missing = Math.round((100 - own.reduce((t, e) => t + (e.pct ?? 0), 0)) * 100) / 100;
    if (missing <= 0) continue;
    const id = `unknown:${n.id}`;
    nodes.push({ id, kind: "unknown" as GraphNode["kind"], label: "Unknown shareholders", sub: "Not yet known · 1 or more", jurisdiction: null, identifiers: {}, flags: [], clientId: null, riskRating: null, level: (n.level ?? 0) + 1, effectivePct: null, mergedCount: 0 } as GraphNode);
    edges.push({ id: `unknown-edge:${n.id}`, source: id, target: n.id, kind: "ownership", label: own.length ? pctLabel(missing) : "?%", pct: null, interest: null, role: null, nominee: false, validFrom: null, validTo: null, sourceRef: "register gap" } as unknown as GraphEdge);
  }
  return toPayload(nodes, edges, { focusId: client.partyId, asOf, depth, truncated: s.truncated });
}

/** Expand one party: its direct owners/controllers and what it owns/controls. */
export function partyGraph(g: WorldGraph, partyId: string, asOf: string, depth = 2): GraphPayload {
  const levels = new Map<string, number>([[partyId, 0]]);
  const edges = new Map<string, Relationship>();
  let frontier = [partyId];
  for (let lvl = 1; lvl <= depth && frontier.length; lvl++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const r of g.rels) {
        if (!isActive(r, asOf) || (r.fromPartyId !== id && r.toPartyId !== id)) continue;
        edges.set(r.id, r);
        const other = r.fromPartyId === id ? r.toPartyId : r.fromPartyId;
        if (!levels.has(other)) {
          levels.set(other, lvl);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  const nodes = [...levels.entries()].map(([id, level]) => ({ id, ...nodeAttrs(g, g.parties[id]!, level) }));
  return toPayload(nodes, [...edges.values()].map(edgeAttrs), { focusId: partyId, asOf, depth });
}

function pathSentence(g: WorldGraph, hops: PathHop[]): string {
  const name = (id: string) => g.parties[id]?.name ?? "Unknown";
  return (
    hops
      .map((h, i) => {
        const verb = h.kind === "ownership" ? `${i === 0 ? "owns" : "which owns"} ${h.pct != null ? pctLabel(h.pct) : "an unknown share"} of` : `${i === 0 ? "is" : "which is"} ${(h.role ?? "controller").toLowerCase()} of`;
        return `${i === 0 ? name(h.fromId) + " " : ""}${verb} ${name(h.toId)}`;
      })
      .join(", ") + "."
  );
}

/** Every simple path from `fromId` up to `toId` following relationship direction (owner → owned). */
function simplePaths(into: Map<string, Relationship[]>, fromId: string, toId: string, opts: { ownershipOnly: boolean; maxHops: number }): Relationship[][] {
  // Walk backwards from the target so the search stays inside the structure.
  const out: Relationship[][] = [];
  const stack: Relationship[] = [];
  const onPath = new Set<string>([toId]);
  const visit = (node: string) => {
    if (stack.length >= opts.maxHops) return;
    for (const r of into.get(node) ?? []) {
      if (opts.ownershipOnly && r.kind !== "ownership") continue;
      if (onPath.has(r.fromPartyId)) continue;
      stack.push(r);
      if (r.fromPartyId === fromId) out.push([...stack].reverse());
      else {
        onPath.add(r.fromPartyId);
        visit(r.fromPartyId);
        onPath.delete(r.fromPartyId);
      }
      stack.pop();
    }
  };
  visit(toId);
  return out;
}

function toPath(g: WorldGraph, rels: Relationship[]): GraphPath {
  const hops: PathHop[] = rels.map((r) => ({ edgeId: r.id, fromId: r.fromPartyId, toId: r.toPartyId, kind: r.kind, pct: r.pct ?? null, role: r.role ?? null }));
  const allOwn = rels.every((r) => r.kind === "ownership" && r.pct != null);
  const eff = allOwn ? round2(rels.reduce((acc, r) => acc * ((r.pct ?? 0) / 100), 1) * 100) : null;
  return { nodeIds: [rels[0]!.fromPartyId, ...rels.map((r) => r.toPartyId)], hops, effectivePct: eff, sentence: pathSentence(g, hops) };
}

export function findCycles(g: WorldGraph, ids: Set<string>, asOf: string): string[][] {
  const adj = new Map<string, string[]>();
  for (const r of g.rels) {
    if (r.kind !== "ownership" || !isActive(r, asOf) || !ids.has(r.fromPartyId) || !ids.has(r.toPartyId)) continue;
    adj.set(r.fromPartyId, [...(adj.get(r.fromPartyId) ?? []), r.toPartyId]);
  }
  const cycles: string[][] = [];
  // Each simple cycle is reported once, rooted at its smallest id.
  for (const start of [...ids].sort()) {
    const path = [start];
    const dfs = (n: string) => {
      for (const m of adj.get(n) ?? []) {
        if (m === start && path.length > 1) cycles.push([...path]);
        else if (m > start && !path.includes(m)) {
          path.push(m);
          dfs(m);
          path.pop();
        }
      }
    };
    dfs(start);
  }
  return cycles;
}

export function beneficialOwners(g: WorldGraph, client: Client, asOf: string, thresholdPct = 25): UboResult {
  const s = structure(g, client.partyId, asOf, 6);
  const into = relsInto(g, asOf);
  const ids = new Set(s.levels.keys());
  const owners: BeneficialOwner[] = [];
  const warnings = new Set<UboWarning>();
  const trusts = [...ids].filter((id) => g.parties[id]?.kind === "trust");
  const trusteeCompanies = new Set(s.edges.filter((r) => r.kind === "control" && /trustee/i.test(r.role ?? "") && trusts.includes(r.toPartyId)).map((r) => r.fromPartyId));
  for (const id of ids) {
    const p = g.parties[id]!;
    if (p.kind !== "person" || id === client.partyId) continue;
    const ownPaths = simplePaths(into, id, client.partyId, { ownershipOnly: true, maxHops: 6 }).map((rels) => toPath(g, rels));
    const eff = ownPaths.length ? round2(ownPaths.reduce((acc, p2) => acc + (p2.effectivePct ?? 0), 0)) : null;
    const controls = s.edges.filter(
      (r) => r.kind === "control" && r.fromPartyId === id && (r.toPartyId === client.partyId || trusts.includes(r.toPartyId) || trusteeCompanies.has(r.toPartyId)),
    );
    const controlPaths = controls.map((r) => {
      const tail = r.toPartyId === client.partyId ? [] : (simplePaths(into, r.toPartyId, client.partyId, { ownershipOnly: false, maxHops: 5 })[0] ?? []);
      return toPath(g, [r, ...tail]);
    });
    if (!ownPaths.length && !controls.length) continue;
    const isOwner = eff != null && eff >= thresholdPct;
    const isUbo = isOwner || controls.length > 0;
    if (controls.some((r) => r.nominee) || p.isNominee) warnings.add("nominee_in_chain");
    const via = isOwner && controls.length ? "both" : controls.length && !isOwner ? "control" : "ownership";
    const roles = [...new Set(controls.map((r) => r.role ?? "Controller"))];
    const best = ownPaths.slice().sort((a, b) => (b.effectivePct ?? 0) - (a.effectivePct ?? 0))[0];
    const explanation = best
      ? `${p.name} ${isOwner ? "owns" : "holds"} ${pctLabel(eff ?? 0)} of ${client.name}${ownPaths.length > 1 ? ` across ${ownPaths.length} paths` : ""}: ${best.sentence}`
      : `${p.name} controls ${client.name} as ${roles.join(" and ").toLowerCase()}.`;
    owners.push({ partyId: id, name: p.name, kind: "person", effectivePct: eff, via, controlRoles: roles, isUbo, paths: [...ownPaths, ...controlPaths], explanation });
  }
  owners.sort((a, b) => Number(b.isUbo) - Number(a.isUbo) || (b.effectivePct ?? 0) - (a.effectivePct ?? 0));

  // Share of the client that cannot be traced to anyone: missing ownership on each entity × that entity's share of the client.
  let unexplained = 0;
  for (const id of ids) {
    const p = g.parties[id]!;
    if (p.kind === "person" || p.kind === "address" || p.kind === "stack") continue;
    const incoming = (into.get(id) ?? []).filter((r) => r.kind === "ownership");
    if (!incoming.length && id !== client.partyId && !p.flags.includes("unknown_owner")) continue;
    if (id === client.partyId && !incoming.length) continue;
    const known = incoming.reduce((a, r) => a + (r.pct ?? 0), 0);
    const missing = Math.max(0, 100 - known);
    if (missing <= 0) continue;
    if (!p.flags.includes("unknown_owner")) continue;
    warnings.add("unknown_owner");
    const share =
      id === client.partyId
        ? 1
        : simplePaths(into, id, client.partyId, { ownershipOnly: true, maxHops: 6 }).reduce((acc, rels) => acc + rels.reduce((m, r) => m * ((r.pct ?? 0) / 100), 1), 0);
    unexplained += (missing / 100) * share * 100;
  }
  if (s.edges.some((r) => r.nominee) || [...ids].some((id) => g.parties[id]?.isNominee)) warnings.add("nominee_in_chain");
  const cycles = findCycles(g, ids, asOf);
  if (cycles.length) warnings.add("circular_ownership");
  if (s.truncated) warnings.add("depth_limit");
  return {
    clientId: client.id,
    asOf,
    thresholdPct,
    owners,
    unexplainedPct: round2(unexplained),
    cycles,
    warnings: [...warnings],
    computedAt: new Date().toISOString(),
  };
}

export function graphDiff(g: WorldGraph, client: Client, fromDate: string, toDate: string): GraphDiff {
  const a = structure(g, client.partyId, fromDate);
  const b = structure(g, client.partyId, toDate);
  const key = (r: Relationship) => `${r.fromPartyId}>${r.toPartyId}>${r.kind}`;
  const before = new Map(a.edges.map((r) => [key(r), r]));
  const after = new Map(b.edges.map((r) => [key(r), r]));
  const added: GraphEdge[] = [];
  const removed: GraphEdge[] = [];
  const changed: GraphDiff["changed"] = [];
  for (const [k, r] of after) {
    const old = before.get(k);
    if (!old) added.push(edgeAttrs(r));
    else if (old.pct !== r.pct || old.role !== r.role) changed.push({ before: edgeAttrs(old), after: edgeAttrs(r), fields: old.pct !== r.pct ? ["pct"] : ["role"] });
  }
  for (const [k, r] of before) if (!after.has(k)) removed.push(edgeAttrs(r));
  const nodesAdded = [...b.levels.keys()].filter((id) => !a.levels.has(id)).map((id) => ({ id, ...nodeAttrs(g, g.parties[id]!, b.levels.get(id)!) }));
  const nodesRemoved = [...a.levels.keys()].filter((id) => !b.levels.has(id)).map((id) => ({ id, ...nodeAttrs(g, g.parties[id]!, a.levels.get(id)!) }));
  const name = (id: string) => g.parties[id]?.name ?? "Someone";
  const summary = [
    ...added.map((e) => `${name(e.source)} ${e.kind === "ownership" ? `now holds ${e.label} of` : `became ${e.label.toLowerCase()} of`} ${name(e.target)}.`),
    ...removed.map((e) => `${name(e.source)} ${e.kind === "ownership" ? "no longer holds shares in" : `is no longer ${e.label.toLowerCase()} of`} ${name(e.target)}.`),
    ...changed.map((c) => `${name(c.after.source)}'s holding in ${name(c.after.target)} changed from ${c.before.label} to ${c.after.label}.`),
  ];
  return { clientId: client.id, fromDate, toDate, added, removed, changed, nodesAdded, nodesRemoved, summary };
}

export function pullThread(g: WorldGraph, partyId: string, asOf: string): ThreadResult {
  const into = relsInto(g, asOf);
  const entries: ThreadResult["entries"] = [];
  const nodeIds = new Set<string>([partyId]);
  const edgeIds = new Set<string>();
  for (const c of g.clients) {
    if (c.partyId === partyId) continue;
    const paths = simplePaths(into, partyId, c.partyId, { ownershipOnly: false, maxHops: 6 }).map((r) => toPath(g, r));
    if (!paths.length) continue;
    paths.sort((a, b) => (b.effectivePct ?? -1) - (a.effectivePct ?? -1) || a.hops.length - b.hops.length);
    const own = paths.filter((p) => p.effectivePct != null);
    const roles = [...new Set(paths.flatMap((p) => p.hops.filter((h) => h.kind === "control" && h.fromId === partyId).map((h) => h.role ?? "Controller")))];
    entries.push({ clientId: c.id, clientName: c.name, effectivePct: own.length ? round2(own.reduce((a, p) => a + (p.effectivePct ?? 0), 0)) : null, roles, paths });
    paths.forEach((p) => {
      p.nodeIds.forEach((n) => nodeIds.add(n));
      p.hops.forEach((h) => edgeIds.add(h.edgeId));
    });
  }
  return { partyId, asOf, entries, nodeIds: [...nodeIds], edgeIds: [...edgeIds] };
}

export function connection(g: WorldGraph, fromId: string, toId: string, asOf: string, maxHops = 6): ConnectionResult {
  const adj = new Map<string, Relationship[]>();
  for (const r of g.rels) {
    if (!isActive(r, asOf)) continue;
    adj.set(r.fromPartyId, [...(adj.get(r.fromPartyId) ?? []), r]);
    adj.set(r.toPartyId, [...(adj.get(r.toPartyId) ?? []), r]);
  }
  const paths: Relationship[][] = [];
  let frontier: { at: string; rels: Relationship[]; seen: Set<string> }[] = [{ at: fromId, rels: [], seen: new Set([fromId]) }];
  for (let hop = 0; hop < maxHops && paths.length < 3 && frontier.length; hop++) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      for (const r of adj.get(f.at) ?? []) {
        const other = r.fromPartyId === f.at ? r.toPartyId : r.fromPartyId;
        if (f.seen.has(other)) continue;
        const rels = [...f.rels, r];
        if (other === toId) paths.push(rels);
        else next.push({ at: other, rels, seen: new Set([...f.seen, other]) });
      }
    }
    frontier = next.slice(0, 400);
  }
  const out: GraphPath[] = paths.slice(0, 3).map((rels) => {
    let at = fromId;
    const nodeIds = [fromId];
    const hops: PathHop[] = rels.map((r) => {
      const other = r.fromPartyId === at ? r.toPartyId : r.fromPartyId;
      at = other;
      nodeIds.push(other);
      return { edgeId: r.id, fromId: r.fromPartyId, toId: r.toPartyId, kind: r.kind, pct: r.pct ?? null, role: r.role ?? null };
    });
    return { nodeIds, hops, effectivePct: null, sentence: pathSentence(g, hops) };
  });
  return { fromId, toId, found: out.length > 0, paths: out };
}

/** Parties that sit in more than one client's structure, with the clients they connect. */
export function sharedParties(g: WorldGraph, asOf: string): Map<string, { clientIds: Set<string>; roles: Set<string> }> {
  const out = new Map<string, { clientIds: Set<string>; roles: Set<string> }>();
  for (const c of g.clients) {
    const s = structure(g, c.partyId, asOf, 6);
    for (const id of s.levels.keys()) {
      if (id === c.partyId) continue;
      const entry = out.get(id) ?? { clientIds: new Set(), roles: new Set() };
      entry.clientIds.add(c.id);
      s.edges.filter((r) => r.fromPartyId === id).forEach((r) => entry.roles.add(r.kind === "control" ? (r.role ?? "Controller") : "Owner"));
      out.set(id, entry);
    }
  }
  for (const link of g.addressLinks) {
    const c = g.clients.find((x) => x.partyId === link.partyId);
    if (!c) continue;
    const entry = out.get(link.addressId) ?? { clientIds: new Set(), roles: new Set(["Registered office"]) };
    entry.clientIds.add(c.id);
    out.set(link.addressId, entry);
  }
  for (const [id, e] of out) if (e.clientIds.size < 2) out.delete(id);
  return out;
}

export function constellation(g: WorldGraph, asOf: string): GraphPayload {
  const shared = sharedParties(g, asOf);
  const nodes: GraphNode[] = g.clients
    .filter((c) => c.status !== "exited")
    .map((c) => ({ id: c.partyId, ...nodeAttrs(g, g.parties[c.partyId]!, 0, { sub: c.kind }) }));
  const live = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  for (const [id, e] of shared) {
    const p = g.parties[id]!;
    const clientIds = [...e.clientIds].filter((cid) => live.has(g.clients.find((c) => c.id === cid)!.partyId));
    if (clientIds.length < 2) continue;
    if (!live.has(id)) nodes.push({ id, ...nodeAttrs(g, p, 1) });
    for (const cid of clientIds) {
      const c = g.clients.find((x) => x.id === cid)!;
      if (c.partyId === id) continue;
      edges.push({ id: `s:${id}:${c.partyId}`, source: id, target: c.partyId, kind: "shared", label: [...e.roles].join(", "), pct: null, role: null, nominee: p.isNominee, validFrom: null, validTo: null, sourceRef: null });
    }
  }
  return toPayload(nodes, edges, { asOf, depth: 1 });
}

export function clusters(g: WorldGraph, asOf: string, kind?: string): Cluster[] {
  const shared = sharedParties(g, asOf);
  const out: Cluster[] = [];
  for (const [id, e] of shared) {
    const p = g.parties[id]!;
    const k: Cluster["kind"] = p.kind === "address" ? "shared_address" : p.isNominee ? "nominee" : "shared_officer";
    if (kind && kind !== k) continue;
    const n = e.clientIds.size;
    const what = p.kind === "address" ? `share the address ${p.name}` : p.kind === "person" ? `share ${[...e.roles].some((r) => r !== "Owner") ? "director" : "owner"} ${p.name}` : `share ${p.name} in their structure`;
    out.push({
      id: `cl:${id}`,
      kind: k,
      label: `${n} clients ${what}`,
      reason: p.isNominee ? `${p.name} holds ${p.count ?? "many"} other appointments, a common sign of a nominee.` : `${p.name} appears in ${n} client structures.`,
      partyIds: [id],
      clientIds: [...e.clientIds],
      size: n,
    });
  }
  return out.sort((a, b) => b.size - a.size);
}

export function search(g: WorldGraph, q: string, limit = 10): GraphNode[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits = Object.values(g.parties).filter((p) => !p.mergedInto && p.kind !== "stack" && p.name.toLowerCase().includes(needle));
  const isClient = (p: WParty) => g.clients.some((c) => c.partyId === p.id);
  hits.sort((a, b) => Number(isClient(b)) - Number(isClient(a)) || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map((p) => ({ id: p.id, ...nodeAttrs(g, p, 0) }));
}
