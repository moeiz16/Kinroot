// Floating board chrome: Find pill, As at / Compared with stamp, zoom + thread + focus tools, minimap, legend.
// All of it floats over the visible part of the board and never covers the work.
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Focus, Lock, Minus, Plus, Scan, Search, Spline } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/endpoints";
import type { GraphNode } from "../api/types";
import { fmtDate } from "../lib/dates";
import { ratingLook } from "../lib/format";
import { PHONE, useMedia } from "../lib/useMedia";
import { useBoard } from "./board";

/** Position helpers relative to the visible board (excluding drawer/sheet). */
export function visibleCenter(occ: { left: number; right: number }): CSSProperties {
  return { left: `calc(${occ.left}px + (100% - ${occ.left + occ.right}px) / 2)`, transform: "translateX(-50%)" };
}

export function FindPill({ width = 400, top = 16, offset = 0, phoneVisible = false }: { width?: number; top?: number; offset?: number; phoneVisible?: boolean }) {
  const phone = useMedia(PHONE);
  const board = useBoard();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { data = [] } = useQuery({ queryKey: ["search", q], queryFn: () => api.graph.search(q, 8), enabled: q.trim().length > 1 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const go = (n: GraphNode) => {
    setOpen(false);
    setQ("");
    if (n.clientId) nav(`/clients/${n.clientId}/summary`);
    else nav(`/ask?q=${encodeURIComponent(`How is ${n.label} linked to our clients?`)}`);
  };
  const w = Math.min(width, 9999);
  const occ = board.occlusion;
  if (phone && !phoneVisible) return null;
  return (
    <div className="chrome find-wrap" style={{ top: phone ? Math.max(top, 70) : top, width: `min(${w}px, calc(100% - ${occ.left + occ.right + 32}px))`, ...visibleCenter(occ), ...(offset && !phone ? { transform: `translateX(-50%) translateX(${offset}px)` } : {}) }}>
      <div className="find" role="combobox" aria-expanded={open && data.length > 0} aria-haspopup="listbox" aria-owns={listId}>
        <Search aria-hidden />
        <input
          ref={input}
          value={q}
          aria-label="Find a person, company or trust"
          aria-autocomplete="list"
          aria-controls={listId}
          placeholder="Find a person, company or trust"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(data.length - 1, a + 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
            else if (e.key === "Enter" && data[active]) go(data[active]!);
            else if (e.key === "Escape") {
              setQ("");
              input.current?.blur();
            }
          }}
        />
        <span className="kbd" aria-hidden>
          /
        </span>
      </div>
      {open && data.length > 0 && (
        <div className="find-results" role="listbox" id={listId}>
          {data.map((n, i) => (
            <button key={n.id} role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => go(n)}>
              <KindGlyph kind={n.kind} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ display: "block", fontWeight: 600 }}>{n.label}</b>
                <small className="muted">{n.clientId ? "Client" : n.kind === "person" ? "Person" : n.kind === "trust" ? "Trust" : "Company"}</small>
              </span>
              {n.clientId && <RatingTag r={n.riskRating} small />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function KindGlyph({ kind, size = 14 }: { kind: string; size?: number }) {
  const s = size;
  if (kind === "person" || kind === "individual") return <svg width={s} height={s} aria-hidden><circle cx={s / 2} cy={s / 2} r={s / 2 - 1.2} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
  if (kind === "trust") return <svg width={s} height={s} aria-hidden><path d={`M1 1 H${s - 4} L${s - 1} 4 V${s - 1} H1 Z`} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
  if (kind === "partnership") return <svg width={s} height={s} aria-hidden><rect x="1" y="1" width={s - 2} height={s - 2} fill="none" stroke="currentColor" strokeWidth="1.4" /><path d={`M${s / 2} 1 V${s - 1}`} stroke="currentColor" strokeWidth="1.2" /></svg>;
  return <svg width={s} height={s} aria-hidden><rect x="1" y="1" width={s - 2} height={s - 2} rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

export function RatingTag({ r, small, word }: { r: "low" | "medium" | "high" | null | undefined; small?: boolean; word?: string }) {
  const l = ratingLook(r);
  return (
    <span className={`status ${l.cls}`} style={small ? { padding: "4px 6px", fontSize: 11.5 } : undefined}>
      <span className="g" aria-hidden>
        {l.glyph}
      </span>
      {word ?? l.word}
    </span>
  );
}

export function Status({ tone, glyph, children }: { tone: "clear" | "review" | "high" | "neutral" | "restricted" | "unknown"; glyph?: string; children: ReactNode }) {
  const g = glyph ?? { clear: "●", review: "◆", high: "▲", neutral: "○", restricted: "", unknown: "?" }[tone];
  return (
    <span className={`status ${tone}`}>
      <span className="g" aria-hidden>
        {tone === "restricted" && !glyph ? <Lock size={11} strokeWidth={2.2} /> : g}
      </span>
      {children}
    </span>
  );
}

export function AsAt({ asAt, compare, compareLabel, onToggle, onPick, top = 16 }: { asAt: string; compare: string | null; compareLabel?: string; onToggle?: () => void; onPick?: (d: string) => void; top?: number }) {
  const board = useBoard();
  const [picking, setPicking] = useState(false);
  return (
    <div className="chrome asat" role="group" aria-label="Point in time" style={{ top, left: board.occlusion.left + 16 }}>
      <div>
        <span className="k">As at</span>
        <span className="v">{fmtDate(asAt)}</span>
      </div>
      <button type="button" aria-pressed={!!compare} onClick={onToggle} title={compare ? "Hide changes" : "Show what changed"}>
        <span className="k">Compared with</span>
        <span className="v">{compare ? `${fmtDate(compare)}${compareLabel ? ` · ${compareLabel}` : ""}` : "Off"}</span>
      </button>
      <div style={{ justifyContent: "center", position: "relative" }}>
        <button className="iconbtn" aria-label="Change the compare date" onClick={() => setPicking((p) => !p)}>
          <CalendarRange />
        </button>
        {picking && (
          <input
            type="date"
            className="input"
            aria-label="Compare with date"
            style={{ position: "absolute", top: 44, left: 0, width: 170, zIndex: 3 }}
            defaultValue={compare ?? undefined}
            max={asAt}
            onChange={(e) => {
              if (e.target.value) {
                onPick?.(e.target.value);
                setPicking(false);
              }
            }}
          />
        )}
      </div>
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
      <button className="chrome more-tools" aria-label="Board tools" aria-expanded={false} onClick={() => setOpen(true)} style={{ right: 12, bottom: board.occlusion.bottom + 64 }}>
        ⋯
      </button>
    );
  return (
    <div className="chrome tools" style={phone ? { right: 12, bottom: board.occlusion.bottom + 64 } : { left: board.occlusion.left + 16, bottom: board.occlusion.bottom + 16 }} onBlur={(e) => phone && !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
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
  const board = useBoard();
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
    <div className="chrome legend" aria-label="Legend" style={{ bottom: board.occlusion.bottom + 16, left: `calc(${board.occlusion.left}px + (100% - ${board.occlusion.left + board.occlusion.right}px) / 2 + 60px)`, transform: "translateX(-50%)" }}>
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
