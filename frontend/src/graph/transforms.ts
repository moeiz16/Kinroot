// Pure transforms from API graph payloads (graphology serialisation) to the board's scene model.
import type { BeneficialOwner, GraphDiff, GraphEdge, GraphNode, GraphPath, GraphPayload, UboResult } from "../api/types";
import type { BEdge, BKind, BNode, StringSpec } from "./model";

const KIND_WORD: Record<BKind, string> = {
  person: "person",
  company: "company",
  trust: "trust",
  partnership: "partnership",
  unknown: "unknown party",
  stack: "group of companies",
  address: "address",
  list: "list entry",
};

export function initials(name: string): string {
  const words = name
    .replace(/^(Hon\.|Dr|Mr|Mrs|Ms|Sir)\s+/i, "")
    .replace(/[^\p{L}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  const first = words[0]![0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function pct(n: number | null | undefined): string {
  if (n == null) return "?%";
  return `${Number.isInteger(n) ? n : Number(n.toFixed(1))}%`;
}

export function identifierLine(a: { identifiers?: { acn?: string; abn?: string; ukCompanyNumber?: string } }): string | undefined {
  const i = a.identifiers ?? {};
  if (i.acn) return `ACN ${i.acn}`;
  if (i.abn) return `ABN ${i.abn}`;
  if (i.ukCompanyNumber) return /^[A-Z]{2,}/.test(i.ukCompanyNumber) ? i.ukCompanyNumber : `Co. no. ${i.ukCompanyNumber}`;
  return undefined;
}

function glyphFor(kind: BKind, label: string, jurisdiction?: string | null, count?: number): string {
  switch (kind) {
    case "person":
      return initials(label);
    case "company":
      return (jurisdiction ?? "").slice(0, 2).toUpperCase() || "Co";
    case "trust":
      return "T";
    case "partnership":
      return "P";
    case "stack":
      return String(count ?? "…");
    case "unknown":
      return "?";
    case "address":
      return "⌂";
    case "list":
      return "≡";
  }
}

/** E-01, E-02 … per dossier, in payload order. Reasons and answers cite these. */
export function citationIds(p: GraphPayload): Map<string, string> {
  const m = new Map<string, string>();
  p.edges.forEach((e, i) => m.set(e.key, `E-${String(i + 1).padStart(2, "0")}`));
  return m;
}

export interface FromPayloadOptions {
  ubo?: UboResult | null;
  clientSub?: string;
}

export function fromPayload(p: GraphPayload, opts: FromPayloadOptions = {}): { nodes: BNode[]; edges: BEdge[] } {
  const cites = citationIds(p);
  const owners = new Map<string, BeneficialOwner>((opts.ubo?.owners ?? []).map((o) => [o.partyId, o]));
  const level = new Map(p.nodes.map((n) => [n.key, n.attributes.level]));
  const outgoing = new Map<string, typeof p.edges>();
  p.edges.forEach((e) => outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]));
  const stackCount = new Map<string, number>();
  p.edges.forEach((e) => {
    const t = p.nodes.find((n) => n.key === e.target);
    if (t?.attributes.kind === "stack") stackCount.set(e.source, t.attributes.count ?? 0);
  });

  const nodes: BNode[] = p.nodes.map(({ key, attributes: a }) => {
    const kind: BKind = a.kind === "address" ? "address" : (a.kind as BKind);
    const isClient = a.flags.includes("client") && (a.level === 0 || key === p.attributes.focusId);
    const o = owners.get(key);
    const roles = (outgoing.get(key) ?? []).filter((e) => e.attributes.kind === "control" && level.get(e.target) !== undefined).map((e) => e.attributes.label || e.attributes.role || "");
    let sub: string | undefined;
    if (isClient) sub = opts.clientSub ?? "Client";
    else if (o?.isUbo && o.effectivePct != null && o.effectivePct >= (opts.ubo?.thresholdPct ?? 25)) sub = `Beneficial owner · ${pct(o.effectivePct)}`;
    else if (kind === "person") sub = a.sub ?? roles[0] ?? ((outgoing.get(key) ?? []).some((e) => e.attributes.kind === "ownership") ? "Shareholder" : undefined);
    else if (kind === "stack") sub = a.sub;
    else sub = a.sub ?? identifierLine(a) ?? undefined;
    const flags: BNode["flags"] = [];
    if (a.flags.includes("sanctions_hit")) flags.push({ text: "▲ Possible sanctions match", level: "high" });
    if (stackCount.has(key)) flags.push({ text: `▲ ${stackCount.get(key)} other companies`, level: "high" });
    else if (a.flags.includes("nominee") && kind === "person") flags.push({ text: "◆ Nominee director", level: "review" });
    if (a.flags.includes("unknown_owner")) flags.push({ text: "◆ Owners not disclosed", level: "review" });
    if (a.flags.includes("high_risk_jurisdiction") && kind !== "person") flags.push({ text: "▲ High-risk jurisdiction", level: "high" });
    if (a.flags.includes("circular") && !isClient && kind !== "person") flags.push({ text: "◆ Part of a circular holding", level: "review" });
    const viaText = o?.paths[0] && o.paths[0].nodeIds.length > 2 ? ` through ${o.paths[0].nodeIds.slice(1, -1).map((id) => p.nodes.find((n) => n.key === id)?.attributes.label ?? "").filter(Boolean).join(" and ")}` : "";
    const aria = [
      a.label,
      isClient ? "client" : KIND_WORD[kind],
      o?.isUbo ? (o.effectivePct != null && o.effectivePct > 0 ? `beneficial owner, ${o.effectivePct} percent${viaText}` : `beneficial owner by control as ${o.controlRoles.join(" and ").toLowerCase()}`) : null,
      !o?.isUbo && sub && !isClient ? sub : null,
      ...flags.map((f) => f.text.replace(/^[▲◆●]\s*/, "")),
    ]
      .filter(Boolean)
      .join(", ");
    return {
      id: key,
      kind,
      label: a.label,
      sub,
      glyph: glyphFor(kind, a.label, a.jurisdiction, a.count),
      level: a.level,
      client: isClient,
      ubo: !!o?.isUbo,
      pep: a.flags.includes("pep"),
      flags,
      rating: a.riskRating,
      clientId: a.clientId,
      aria,
      x: 0,
      y: 0,
    };
  });

  // An ownership link is circular only when the owned party can reach its owner again through ownership.
  const ownOut = new Map<string, string[]>();
  p.edges.forEach((e) => e.attributes.kind === "ownership" && ownOut.set(e.source, [...(ownOut.get(e.source) ?? []), e.target]));
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(ownOut.get(n) ?? []));
    }
    return false;
  };
  const edges: BEdge[] = p.edges.map(({ key, source, target, attributes: a }) => {
    const kind: BEdge["kind"] = a.kind === "ownership" ? (a.pct == null ? "unknown" : "own") : a.kind === "control" ? "ctrl" : "faint";
    const back = a.kind === "ownership" && (level.get(source) ?? 0) <= (level.get(target) ?? 0) && reaches(target, source);
    return {
      id: key,
      s: source,
      t: target,
      kind,
      label: back ? `Circular · ${pct(a.pct)} ↺` : a.kind === "ownership" ? (a.pct == null ? a.label || "?%" : pct(a.pct)) : a.kind === "control" ? (a.label || a.role || undefined) : undefined,
      pct: a.pct,
      curve: back,
      citation: cites.get(key),
      source: a.sourceRef ?? undefined,
      validFrom: a.validFrom,
    };
  });

  // Unknown shareholders and "N companies" stacks arrive from the API as group nodes (kinds unknown / stack).

  // Each node unfolds out of the party it owns or controls one level up.
  const lv = new Map(nodes.map((n) => [n.id, n.level]));
  for (const n of nodes) {
    const up = edges.find((e) => e.s === n.id && (lv.get(e.t) ?? 0) < n.level);
    if (up) n.from = up.t;
  }
  return { nodes, edges };
}

