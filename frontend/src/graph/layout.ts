// Layouts for the chart. Structures are drawn as a structure chart: the client at the foot and its owners in rows
// above it (y grows downward, so owners get negative y). The client book uses ForceAtlas2, run synchronously from a
// seeded start so the picture is stable per firm.
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { BEdge, BNode } from "./model";

export interface LayeredOptions {
  rankSep?: number;
  nodeSep?: number;
}

/**
 * Structure-chart layered layout: the client on the bottom row, owners and controllers in rows above. Each row is ordered by the mean x of the parties it owns or controls
 * (barycentre), then pushed apart to at least `nodeSep` so labels (to the right of shapes) never collide.
 * Returns positions in layout px, client at x = 0.
 */
export function layered(nodes: BNode[], edges: BEdge[], opts: LayeredOptions = {}): Map<string, { x: number; y: number }> {
  const rankSep = opts.rankSep ?? 108;
  const nodeSep = opts.nodeSep ?? 212;
  const pos = new Map<string, { x: number; y: number }>();
  const lv = new Map(nodes.map((n) => [n.id, n.level]));
  // Rank by the longest chain of interests above the client, not by hop count: a person who directs the client and
  // also owns it through three companies sits at the foot of that chain, so every ownership path runs straight down
  // and only the short control link reaches back up. Loops (curved links) are skipped; the cap stops runaway cycles.
  const chain = edges.filter((e) => !e.curve && (e.kind === "own" || e.kind === "unknown" || e.kind === "ctrl") && lv.has(e.s) && lv.has(e.t));
  const cap = nodes.length + 1;
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of chain) {
      const want = Math.min(cap, lv.get(e.t)! + 1);
      if (lv.get(e.s)! < want) {
        lv.set(e.s, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // A link between two parties on the same row would run through their plates: lift the interested party a row.
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of edges) {
      if (e.curve || e.kind === "faint" || e.kind === "possible" || !lv.has(e.s) || !lv.has(e.t)) continue;
      if (lv.get(e.s) === lv.get(e.t)) {
        lv.set(e.s, lv.get(e.t)! + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const levels = new Map<number, BNode[]>();
  nodes.forEach((n) => levels.set(lv.get(n.id)!, [...(levels.get(lv.get(n.id)!) ?? []), n]));
  const sorted = [...levels.keys()].sort((a, b) => a - b);
  const kindOrder: Record<string, number> = { person: 3, company: 0, trust: 1, partnership: 1, unknown: 4, stack: 5, address: 6, list: 7 };
  for (const lvl of sorted) {
    const row = levels.get(lvl)!;
    const ideal = new Map<string, number>();
    row.forEach((n) => {
      const targets = edges.filter((e) => e.s === n.id && pos.has(e.t)).map((e) => pos.get(e.t)!.x);
      const sources = edges.filter((e) => e.t === n.id && pos.has(e.s)).map((e) => pos.get(e.s)!.x);
      const ref = targets.length ? targets : sources;
      const rows = new Set(edges.filter((e) => e.s === n.id && pos.has(e.t)).map((e) => pos.get(e.t)!.y));
      // A party linked into more than one row sits to the left so its links pass clear of the row between.
      const nudge = rows.size > 1 ? -nodeSep : 0;
      ideal.set(n.id, (ref.length ? ref.reduce((a, b) => a + b, 0) / ref.length : 0) + nudge);
    });
    // Within one parent, controllers sit to the left of owners so control lines don't cross ownership lines.
    const bias = (n: BNode) => {
      const ctrlOnly = edges.some((e) => e.s === n.id && e.kind === "ctrl") && !edges.some((e) => e.s === n.id && (e.kind === "own" || e.kind === "unknown"));
      return ctrlOnly ? -1 : n.kind === "unknown" ? 0.5 : 0;
    };
    row.sort((a, b) => ideal.get(a.id)! - ideal.get(b.id)! || bias(a) - bias(b) || (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) || a.label.localeCompare(b.label));
    // Sweep to enforce separation, then recentre the row on its ideal positions.
    const xs = row.map((n) => ideal.get(n.id)!);
    for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i]!, xs[i - 1]! + nodeSep);
    const shift = row.reduce((s, n, i) => s + (ideal.get(n.id)! - xs[i]!), 0) / Math.max(1, row.length);
    row.forEach((n, i) => pos.set(n.id, { x: xs[i]! + shift, y: lvl ? -lvl * rankSep : 0 }));
  }
  return pos;
}

export function applyPositions(nodes: BNode[], pos: Map<string, { x: number; y: number }>): BNode[] {
  return nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? { x: n.x, y: n.y }) }));
}

