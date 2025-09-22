// The board engine. Sigma 3 owns the camera, the coordinate space (custom bbox, so unfolding never rescales the
// view), hit-testing and the WebGL ownership arrows; nodes are transparent in WebGL at their real radius so
// arrowheads stop at the shape. An evidence layer (absolutely positioned HTML + one SVG, synced on afterRender)
// draws node shapes and labels (focusable buttons), dashed control edges, labels, tags and the red string.
import Graph from "graphology";
import Sigma from "sigma";
import { createEdgeArrowProgram } from "sigma/rendering";
import { extents } from "./layout";
import type { BEdge, BNode, Scene, StringSpec } from "./model";

const SVGNS = "http://www.w3.org/2000/svg";
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Unfold spring as an easing curve (≈ stiffness 220, damping 22, 6% overshoot). */
export const easeUnfold = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);
/** String snapping taut: damped oscillation 1 − e^(−6t)·cos 9t. */
export const easeTaut = (t: number) => 1 - Math.exp(-6 * t) * Math.cos(9 * t);
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
  /** called after every evidence-layer sync (camera move, animation frame) */
  onSync?: () => void;
  ariaLabel?: string;
  /** extra space reserved around the content when fitting it (px, layout units) */
  pad?: { x: number; y: number };
}

interface RNode extends BNode {
  el: HTMLElement;
  vx: number;
  vy: number;
  scale: number;
  shown: boolean;
}
interface REdge extends BEdge {
  bow?: number;
  path?: SVGPathElement;
  lbl?: HTMLElement;
  tagEl?: HTMLElement;
  citeEl?: HTMLElement;
  onString?: boolean;
}
interface RString {
  spec: StringSpec;
  under: SVGPathElement;
  line: SVGPathElement;
  knot?: SVGCircleElement;
  tag?: HTMLElement;
  slack: number;
  progress: number;
}

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#3A4146";
}
function radius(n: BNode): number {
  return n.pin ? 14 : n.client ? 23 : n.kind === "list" ? 22 : 19;
}

export class BoardEngine {
  readonly host: HTMLElement;
  private opts: EngineOptions;
  private graph = new Graph({ type: "directed", multi: true });
  private sigma: Sigma;
  private svg: SVGSVGElement;
  private gEdges: SVGGElement;
  private gSeam: SVGGElement;
  private gString: SVGGElement;
  private hLabels: HTMLElement;
  private hNodes: HTMLElement;
  private overlay: HTMLElement;
  private nodes = new Map<string, RNode>();
  private edges = new Map<string, REdge>();
  private strings: RString[] = [];
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private center = { x: 0, y: 0 }; // content centre in layout px
  private base = 1; // layout px → viewport px at camera ratio 1
  private selected: string | null = null;
  private dimSet: Set<string> | null = null;
  private hoverId: string | null = null;
  private focusMode = false;
  private seam: { a: string; b: string; chip: HTMLElement; ghost: HTMLElement; stitches: number; onFuse?: () => void } | null = null;
  private colors = { own: "#3A4146", faint: "#B9C0BE" };
  private destroyed = false;
  private raf = 0;
  private sceneKey = "";
  private content = { w: 0, h: 0 };