/** Before/after overlay: tag edges and parties added since the compare date; bring back removed ones, faded. */
export function applyDiff(scene: { nodes: BNode[]; edges: BEdge[] }, diff: GraphDiff, sinceLabel: string): { nodes: BNode[]; edges: BEdge[] } {
  const nodes = scene.nodes.map((n) => ({ ...n }));
  const edges = scene.edges.map((e) => ({ ...e }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const removedLabel = (e: GraphEdge) => `– Removed ${e.validTo ? shortDate(e.validTo) : ""}`.trim();
  for (const a of diff.added) {
    const e = edges.find((x) => x.id === a.id);
    if (e) e.added = `+ New since ${sinceLabel}`;
  }
  for (const c of diff.changed) {
    const e = edges.find((x) => x.id === c.after.id);
    if (e) e.added = `Was ${c.before.label}`;
  }
  for (const n of diff.nodesAdded) {
    const node = byId.get(n.id);
    if (node) node.since = `+ New since ${sinceLabel}`;
  }
  for (const n of diff.nodesRemoved) {
    if (byId.has(n.id)) continue;
    const node: BNode = { ...nodeFromGraphNode(n), removed: "– Removed" };
    nodes.push(node);
    byId.set(n.id, node);
  }
  for (const r of diff.removed) {
    if (edges.some((e) => e.id === r.id)) continue;
    if (!byId.has(r.source) || !byId.has(r.target)) continue;
    edges.push({ id: r.id, s: r.source, t: r.target, kind: r.kind === "ownership" ? "own" : "ctrl", label: r.kind === "ownership" ? pct(r.pct) : (r.label || r.role || undefined), pct: r.pct, removed: removedLabel(r) });
    const src = byId.get(r.source)!;
    if (!edges.some((e) => !e.removed && (e.s === src.id || e.t === src.id))) src.removed = removedLabel(r);
  }
  const lv = new Map(nodes.map((n) => [n.id, n.level]));
  for (const n of nodes) {
    if (n.from) continue;
    const up = edges.find((e) => e.s === n.id && (lv.get(e.t) ?? 0) < n.level);
    if (up) n.from = up.t;
  }
  return { nodes, edges };
}

export function nodeFromGraphNode(n: GraphNode): BNode {
  const kind = n.kind as BKind;
  return { id: n.id, kind, label: n.label, sub: kind === "person" ? undefined : identifierLine(n), glyph: glyphFor(kind, n.label, n.jurisdiction, n.count), level: n.level, flags: [], rating: n.riskRating, clientId: n.clientId, aria: `${n.label}, ${KIND_WORD[kind]}`, x: 0, y: 0 };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}`;
}

/** The compounded-% equation for a path from an owner up to the client, as the string's tag and per-hop steps. */
export function compound(path: GraphPath, names: (id: string) => string): Pick<StringSpec, "steps" | "tag"> & { equation: string; value: number | null } {
  const pcts = path.hops.map((h) => h.pct ?? null);
  if (pcts.some((x) => x == null)) {
    return { equation: "", value: null, tag: { anchor: path.nodeIds[0]!, eq: path.hops.map((h) => h.role ?? pct(h.pct)).join(" → "), value: "control" }, steps: [] };
  }
  const nums = pcts as number[];
  const value = Math.round(nums.reduce((a, b) => a * (b / 100), 1) * 10000) / 100;
  const steps: { eq: string; value: string }[] = [{ eq: names(path.nodeIds[0]!), value: pct(nums[0]) }];
  let acc = nums[0]! / 100;
  for (let i = 1; i < nums.length; i++) {
    const prev = acc;
    acc *= nums[i]! / 100;
    steps.push({ eq: `${pct(Math.round(prev * 10000) / 100)} × ${pct(nums[i])}`, value: pct(Math.round(acc * 10000) / 100) });
  }
  const equation = `${nums.map((n) => pct(n)).join(" × ")} = ${pct(value)}`;
  const eq = nums.length === 1 ? "owns directly" : `${nums.map((n) => pct(n)).join(" × ")} =`;
  return { equation, value, steps, tag: { anchor: path.nodeIds[0]!, eq, value: pct(value) } };
}

/** Strings for every beneficial owner's paths; the strongest path is pulled at full weight, the rest faint. */
export function stringsForOwner(owner: BeneficialOwner, names: (id: string) => string): StringSpec[] {
  const own = owner.paths.filter((p) => p.effectivePct != null).sort((a, b) => (b.effectivePct ?? 0) - (a.effectivePct ?? 0));
  const ctrl = owner.paths.filter((p) => p.effectivePct == null);
  const ordered = [...own, ...ctrl];
  return ordered.map((p, i) => {
    const c = compound(p, names);
    return { ids: p.nodeIds, weight: i === 0 ? "full" : "faint", ...(i === 0 ? { tag: own.length > 1 && owner.effectivePct != null ? { anchor: p.nodeIds[0]!, eq: `${own.length} paths:`, value: pct(owner.effectivePct) } : c.tag, steps: c.steps } : {}) };
  });
}

/** Strongest beneficial owner by ownership, used for the dossier's default string. */
export function primaryOwner(ubo: UboResult | null | undefined): BeneficialOwner | null {
  if (!ubo) return null;
  return ubo.owners.filter((o) => o.isUbo && (o.effectivePct ?? 0) > 0).sort((a, b) => (b.effectivePct ?? 0) - (a.effectivePct ?? 0))[0] ?? null;
}

/** Text twin of the board for screen readers and keyboard users (ledger twin, DESIGN.md §11). */
export function ledgerTwin(nodes: BNode[], edges: BEdge[]): { id: string; label: string; links: string[] }[] {
  const name = new Map(nodes.map((n) => [n.id, n.label]));
  return nodes.map((n) => ({
    id: n.id,
    label: n.aria,
    links: edges
      .filter((e) => e.s === n.id && !e.removed)
      .map((e) => (e.kind === "own" ? `owns ${e.label} of ${name.get(e.t)}` : e.kind === "unknown" ? `holds an unknown share of ${name.get(e.t)}` : e.kind === "ctrl" ? `${(e.label ?? "controls").toLowerCase()} of ${name.get(e.t)}` : `linked to ${name.get(e.t)}`)),
  }));
}
