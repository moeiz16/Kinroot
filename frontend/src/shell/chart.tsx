// The chart band and its chrome: the chart bar (exhibit name, as-at stamp, compare, tools), the canvas with the
// depth gauge, and the foot (legend and the trace written out). Status stamps and shape glyphs live here too.
import { CalendarRange, Focus, Lock, Minus, Plus, Scan, Spline } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { fmtDate } from "../lib/dates";
import { ratingLook } from "../lib/format";
import { BoardStage, useBoard } from "./board";

/** The shape of a party, as drawn on the chart: box, oval, circle, box with a flow-through triangle. */
export function KindGlyph({ kind, size = 14 }: { kind: string; size?: number }) {
  const s = size;
  if (kind === "person" || kind === "individual") return <svg width={s} height={s} aria-hidden className="kglyph"><circle cx={s / 2} cy={s / 2} r={s / 2 - 1.3} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
  if (kind === "trust") return <svg width={s + 4} height={s} aria-hidden className="kglyph"><ellipse cx={(s + 4) / 2} cy={s / 2} rx={(s + 4) / 2 - 1.3} ry={s / 2 - 2} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
  if (kind === "partnership")
    return (
      <svg width={s} height={s} aria-hidden className="kglyph">
        <rect x="1" y="1.5" width={s - 2} height={s - 3} fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d={`M2.5 3 H${s / 2} L2.5 ${s / 2 + 1} Z`} fill="currentColor" />
      </svg>
    );
  if (kind === "page") return <svg width={s} height={s} aria-hidden className="kglyph"><path d={`M2 1.5 H${s - 5} L${s - 2} 4.5 V${s - 1.5} H2 Z`} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
  if (kind === "restricted") return <Lock size={s - 1} aria-hidden className="kglyph" strokeWidth={2.2} />;
  return <svg width={s} height={s} aria-hidden className="kglyph"><rect x="1" y="2" width={s - 2} height={s - 4} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
}

export function RatingTag({ r, small, word }: { r: "low" | "medium" | "high" | null | undefined; small?: boolean; word?: string }) {
  const l = ratingLook(r);
  const tone = l.cls === "neutral" ? "neutral" : l.cls;
  return (
    <Badge tone={tone as "clear"} className={small ? "badge-sm" : undefined}>
      <span className="g" aria-hidden>
        {l.glyph}
      </span>
      {word ?? l.word}
    </Badge>
  );
}

export type Tone = "clear" | "review" | "high" | "neutral" | "restricted" | "unknown";
/** Status language: glyph + word + tint (DESIGN.md §8). */
export function Status({ tone, glyph, children }: { tone: Tone; glyph?: string; children: ReactNode }) {
  const g = glyph ?? { clear: "●", review: "◆", high: "▲", neutral: "○", restricted: "", unknown: "?" }[tone];
  return (
    <Badge tone={tone}>
      <span className="g" aria-hidden>
        {tone === "restricted" && !glyph ? <Lock size={11} strokeWidth={2.4} /> : g}
      </span>
      {children}
    </Badge>
  );
}