/** Seeded pseudo-random numbers (mulberry32) so the constellation is the same on every visit. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** ForceAtlas2 over the client book; shared officers and addresses pull clients into clusters. Output fits `width`×`height`. */
export function constellationLayout(nodes: BNode[], edges: BEdge[], width = 1100, height = 640): Map<string, { x: number; y: number }> {
  const g = new Graph({ type: "undirected", multi: false });
  const rnd = seeded(hash(nodes.map((n) => n.id).join("|")));
  nodes.forEach((n) => g.addNode(n.id, { x: rnd() * 100, y: rnd() * 100, size: n.pin ? 2 : 1 }));
  edges.forEach((e) => {
    if (g.hasNode(e.s) && g.hasNode(e.t) && !g.hasEdge(e.s, e.t)) g.addEdge(e.s, e.t, { weight: 2 });
  });
  forceAtlas2.assign(g, { iterations: 600, settings: { gravity: 0.6, scalingRatio: 14, strongGravityMode: false, barnesHutOptimize: false, linLogMode: false, adjustSizes: false, slowDown: 2 } });
  const xs = g.mapNodes((_, a) => a.x as number);
  const ys = g.mapNodes((_, a) => a.y as number);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = (width - 40) / Math.max(1, maxX - minX);
  const sy = (height - 40) / Math.max(1, maxY - minY);
  const pos = new Map<string, { x: number; y: number }>();
  g.forEachNode((id, a) => pos.set(id, { x: ((a.x as number) - minX) * sx + 20, y: ((a.y as number) - minY) * sy + 20 }));
  return relax(pos, nodes, 175, 46);
}

/** Room a pin needs to its right: the shape plus its label (labels sit to the right, max 150 px wide). */
export function labelRoom(n: BNode): number {
  return (n.client ? 40 : 24) + Math.min(150, n.label.length * (n.client ? 6.7 : 5.6));
}

/** Resolve label collisions: overlapping pins are pushed apart along the axis of least overlap. The horizontal gap
 * a pair needs is the label room of whichever pin is on the left, so long names never run into a neighbour. */
function relax(pos: Map<string, { x: number; y: number }>, nodes: BNode[], minDxFloor: number, minDy: number): Map<string, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id);
  const room = new Map(nodes.map((n) => [n.id, Math.max(minDxFloor * 0.6, labelRoom(n))]));
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]!)!;
        const b = pos.get(ids[j]!)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDx = dx >= 0 ? room.get(ids[i]!)! : room.get(ids[j]!)!;
        const ox = minDx - Math.abs(dx);
        const oy = minDy - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox / minDx < oy / minDy) {
          const s = (dx >= 0 ? 1 : -1) * (ox / 2 + 0.5);
          a.x -= s;
          b.x += s;
        } else {
          const s = (dy >= 0 ? 1 : -1) * (oy / 2 + 0.5);
          a.y -= s;
          b.y += s;
        }
      }
    }
    if (!moved) break;
  }
  return pos;
}

export function extents(nodes: { x: number; y: number }[]): { minX: number; maxX: number; minY: number; maxY: number } {
  if (!nodes.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return {
    minX: Math.min(...nodes.map((n) => n.x)),
    maxX: Math.max(...nodes.map((n) => n.x)),
    minY: Math.min(...nodes.map((n) => n.y)),
    maxY: Math.max(...nodes.map((n) => n.y)),
  };
}
