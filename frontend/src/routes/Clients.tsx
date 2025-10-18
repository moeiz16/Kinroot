// Client book: a register of every client in the folio (sortable, filterable); the exhibit shows only the clients
// in the current filter, and hovering a row selects its pin.
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { ArrowDownUp, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../api/endpoints";
import type { Client } from "../api/types";
import { daysFromToday, dueIn, fmtDate, today } from "../lib/dates";
import { KIND_LABEL } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardHandlers, useBoardScene } from "../shell/board";
import { AsAt, BoardTools, FindTrigger, RatingTag } from "../shell/chrome";
import { Caption, Folio, FolioBody } from "../shell/Folio";
import { constellationScene } from "./BoardHome";

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

const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const col = createColumnHelper<Client>();

export default function Clients() {
  const { can } = useAuth();
  const nav = useNavigate();
  const board = useBoard();
  const [params] = useSearchParams();
  const initial = params.get("filter");
  const [filter, setFilter] = useState<Filter | "all">(FILTERS.some((f) => f.id === initial) ? (initial as Filter) : "all");
  const [q, setQ] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "review", desc: false }]);
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => api.clients.list({ pageSize: 200 }) });
  const payload = useQuery({ queryKey: ["constellation"], queryFn: api.graph.constellation });
  const clusters = useQuery({ queryKey: ["clusters"], queryFn: () => api.graph.clusters() });
  const all = useMemo(() => clients.data?.items ?? [], [clients.data]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((c) => bucket(c) === f.id).length])), [all]);
  const rows = useMemo(() => {
    let list = all.filter((c) => (filter === "all" ? c.status !== "exited" : bucket(c) === filter));
    if (q.trim()) list = list.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
    return list;
  }, [all, filter, q]);
  const columns = useMemo(
    () => [
      col.accessor((c) => RANK[c.rating ?? ""] ?? 3, { id: "rating", header: "Rating", cell: (c) => <RatingTag r={c.row.original.rating} small /> }),
      col.accessor("name", {
        header: "Client",
        cell: (c) => (
          <span className="who">
            <Link to={`/clients/${c.row.original.id}/summary`} className="cr-name">
              {c.getValue()}
            </Link>
            <small>
              {KIND_LABEL[c.row.original.kind]} · {c.row.original.jurisdiction === "AU" ? "Australia" : c.row.original.jurisdiction} · {c.row.original.assignedTo?.fullName ?? "Unassigned"}
            </small>
            <small className="cr-status">{statusLine(c.row.original)}</small>
          </span>
        ),
      }),
      col.accessor((c) => c.structure.layers, {
        id: "layers",
        header: "Structure",
        cell: (c) => (
          <span className="cr-structure">
            <StructureGlyph layers={c.row.original.structure.layers} parties={c.row.original.structure.parties} />
            <span className="mono">{c.getValue() === 0 ? "Individual" : `${c.getValue()} ${c.getValue() === 1 ? "layer" : "layers"}`}</span>
          </span>
        ),
      }),
      col.accessor((c) => c.nextReviewOn ?? "9999", {
        id: "review",
        header: "Next review",
        cell: (c) => {
          const d = c.row.original.nextReviewOn;
          const overdue = d && d < today();
          const words = dueIn(d);
          return (
            <span className={`mono ${overdue ? "overdue" : ""}`} title={d ? fmtDate(d) : undefined}>
              {d ? words.charAt(0).toUpperCase() + words.slice(1) : "—"}
            </span>
          );
        },
      }),
    ],
    [],
  );
  const table = useReactTable({ data: rows, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  const built = useMemo(() => (payload.data && clients.data ? constellationScene(payload.data, clients.data.items, clusters.data ?? [], [], "risk") : null), [payload.data, clients.data, clusters.data]);
  useBoardScene(built?.scene ?? null);
  const visible = rows.map((c) => c.partyId).join("|");
  useEffect(() => {
    const t = setTimeout(() => board.engine()?.setDim(visible ? visible.split("|") : []), 80);
    return () => clearTimeout(t);
  }, [visible, board.version > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useBoardHandlers({ onActivate: (id) => { const c = all.find((x) => x.partyId === id); if (c) nav(`/clients/${c.id}/summary`); } });
  const live = all.filter((c) => c.status !== "exited").length;

  return (
    <>
      <Folio label="Clients" width="wide">
        <Caption
          refLine={<span>Client book · {live} clients · {counts.needs ?? 0} need you</span>}
          title="Clients"
          tools={
            can("clients:onboard") && (
              <Button asChild variant="string">
                <Link to="/onboard">
                  <Plus /> Onboard a client
                </Link>
              </Button>
            )
          }
        />
        <FolioBody>
          <div className="sheet-tools">
            <Input placeholder="Find a client" aria-label="Find a client" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-[280px]" />
            <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v as Filter | "all")} aria-label="Filter clients" className="facets">
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              {FILTERS.map((f) => (
                <ToggleGroupItem key={f.id} value={f.id}>
                  {f.label} <span className="mono">{counts[f.id] ?? 0}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <Table className="client-book" aria-label="Client list">
            <TableHeader>
              {table.getHeaderGroups().map((g) => (
                <TableRow key={g.id}>
                  {g.headers.map((h) => (
                    <TableHead key={h.id} className={h.column.id === "layers" ? "hide-sm" : undefined} aria-sort={h.column.getIsSorted() === "asc" ? "ascending" : h.column.getIsSorted() === "desc" ? "descending" : undefined}>
                      <button type="button" className="sort-head" onClick={h.column.getToggleSortingHandler()}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <ArrowDownUp aria-hidden />
                      </button>
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="rowlink"
                  onClick={(e) => (e.target as HTMLElement).closest("a") || nav(`/clients/${r.original.id}/summary`)}
                  onMouseEnter={() => board.engine()?.setSelected(r.original.partyId)}
                  onFocus={() => board.engine()?.setSelected(r.original.partyId)}
                >
                  {r.getVisibleCells().map((c) => (
                    <TableCell key={c.id} className={c.column.id === "layers" ? "hide-sm" : undefined}>
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={4} className="muted">
                    No clients match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </FolioBody>
      </Folio>
      <AsAt exhibit="Exhibit" title="Clients in this view" />
      <FindTrigger />
      <BoardTools minimap />
    </>
  );
}