/** Kinroot's mark: a person over a company, joined by an elbow. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" className="mark-svg">
      <circle cx="7" cy="6.5" r="4.6" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M7 11.1 V15.5 H17.5 V18" fill="none" stroke="var(--moss)" strokeWidth="2.4" strokeLinejoin="round" />
      <rect x="11" y="18" width="13" height="6.4" fill="var(--moss)" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
export const Logo = Mark;

interface CompareProps {
  asAt?: string;
  compare?: string | null;
  compareLabel?: string;
  onToggle?: () => void;
  onPick?: (d: string) => void;
}

/** The point-in-time stamp: As at today, compared with an earlier date. */
export function AsAt({ asAt, compare, compareLabel, onToggle, onPick }: CompareProps) {
  const [picking, setPicking] = useState(false);
  if (!asAt) return null;
  return (
    <div className="asat" role="group" aria-label="Point in time">
      <span className="asat-cell">
        <span className="k">As at</span>
        <span className="v">{fmtDate(asAt)}</span>
      </span>
      {onToggle && (
        <button type="button" className="asat-cell asat-toggle" aria-pressed={!!compare} onClick={onToggle} title={compare ? "Hide changes" : "Show what changed"}>
          <span className="k">Compared with</span>
          <span className="v">{compare ? `${fmtDate(compare)}${compareLabel ? ` · ${compareLabel}` : ""}` : "Off"}</span>
        </button>
      )}
      {onPick && (
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <button type="button" className="asat-pick" aria-label="Change the compare date">
              <CalendarRange size={15} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[220px] p-3">
            <label className="field">
              <span>Compare with</span>
              <Input
                type="date"
                aria-label="Compare with date"
                defaultValue={compare ?? undefined}
                max={asAt}
                onChange={(e) => {
                  if (e.target.value) {
                    onPick(e.target.value);
                    setPicking(false);
                  }
                }}
              />
            </label>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

/** Zoom, fit, trace and focus. */
export function ChartTools({ onThread, threadLabel = "Trace from the selected person", extra }: { onThread?: () => void; threadLabel?: string; extra?: ReactNode }) {
  const board = useBoard();
  const [focus, setFocus] = useState(false);
  return (
    <div className="chart-tools" role="toolbar" aria-label="Chart tools">
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => board.engine()?.zoomBy(1.4)}>
        <Plus />
      </button>
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => board.engine()?.zoomBy(1 / 1.4)}>
        <Minus />
      </button>
      <button type="button" aria-label="Fit to screen" title="Fit to screen" onClick={() => board.engine()?.fit()}>
        <Scan />
      </button>
      {onThread && (
        <button type="button" className="tool-word" aria-label={threadLabel} title={`${threadLabel} (T)`} onClick={onThread}>
          <Spline />
          <span>Trace</span>
        </button>
      )}
      {extra}
      <button
        type="button"
        aria-label="Focus mode: show only what is linked to the selection"
        title="Focus on the selection"
        aria-pressed={focus}
        onClick={() => {
          board.engine()?.setFocusMode(!focus);
          setFocus(!focus);
        }}
      >
        <Focus />
      </button>
    </div>
  );
}

/** The minimap, redrawn: one tick per layer of the structure, with what sits on it, and the visible window bracketed.
 * On the client book it is a small map drawn with the same glyphs, with crop marks for the window. */
export function DepthGauge() {
  const board = useBoard();
  const snap = useMemo(() => board.engine()?.snapshot() ?? null, [board, board.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!snap || !snap.nodes.length) return null;
  if (snap.book) {
    const xs = snap.nodes.map((n) => n.x);
    const ys = snap.nodes.map((n) => n.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const W = 132;
    const H = 88;
    const s = Math.min((W - 12) / (maxX - minX || 1), (H - 12) / (maxY - minY || 1));
    const tx = (x: number) => 6 + (x - minX) * s;
    const ty = (y: number) => 6 + (y - minY) * s;
    const x1 = Math.max(1, tx(snap.view.x));
    const y1 = Math.max(1, ty(snap.view.y));
    const x2 = Math.min(W - 1, tx(snap.view.x + snap.view.w));
    const y2 = Math.min(H - 1, ty(snap.view.y + snap.view.h));
    const c = 7;
    return (
      <div className="gauge book-map" aria-hidden="true">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          {snap.nodes.map((n) =>
            n.client ? <rect key={n.id} x={tx(n.x) - 2} y={ty(n.y) - 2} width={4} height={4} className="g-client" /> : <circle key={n.id} cx={tx(n.x)} cy={ty(n.y)} r={1.2} className="g-party" />,
          )}
          {x2 - x1 > 8 && y2 - y1 > 8 && <path className="g-window" d={`M${x1},${y1 + c} V${y1} H${x1 + c} M${x2 - c},${y1} H${x2} V${y1 + c} M${x2},${y2 - c} V${y2} H${x2 - c} M${x1 + c},${y2} H${x1} V${y2 - c}`} />}
        </svg>
      </div>
    );
  }
  const top = snap.view.y;
  const bottom = snap.view.y + snap.view.h;
  return (
    <nav className="gauge depth" aria-label="Layers">
      <ol>
        {snap.rows
          .slice()
          .sort((a, b) => a.y - b.y)
          .map((r) => {
            const on = snap.nodes.filter((n) => Math.abs(n.y - r.y) < 4);
            const inView = r.y >= top && r.y <= bottom;
            const traced = on.some((n) => n.onString);
            return (
              <li key={r.y}>
                <button type="button" className={cn("g-row", inView && "in-view", traced && "traced")} onClick={() => board.engine()?.flyToRow(r.y)} aria-label={`${r.label}: ${on.length} ${on.length === 1 ? "party" : "parties"}. Show this layer`}>
                  <span className="g-lbl">{r.label === "Client" ? "C" : r.label.replace(/^Layer /, "")}</span>
                  <span className="g-tick" aria-hidden />
                  <span className="g-glyphs" aria-hidden>
                    {on.slice(0, 5).map((n) => (
                      <i key={n.id} className={cn("g-g", `g-${n.kind}`, n.onString && "on")} />
                    ))}
                    {on.length > 5 && <i className="g-more">+{on.length - 5}</i>}
                  </span>
                </button>
              </li>
            );
          })}
      </ol>
    </nav>
  );
}

export function Legend({ items = ["person", "company", "trust", "owns", "controls", "trace"] }: { items?: string[] }) {
  const all: Record<string, ReactNode> = {
    person: (
      <span key="p">
        <KindGlyph kind="person" size={12} />
        Person
      </span>
    ),
    company: (
      <span key="c">
        <KindGlyph kind="company" size={12} />
        Company
      </span>
    ),
    trust: (
      <span key="t">
        <KindGlyph kind="trust" size={12} />
        Trust
      </span>
    ),
    owns: (
      <span key="o">
        <svg width="22" height="8" aria-hidden>
          <path d="M1 4 H21" stroke="var(--line-own)" strokeWidth="1.6" />
        </svg>
        Owns
      </span>
    ),
    controls: (
      <span key="ct">
        <svg width="22" height="8" aria-hidden>
          <path d="M1 4 H21" stroke="var(--line-ctrl)" strokeWidth="1.6" strokeDasharray="5 3" />
        </svg>
        Controls
      </span>
    ),
    trace: (
      <span key="s">
        <svg width="22" height="8" aria-hidden>
          <path d="M1 4 H21" stroke="var(--moss)" strokeWidth="4" strokeLinecap="round" />
        </svg>
        Traced to the owner
      </span>
    ),
    shared: (
      <span key="sh">
        <svg width="22" height="8" aria-hidden>
          <path d="M1 4 H21" stroke="var(--line-faint)" strokeWidth="1.4" />
        </svg>
        Shared officer or address
      </span>
    ),
  };
  return (
    <div className="legend" aria-label="Legend">
      {items.map((k) => all[k])}
    </div>
  );
}

/** The trace written out: the hops from the person to the client and the result. */
export function TracePath({ hops, end }: { hops: string[]; end?: string }) {
  if (hops.length < 2) return null;
  return (
    <div className="trace-path" role="note" aria-label={`Trace: ${hops.join(", then ")}${end ? `, ${end}` : ""}`}>
      <span className="k">Trace</span>
      {hops.map((h, i) => (
        <span key={i} className="hop">
          {h}
        </span>
      ))}
      {end && <b className="end">{end}</b>}
    </div>
  );
}

/** A full-width chart band: bar, canvas (with the depth gauge) and foot. Mounts the page's one chart. */
export function ChartBand({
  label,
  exhibit = "Exhibit A",
  title,
  compare,
  tools,
  legend,
  trace,
  foot,
  height = "tall",
  className,
  children,
  restricted,
  bar,
}: {
  bar?: ReactNode;
  label: string;
  exhibit?: string;
  title: string;
  compare?: CompareProps;
  tools?: { onThread?: () => void; threadLabel?: string; extra?: ReactNode } | false;
  legend?: string[] | false;
  trace?: { hops: string[]; end?: string } | null;
  foot?: ReactNode;
  height?: "tall" | "mid" | "short" | "book";
  className?: string;
  children?: ReactNode;
  restricted?: boolean;
}) {
  return (
    <section className={cn("chart-band", `h-${height}`, restricted && "restricted", className)} aria-label={label}>
      <header className="chart-bar">
        <div className="cb-title">
          <span className="k">{exhibit}</span>
          <b>{title}</b>
        </div>
        {compare && <AsAt {...compare} />}
        {bar}
        <div className="cb-grow" />
        {tools !== false && <ChartTools {...(tools ?? {})} />}
      </header>
      <div className="chart-frame">
        <BoardStage label={label} />
        <DepthGauge />
        {children}
      </div>
      {(legend !== false || trace || foot) && (
        <footer className="chart-foot">
          {trace ? <TracePath hops={trace.hops} end={trace.end} /> : null}
          {foot}
          <div className="cb-grow" />
          {legend !== false && <Legend items={legend} />}
          <span className="zoom-hint" aria-hidden>
            ⌘ or Ctrl + scroll to zoom
          </span>
        </footer>
      )}
    </section>
  );
}
