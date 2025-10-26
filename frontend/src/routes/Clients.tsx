// Clients: the title with the count, a search and New client, filter tabs, and one sortable table (client, rating,
// fee earner, next review). A row opens the dossier.
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { ArrowDownUp, Plus, Search } from "lucide-react";
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
import { Page, PageHeader, useTitle } from "../shell/page";

type Filter = "needs" | "review" | "clear" | "onboarding" | "exited";
export function bucket(c: Client): Filter {
  if (c.status === "exited") return "exited";
  if (c.status === "onboarding") return "onboarding";
  if (c.rating === "high" || c.flags.includes("sanctions_review") || (c.nextReviewOn && c.nextReviewOn < daysFromToday(30))) return "needs";
  return c.rating === "medium" ? "review" : "clear";
}
const FILTERS: { id: Filter; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "review", label: "Review" },
  { id: "clear", label: "Clear" },
  { id: "onboarding", label: "Onboarding" },
  { id: "exited", label: "Exited" },
];

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
      col.accessor("name", {
        header: "Client",
        cell: (c) => (
          <span className="who">
            <Link to={`/clients/${c.row.original.id}/summary`}>{c.getValue()}</Link>
            <small>{KIND_LABEL[c.row.original.kind]}</small>
          </span>
        ),
      }),
      col.accessor((c) => RANK[c.rating ?? ""] ?? 3, { id: "rating", header: "Rating", cell: (c) => <RatingTag r={c.row.original.rating} small /> }),
      col.accessor((c) => c.assignedTo?.fullName ?? "", { id: "owner", header: "Fee earner", cell: (c) => <span className="muted">{c.getValue() || "—"}</span> }),
      col.accessor((c) => c.nextReviewOn ?? "9999", {
        id: "review",
        header: "Next review",
        cell: (c) => {
          const d = c.row.original.nextReviewOn;
          const overdue = d && d < today();
          const words = dueIn(d);
          return (
            <span className={overdue ? "late" : undefined} title={d ? fmtDate(d) : undefined}>
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

  useTitle("Clients");
  return (
    <Page label="Clients">
      <PageHeader
        title="Clients"
        count={live}
        actions={
          <>
            <div className="search-field">
              <Search aria-hidden />
              <Input placeholder="Find a client" aria-label="Find a client" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {can("clients:onboard") && (
              <Button asChild variant="primary">
                <Link to="/onboard">
                  <Plus /> New client
                </Link>
              </Button>
            )}
          </>
        }
      />
      <div className="filters">
        <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v as Filter | "all")} aria-label="Filter clients">
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          {FILTERS.map((f) => (
            <ToggleGroupItem key={f.id} value={f.id} aria-label={`${f.label}, ${counts[f.id] ?? 0}`}>
              {f.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="card table-card">
        <Table className="client-book" aria-label="Client list">
          <TableHeader>
            {table.getHeaderGroups().map((g) => (
              <TableRow key={g.id}>
                {g.headers.map((h) => (
                  <TableHead key={h.id} className={h.column.id === "owner" ? "hide-sm" : h.column.id === "review" ? "num" : undefined} aria-sort={h.column.getIsSorted() === "asc" ? "ascending" : h.column.getIsSorted() === "desc" ? "descending" : undefined}>
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
                  <TableCell key={c.id} className={c.column.id === "owner" ? "hide-sm" : c.column.id === "review" ? "num" : undefined}>
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={4} className="empty">
                  No clients match
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Page>
  );
}