  constructor(host: HTMLElement, opts: EngineOptions = {}) {
    this.host = host;
    this.opts = opts;
    host.classList.add("board");
    host.innerHTML = "";
    const sHost = document.createElement("div");
    sHost.className = "sigma-host";
    this.overlay = document.createElement("div");
    this.overlay.className = "overlay";
    this.svg = document.createElementNS(SVGNS, "svg");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.innerHTML =
      '<defs><marker id="kr-ah-ctrl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--edge-ctrl)"/></marker>' +
      '<marker id="kr-ah-unk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--faint)"/></marker>' +
      '<marker id="kr-ah-own" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--edge-own)"/></marker></defs>';
    this.gEdges = document.createElementNS(SVGNS, "g");
    this.gSeam = document.createElementNS(SVGNS, "g");
    this.gString = document.createElementNS(SVGNS, "g");
    this.svg.append(this.gEdges, this.gSeam, this.gString);
    this.hLabels = document.createElement("div");
    this.hLabels.className = "h-labels";
    this.hNodes = document.createElement("div");
    this.hNodes.className = "h-nodes";
    this.hNodes.setAttribute("role", "group");
    this.hNodes.setAttribute("aria-label", opts.ariaLabel ?? "Ownership board. Use the arrow keys to move between connected parties.");
    this.overlay.append(this.svg, this.hLabels, this.hNodes);
    host.append(sHost, this.overlay);
    this.readColors();

    this.sigma = new Sigma(this.graph, sHost, {
      renderLabels: false,
      renderEdgeLabels: false,
      enableEdgeEvents: false,
      defaultEdgeType: "arrow",
      stagePadding: 0,
      zIndex: true,
      minCameraRatio: 0.35,
      maxCameraRatio: 3,
      zoomToSizeRatioFunction: () => 1,
      edgeProgramClasses: { arrow: createEdgeArrowProgram({ lengthToThicknessRatio: 4.2, widenessToThicknessRatio: 3.4 }) },
      nodeReducer: (key, attr) => {
        const n = this.nodes.get(key);
        return { ...attr, hidden: !n?.shown, size: n ? radius(n) * this.nodeScale() + 1 : 1, color: "rgba(0,0,0,0)" };
      },
      edgeReducer: (key, attr) => {
        const e = this.edges.get(key);
        const a = e && this.nodes.get(e.s);
        const b = e && this.nodes.get(e.t);
        const hidden = !e || e.kind !== "own" || !!e.removed || !!e.curve || !!e.onString || !a?.shown || !b?.shown;
        const dimmed = e && this.isDimmed(e.s) && this.isDimmed(e.t);
        return { ...attr, hidden, size: 1.6, color: dimmed ? this.colors.faint : this.colors.own };
      },
    });
    this.sigma.on("afterRender", () => this.sync());
    this.sigma.getCamera().on("updated", () => this.scheduleChange());
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
    this.hLabels.innerHTML = "";
    this.hNodes.innerHTML = "";
    const animate = (unfold && !this.opts.reduced && !same) || hold;
    // Same scene, new parties (e.g. an owner added while onboarding): only the newcomers unfold.
    const fresh = same && !this.opts.reduced && prevIds.size ? scene.nodes.filter((n) => !prevIds.has(n.id)).map((n) => n.id) : [];
    for (const n of scene.nodes) this.addNode(n, (!animate || n.level === 0) && !fresh.includes(n.id));
    for (const e of scene.edges) this.addEdge(e);
    const ext = extents(scene.nodes);
    this.center = { x: (ext.minX + ext.maxX) / 2 + 60, y: (ext.minY + ext.maxY) / 2 };
    const pad = this.opts.pad ?? { x: 230, y: 120 };
    this.content = { w: ext.maxX - ext.minX + pad.x, h: ext.maxY - ext.minY + pad.y };
    this.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
    this.applyBBox();
    this.restyle();
    if (animate && !hold) await this.unfoldAll();
    else if (fresh.length) await this.unfoldGroup([...this.nodes.values()].filter((n) => fresh.includes(n.id)));
  }

  /** Unfold every hidden layer, hop by hop (620 ms each, 90 ms apart). */
  async unfoldAll(): Promise<void> {
    const key = this.sceneKey;
    const levels = [...new Set([...this.nodes.values()].filter((n) => !n.shown).map((n) => n.level))].sort((a, b) => a - b);
    for (const lvl of levels) {
      if (this.destroyed || this.sceneKey !== key) return;
      if (this.opts.reduced) {
        [...this.nodes.values()].filter((n) => n.level === lvl).forEach((n) => {
          n.shown = true;
          n.el.style.opacity = n.removed ? "0.35" : "1";
        });
        continue;
      }
      await this.unfold(lvl);
      await wait(90);
    }
    this.sigma.refresh();
    this.sync();
  }

