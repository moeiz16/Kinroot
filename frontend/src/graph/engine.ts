// The chart engine. Sigma 3 is kept as the camera only (pan, pinch, zoom, custom bbox so rising plates never
// rescale the view). Everything you see is Kinroot's own drawing, synced to the camera after every render:
//  - plates: focusable HTML buttons shaped by kind (company box, trust oval, person circle, partnership box with a
//    flow-through triangle, dashed unknown, stacked companies, list entry), labels inside, after structure-chart use;
//  - lines: one SVG, elbowed with rounded corners and a small head into the subject (owns solid, controls dashed,
//    unknown dotted), % tags on the owner's drop, layer rules with mono labels behind;
//  - the trace: a thick moss line that climbs from the client to the owner, elbow by elbow, with a counter;
//  - the zip seam between two candidate records (graft to fuse, cleave to split).
import Graph from "graphology";
import Sigma from "sigma";
import { extents } from "./layout";
import type { BEdge, BNode, Scene, StringSpec } from "./model";

const SVGNS = "http://www.w3.org/2000/svg";
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Rise spring as an easing curve (≈ stiffness 240, damping 24, 5% overshoot). */
export const easeRise = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
/** The climb: quick out of the client, settling into the owner. */
export const easeClimb = (t: number) => 1 - Math.pow(1 - t, 2.4);
const easeQuadInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface EngineOptions {
  reduced?: boolean;
  onActivate?: (id: string) => void;
  onThread?: (id: string) => void;
  onFocusNode?: (id: string | null) => void;
  onChange?: () => void;
  /** called after every sync (camera move, animation frame) */
  onSync?: () => void;
  ariaLabel?: string;
  /** extra space reserved around the content when fitting it (px, layout units) */
  pad?: { x: number; y: number };
  /** draw layer rules with labels behind a structure (default true) */
  layers?: boolean;
}

interface RNode extends BNode {
  el: HTMLElement;
  vx: number;
  vy: number;
  scale: number;
  shown: boolean;
  /** element box (unscaled) */
  w: number;
  h: number;
  /** pins: the shape's half size, the anchor */
  r: number;
}
type Pt = { x: number; y: number };
interface REdge extends BEdge {
  path?: SVGPathElement;
  lbl?: HTMLElement;
  tagEl?: HTMLElement;
  citeEl?: HTMLElement;
  onString?: boolean;
  exitOff: number;
  entryOff: number;
  labelRow: number;
  pts: Pt[];
}
interface RTrace {
  spec: StringSpec;
  under: SVGPathElement;
  line: SVGPathElement;
  head?: SVGCircleElement;
  counter?: HTMLElement;
  tag?: HTMLElement;
  progress: number;
}

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#1B1D13";
}
const PLATE_W = 176;
function pinRadius(n: BNode): number {
  return n.client ? 10 : n.kind === "address" ? 5 : 6;
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function pctOf(e: BEdge | undefined): number | null {
  if (!e) return null;
  if (e.pct != null) return e.pct;
  const m = e.label?.match(/^(\d+(?:\.\d+)?)%$/);
  return m ? Number(m[1]) : null;
}
function fmtPct(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `${Number.isInteger(r) ? r : Number(r.toFixed(1))}%`;
}
/** A polyline with rounded corners. */
export function rounded(pts: Pt[], r: number): string {
  if (!pts.length) return "";
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = pts[i - 1]!;
    const next = pts[i + 1];
    if (!next) {
      d += ` L${p.x},${p.y}`;
      break;
    }
    const l1 = Math.hypot(p.x - prev.x, p.y - prev.y) || 1;
    const l2 = Math.hypot(next.x - p.x, next.y - p.y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a = { x: p.x - ((p.x - prev.x) / l1) * rr, y: p.y - ((p.y - prev.y) / l1) * rr };
    const b = { x: p.x + ((next.x - p.x) / l2) * rr, y: p.y + ((next.y - p.y) / l2) * rr };
    d += ` L${a.x},${a.y} Q${p.x},${p.y} ${b.x},${b.y}`;
  }
  return d;
}
function polyLength(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return s;
}
function dedupe(pts: Pt[]): Pt[] {
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 0.5);
}

export class BoardEngine {
  readonly host: HTMLElement;
  private opts: EngineOptions;
  private graph = new Graph({ type: "directed", multi: true });
  private sigma: Sigma;
  private svg: SVGSVGElement;
  private gRules: SVGGElement;
  private gEdges: SVGGElement;
  private gSeam: SVGGElement;
  private gTrace: SVGGElement;
  private hLabels: HTMLElement;
  private hNodes: HTMLElement;
  private overlay: HTMLElement;
  private nodes = new Map<string, RNode>();
  private edges = new Map<string, REdge>();
  private traces: RTrace[] = [];
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private center = { x: 0, y: 0 };
  private base = 1;
  private selected: string | null = null;
  private dimSet: Set<string> | null = null;
  private hoverId: string | null = null;
  private focusMode = false;
  private seam: { a: string; b: string; chip: HTMLElement; ghost: HTMLElement; zip: number; onFuse?: () => void } | null = null;
  private destroyed = false;
  private raf = 0;
  private sceneKey = "";
  private content = { w: 0, h: 0 };
  private pins = false;
  private rows: { y: number; label: string }[] = [];

