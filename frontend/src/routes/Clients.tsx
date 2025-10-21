// Client book, register skeleton: a poster title with the count, facet words, and a full-width register of every
// client (sortable, filterable), each with a small structure-chart glyph. No chart on this page.
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { ArrowDownUp, Plus } from "lucide-react";
import { useMemo, useState } from "react";
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
import { RatingTag } from "../shell/chart";
import { Masthead, Page, PageBody } from "../shell/page";

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

/** A tiny structure chart: the client box at the foot, one row of owners per layer above it. */
export function StructureGlyph({ layers, parties }: { layers: number; parties: number }) {
  const rows = Math.min(3, Math.max(0, layers));
  const spread = Math.min(3, Math.max(1, Math.round(parties / Math.max(1, rows))));
  const H = 34;
  return (
    <svg width="62" height="40" viewBox={`0 0 46 ${H}`} aria-hidden="true" className="sglyph">
      <rect x="16" y={H - 8} width="14" height="7" fill="var(--moss)" stroke="currentColor" strokeWidth="1.2" />
      {Array.from({ length: rows }, (_, r) => {
        const y = H - 8 - (r + 1) * 8;
        return (
          <g key={r} stroke="currentColor" strokeWidth="1.1" fill="none">
            {Array.from({ length: spread }, (_, i) => {
              const x = 23 + (i - (spread - 1) / 2) * 12;
              return (
                <g key={i}>
                  <path d={`M${x} ${y + 4} V${y + 6} H23 V${y + 7.5}`} />
                  {r === rows - 1 && i % 2 === 0 ? <circle cx={x} cy={y + 1.8} r="2.2" /> : <rect x={x - 3.5} y={y} width="7" height="4" />}
                </g>
              );
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
  const [params] = useSearchParams();
  const initial = params.get("filter");
  const [filter, setFilter] = useState<Filter | "all">(FILTERS.some((f) => f.id === initial) ? (initial as Filter) : "all");
  const [q, setQ] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "review", desc: false }]);
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => api.clients.list({ pageSize: 200 }) });
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
  const live = all.filter((c) => c.status !== "exited").length;

  return (
    <Page skeleton="register" label="Clients">
      <Masthead
        size="poster"
        refLine={
          <>
            <b>Client book</b>
            <span className="sep">/</span>
            <span>{live} clients</span>
            <span className="sep">/</span>
            <span>{counts.needs ?? 0} need you</span>
          </>
        }
        title={
          <>
            Clients <span className="mast-count">{live}</span>
          </>
        }
        tools={
          can("clients:onboard") && (
            <Button asChild variant="primary">
              <Link to="/onboard">
                <Plus /> Onboard a client
              </Link>
            </Button>
          )
        }
      />
      <PageBody>
        <div className="register-tools">
          <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v as Filter | "all")} aria-label="Filter clients" className="facets">
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            {FILTERS.map((f) => (
              <ToggleGroupItem key={f.id} value={f.id}>
                {f.label} <span className="mono">{counts[f.id] ?? 0}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Input placeholder="Find a client" aria-label="Find a client" value={q} onChange={(e) => setQ(e.target.value)} className="register-find" />
        </div>
        <Table className="client-book" aria-label="Client list">
          <TableHeader>
            {table.getHeaderGroups().map((g) => (
              <TableRow key={g.id}>
                {g.headers.map((h) => (
                  <TableHead key={h.id} className={h.column.id === "layers" ? "hide-sm" : h.column.id === "review" ? "num" : undefined} aria-sort={h.column.getIsSorted() === "asc" ? "ascending" : h.column.getIsSorted() === "desc" ? "descending" : undefined}>
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
              <TableRow key={r.id} className="rowlink" onClick={(e) => (e.target as HTMLElement).closest("a") || nav(`/clients/${r.original.id}/summary`)}>
                {r.getVisibleCells().map((c) => (
                  <TableCell key={c.id} className={c.column.id === "layers" ? "hide-sm" : c.column.id === "review" ? "num" : undefined}>
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
      </PageBody>
    </Page>
  );
}
