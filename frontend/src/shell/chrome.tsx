// Exhibit chrome: the exhibit label with its As at / Compared with stamp, the evidence trail, the find trigger,
// zoom + thread + focus tools, minimap and legend. All of it floats over the board and never covers the work.
import { CalendarRange, Focus, Lock, Minus, Plus, Scan, Search, Spline } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtDate } from "../lib/dates";
import { ratingLook } from "../lib/format";
import { PHONE, useMedia } from "../lib/useMedia";
import { useBoard } from "./board";
import { openFind } from "./CommandPalette";

export function KindGlyph({ kind, size = 14 }: { kind: string; size?: number }) {
  const s = size;
  if (kind === "person" || kind === "individual") return <svg width={s} height={s} aria-hidden><circle cx={s / 2} cy={s / 2} r={s / 2 - 1.2} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
  if (kind === "trust") return <svg width={s} height={s} aria-hidden><path d={`M1 1 H${s - 4} L${s - 1} 4 V${s - 1} H1 Z`} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
  if (kind === "partnership") return <svg width={s} height={s} aria-hidden><rect x="1" y="1" width={s - 2} height={s - 2} fill="none" stroke="currentColor" strokeWidth="1.4" /><path d={`M${s / 2} 1 V${s - 1}`} stroke="currentColor" strokeWidth="1.2" /></svg>;
  return <svg width={s} height={s} aria-hidden><rect x="1" y="1" width={s - 2} height={s - 2} rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

export function RatingTag({ r, small, word }: { r: "low" | "medium" | "high" | null | undefined; small?: boolean; word?: string }) {
  const l = ratingLook(r);
  const tone = l.cls === "neutral" ? "neutral" : l.cls;
  return (
    <Badge tone={tone as "clear"} className={small ? "px-1.5 py-1 text-[12px]" : undefined}>
      <span className="g" aria-hidden>
        {l.glyph}
      </span>
      {word ?? l.word}
    </Badge>
  );
}

export type Tone = "clear" | "review" | "high" | "neutral" | "restricted" | "unknown";
/** Status language: glyph + word + tint (DESIGN.md §9). */
export function Status({ tone, glyph, children }: { tone: Tone; glyph?: string; children: ReactNode }) {
  const g = glyph ?? { clear: "●", review: "◆", high: "▲", neutral: "○", restricted: "", unknown: "?" }[tone];
  return (
    <Badge tone={tone}>
      <span className="g" aria-hidden>
        {tone === "restricted" && !glyph ? <Lock size={11} strokeWidth={2.2} /> : g}
      </span>
      {children}
    </Badge>
  );
}

/** Opens the command palette from the exhibit (also `/` and ⌘K anywhere). */
export function FindTrigger() {
  const phone = useMedia(PHONE);
  if (phone) return null;
  return (
    <button type="button" className="chrome find-trigger" style={{ top: 16, right: 16 }} onClick={() => openFind()} aria-label="Find a person, company or trust">
      <Search aria-hidden />
      Find a person, company or trust
      <span className="kbd" aria-hidden>
        /
      </span>
    </button>
  );
}

/** The exhibit label. With a date it is the point-in-time stamp: As at today, compared with an earlier date. */
export function AsAt({ exhibit = "Exhibit A", title, asAt, compare, compareLabel, onToggle, onPick, top = 16 }: { exhibit?: string; title?: string; asAt?: string; compare?: string | null; compareLabel?: string; onToggle?: () => void; onPick?: (d: string) => void; top?: number }) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="chrome exhibit-label" role="group" aria-label={asAt ? "Point in time" : "Exhibit"} style={{ top, left: 16 }}>
      <div>
        <span className="k">{exhibit}</span>
        <span className="x">{title ?? "The structure"}</span>
      </div>
      {asAt && (
        <div className="x-wide">
          <span className="k">As at</span>
          <span className="v">{fmtDate(asAt)}</span>
        </div>
      )}
      {asAt && onToggle && (
        <button type="button" aria-pressed={!!compare} onClick={onToggle} title={compare ? "Hide changes" : "Show what changed"}>
          <span className="k">Compared with</span>
          <span className="v">{compare ? `${fmtDate(compare)}${compareLabel ? ` · ${compareLabel}` : ""}` : "Off"}</span>
        </button>
      )}
      {asAt && onPick && (
        <div style={{ justifyContent: "center" }}>
          <Popover open={picking} onOpenChange={setPicking}>
            <PopoverTrigger asChild>
              <button type="button" className="grid size-[30px] place-items-center text-muted hover:text-ink" aria-label="Change the compare date">
                <CalendarRange size={16} />
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
        </div>
      )}
    </div>
  );
}

/** The evidence trail: the last thread pulled, as a hop log from the person to the client. */
export function Trail({ hops, end, top = 76 }: { hops: string[]; end?: string; top?: number }) {
  if (hops.length < 2) return null;
  return (
    <div className="chrome trail" role="note" aria-label={`Trail: ${hops.join(", then ")}${end ? `, ${end}` : ""}`} style={{ top, left: 16 }}>
      <span className="k">Trail</span>
      {hops.map((h, i) => (
        <span key={i} className="hop">
          {h}
        </span>
      ))}
      {end && <span className="end">{end}</span>}
    </div>
  );
}