  constructor(host: HTMLElement, opts: EngineOptions = {}) {
    this.host = host;
    this.opts = opts;
    host.classList.add("chart");
    host.innerHTML = "";
    const sHost = document.createElement("div");
    sHost.className = "sigma-host";
    this.overlay = document.createElement("div");
    this.overlay.className = "overlay";
    this.svg = document.createElementNS(SVGNS, "svg");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.innerHTML =
      '<defs><marker id="kr-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 z" fill="context-stroke"/></marker>' +
      '<marker id="kr-head-own" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 z" fill="var(--line-own)"/></marker>' +
      '<marker id="kr-head-ctrl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 z" fill="var(--line-ctrl)"/></marker>' +
      '<marker id="kr-head-unk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 z" fill="var(--muted)"/></marker></defs>';
    this.gRules = document.createElementNS(SVGNS, "g");
    this.gRules.setAttribute("class", "rules");
    this.gEdges = document.createElementNS(SVGNS, "g");
    this.gSeam = document.createElementNS(SVGNS, "g");
    this.gTrace = document.createElementNS(SVGNS, "g");
    this.svg.append(this.gRules, this.gEdges, this.gSeam, this.gTrace);
    this.hLabels = document.createElement("div");
    this.hLabels.className = "h-labels";
    this.hNodes = document.createElement("div");
    this.hNodes.className = "h-nodes";
    this.hNodes.setAttribute("role", "group");
    this.hNodes.setAttribute("aria-label", opts.ariaLabel ?? "Structure chart. Use the arrow keys to move between linked parties.");
    this.overlay.append(this.svg, this.hLabels, this.hNodes);
    host.append(sHost, this.overlay);

    this.sigma = new Sigma(this.graph, sHost, {
      renderLabels: false,
      renderEdgeLabels: false,
      enableEdgeEvents: false,
      stagePadding: 0,
      minCameraRatio: 0.35,
      maxCameraRatio: 3,
      zoomToSizeRatioFunction: () => 1,
      nodeReducer: (_key, attr) => ({ ...attr, hidden: true }),
    });
    this.sigma.on("afterRender", () => this.sync());
    this.sigma.getCamera().on("updated", () => this.scheduleChange());
    // The chart lives in a scrolling page: a plain wheel scrolls the page, ⌘/Ctrl + wheel (and trackpad pinch) zooms;
    // one finger scrolls the page on touch screens, two fingers pan and pinch.
    const sigmaLayer = sHost;
    host.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey && sigmaLayer.contains(e.target as Node)) e.stopPropagation();
      },
      { capture: true },
    );
    for (const type of ["touchstart", "touchmove", "touchend"] as const)
      host.addEventListener(
        type,
        (e) => {
          if ((e as TouchEvent).touches.length < 2 && type !== "touchend" && sigmaLayer.contains(e.target as Node)) e.stopPropagation();
        },
        { capture: true, passive: true },
      );
  }

  // ------------------------------------------------------------ scene
  async setScene(scene: Scene, { unfold = false, hold = false }: { unfold?: boolean; hold?: boolean } = {}): Promise<void> {
    const same = scene.key === this.sceneKey;
    const prevIds = new Set(this.nodes.keys());
    this.sceneKey = scene.key;
    this.clearStrings();
    this.clearSeam();
    this.graph.clear();
    this.nodes.clear();
    this.edges.clear();
    this.gEdges.innerHTML = "";
    this.gRules.innerHTML = "";
    this.hLabels.innerHTML = "";
    this.hNodes.innerHTML = "";
    this.pins = scene.nodes.length > 0 && scene.nodes.every((n) => n.pin);
    this.host.classList.toggle("is-book", this.pins);
    const animate = (unfold && !this.opts.reduced && !same) || hold;
    const fresh = same && !this.opts.reduced && prevIds.size ? scene.nodes.filter((n) => !prevIds.has(n.id)).map((n) => n.id) : [];
    const clientLevel = Math.min(...scene.nodes.map((n) => n.level));
    for (const n of scene.nodes) this.addNode(n, (!animate || n.level === clientLevel) && !fresh.includes(n.id));
    for (const e of scene.edges) this.addEdge(e);
    this.spreadPorts();
    this.buildRows();
    const ext = extents(scene.nodes);
    this.center = { x: (ext.minX + ext.maxX) / 2, y: (ext.minY + ext.maxY) / 2 };
    const pad = this.opts.pad ?? (this.pins ? { x: 220, y: 60 } : { x: PLATE_W + 40, y: 116 });
    this.content = { w: ext.maxX - ext.minX + pad.x, h: ext.maxY - ext.minY + pad.y };
    this.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
    this.applyBBox();
    this.restyle();
    if (animate && !hold) await this.unfoldAll();
    else if (fresh.length) await this.unfoldGroup([...this.nodes.values()].filter((n) => fresh.includes(n.id)));
  }

  /** Rise every hidden layer, nearest the client first (560 ms each, 70 ms apart). */
  async unfoldAll(): Promise<void> {
    const key = this.sceneKey;
    const levels = [...new Set([...this.nodes.values()].filter((n) => !n.shown).map((n) => n.level))].sort((a, b) => a - b);
    for (const lvl of levels) {
      if (this.destroyed || this.sceneKey !== key) return;
      if (this.opts.reduced) {
        [...this.nodes.values()]
          .filter((n) => n.level === lvl)
          .forEach((n) => {
            n.shown = true;
            n.el.style.opacity = n.removed ? "0.4" : "1";
          });
        continue;
      }
      await this.unfoldGroup([...this.nodes.values()].filter((n) => n.level === lvl));
      await wait(70);
    }
    this.sync();
  }

  nodeViewport(id: string): Pt | null {
    const n = this.nodes.get(id);
    return n ? this.vp(n) : null;
  }
  setNodeLabel(id: string, label: string): void {
    const n = this.nodes.get(id);
    const b = n?.el.querySelector(".pl-name");
    if (n && b) {
      n.label = label;
      b.textContent = label;
      this.measure(n);
    }
  }
  setNodeSub(id: string, sub: string): void {
    const n = this.nodes.get(id);
    const small = n?.el.querySelector(".pl-sub");
    if (n && small) {
      small.textContent = sub;
      this.measure(n);
    }
  }

  private addNode(n: BNode, shown: boolean) {
    const el = document.createElement("div");
    const kind = n.kind === "company" ? "company" : n.kind;
    el.className = `${n.pin ? "pin" : "plate"} k-${kind}${n.client ? " client" : ""}${n.cand ? " cand" : ""}${n.removed ? " removed" : ""}${n.since ? " since" : ""}${n.ubo ? " is-ubo" : ""}${n.rating ? ` r-${n.rating}` : ""}`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", n.aria + (n.since ? `, ${n.since.replace("+ ", "")}` : "") + (n.removed ? `, ${n.removed.replace("– ", "")}` : ""));
    el.dataset.id = n.id;
    const rating = n.rating ? `<span class="pl-rating r-${n.rating}" aria-hidden="true">${n.rating === "high" ? "▲" : n.rating === "medium" ? "◆" : "●"}</span>` : "";
    if (n.pin) {
      el.innerHTML = `<span class="pin-shape" aria-hidden="true">${n.client ? rating : ""}</span><span class="pin-name">${esc(n.label)}</span>${n.flags.map((f) => `<span class="pin-flag ${f.level}">${esc(f.text)}</span>`).join("")}${n.tag ? `<span class="pin-tag">${esc(n.tag)}</span>` : ""}`;
    } else {
      const flags = n.flags.length ? `<span class="pl-flags">${n.flags.map((f) => `<span class="flag ${f.level}">${esc(f.text)}</span>`).join("")}</span>` : "";
      const tabs = [n.since ? `<span class="pl-tab since">${esc(n.since)}</span>` : "", n.removed ? `<span class="pl-tab gone">${esc(n.removed)}</span>` : "", n.rec ? `<span class="pl-tab rec">${esc(n.rec)}</span>` : "", n.tag ? `<span class="pl-tab tag">${esc(n.tag)}</span>` : ""].join("");
      const head = n.kind === "person" ? `<span class="pl-face" aria-hidden="true">${esc(n.glyph)}${n.pep ? '<span class="pl-pep">PEP</span>' : ""}</span>` : n.pep ? '<span class="pl-pep">PEP</span>' : "";
      const mark = n.kind === "unknown" ? `<span class="pl-q" aria-hidden="true">${esc(n.glyph || "?")}</span>` : n.kind === "list" ? '<span class="pl-list" aria-hidden="true">LIST</span>' : "";
      el.innerHTML = `${head}<span class="pl-body">${mark}<span class="pl-name">${esc(n.label)}</span>${n.sub ? `<span class="pl-sub">${esc(n.sub)}</span>` : ""}${flags}</span>${rating}${tabs ? `<span class="pl-tabs">${tabs}</span>` : ""}${n.badge ? `<span class="pl-badge" aria-hidden="true">${n.badge}</span>` : ""}`;
    }
    el.style.opacity = shown ? (n.removed ? "0.4" : "1") : "0";
    el.addEventListener("click", () => this.opts.onActivate?.(n.id));
    el.addEventListener("keydown", (ev) => this.onKey(ev, n.id));
    el.addEventListener("focus", () => this.opts.onFocusNode?.(n.id));
    el.addEventListener("pointerenter", () => this.hover(n.id));
    el.addEventListener("pointerleave", () => this.hover(null));
    this.hNodes.appendChild(el);
    const rn: RNode = { ...n, el, vx: n.x, vy: n.y, scale: 1, shown, w: PLATE_W, h: 58, r: pinRadius(n) };
    this.measure(rn);
    this.nodes.set(n.id, rn);
    this.graph.addNode(n.id, { x: n.x, y: -n.y, size: 1, color: "rgba(0,0,0,0)", zIndex: 1 });
  }

  private measure(n: RNode) {
    const w = n.el.offsetWidth;
    const h = n.el.offsetHeight;
    if (w && h) {
      n.w = w;
      n.h = h;
    } else if (!n.pin) {
      n.w = PLATE_W;
      n.h = n.kind === "person" ? 92 : 58;
    }
  }

  private addEdge(e: BEdge) {
    if (!this.nodes.has(e.s) || !this.nodes.has(e.t)) return;
    const re: REdge = { ...e, exitOff: 0, entryOff: 0, labelRow: 0, pts: [] };
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke-linejoin", "round");
    const style =
      e.kind === "ctrl"
        ? { cls: "ln-ctrl", marker: "kr-head-ctrl" }
        : e.kind === "unknown"
          ? { cls: "ln-unk", marker: "kr-head-unk" }
          : e.kind === "faint"
            ? { cls: "ln-faint", marker: "" }
            : e.kind === "possible"
              ? { cls: "ln-possible", marker: "" }
              : { cls: "ln-own", marker: "kr-head-own" };
    p.setAttribute("class", `${style.cls}${e.removed ? " gone" : ""}${e.added ? " added" : ""}`);
    if (style.marker && !this.pins) p.setAttribute("marker-end", `url(#${style.marker})`);
    this.gEdges.appendChild(p);
    re.path = p;
    if (e.label && !this.pins) {
      const l = document.createElement("div");
      l.className = "ln-label " + (e.kind === "ctrl" ? "ctrl" : e.kind === "unknown" ? "unknown" : e.kind === "possible" ? "possible" : "own") + (e.curve ? " loop" : "");
      l.textContent = e.label;
      this.hLabels.appendChild(l);
      re.lbl = l;
    }
    if (e.added || e.removed) {
      const t = document.createElement("div");
      t.className = "ln-tag" + (e.removed ? " gone" : "");
      t.textContent = e.added ?? e.removed ?? "";
      this.hLabels.appendChild(t);
      re.tagEl = t;
    }
    if (e.cite) {
      const c = document.createElement("div");
      c.className = "ln-cite";
      c.textContent = String(e.cite);
      this.hLabels.appendChild(c);
      re.citeEl = c;
    }
    this.edges.set(e.id, re);
  }

  /** Spread the lines leaving a plate (and arriving at one) along its edge, ordered so they don't cross. */
  private spreadPorts() {
    if (this.pins) return;
    const live = [...this.edges.values()].filter((e) => !e.curve && e.kind !== "faint");
    const byS = new Map<string, REdge[]>();
    const byT = new Map<string, REdge[]>();
    for (const e of live) {
      byS.set(e.s, [...(byS.get(e.s) ?? []), e]);
      byT.set(e.t, [...(byT.get(e.t) ?? []), e]);
    }
    const x = (id: string) => this.nodes.get(id)!.x;
    for (const [id, list] of byS) {
      list.sort((a, b) => x(a.t) - x(b.t) || (a.kind === "ctrl" ? 1 : 0) - (b.kind === "ctrl" ? 1 : 0));
      const half = (this.nodes.get(id)!.kind === "person" ? 18 : this.nodes.get(id)!.w / 2 - 22) || 60;
      const gap = Math.min(30, (half * 2) / Math.max(1, list.length - 1));
      list.forEach((e, i) => {
        e.exitOff = clamp((i - (list.length - 1) / 2) * gap, -half, half);
        e.labelRow = list.length > 1 ? i : 0;
      });
    }
    for (const [id, list] of byT) {
      list.sort((a, b) => x(a.s) - x(b.s));
      const half = (this.nodes.get(id)!.kind === "person" ? 16 : this.nodes.get(id)!.w / 2 - 18) || 60;
      const gap = Math.min(26, (half * 2) / Math.max(1, list.length - 1));
      list.forEach((e, i) => (e.entryOff = clamp((i - (list.length - 1) / 2) * gap, -half, half)));
    }
  }

  /** Rows of the structure for the layer rules and the depth gauge: the client's row is CLIENT, then LAYER 1… */
  private buildRows() {
    this.rows = [];
    if (this.pins) return;
    const ys = [...new Set([...this.nodes.values()].map((n) => Math.round(n.y)))].sort((a, b) => b - a);
    const clientY = [...this.nodes.values()].find((n) => n.client)?.y;
    const baseIdx = clientY != null ? ys.indexOf(Math.round(clientY)) : 0;
    this.rows = ys.map((y, i) => ({ y, label: i === baseIdx ? "Client" : i > baseIdx ? `Layer ${i - baseIdx}` : `Below ${baseIdx - i}` }));
    for (const r of this.rows) {
      const g = document.createElementNS(SVGNS, "g");
      g.innerHTML = `<line class="rule-line"/><text class="rule-label">${esc(r.label.toUpperCase())}</text>`;
      this.gRules.appendChild(g);
    }
  }

  private async unfoldGroup(group: RNode[], dur = 560) {
    group.forEach((n) => (n.shown = true));
    await this.tween(dur, (t) => {
      const k = easeRise(t);
      for (const n of group) {
        const from = n.from ? this.nodes.get(n.from) : undefined;
        const fx = from ? from.x : n.x;
        const fy = from ? from.y : n.y + 40;
        n.vx = lerp(fx, n.x, k);
        n.vy = lerp(fy, n.y, k);
        n.scale = lerp(0.7, 1, Math.min(1, t * 1.6));
        n.el.style.opacity = String(Math.min(1, t / 0.4) * (n.removed ? 0.4 : 1));
      }
    });
    for (const n of group) {
      n.vx = n.x;
      n.vy = n.y;
      n.scale = 1;
    }
    this.sync();
  }

  // ------------------------------------------------------------ camera and space
  setInsets(insets: Partial<Insets>, animate = false): void {
    const from = { ...this.insets };
    const to = { ...this.insets, ...insets };
    if (!animate || this.opts.reduced) {
      this.insets = to;
      this.applyBBox();
      return;
    }
    void this.tween(450, (t) => {
      const k = easeQuadInOut(t);
      this.insets = { top: lerp(from.top, to.top, k), right: lerp(from.right, to.right, k), bottom: lerp(from.bottom, to.bottom, k), left: lerp(from.left, to.left, k) };
      this.applyBBox();
    });
  }

  /** Fit the content into the visible part of the chart (the host minus its chrome). */
  private applyBBox() {
    const W = this.host.clientWidth || 1;
    const H = this.host.clientHeight || 1;
    const vw = Math.max(80, W - this.insets.left - this.insets.right);
    const vh = Math.max(80, H - this.insets.top - this.insets.bottom);
    // Plates stay legible: below this the structure overflows the frame and the depth gauge pans it.
    const s = clamp(Math.min(vw / Math.max(1, this.content.w), vh / Math.max(1, this.content.h)), this.pins ? (W < 640 ? 0.3 : 0.4) : W < 640 ? 0.5 : 0.56, 1.05);
    this.base = s;
    const vcx = this.insets.left + vw / 2;
    const vcy = this.insets.top + vh / 2;
    const L = this.center.x - vcx / s;
    // A structure taller than the frame keeps its foot (the client) in view; the gauge pans up to the owners.
    const T = !this.pins && this.content.h * s > vh + 1 ? this.center.y + this.content.h / 2 - (this.insets.top + vh) / s : this.center.y - vcy / s;
    this.sigma.setCustomBBox({ x: [L, L + W / s], y: [-(T + H / s), -T] });
    this.sigma.refresh();
  }

  resize(): void {
    this.sigma.resize();
    for (const n of this.nodes.values()) this.measure(n);
    this.applyBBox();
  }
  zoomBy(factor: number): void {
    const cam = this.sigma.getCamera();
    if (this.opts.reduced) cam.setState({ ratio: clamp(cam.ratio / factor, 0.35, 3) });
    else void cam.animate({ ratio: clamp(cam.ratio / factor, 0.35, 3) }, { duration: 250 });
  }
  fit(): void {
    const cam = this.sigma.getCamera();
    if (this.opts.reduced) cam.setState({ x: 0.5, y: 0.5, ratio: 1 });
    else void cam.animate({ x: 0.5, y: 0.5, ratio: 1 }, { duration: 450, easing: "quadraticInOut" });
  }
  private flyToPoint(x: number, y: number, ratio: number) {
    const p = this.sigma.graphToViewport({ x, y: -y });
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    const cam = this.sigma.getCamera();
    const vcx = this.insets.left + (W - this.insets.left - this.insets.right) / 2;
    const vcy = this.insets.top + (H - this.insets.top - this.insets.bottom) / 2;
    const target = this.sigma.viewportToFramedGraph({ x: p.x + (W / 2 - vcx), y: p.y + (H / 2 - vcy) });
    const state = { x: target.x, y: target.y, ratio };
    if (this.opts.reduced) cam.setState(state);
    else void cam.animate(state, { duration: 450, easing: "quadraticInOut" });
  }
  /** Fly the camera to a party (450 ms). */
  flyTo(id: string, ratio = 0.8): void {
    const n = this.nodes.get(id);
    if (n) this.flyToPoint(n.x, n.y, Math.min(this.sigma.getCamera().ratio, ratio));
  }
  /** Pan to a layer of the structure (the depth gauge). */
  flyToRow(y: number): void {
    this.flyToPoint(this.center.x, y, this.sigma.getCamera().ratio);
  }

  private nodeScale(): number {
    return clamp(this.base / this.sigma.getCamera().ratio, 0.45, 1.4);
  }
  private vp(n: RNode): Pt {
    return this.sigma.graphToViewport({ x: n.vx, y: -n.vy });
  }

  // ------------------------------------------------------------ sync
  private sync() {
    if (this.destroyed) return;
    const k = this.nodeScale();
    this.host.style.setProperty("--k", k.toFixed(3));
    for (const n of this.nodes.values()) {
      const p = this.vp(n);
      const s = k * n.scale;
      if (n.pin) {
        n.el.style.transform = `translate(${p.x - n.r}px, ${p.y - n.r}px) scale(${s})`;
        n.el.style.transformOrigin = `${n.r}px ${n.r}px`;
      } else {
        n.el.style.transform = `translate(${p.x - n.w / 2}px, ${p.y - n.h / 2}px) scale(${s})`;
        n.el.style.transformOrigin = `${n.w / 2}px ${n.h / 2}px`;
      }
      n.el.classList.toggle("dim", this.isDimmed(n.id));
      n.el.classList.toggle("selected", this.selected === n.id);
      n.el.classList.toggle("compact", k < 0.6);
    }
    const W = this.host.clientWidth;
    this.rows.forEach((r, i) => {
      const g = this.gRules.children[i] as SVGGElement | undefined;
      if (!g) return;
      const y = this.sigma.graphToViewport({ x: 0, y: -r.y }).y;
      const line = g.firstElementChild as SVGLineElement;
      const text = g.lastElementChild as SVGTextElement;
      line.setAttribute("x1", "0");
      line.setAttribute("x2", String(W));
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
      text.setAttribute("x", String(Math.max(14, this.insets.left - 84)));
      text.setAttribute("y", String(y - 7));
    });
    for (const e of this.edges.values()) this.syncEdge(e, k);
    this.drawTraces();
    this.drawSeam();
    this.opts.onSync?.();
  }

  /** Top and bottom attach points of a plate on screen. */
  private ends(n: RNode, k: number): { top: number; bottom: number; left: number; right: number; c: Pt } {
    const c = this.vp(n);
    const s = k * n.scale;
    return { top: c.y - (n.h / 2) * s, bottom: c.y + (n.h / 2) * s, left: c.x - (n.w / 2) * s, right: c.x + (n.w / 2) * s, c };
  }

  private route(e: REdge, k: number): Pt[] {
    const a = this.nodes.get(e.s)!;
    const b = this.nodes.get(e.t)!;
    if (this.pins) {
      const pa = this.vp(a);
      const pb = this.vp(b);
      const d = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      const ra = (a.r + 2) * k;
      const rb = (b.r + 2) * k;
      return [
        { x: pa.x + ((pb.x - pa.x) / d) * ra, y: pa.y + ((pb.y - pa.y) / d) * ra },
        { x: pb.x - ((pb.x - pa.x) / d) * rb, y: pb.y - ((pb.y - pa.y) / d) * rb },
      ];
    }
    const A = this.ends(a, k);
    const B = this.ends(b, k);
    if (e.curve) {
      // A circular holding: out of the owner's right side, round the outside, into the subject's right side.
      const out = Math.max(A.right, B.right) + 34 * k;
      return [
        { x: A.right, y: A.c.y },
        { x: out, y: A.c.y },
        { x: out, y: B.c.y },
        { x: B.right + 2, y: B.c.y },
      ];
    }
    const sAbove = A.c.y <= B.c.y;
    const sx = A.c.x + e.exitOff * k;
    const tx = B.c.x + e.entryOff * k;
    const sy = sAbove ? A.bottom : A.top;
    const ty = sAbove ? B.top - 2 : B.bottom + 2;
    if (Math.abs(A.c.y - B.c.y) < 4) {
      // same row (fuse candidates, list entries): a straight line between facing sides
      const right = A.c.x < B.c.x;
      return [
        { x: right ? A.right : A.left, y: A.c.y },
        { x: right ? B.left - 2 : B.right + 2, y: B.c.y },
      ];
    }
    const busY = sAbove ? ty - 24 * k : ty + 24 * k;
    if (Math.abs(sx - tx) < 1.5) return [{ x: sx, y: sy }, { x: tx, y: ty }];
    return dedupe([{ x: sx, y: sy }, { x: sx, y: busY }, { x: tx, y: busY }, { x: tx, y: ty }]);
  }

  private syncEdge(e: REdge, k: number) {
    const a = this.nodes.get(e.s)!;
    const b = this.nodes.get(e.t)!;
    const vis = a.shown && b.shown;
    e.pts = this.route(e, k);
    if (e.path) {
      e.path.setAttribute("d", this.pins ? `M${e.pts[0]!.x},${e.pts[0]!.y} L${e.pts[1]!.x},${e.pts[1]!.y}` : rounded(e.pts, 9 * k));
      const dimmed = this.isDimmed(e.s) && this.isDimmed(e.t);
      e.path.style.opacity = !vis ? "0" : e.removed ? "0.45" : dimmed ? "0.22" : "1";
      e.path.style.strokeWidth = "";
    }
    // the label sits on the owner's drop (or the loop's outer leg)
    const p0 = e.pts[0]!;
    const p1 = e.pts[1] ?? p0;
    let at: Pt;
    if (e.curve) at = { x: e.pts[1]!.x, y: (e.pts[1]!.y + e.pts[2]!.y) / 2 };
    else if (Math.abs(p0.y - p1.y) < 1) at = { x: (p0.x + p1.x) / 2, y: p0.y - 12 * k };
    else at = { x: p0.x, y: p0.y + (Math.min(e.labelRow ? 16 : 26, Math.abs(p1.y - p0.y) * 0.5) + e.labelRow * 21) * k * Math.sign(p1.y - p0.y || 1) };
    if (e.lbl) {
      const ls = clamp(k, 0.6, 1);
      e.lbl.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)${ls < 1 ? ` scale(${ls.toFixed(3)})` : ""}`;
      e.lbl.style.opacity = vis ? (e.removed ? "0.55" : this.isDimmed(e.s) && this.isDimmed(e.t) ? "0.3" : "1") : "0";
      e.lbl.classList.toggle("on-trace", !!e.onString);
    }
    if (e.tagEl) {
      // beside the line's label, on the owner's drop
      const off = e.lbl ? (e.lbl.offsetWidth / 2) * clamp(k, 0.6, 1) + 6 : 8;
      e.tagEl.style.transform = `translate(${at.x + off}px, ${at.y}px) translate(0, -50%)`;
      e.tagEl.style.opacity = vis ? "1" : "0";
    }
    if (e.citeEl) {
      e.citeEl.style.transform = `translate(${at.x + (e.lbl ? e.lbl.offsetWidth / 2 + 12 : 0)}px, ${at.y}px) translate(-50%, -50%)`;
      e.citeEl.style.opacity = vis ? "1" : "0";
    }
  }

  private scheduleChange() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.sigma.refresh({ skipIndexation: true });
      this.opts.onChange?.();
    });
  }

  // ------------------------------------------------------------ selection, hover, dimming
  setSelected(id: string | null): void {
    this.selected = id;
    this.sync();
  }
  setDim(ids: Iterable<string> | null): void {
    this.dimSet = ids ? new Set(ids) : null;
    this.sync();
  }
  setFocusMode(on: boolean): void {
    this.focusMode = on;
    this.sync();
  }
  get isFocusMode(): boolean {
    return this.focusMode;
  }
  private neighbours(id: string): Set<string> {
    const s = new Set([id]);
    for (const e of this.edges.values()) {
      if (e.s === id) s.add(e.t);
      if (e.t === id) s.add(e.s);
    }
    return s;
  }
  private isDimmed(id: string): boolean {
    const keep = this.hoverId ? this.neighbours(this.hoverId) : this.focusMode && this.selected ? this.neighbours(this.selected) : this.dimSet;
    return keep ? !keep.has(id) : false;
  }
  private hover(id: string | null) {
    if (this.seam) return;
    this.hoverId = id;
    this.sync();
  }

  focusNode(id: string): void {
    this.nodes.get(id)?.el.focus();
  }

  private onKey(ev: KeyboardEvent, id: string) {
    const n = this.nodes.get(id)!;
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      this.opts.onActivate?.(id);
      return;
    }
    if (ev.key === "t" || ev.key === "T") {
      ev.preventDefault();
      this.opts.onThread?.(id);
      return;
    }
    const dirs: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const d = dirs[ev.key];
    if (!d) return;
    ev.preventDefault();
    const linked = [...this.neighbours(id)].filter((x) => x !== id);
    const pool = d[1] !== 0 ? linked : [...this.nodes.values()].filter((m) => Math.abs(m.y - n.y) < 4 && m.id !== id).map((m) => m.id);
    let best: string | null = null;
    let bestScore = Infinity;
    for (const other of pool) {
      const m = this.nodes.get(other);
      if (!m || !m.shown) continue;
      const dx = m.x - n.x;
      const dy = m.y - n.y;
      const along = dx * d[0] + dy * d[1];
      if (along <= 0) continue;
      const score = along + Math.abs(dx * d[1]) + Math.abs(dy * d[0]) * 2;
      if (score < bestScore) {
        bestScore = score;
        best = other;
      }
    }
    if (best) this.focusNode(best);
  }

  // ------------------------------------------------------------ the trace
  clearStrings(): void {
    this.traces.forEach((s) => {
      s.under.remove();
      s.line.remove();
      s.head?.remove();
      s.counter?.remove();
      s.tag?.remove();
    });
    this.traces = [];
    for (const e of this.edges.values()) e.onString = false;
    for (const n of this.nodes.values()) n.el.classList.remove("ubo", "on-trace");
  }

  private edgeBetween(a: string, b: string): REdge | undefined {
    return [...this.edges.values()].find((x) => (x.s === a && x.t === b) || (x.s === b && x.t === a));
  }

  /** Trace a path: the moss line climbs from the client to the owner, elbow by elbow, multiplying as it goes. */
  async pull(specs: StringSpec[], { animate = true, dur = 1000 }: { animate?: boolean; dur?: number } = {}): Promise<void> {
    this.clearStrings();
    const live = specs.filter((s) => s.ids.length > 1 && s.ids.every((id) => this.nodes.has(id)));
    if (!live.length) return;
    for (const spec of live) {
      const full = spec.weight !== "faint";
      const under = document.createElementNS(SVGNS, "path");
      under.setAttribute("class", full ? "trace-under" : "trace-under faint");
      const line = document.createElementNS(SVGNS, "path");
      line.setAttribute("class", full ? "trace" : "trace faint");
      this.gTrace.append(under, line);
      const t: RTrace = { spec, under, line, progress: 1 };
      if (full) {
        t.head = document.createElementNS(SVGNS, "circle");
        t.head.setAttribute("r", "6");
        t.head.setAttribute("class", "trace-head");
        this.gTrace.append(t.head);
        for (let i = 1; i < spec.ids.length; i++) {
          const e = this.edgeBetween(spec.ids[i - 1]!, spec.ids[i]!);
          if (e) e.onString = true;
        }
        t.counter = document.createElement("div");
        t.counter.className = "trace-counter";
        t.counter.setAttribute("aria-hidden", "true");
        this.overlay.appendChild(t.counter);
        if (spec.tag) {
          t.tag = document.createElement("div");
          t.tag.className = "trace-tag";
          t.tag.setAttribute("role", "status");
          this.overlay.appendChild(t.tag);
        }
        this.nodes.get(spec.ids[0]!)?.el.classList.add("ubo");
      }
      this.traces.push(t);
    }
    const main = this.traces.find((s) => s.spec.weight !== "faint");
    if (main?.tag && main.spec.tag) main.tag.innerHTML = `<span class="tt-who">Owner</span><span class="eq">${esc(main.spec.tag.eq)}</span><b>${esc(main.spec.tag.value)}</b>`;
    if (!animate || this.opts.reduced) {
      if (main) main.progress = 1;
      this.drawTraces();
      return;
    }
    if (main) {
      main.progress = 0;
      main.tag?.classList.add("hidden");
    }
    await this.tween(dur, (t) => {
      if (main) main.progress = easeClimb(t);
      this.drawTraces();
    });
    if (main) {
      main.progress = 1;
      main.tag?.classList.remove("hidden");
    }
    this.drawTraces();
  }

  /** The climbing polyline for a trace: from the client (last id) up to the owner (first id), on the drawn elbows. */
  private climbPoints(ids: string[]): { pts: Pt[]; hops: number[] } {
    const pts: Pt[] = [];
    const hops: number[] = [0];
    for (let i = ids.length - 1; i > 0; i--) {
      const lower = ids[i]!;
      const upper = ids[i - 1]!;
      const e = this.edgeBetween(upper, lower);
      let seg: Pt[];
      if (e && e.pts.length) seg = e.s === upper ? [...e.pts].reverse() : [...e.pts];
      else seg = [this.vp(this.nodes.get(lower)!), this.vp(this.nodes.get(upper)!)];
      if (!pts.length) pts.push(this.vp(this.nodes.get(lower)!));
      pts.push(...seg);
      pts.push(this.vp(this.nodes.get(upper)!));
      hops.push(polyLength(dedupe(pts)));
    }
    return { pts: dedupe(pts), hops };
  }

  private drawTraces() {
    const k = this.nodeScale();
    for (const s of this.traces) {
      const { pts, hops } = this.climbPoints(s.spec.ids);
      const d = rounded(pts, 9 * k);
      s.under.setAttribute("d", d);
      s.line.setAttribute("d", d);
      const total = polyLength(pts);
      const done = total * s.progress;
      if (s.spec.weight !== "faint") {
        s.line.style.strokeDasharray = `${total} ${total}`;
        s.line.style.strokeDashoffset = String(total - done);
        s.under.style.strokeDasharray = `${total} ${total}`;
        s.under.style.strokeDashoffset = String(total - done);
      }
      // plates the head has reached
      const ids = s.spec.ids;
      let reached = 0;
      hops.forEach((h, j) => {
        const id = ids[ids.length - 1 - j];
        const on = s.spec.weight !== "faint" && done >= h - 1;
        if (id) this.nodes.get(id)?.el.classList.toggle("on-trace", on);
        if (on) reached = j;
      });
      if (s.head) {
        const head = s.line.getPointAtLength?.(Math.max(0, Math.min(total, done))) ?? pts[0]!;
        s.head.setAttribute("cx", String(head.x));
        s.head.setAttribute("cy", String(head.y));
        s.head.style.opacity = s.progress > 0 && s.progress < 1 ? "1" : "0";
        if (s.counter) {
          // the running product from the client upward
          let acc = 1;
          let ok = true;
          const parts: string[] = [];
          for (let j = 1; j <= Math.max(1, reached + (s.progress < 1 ? 1 : 0)) && j < ids.length; j++) {
            const e = this.edgeBetween(ids[ids.length - 1 - j]!, ids[ids.length - j]!);
            const p = pctOf(e);
            if (p == null) ok = false;
            else {
              acc *= p / 100;
              parts.push(fmtPct(p));
            }
          }
          s.counter.textContent = ok && parts.length ? `${parts.join(" × ")}${parts.length > 1 ? ` = ${fmtPct(acc * 100)}` : ""}` : "control";
          s.counter.style.transform = `translate(${head.x + 14}px, ${head.y}px) translate(0, -50%)`;
          s.counter.style.opacity = s.progress > 0.02 && s.progress < 1 ? "1" : "0";
        }
      }
      if (s.tag && s.spec.tag) {
        const anchor = this.nodes.get(s.spec.tag.anchor);
        if (anchor) {
          const A = this.ends(anchor, k);
          // beside the owner (right, or left when the right edge is too close), level with the plate's top
          const W = this.host.clientWidth;
          const right = A.right + 12 + s.tag.offsetWidth < W - 8;
          const x = right ? A.right + 12 : Math.max(8, A.left - 12 - s.tag.offsetWidth);
          const y = Math.max(6, A.top);
          s.tag.style.transform = `translate(${x}px, ${y}px)`;
          s.tag.style.visibility = A.bottom < 0 || A.top > this.host.clientHeight ? "hidden" : "";
        }
      }
    }
  }

  // ------------------------------------------------------------ fuse and split
  /** The zip seam between two candidate records, with drag-to-fuse. */
  setSeam(a: string, b: string, chipHtml: string, onFuse?: () => void): void {
    this.clearSeam();
    const chip = document.createElement("div");
    chip.className = "seam-chip";
    chip.innerHTML = chipHtml;
    const ghost = document.createElement("div");
    ghost.className = "graft";
    ghost.textContent = this.nodes.get(a)?.label ?? "";
    ghost.setAttribute("aria-hidden", "true");
    this.overlay.append(chip, ghost);
    this.seam = { a, b, chip, ghost, zip: 1, onFuse };
    for (const id of [a, b]) this.enableDrag(id, id === a ? b : a);
    this.drawSeam();
  }
  clearSeam(): void {
    if (!this.seam) return;
    this.seam.chip.remove();
    this.seam.ghost.remove();
    this.gSeam.innerHTML = "";
    this.seam = null;
  }

  private enableDrag(id: string, otherId: string) {
    const n = this.nodes.get(id)!;
    n.el.classList.add("draggable");
    n.el.addEventListener("pointerdown", (ev) => {
      if (!this.seam || ev.button !== 0) return;
      ev.preventDefault();
      n.el.setPointerCapture(ev.pointerId);
      const rect = this.host.getBoundingClientRect();
      const other = this.nodes.get(otherId)!;
      let near = false;
      const move = (e: PointerEvent) => {
        const g = this.sigma.viewportToGraph({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        let x = g.x;
        let y = -g.y;
        const po = this.vp(other);
        near = Math.hypot(e.clientX - rect.left - po.x, e.clientY - rect.top - po.y) < 80;
        if (near) {
          x = lerp(x, other.x, 0.65);
          y = lerp(y, other.y, 0.65);
        }
        n.vx = x;
        n.vy = y;
        n.el.classList.toggle("near", near);
        this.sigma.refresh({ skipIndexation: true });
      };
      const up = async () => {
        n.el.removeEventListener("pointermove", move);
        n.el.removeEventListener("pointerup", up);
        n.el.removeEventListener("pointercancel", up);
        n.el.classList.remove("near");
        if (near && this.seam?.onFuse) this.seam.onFuse();
        else await this.springHome(n);
      };
      n.el.addEventListener("pointermove", move);
      n.el.addEventListener("pointerup", up);
      n.el.addEventListener("pointercancel", up);
    });
  }

  private async springHome(n: RNode) {
    const fx = n.vx;
    const fy = n.vy;
    await this.tween(420, (t) => {
      const k = easeRise(t);
      n.vx = lerp(fx, n.x, k);
      n.vy = lerp(fy, n.y, k);
    });
  }

  /** Graft: both records slide together and become one double-outlined plate. */
  async playFuse(): Promise<void> {
    if (!this.seam) return;
    const a = this.nodes.get(this.seam.a)!;
    const b = this.nodes.get(this.seam.b)!;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const [ax, ay, bx, by] = [a.vx, a.vy, b.vx, b.vy];
    if (this.opts.reduced) {
      this.seam.ghost.classList.add("fused");
      return;
    }
    await this.tween(420, (t) => {
      const k = easeRise(t);
      a.vx = lerp(ax, mx, k);
      a.vy = lerp(ay, my, k);
      b.vx = lerp(bx, mx, k);
      b.vy = lerp(by, my, k);
      a.el.style.opacity = b.el.style.opacity = String(1 - t * 0.7);
      if (this.seam) this.seam.zip = 1 - t;
    });
    this.seam.ghost.classList.add("fused", "pulse");
    await wait(240);
  }

  /** Cleave: the zip opens from the top and the records stay apart. */
  async playSplit(): Promise<void> {
    if (!this.seam) return;
    const s = this.seam;
    if (this.opts.reduced) {
      s.zip = 0;
      this.drawSeam();
      return;
    }
    await this.tween(480, (t) => {
      s.zip = 1 - t;
      this.drawSeam();
    });
  }

  private drawSeam() {
    const s = this.seam;
    if (!s) return;
    const A = this.nodes.get(s.a);
    const B = this.nodes.get(s.b);
    if (!A || !B) return;
    const k = this.nodeScale();
    const ea = this.ends(A, k);
    const eb = this.ends(B, k);
    const right = ea.c.x < eb.c.x;
    const x1 = right ? ea.right + 6 : ea.left - 6;
    const x2 = right ? eb.left - 6 : eb.right + 6;
    const y = (ea.c.y + eb.c.y) / 2;
    const span = Math.abs(x2 - x1);
    const count = Math.max(0, Math.floor(span / 9));
    const shown = Math.round(count * s.zip);
    let st = "";
    const dir = x2 > x1 ? 1 : -1;
    for (let i = 1; i < shown; i++) {
      const cx = x1 + dir * i * 9;
      const up = i % 2 ? -7 : 7;
      st += `M${cx},${y} L${cx},${y + up} `;
    }
    this.gSeam.innerHTML = `<path class="zip-line" d="M${x1},${y} L${x2},${y}"/><path class="zip-teeth" d="${st}"/>`;
    const mx = (x1 + x2) / 2;
    s.chip.style.transform = `translate(${mx}px, ${Math.min(ea.top, eb.top) - 16}px) translate(-50%, -100%)`;
    s.ghost.style.transform = `translate(${(ea.c.x + eb.c.x) / 2}px, ${y}px) translate(-50%, -50%) scale(${k.toFixed(3)})`;
  }

  // ------------------------------------------------------------ the depth gauge and book map
  snapshot(): {
    nodes: { id: string; x: number; y: number; kind: string; onString: boolean; client: boolean }[];
    edges: { s: string; t: string }[];
    view: { x: number; y: number; w: number; h: number };
    string: string[];
    rows: { y: number; label: string }[];
    book: boolean;
  } {
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    const tl = this.sigma.viewportToGraph({ x: 0, y: 0 });
    const br = this.sigma.viewportToGraph({ x: W, y: H });
    const main = this.traces.find((s) => s.spec.weight !== "faint");
    return {
      nodes: [...this.nodes.values()].filter((n) => n.shown).map((n) => ({ id: n.id, x: n.x, y: n.y, kind: n.kind, onString: !!main?.spec.ids.includes(n.id), client: !!n.client })),
      edges: [...this.edges.values()].map((e) => ({ s: e.s, t: e.t })),
      view: { x: tl.x, y: -tl.y, w: br.x - tl.x, h: -br.y + tl.y },
      string: main?.spec.ids ?? [],
      rows: this.rows,
      book: this.pins,
    };
  }

  // ------------------------------------------------------------ theme and lifecycle
  readColors(): void {
    void css("--ink");
  }
  restyle(): void {
    for (const n of this.nodes.values()) this.measure(n);
    this.sigma?.refresh();
  }

  private tween(dur: number, fn: (t: number) => void): Promise<void> {
    return new Promise((resolve) => {
      if (this.opts.reduced) {
        fn(1);
        resolve();
        return;
      }
      const t0 = performance.now();
      const step = (now: number) => {
        if (this.destroyed) return resolve();
        const t = Math.max(0, Math.min(1, (now - t0) / dur));
        fn(t);
        this.sigma.refresh({ skipIndexation: true });
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.sigma.kill();
    this.host.innerHTML = "";
  }
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}