  /** Where a node sits on screen right now (viewport px), for things pinned to it. */
  nodeViewport(id: string): { x: number; y: number } | null {
    const n = this.nodes.get(id);
    return n ? this.vp(n) : null;
  }
  setNodeLabel(id: string, label: string): void {
    const n = this.nodes.get(id);
    const b = n?.el.querySelector(".lbl b");
    if (n && b) {
      n.label = label;
      b.textContent = label;
    }
  }
  setNodeSub(id: string, sub: string): void {
    const small = this.nodes.get(id)?.el.querySelector(".lbl small");
    if (small) small.textContent = sub;
  }

  private addNode(n: BNode, shown: boolean) {
    const el = document.createElement("div");
    const kindClass = n.kind === "company" ? "entity" : n.kind === "trust" || n.kind === "partnership" ? `arrangement ${n.kind}` : n.kind;
    el.className = `node ${kindClass}${n.client ? " client" : ""}${n.pin ? " pin-node" : ""}${n.cand ? " cand" : ""}${n.leftLabel ? " left" : ""}${n.removed ? " removed" : ""}${n.rating ? ` r-${n.rating}` : ""}`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", n.aria + (n.since ? `, ${n.since.replace("+ ", "")}` : "") + (n.removed ? `, ${n.removed.replace("– ", "")}` : ""));
    el.dataset.id = n.id;
    const rating = n.rating ? `<span class="rglyph r-${n.rating}" aria-hidden="true">${n.rating === "high" ? "▲" : n.rating === "medium" ? "◆" : "●"}</span>` : "";
    const flags = n.flags.map((f) => `<span class="flag ${f.level}">${esc(f.text)}</span>`).join("");
    el.innerHTML =
      `${n.client && !n.pin ? '<span class="pin" aria-hidden="true"></span>' : ""}<div class="shape" aria-hidden="true">${esc(n.glyph)}${n.pep ? '<span class="pep">PEP</span>' : ""}${rating}</div>` +
      `<div class="lbl"><b>${esc(n.label)}</b>${n.sub ? `<small>${esc(n.sub)}</small>` : ""}${flags}${n.since ? `<span class="since">${esc(n.since)}</span>` : ""}${n.rec ? `<span class="rec">${esc(n.rec)}</span>` : ""}${n.tag ? `<span class="ptag">${esc(n.tag)}</span>` : ""}</div>` +
      `${n.badge ? `<span class="nbadge" aria-hidden="true">${n.badge}</span>` : ""}`;
    el.style.opacity = shown ? (n.removed ? "0.35" : "1") : "0";
    el.addEventListener("click", () => this.opts.onActivate?.(n.id));
    el.addEventListener("keydown", (ev) => this.onKey(ev, n.id));
    el.addEventListener("focus", () => {
      this.opts.onFocusNode?.(n.id);
    });
    el.addEventListener("pointerenter", () => this.hover(n.id));
    el.addEventListener("pointerleave", () => this.hover(null));
    this.hNodes.appendChild(el);
    const rn: RNode = { ...n, el, vx: n.x, vy: n.y, scale: 1, shown };
    this.nodes.set(n.id, rn);
    this.graph.addNode(n.id, { x: n.x, y: -n.y, size: radius(n), color: "rgba(0,0,0,0)", label: n.label, zIndex: 1 });
  }