export function BoardTools({ onThread, threadLabel = "Pull the thread from the selected person", extra, minimap = true }: { onThread?: () => void; threadLabel?: string; extra?: ReactNode; minimap?: boolean }) {
  const board = useBoard();
  const phone = useMedia(PHONE);
  const [focus, setFocus] = useState(false);
  const [open, setOpen] = useState(false);
  if (phone && !open)
    return (
      <button className="chrome more-tools" aria-label="Board tools" aria-expanded={false} onClick={() => setOpen(true)} style={{ right: 12, bottom: 16 }}>
        ⋯
      </button>
    );
  return (
    <div className="chrome tools" style={phone ? { right: 12, bottom: 16 } : { left: 16, bottom: 16 }} onBlur={(e) => phone && !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <div className="toolgroup">
        <button aria-label="Zoom in" onClick={() => board.engine()?.zoomBy(1.4)}>
          <Plus />
        </button>
        <button aria-label="Zoom out" onClick={() => board.engine()?.zoomBy(1 / 1.4)}>
          <Minus />
        </button>
        <button aria-label="Fit to screen" onClick={() => board.engine()?.fit()}>
          <Scan />
        </button>
      </div>
      <div className="toolgroup">
        {onThread && (
          <button aria-label={threadLabel} title={`${threadLabel} (T)`} onClick={onThread}>
            <Spline />
          </button>
        )}
        {extra}
        <button
          aria-label="Focus mode: show only what is linked to the selection"
          aria-pressed={focus}
          onClick={() => {
            const e = board.engine();
            e?.setFocusMode(!focus);
            setFocus(!focus);
          }}
        >
          <Focus />
        </button>
      </div>
      {minimap && <Minimap />}
    </div>
  );
}

export function Minimap() {
  const board = useBoard();
  const snap = useMemo(() => board.engine()?.snapshot() ?? null, [board, board.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!snap || !snap.nodes.length) return null;
  const xs = snap.nodes.map((n) => n.x);
  const ys = snap.nodes.map((n) => n.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 60;
  const W = 150;
  const H = 102;
  const s = Math.min((W - 16) / (maxX - minX + pad * 2 || 1), (H - 16) / (maxY - minY + pad * 2 || 1));
  const tx = (x: number) => 8 + (x - minX + pad) * s;
  const ty = (y: number) => 8 + (y - minY + pad) * s;
  const pos = new Map(snap.nodes.map((n) => [n.id, n]));
  return (
    <div className="minimap" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
        <g stroke="var(--edge-faint)" strokeWidth="1">
          {snap.edges.map((e, i) => {
            const a = pos.get(e.s);
            const b = pos.get(e.t);
            return a && b ? <line key={i} x1={tx(a.x)} y1={ty(a.y)} x2={tx(b.x)} y2={ty(b.y)} /> : null;
          })}
        </g>
        {snap.string.length > 1 && <polyline fill="none" stroke="var(--string)" strokeWidth="2" points={snap.string.map((id) => (pos.get(id) ? `${tx(pos.get(id)!.x)},${ty(pos.get(id)!.y)}` : "")).join(" ")} />}
        {snap.nodes.map((n) =>
          n.kind === "person" ? <circle key={n.id} cx={tx(n.x)} cy={ty(n.y)} r={3} fill={n.onString ? "var(--string)" : "var(--ink-2)"} /> : <rect key={n.id} x={tx(n.x) - 3} y={ty(n.y) - 3} width={6} height={6} fill={n.onString ? "var(--string)" : "var(--ink-2)"} />,
        )}
        {(() => {
          const x1 = Math.max(2, tx(snap.view.x));
          const y1 = Math.max(2, ty(snap.view.y));
          const x2 = Math.min(W - 2, tx(snap.view.x + snap.view.w));
          const y2 = Math.min(H - 2, ty(snap.view.y + snap.view.h));
          return x2 - x1 > 6 && y2 - y1 > 6 ? <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke="var(--ink)" strokeWidth="1.2" /> : null;
        })()}
      </svg>
    </div>
  );
}

export function Legend({ items = ["person", "company", "trust", "owns", "controls", "string"] }: { items?: string[] }) {
  const all: Record<string, ReactNode> = {
    person: (
      <span key="p">
        <i><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg></i>Person
      </span>
    ),
    company: (
      <span key="c">
        <i><svg width="12" height="12"><rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg></i>Company
      </span>
    ),
    trust: (
      <span key="t">
        <i><svg width="12" height="12"><path d="M1 1 H8 L11 4 V11 H1 Z" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg></i>Trust
      </span>
    ),
    owns: (
      <span key="o">
        <i><svg width="22" height="8"><path d="M1 4 H21" stroke="currentColor" strokeWidth="1.5" /></svg></i>Owns
      </span>
    ),
    controls: (
      <span key="ct">
        <i><svg width="22" height="8"><path d="M1 4 H21" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" /></svg></i>Controls
      </span>
    ),
    string: (
      <span key="s">
        <i><svg width="22" height="8"><path d="M1 4 H21" stroke="var(--string)" strokeWidth="3" /></svg></i>Path to owner
      </span>
    ),
    shared: (
      <span key="sh">
        <i><svg width="22" height="8"><path d="M1 4 H21" stroke="var(--edge-faint)" strokeWidth="1.5" /></svg></i>Shared officer or address
      </span>
    ),
  };
  return (
    <div className="chrome legend" aria-label="Legend" style={{ bottom: 16, right: 16 }}>
      {items.map((k) => all[k])}
    </div>
  );
}

export function Logo({ size = 26, light = false }: { size?: number; light?: boolean }) {
  const stroke = light ? "#fff" : "currentColor";
  const thread = light ? "#E35D71" : "var(--string)";
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <rect x="3" y="2.5" width="9" height="9" rx="1" fill="none" stroke={stroke} strokeWidth="1.8" />
      <path d="M7.5 11.5 C 7.5 17, 18 13, 18.5 19" fill="none" stroke={thread} strokeWidth="2" strokeLinecap="round" />
      <circle cx="12.6" cy="14.6" r="1.9" fill={thread} />
      <circle cx="18.5" cy="20.5" r="3.6" fill="none" stroke={stroke} strokeWidth="1.8" />
    </svg>
  );
}
