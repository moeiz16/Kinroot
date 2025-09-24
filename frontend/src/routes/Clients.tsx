// Client book: a paper index sheet slides from the spine; the board on the right shows only the clients in the filter.
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/endpoints";
import type { Client } from "../api/types";
import { daysFromToday, fmtDate, today } from "../lib/dates";
import { KIND_LABEL } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardHandlers, useBoardScene } from "../shell/board";
import { RatingTag } from "../shell/chrome";
import { Sheet } from "../shell/Drawer";
import { constellationScene } from "./BoardHome";
import "./sheets.css";

type Filter = "needs" | "review" | "clear" | "onboarding" | "exited";
export function bucket(c: Client): Filter {
  if (c.status === "exited") return "exited";
  if (c.status === "onboarding") return "onboarding";
  if (c.rating === "high" || c.flags.includes("sanctions_review") || (c.nextReviewOn && c.nextReviewOn < daysFromToday(30))) return "needs";
  return c.rating === "medium" ? "review" : "clear";
}
const FILTERS: { id: Filter; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "review", label: "In review" },
  { id: "clear", label: "Clear" },
  { id: "onboarding", label: "Onboarding" },
  { id: "exited", label: "Exited" },
];

/** A tiny root diagram: the client on top, one row of roots per layer of ownership. */
export function StructureGlyph({ layers, parties }: { layers: number; parties: number }) {
  const rows = Math.min(4, Math.max(0, layers));
  const spread = Math.min(4, Math.max(1, Math.round(parties / Math.max(1, rows))));
  return (
    <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true" className="sglyph">
      <rect x="16" y="1" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      {Array.from({ length: rows }, (_, r) => {
        const y = 8 + (r + 1) * 4.2;
        return (
          <g key={r} stroke="currentColor" strokeWidth="1.1">
            <path d={`M19.5 ${y - 4.2} V${y}`} />
            {Array.from({ length: spread }, (_, i) => {
              const x = 19.5 + (i - (spread - 1) / 2) * 7;
              return <path key={i} d={`M19.5 ${y} L${x} ${y + 3}`} />;
            })}
          </g>
        );
      })}
    </svg>
  );
}

function statusLine(c: Client): string {
  if (c.status === "onboarding") return "Onboarding · waiting for identity documents";
  if (c.status === "exited") return "Relationship ended";
  if (c.status === "blocked") return "Work paused";
  if (c.flags.includes("sanctions_review")) return "Possible sanctions match";
  if (c.flags.includes("pep")) return "Politically exposed person in the structure";
  if (c.flags.includes("circular")) return "Circular holding";
  if (c.flags.includes("nominee")) return "Nominee director";
  if (c.flags.includes("offshore")) return "Offshore layer";
  return c.eddRequired ? "Enhanced due diligence" : "Standard due diligence";
}

export default function Clients() {
  const { can } = useAuth();
  const nav = useNavigate();
  const board = useBoard();
  const [filter, setFilter] = useState<Filter | "all">("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"review" | "name" | "risk">("review");
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => api.clients.list({ pageSize: 200 }) });
  const payload = useQuery({ queryKey: ["constellation"], queryFn: api.graph.constellation });
  const clusters = useQuery({ queryKey: ["clusters"], queryFn: () => api.graph.clusters() });
  const all = useMemo(() => clients.data?.items ?? [], [clients.data]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((c) => bucket(c) === f.id).length])), [all]);
  const rows = useMemo(() => {
    let list = all.filter((c) => (filter === "all" ? c.status !== "exited" : bucket(c) === filter));
    if (q.trim()) list = list.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
    const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    return [...list].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "risk" ? (rank[a.rating ?? ""] ?? 3) - (rank[b.rating ?? ""] ?? 3) : (a.nextReviewOn ?? "9999").localeCompare(b.nextReviewOn ?? "9999")));
  }, [all, filter, q, sort]);
  const built = useMemo(() => (payload.data && clients.data ? constellationScene(payload.data, clients.data.items, clusters.data ?? [], [], "risk") : null), [payload.data, clients.data, clusters.data]);
  useBoardScene(built?.scene ?? null);
  const visible = rows.map((c) => c.partyId).join("|");
  useEffect(() => {
    const t = setTimeout(() => board.engine()?.setDim(visible ? visible.split("|") : []), 80);
    return () => clearTimeout(t);
  }, [visible, board.version > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useBoardHandlers({ onActivate: (id) => { const c = all.find((x) => x.partyId === id); if (c) nav(`/clients/${c.id}/summary`); } });

  return (
    <Sheet label="Clients" width={640}>
      <div className="sheet-head">
        <h1 className="title">
          Clients <span className="mono muted" style={{ fontSize: 18 }}>· {all.filter((c) => c.status !== "exited").length}</span>
        </h1>
        {can("clients:onboard") && (
          <Link to="/onboard" className="btn btn-string">
            <Plus /> Onboard a client
          </Link>
        )}
      </div>
      <div className="sheet-tools">
        <input className="input" placeholder="Find a client" aria-label="Find a client" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
        <label className="sort">
          <span className="muted">Sort</span>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="review">Next review</option>
            <option value="risk">Rating</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      <div className="filters" role="group" aria-label="Filter clients">
        <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All
        </button>
        {FILTERS.map((f) => (
          <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span className="mono">({counts[f.id] ?? 0})</span>
          </button>
        ))}
      </div>
      <ul className="client-rows" aria-label="Client list">
        {rows.map((c) => {
          const overdue = c.nextReviewOn && c.nextReviewOn < today();
          return (
            <li key={c.id}>
              <Link
                to={`/clients/${c.id}/summary`}
                className="client-row"
                onMouseEnter={() => board.engine()?.setSelected(c.partyId)}
                onFocus={() => board.engine()?.setSelected(c.partyId)}
              >
                <div className="cr-rating">
                  <RatingTag r={c.rating} small />
                </div>
                <div className="cr-main">
                  <span className="cr-name">{c.name}</span>
                  <span className="cr-meta">
                    {KIND_LABEL[c.kind]} · {c.jurisdiction === "AU" ? "Australia" : c.jurisdiction} · {c.assignedTo?.fullName ?? "Unassigned"}
                  </span>
                  <span className="cr-status">{statusLine(c)}</span>
                </div>
                <div className="cr-side">
                  <StructureGlyph layers={c.structure.layers} parties={c.structure.parties} />
                  <span className="mono muted">{c.structure.layers === 0 ? "Individual" : `${c.structure.layers} ${c.structure.layers === 1 ? "layer" : "layers"}`}</span>
                  <span className={`mono ${overdue ? "overdue" : "muted"}`}>{c.nextReviewOn ? (overdue ? `Review overdue` : `Review ${fmtDate(c.nextReviewOn)}`) : "—"}</span>
                </div>
              </Link>
            </li>
          );
        })}
        {!rows.length && <li className="muted" style={{ padding: "18px 0" }}>No clients match.</li>}
      </ul>
    </Sheet>
  );
}