  private addEdge(e: BEdge) {
    if (!this.nodes.has(e.s) || !this.nodes.has(e.t)) return;
    const re: REdge = { ...e };
    // A link that skips a row would cut through the parties between: it bows out instead.
    const na = this.nodes.get(e.s)!;
    const nb = this.nodes.get(e.t)!;
    const skips = !e.curve && Math.abs(na.y - nb.y) > 240 && e.kind !== "faint" && e.kind !== "possible";
    if (skips) re.bow = 70 * (na.x >= nb.x ? -1 : 1);
    const svgDrawn = e.kind !== "own" || e.removed || e.curve || skips;
    if (svgDrawn) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("fill", "none");
      const style =
        e.kind === "ctrl"
          ? { stroke: "var(--edge-ctrl)", dash: "6 4", marker: "kr-ah-ctrl", w: "1.5" }
          : e.kind === "unknown"
            ? { stroke: "var(--faint)", dash: "2 4", marker: "kr-ah-unk", w: "1.5" }
            : e.kind === "faint"
              ? { stroke: "var(--edge-faint)", dash: "", marker: "", w: "1" }
              : e.kind === "possible"
                ? { stroke: "var(--string)", dash: "3 3", marker: "", w: "1.5" }
                : { stroke: "var(--edge-own)", dash: e.removed ? "6 4" : "", marker: "kr-ah-own", w: "1.6" };
      p.setAttribute("stroke", style.stroke);
      p.setAttribute("stroke-width", style.w);
      if (style.dash) p.setAttribute("stroke-dasharray", style.dash);
      if (style.marker) p.setAttribute("marker-end", `url(#${style.marker})`);
      this.gEdges.appendChild(p);
      re.path = p;
    } else {
      this.graph.addEdgeWithKey(e.id, e.s, e.t, { size: 1.6, type: "arrow" });
    }
    if (e.label) {
      const l = document.createElement("div");
      l.className = "elabel " + (e.kind === "ctrl" ? "ctrl" : e.kind === "unknown" ? "unknown" : e.kind === "possible" ? "possible" : "") + (e.curve ? " loop" : "");
      l.textContent = e.label;
      this.hLabels.appendChild(l);
      re.lbl = l;
    }
    if (e.added || e.removed) {
      const t = document.createElement("div");
      t.className = "etag" + (e.removed ? " gone" : "");
      t.textContent = e.added ?? e.removed ?? "";
      this.hLabels.appendChild(t);
      re.tagEl = t;
    }
    if (e.cite) {
      const c = document.createElement("div");
      c.className = "ecite";
      c.textContent = String(e.cite);
      this.hLabels.appendChild(c);
      re.citeEl = c;
    }
    // Parallel links between the same two parties (owns and controls) bow apart so neither hides the other.
    const twins = [...this.edges.values()].filter((x) => (x.s === e.s && x.t === e.t) || (x.s === e.t && x.t === e.s));
    if (twins.length && svgDrawn) re.bow = (re.bow ?? 0) + 52 * twins.length;
    this.edges.set(e.id, re);
  }

  private unfold(level: number, dur = 620) {
    return this.unfoldGroup([...this.nodes.values()].filter((n) => n.level === level), dur);
  }

  private async unfoldGroup(group: RNode[], dur = 620) {
    group.forEach((n) => (n.shown = true));
    this.sigma.refresh();
    await this.tween(dur, (t) => {
      const k = easeUnfold(t);
      for (const n of group) {
        const from = n.from ? this.nodes.get(n.from) : undefined;
        const fx = from ? from.x : n.x;
        const fy = from ? from.y : n.y;
        n.vx = lerp(fx, n.x, k);
        n.vy = lerp(fy, n.y, k);
        n.scale = lerp(0.6, 1, Math.min(1, t * 1.6));
        n.el.style.opacity = String(Math.min(1, t / 0.45) * (n.removed ? 0.35 : 1));
        this.graph.mergeNodeAttributes(n.id, { x: n.vx, y: -n.vy });
      }
    });
    for (const n of group) {
      n.vx = n.x;
      n.vy = n.y;
      n.scale = 1;
      this.graph.mergeNodeAttributes(n.id, { x: n.x, y: -n.y });
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

  /** Fit the content into the visible part of the board (the host minus floating chrome and the drawer). */
  private applyBBox() {
    const W = this.host.clientWidth || 1;
    const H = this.host.clientHeight || 1;
    const vw = Math.max(80, W - this.insets.left - this.insets.right);
    const vh = Math.max(80, H - this.insets.top - this.insets.bottom);
    const s = clamp(Math.min(vw / Math.max(1, this.content.w), vh / Math.max(1, this.content.h)), 0.42, 1);
    this.base = s;
    const vcx = this.insets.left + vw / 2;
    const vcy = this.insets.top + vh / 2;
    const L = this.center.x - vcx / s;
    const T = this.center.y - vcy / s;
    this.sigma.setCustomBBox({ x: [L, L + W / s], y: [-(T + H / s), -T] });
    this.sigma.refresh();
  }

  resize(): void {
    this.sigma.resize();
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
  /** Fly the camera to a node (Fly to, 450 ms). */
  flyTo(id: string, ratio = 0.8): void {
    const n = this.nodes.get(id);
    if (!n) return;
    const p = this.sigma.graphToViewport({ x: n.x, y: -n.y });
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    const cam = this.sigma.getCamera();
    const vcx = this.insets.left + (W - this.insets.left - this.insets.right) / 2;
    const vcy = this.insets.top + (H - this.insets.top - this.insets.bottom) / 2;
    const target = this.sigma.viewportToFramedGraph({ x: p.x + (W / 2 - vcx), y: p.y + (H / 2 - vcy) });
    const state = { x: target.x, y: target.y, ratio: Math.min(cam.ratio, ratio) };
    if (this.opts.reduced) cam.setState(state);
    else void cam.animate(state, { duration: 450, easing: "quadraticInOut" });
  }

  private nodeScale(): number {
    return clamp(this.base / this.sigma.getCamera().ratio, 0.5, 1.5);
  }
  private vp(n: RNode) {
    return this.sigma.graphToViewport({ x: n.vx, y: -n.vy });
  }

  // ------------------------------------------------------------ evidence layer sync
  private sync() {
    if (this.destroyed) return;
    const k = this.nodeScale();
    for (const n of this.nodes.values()) {
      const p = this.vp(n);
      const r = radius(n);
      const s = k * n.scale;
      const dx = n.leftLabel ? n.el.offsetWidth - r : r;
      n.el.style.transform = `translate(${p.x - dx}px, ${p.y - r}px) scale(${s})`;
      n.el.style.transformOrigin = `${dx}px ${r}px`;
      n.el.classList.toggle("dim", this.isDimmed(n.id));
      n.el.classList.toggle("selected", this.selected === n.id);
      n.el.classList.toggle("compact", k < 0.6);
    }
    for (const e of this.edges.values()) this.syncEdge(e, k);
    this.drawStrings();
    this.drawSeam();
    this.opts.onSync?.();
  }

  private syncEdge(e: REdge, k: number) {
    const a = this.nodes.get(e.s)!;
    const b = this.nodes.get(e.t)!;
    const vis = a.shown && b.shown;
    const pa = this.vp(a);
    const pb = this.vp(b);
    const t = trimmed(pa, pb, (radius(a) + 2) * k, (radius(b) + 3) * k);
    let mid = { x: lerp(t.x1, t.x2, e.labelAt ?? 0.5), y: lerp(t.y1, t.y2, e.labelAt ?? 0.5) };
    if (e.path) {
      if (e.curve) {
        // A back edge (circular holding) bows out to the right of both parties.
        const bow = Math.max(90, Math.abs(pa.y - pb.y) * 0.6) * k;
        const side = pb.x < pa.x ? -1 : 1; // loop round the outside, away from the parties in between
        const cx = side < 0 ? Math.min(pa.x, pb.x) - bow : Math.max(pa.x, pb.x) + bow;
        const cy = (pa.y + pb.y) / 2;
        e.path.setAttribute("d", `M${pa.x + side * radius(a) * k},${pa.y} Q${cx},${cy} ${pb.x + side * (radius(b) + 3) * k},${pb.y}`);
        mid = { x: 0.25 * pa.x + 0.5 * cx + 0.25 * pb.x, y: cy };
      } else if (e.bow) {
        const len = Math.hypot(t.x2 - t.x1, t.y2 - t.y1) || 1;
        const cx = (t.x1 + t.x2) / 2 + (-(t.y2 - t.y1) / len) * e.bow * k;
        const cy = (t.y1 + t.y2) / 2 + ((t.x2 - t.x1) / len) * e.bow * k;
        e.path.setAttribute("d", `M${t.x1},${t.y1} Q${cx},${cy} ${t.x2},${t.y2}`);
        mid = { x: 0.25 * t.x1 + 0.5 * cx + 0.25 * t.x2, y: 0.25 * t.y1 + 0.5 * cy + 0.25 * t.y2 };
      } else e.path.setAttribute("d", `M${t.x1},${t.y1} L${t.x2},${t.y2}`);
      const dimmed = this.isDimmed(e.s) && this.isDimmed(e.t);
      e.path.style.opacity = !vis || e.onString ? "0" : e.removed || dimmed ? "0.35" : "1";
    }
    if (e.lbl) {
      e.lbl.style.transform = `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%)`;
      e.lbl.style.opacity = vis ? (e.removed ? "0.5" : "1") : "0";
      e.lbl.classList.toggle("on-string", !!e.onString);
    }
    if (e.tagEl) {
      e.tagEl.style.transform = `translate(${mid.x}px, ${mid.y + 14}px) translate(-50%, 0)`;
      e.tagEl.style.opacity = vis ? "1" : "0";
    }
    if (e.citeEl) {
      e.citeEl.style.transform = `translate(${mid.x + (e.lbl ? e.lbl.offsetWidth / 2 + 12 : 0)}px, ${mid.y}px) translate(-50%, -50%)`;
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
    this.sigma.refresh();
  }
  setFocusMode(on: boolean): void {
    this.focusMode = on;
    this.sigma.refresh();
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
    this.sigma.refresh();
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
    const pool = d[1] !== 0 ? linked : [...this.nodes.values()].filter((m) => m.level === n.level && m.id !== id).map((m) => m.id);
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

  // ------------------------------------------------------------ the red string
  clearStrings(): void {
    this.strings.forEach((s) => {
      s.under.remove();
      s.line.remove();
      s.knot?.remove();
      s.tag?.remove();
    });
    this.strings = [];
    for (const e of this.edges.values()) e.onString = false;
    for (const n of this.nodes.values()) n.el.classList.remove("ubo");
    if (this.graph.order) this.sigma.refresh();
  }

  /** Pull the thread: each string appears slack and snaps taut while a knot travels from owner to client. */
  async pull(specs: StringSpec[], { animate = true, dur = 1100 }: { animate?: boolean; dur?: number } = {}): Promise<void> {
    this.clearStrings();
    const live = specs.filter((s) => s.ids.length > 1 && s.ids.every((id) => this.nodes.has(id)));
    if (!live.length) return;
    for (const spec of live) {
      const full = spec.weight !== "faint";
      const under = document.createElementNS(SVGNS, "path");
      under.setAttribute("fill", "none");
      under.setAttribute("stroke", "var(--canvas)");
      under.setAttribute("stroke-width", full ? "9" : "5");
      under.setAttribute("stroke-linecap", "round");
      const line = document.createElementNS(SVGNS, "path");
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "var(--string)");
      line.setAttribute("stroke-width", full ? "3" : "1.5");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("stroke-linejoin", "round");
      if (!full) line.setAttribute("opacity", "0.5");
      this.gString.append(under, line);
      const s: RString = { spec, under, line, slack: 0, progress: 1 };
      if (full) {
        s.knot = document.createElementNS(SVGNS, "circle");
        s.knot.setAttribute("r", "6");
        s.knot.setAttribute("fill", "var(--string)");
        s.knot.setAttribute("stroke", "var(--canvas)");
        s.knot.setAttribute("stroke-width", "2.5");
        this.gString.append(s.knot);
        for (let i = 1; i < spec.ids.length; i++) {
          const e = [...this.edges.values()].find((x) => (x.s === spec.ids[i - 1] && x.t === spec.ids[i]) || (x.s === spec.ids[i] && x.t === spec.ids[i - 1]));
          if (e) e.onString = true;
        }
        if (spec.tag) {
          s.tag = document.createElement("div");
          s.tag.className = "string-tag";
          s.tag.setAttribute("role", "status");
          this.overlay.appendChild(s.tag);
        }
        this.nodes.get(spec.ids[0]!)?.el.classList.add("ubo");
      }
      this.strings.push(s);
    }
    this.sigma.refresh();
    const main = this.strings.find((s) => s.spec.weight !== "faint");
    const setTag = (t: number) => {
      if (!main?.tag || !main.spec.tag) return;
      const steps = main.spec.steps ?? [];
      const step = t < 1 && steps.length ? steps[Math.min(steps.length - 1, Math.floor(t * steps.length))]! : main.spec.tag;
      main.tag.innerHTML = `<span class="eq">${esc(step.eq)}</span>${esc(step.value)}`;
    };
    if (!animate || this.opts.reduced) {
      setTag(1);
      this.drawStrings();
      return;
    }
    if (main) main.slack = 46;
    await this.tween(dur, (t) => {
      if (main) {
        main.slack = 46 * (1 - easeTaut(Math.min(1, t * 1.15)));
        main.progress = t;
      }
      setTag(t);
      this.drawStrings();
    });
    if (main) {
      main.slack = 0;
      main.progress = 1;
    }
    setTag(1);
    this.drawStrings();
  }

  private drawStrings() {
    const k = this.nodeScale();
    for (const s of this.strings) {
      const pts = s.spec.ids.map((id) => this.vp(this.nodes.get(id)!));
      let d = `M${pts[0]!.x},${pts[0]!.y}`;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const sag = s.slack * (i % 2 ? 1 : -1);
        d += ` Q${mx + (-dy / len) * sag},${my + (dx / len) * sag} ${b.x},${b.y}`;
      }
      s.under.setAttribute("d", d);
      s.line.setAttribute("d", d);
      if (s.knot) {
        const total = s.line.getTotalLength?.() ?? 0;
        const pt = total ? s.line.getPointAtLength(total * s.progress) : pts[0]!;
        s.knot.setAttribute("cx", String(pt.x));
        s.knot.setAttribute("cy", String(pt.y));
        s.knot.style.opacity = s.progress > 0 && s.progress < 1 ? "1" : "0";
      }
      if (s.tag && s.spec.tag) {
        const anchor = this.nodes.get(s.spec.tag.anchor);
        if (anchor) {
          const p = this.vp(anchor);
          const maxX = this.host.clientWidth - this.insets.right - s.tag.offsetWidth - 8;
          const x = Math.max(this.insets.left, Math.min(p.x - radius(anchor) * k, maxX));
          s.tag.style.transform = `translate(${x}px, ${p.y + (radius(anchor) + 15) * k}px)`;
        }
      }
    }
  }

  // ------------------------------------------------------------ fuse and split
  /** The stitched seam between two candidate records, with drag-to-fuse. */
  setSeam(a: string, b: string, chipHtml: string, onFuse?: () => void): void {
    this.clearSeam();
    const chip = document.createElement("div");
    chip.className = "seam-chip";
    chip.innerHTML = chipHtml;
    const ghost = document.createElement("div");
    ghost.className = "ghost";
    ghost.textContent = this.nodes.get(a)?.glyph ?? "";
    ghost.setAttribute("aria-hidden", "true");
    this.overlay.append(chip, ghost);
    this.seam = { a, b, chip, ghost, stitches: 1, onFuse };
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
        const dist = Math.hypot(e.clientX - rect.left - po.x, e.clientY - rect.top - po.y);
        near = dist < 64;
        if (near) {
          // within reach the candidate pulls the record in (spring 400/30 approximated by a strong lerp)
          x = lerp(x, other.x, 0.65);
          y = lerp(y, other.y, 0.65);
        }
        n.vx = x;
        n.vy = y;
        this.graph.mergeNodeAttributes(id, { x, y: -y });
        n.el.classList.toggle("near", near);
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
      const k = easeUnfold(t);
      n.vx = lerp(fx, n.x, k);
      n.vy = lerp(fy, n.y, k);
      this.graph.mergeNodeAttributes(n.id, { x: n.vx, y: -n.vy });
    });
  }

  /** Confirmed fuse: both records slide to the midpoint and the knot pulses once. */
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
      const k = easeUnfold(t);
      a.vx = lerp(ax, mx, k);
      a.vy = lerp(ay, my, k);
      b.vx = lerp(bx, mx, k);
      b.vy = lerp(by, my, k);
      a.el.style.opacity = b.el.style.opacity = String(1 - t * 0.6);
      this.graph.mergeNodeAttributes(a.id, { x: a.vx, y: -a.vy });
      this.graph.mergeNodeAttributes(b.id, { x: b.vx, y: -b.vy });
    });
    this.seam.ghost.classList.add("fused", "pulse");
    await wait(240);
  }

  /** Split: stitches unpick right to left and the records spring apart to their own slots. */
  async playSplit(): Promise<void> {
    if (!this.seam) return;
    const s = this.seam;
    if (this.opts.reduced) {
      s.stitches = 0;
      this.drawSeam();
      return;
    }
    await this.tween(480, (t) => {
      s.stitches = 1 - t;
      this.drawSeam();
    });
  }

  private drawSeam() {
    const s = this.seam;
    if (!s) return;
    const A = this.nodes.get(s.a);
    const B = this.nodes.get(s.b);
    if (!A || !B) return;
    const a = this.vp(A);
    const b = this.vp(B);
    const k = this.nodeScale();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const r = 26 * k;
    const x1 = a.x + ux * r;
    const y1 = a.y + uy * r;
    const x2 = b.x - ux * r;
    const y2 = b.y - uy * r;
    const span = Math.max(0, Math.hypot(x2 - x1, y2 - y1));
    const count = Math.floor(span / 12);
    const shown = Math.round(count * s.stitches);
    let st = "";
    for (let i = 1; i < shown; i++) {
      const cx = x1 + ux * i * 12;
      const cy = y1 + uy * i * 12;
      st += `M${cx - uy * 5 - ux * 3},${cy + ux * 5 - uy * 3} L${cx + uy * 5 + ux * 3},${cy - ux * 5 + uy * 3} `;
    }
    this.gSeam.innerHTML = `<path d="M${x1},${y1} L${x2},${y2}" stroke="var(--string)" stroke-width="1.5" stroke-dasharray="3 3" fill="none"/><path d="${st}" stroke="var(--string)" stroke-width="1.5" stroke-linecap="round" fill="none"/>`;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    s.chip.style.transform = `translate(${mx}px, ${my - 92 * k}px) translate(-50%, 0)`;
    s.ghost.style.transform = `translate(${mx}px, ${my}px)`;
  }

  // ------------------------------------------------------------ minimap snapshot
  snapshot(): { nodes: { id: string; x: number; y: number; kind: string; onString: boolean }[]; edges: { s: string; t: string }[]; view: { x: number; y: number; w: number; h: number }; string: string[] } {
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    const tl = this.sigma.viewportToGraph({ x: 0, y: 0 });
    const br = this.sigma.viewportToGraph({ x: W, y: H });
    const main = this.strings.find((s) => s.spec.weight !== "faint");
    return {
      nodes: [...this.nodes.values()].filter((n) => n.shown).map((n) => ({ id: n.id, x: n.x, y: n.y, kind: n.kind, onString: !!main?.spec.ids.includes(n.id) })),
      edges: [...this.edges.values()].map((e) => ({ s: e.s, t: e.t })),
      view: { x: tl.x, y: -tl.y, w: br.x - tl.x, h: -br.y + tl.y },
      string: main?.spec.ids ?? [],
    };
  }

  // ------------------------------------------------------------ theme and lifecycle
  readColors(): void {
    this.colors = { own: css("--edge-own"), faint: css("--edge-faint") };
  }
  restyle(): void {
    this.readColors();
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

function trimmed(a: { x: number; y: number }, b: { x: number; y: number }, ra: number, rb: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x1: a.x + (dx / d) * ra, y1: a.y + (dy / d) * ra, x2: b.x - (dx / d) * rb, y2: b.y - (dy / d) * rb };
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}
