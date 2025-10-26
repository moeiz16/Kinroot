// The chart band and its quiet chrome: the canvas, a small toolbar (changes, key, zoom, fit) in the top-right
// corner, an optional slot top-left (lenses) and one chip bottom-left (the traced owner and their share).
// Status badges, shape glyphs and the mark live here too. See DESIGN.md §4.
import { CalendarRange, GitCompareArrows, Info, Lock, Minus, Plus, Scan } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fmtDate } from "../lib/dates";
import { ratingLook } from "../lib/format";
import { BoardStage, useBoard } from "./board";

/** The shape of a party, as drawn on the chart: box, pill, circle. */
export function KindGlyph({ kind, size = 14 }: { kind: string; size?: number }) {
  const s = size;
  if (kind === "person" || kind === "individual") return <svg width={s} height={s} aria-hidden className="kglyph"><circle cx={s / 2} cy={s / 2} r={s / 2 - 1.2} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
  if (kind === "trust") return <svg width={s + 4} height={s} aria-hidden className="kglyph"><rect x="1" y="2.5" width={s + 2} height={s - 5} rx={(s - 5) / 2} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
  if (kind === "restricted") return <Lock size={s - 1} aria-hidden className="kglyph" strokeWidth={2} />;
  if (kind === "page") return <svg width={s} height={s} aria-hidden className="kglyph"><rect x="2" y="1.5" width={s - 4} height={s - 3} rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
  return <svg width={s} height={s} aria-hidden className="kglyph"><rect x="1" y="2.5" width={s - 2} height={s - 5} rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

export function RatingTag({ r, small, word }: { r: "low" | "medium" | "high" | null | undefined; small?: boolean; word?: string }) {
  const l = ratingLook(r);
  const tone = l.cls === "neutral" ? "neutral" : l.cls;
  return (
    <Badge tone={tone as "clear"} className={small ? "badge-sm" : undefined}>
      <span className="g" aria-hidden />
      {word ?? l.word}
    </Badge>
  );
}

export type Tone = "clear" | "review" | "high" | "neutral" | "restricted" | "unknown";
/** Status language: a dot and a word on a tint (DESIGN.md §7). */
export function Status({ tone, children }: { tone: Tone; glyph?: string; children: ReactNode }) {
  return (
    <Badge tone={tone}>
      <span className="g" aria-hidden>
        {tone === "restricted" ? <Lock size={11} strokeWidth={2.2} /> : null}
      </span>
      {children}
    </Badge>
  );
}

/** Kinroot's mark: a person over a holding, joined by a root line, on a plum tile. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="mark-svg">
      <rect width="24" height="24" rx="7" fill="var(--accent)" />
      <circle cx="12" cy="7.6" r="2.6" fill="none" stroke="var(--accent-fg)" strokeWidth="1.8" />
      <path d="M12 10.2 V13.4 M7 17.4 V15.4 H17 V17.4" fill="none" stroke="var(--accent-fg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const KEY_ITEMS: Record<string, ReactNode> = {
  person: (
    <span key="p">
      <KindGlyph kind="person" size={14} />
      Person
    </span>
  ),
  company: (
    <span key="c">
      <KindGlyph kind="company" size={14} />
      Company
    </span>
  ),
  trust: (
    <span key="t">
      <KindGlyph kind="trust" size={14} />
      Trust
    </span>
  ),
  owns: (
    <span key="o">
      <svg width="22" height="8" aria-hidden>
        <path d="M1 4 H21" stroke="var(--line)" strokeWidth="1.4" />
      </svg>
      Owns
    </span>
  ),
  controls: (
    <span key="ct">
      <svg width="22" height="8" aria-hidden>
        <path d="M1 4 H21" stroke="var(--line)" strokeWidth="1.3" strokeDasharray="5 4" />
      </svg>
      Controls
    </span>
  ),
  trace: (
    <span key="s">
      <svg width="22" height="8" aria-hidden>
        <path d="M1 4 H21" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      Path to the owner
    </span>
  ),
  shared: (
    <span key="sh">
      <svg width="22" height="8" aria-hidden>
        <path d="M1 4 H21" stroke="var(--line-soft)" strokeWidth="1.4" />
      </svg>
      Shared officer or address
    </span>
  ),
};

export function Legend({ items = ["person", "company", "trust", "owns", "controls", "trace"] }: { items?: string[] }) {
  return (
    <div className="legend" aria-label="Key">
      {items.map((k) => KEY_ITEMS[k])}
    </div>
  );
}

/** Changes, key, zoom out, zoom in, fit. */
export function ChartTools({ compare, legend, extra }: { compare?: CompareProps; legend?: string[] | false; extra?: ReactNode }) {
  const board = useBoard();
  const [picking, setPicking] = useState(false);
  return (
    <div className="chart-tools" role="toolbar" aria-label="Chart tools">
      {compare?.onToggle && (
        <Tip label={compare.compare ? `Showing changes since ${fmtDate(compare.compare)}` : "Show changes since onboarding"}>
          <button type="button" aria-pressed={!!compare.compare} onClick={compare.onToggle} aria-label="Show what changed">
            <GitCompareArrows />
            <span>Changes</span>
          </button>
        </Tip>
      )}
      {compare?.onPick && compare.compare && (
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Change the compare date">
              <CalendarRange />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[220px] p-3">
            <label className="field">
              <span>Compare with</span>
              <Input
                type="date"
                aria-label="Compare with date"
                defaultValue={compare.compare ?? undefined}
                max={compare.asAt}
                onChange={(e) => {
                  if (e.target.value) {
                    compare.onPick?.(e.target.value);
                    setPicking(false);
                  }
                }}
              />
            </label>
          </PopoverContent>
        </Popover>
      )}
      {compare?.onToggle && <span className="sep" aria-hidden />}
      {extra}
      {legend !== false && (
        <Popover>
          <Tip label="Key">
            <PopoverTrigger asChild>
              <button type="button" aria-label="Key">
                <Info />
              </button>
            </PopoverTrigger>
          </Tip>
          <PopoverContent align="end" className="w-[220px] p-4">
            <Legend items={legend} />
          </PopoverContent>
        </Popover>
      )}
      <Tip label="Zoom out (⌘ scroll)">
        <button type="button" aria-label="Zoom out" onClick={() => board.engine()?.zoomBy(1 / 1.4)}>
          <Minus />
        </button>
      </Tip>
      <Tip label="Zoom in (⌘ scroll)">
        <button type="button" aria-label="Zoom in" onClick={() => board.engine()?.zoomBy(1.4)}>
          <Plus />
        </button>
      </Tip>
      <Tip label="Fit">
        <button type="button" aria-label="Fit to screen" onClick={() => board.engine()?.fit()}>
          <Scan />
        </button>
      </Tip>
    </div>
  );
}

/** The traced owner as one chip: their name and effective share; the hops are in the tooltip. */
export function TraceChip({ hops, end, onClick }: { hops: string[]; end?: string; onClick?: () => void }) {
  if (hops.length < 2) return null;
  const label = `Path: ${hops.join(", then ")}${end ? `. Effective share ${end}` : ""}`;
  return (
    <Tip label={hops.join(" → ")}>
      <button type="button" className="chip" onClick={onClick} aria-label={label}>
        <span className="sw" aria-hidden />
        {hops[0]}
        {end && <b>{end}</b>}
      </button>
    </Tip>
  );
}

/** A chart card: the canvas, the toolbar and up to two overlay slots. Mounts the page's one chart. */
export function ChartBand({
  label,
  compare,
  tools,
  legend,
  trace,
  onTrace,
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
  title?: string;
  compare?: CompareProps;
  tools?: { extra?: ReactNode } | false;
  legend?: string[] | false;
  trace?: { hops: string[]; end?: string } | null;
  onTrace?: () => void;
  foot?: ReactNode;
  height?: "tall" | "mid" | "short" | "book";
  className?: string;
  children?: ReactNode;
  restricted?: boolean;
}) {
  return (
    <section className={cn("chart-band", `h-${height}`, restricted && "restricted", className)} aria-label={label}>
      <div className="chart-frame">
        <BoardStage label={label} />
        {bar && <div className="chart-overlay-tl">{bar}</div>}
        {tools !== false && (
          <div className="chart-overlay-tr">
            <ChartTools compare={compare} legend={legend} extra={tools?.extra} />
          </div>
        )}
        {(trace || foot) && (
          <div className="chart-overlay-bl">
            {trace ? <TraceChip hops={trace.hops} end={trace.end} onClick={onTrace} /> : null}
            {foot}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
