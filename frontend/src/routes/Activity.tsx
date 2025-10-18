// Activity log: a ledger sheet in which every row is sealed to the one before it. "Verify the chain" walks
// the seals row by row and closes each chain link.
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, Lock, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "../api/endpoints";
import type { AuditEntry, AuditVerify } from "../api/types";
import { fmtDateTime } from "../lib/dates";
import { prefersReduced } from "../lib/theme";
import { useAuth } from "../lib/auth";
import { Status } from "../shell/chrome";
import { Caption, Folio, FolioBody } from "../shell/Folio";
import { NotAvailable } from "./NotFound";

const ACTIONS = [
  { v: "all", label: "Every action" },
  { v: "client", label: "Client files" },
  { v: "screening", label: "Screening" },
  { v: "resolution", label: "Fuse or split" },
  { v: "signoff", label: "Sign-offs" },
  { v: "risk", label: "Ratings" },
  { v: "auth", label: "Sign-ins" },
];

export function toCsv(rows: AuditEntry[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ["when,who,what,seal", ...rows.map((r) => [r.createdAt, q(r.actorName), q(r.label), r.hash].join(","))].join("\n");
}

export default function Activity() {
  const { can } = useAuth();
  const [action, setAction] = useState("all");
  const [from, setFrom] = useState("");
  const [checked, setChecked] = useState(0);
  const [result, setResult] = useState<AuditVerify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["audit", action, from],
    queryFn: ({ pageParam }) => api.audit.list({ action: action === "all" ? undefined : action, from: from || undefined, page: pageParam, pageSize: 40 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    enabled: can("audit:read"),
  });
  const total = q.data?.pages[0]?.total ?? 0;
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  if (!can("audit:read")) return <NotAvailable />;

  const verify = async () => {
    setVerifying(true);
    setResult(null);
    setChecked(0);
    const res = await api.audit.verify();
    if (prefersReduced()) setChecked(rows.length);
    else for (let i = 1; i <= rows.length; i++) {
      setChecked(i);
      await new Promise((r) => setTimeout(r, 25));
    }
    setResult(res);
    setVerifying(false);
  };
  const exportCsv = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));
    a.download = "kinroot-activity-log.csv";
    a.click();
  };

  return (
    <Folio label="Activity log" width="full">
      <Caption
        refLine={<span>Sealed record of every decision · {total.toLocaleString("en-AU")} entries</span>}
        title="Activity log"
        tools={
          <>
            <Button onClick={exportCsv}>
              <Download /> Export
            </Button>
            <Button variant="ink" onClick={verify} disabled={verifying}>
              <ShieldCheck /> {verifying ? "Checking the seals…" : "Verify the chain"}
            </Button>
          </>
        }
      />
      <FolioBody>
        <div className="sheet-tools">
          <label className="sort">
            <span className="muted">Action</span>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger size="sm" aria-label="Action" className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIONS.map((a) => (
                  <SelectItem key={a.v} value={a.v}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="sort">
            <span className="muted">From</span>
            <Input type="date" className="h-8 w-[170px] text-[13.5px]" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
        </div>
        <Table className="activity" aria-label="Activity log entries">
          <TableHeader>
            <TableRow>
              <TableHead scope="col" style={{ width: 130 }}>When</TableHead>
              <TableHead scope="col" style={{ width: 170 }}>Who</TableHead>
              <TableHead scope="col">What</TableHead>
              <TableHead scope="col" style={{ width: 120 }}>Seal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const restricted = !!r.metadata.restricted;
              return (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 13 }}>{fmtDateTime(r.createdAt)}</td>
                  <td>{r.actorName}</td>
                  <td>
                    {r.label}
                    {restricted && (
                      <>
                        {" "}
                        <Status tone="restricted">Restricted</Status>
                      </>
                    )}
                  </td>
                  <td>
                    <span className={`seal${i < checked ? " closed" : ""}`} aria-label={`Seal ${r.hash.slice(0, 4)}${i < checked ? ", verified" : ""}`}>
                      <span className="chain" aria-hidden>
                        <span className="link-l" />
                        <span className="link-r" />
                      </span>
                      {r.hash.slice(0, 4)}…
                    </span>
                  </td>
                </tr>
              );
            })}
          </TableBody>
        </Table>
        {result && (
          <div className="verify-line" role="status">
            {result.valid ? (
              <>
                <Status tone="clear">Chain verified</Status> {result.checked.toLocaleString("en-AU")} entries, unbroken.
              </>
            ) : (
              <>
                <Status tone="high">Chain broken</Status> The seal on entry {result.brokenAt} does not match the entry before it.
              </>
            )}
          </div>
        )}
        {q.hasNextPage && (
          <Button style={{ marginTop: 16 }} onClick={() => void q.fetchNextPage()}>
            Show older entries
          </Button>
        )}
        <p className="note" style={{ marginTop: 16, display: "flex", gap: 6, alignItems: "center" }}>
          <Lock size={12} aria-hidden /> Entries about restricted cases appear only for people who can see those cases. They stay in the chain for everyone.
        </p>
      </FolioBody>
    </Folio>
  );
}
