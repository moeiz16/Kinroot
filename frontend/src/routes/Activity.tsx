// Activity log: one table of who did what and when; every row is sealed to the one before it. Verify walks the
// seals row by row and ticks each one.
import { useInfiniteQuery } from "@tanstack/react-query";
import { Check, Download, ShieldCheck } from "lucide-react";
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
import { Status } from "../shell/chart";
import { Page, PageHeader, useTitle } from "../shell/page";
import { NotAvailable } from "./NotFound";

const ACTIONS = [
  { v: "decisions", label: "Decisions and changes" },
  { v: "all", label: "Everything" },
  { v: "client", label: "Client files" },
  { v: "screening", label: "Screening" },
  { v: "resolution", label: "Duplicates" },
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
  const [action, setAction] = useState("decisions");
  const [from, setFrom] = useState("");
  const [checked, setChecked] = useState(0);
  const [result, setResult] = useState<AuditVerify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["audit", action, from],
    queryFn: ({ pageParam }) => api.audit.list({ action: action === "all" || action === "decisions" ? undefined : action, from: from || undefined, page: pageParam, pageSize: 40 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    enabled: can("audit:read"),
  });
  const total = q.data?.pages[0]?.total ?? 0;
  // Sign-ins are routine: they stay in the chain but only show under "Everything" or "Sign-ins".
  const rows = useMemo(() => (q.data?.pages.flatMap((p) => p.items) ?? []).filter((r) => action !== "decisions" || !r.action.startsWith("auth.")), [q.data, action]);
  useTitle("Activity log");
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
    <Page label="Activity log">
      <PageHeader
        title="Activity log"
        count={total}
        status={
          result &&
          (result.valid ? (
            <span role="status">
              <Status tone="clear">Chain verified</Status>
            </span>
          ) : (
            <span role="status" title={`The seal on entry ${result.brokenAt} does not match the entry before it.`}>
              <Status tone="high">Chain broken</Status>
            </span>
          ))
        }
        actions={
          <>
            <Button variant="line" onClick={exportCsv}>
              <Download /> Export
            </Button>
            <Button variant="primary" onClick={verify} disabled={verifying}>
              <ShieldCheck /> {verifying ? "Checking…" : "Verify"}
            </Button>
          </>
        }
      />
      <div className="filters">
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger aria-label="Action" className="w-[180px]">
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
        <Input type="date" aria-label="From date" className="w-[170px]" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="card table-card">
        <Table className="activity" aria-label="Activity log entries">
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-when">
                When
              </TableHead>
              <TableHead scope="col" className="w-who">
                Who
              </TableHead>
              <TableHead scope="col">What</TableHead>
              <TableHead scope="col" className="w-seal hide-sm">
                Verified
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const restricted = !!r.metadata.restricted;
              return (
                <tr key={r.id}>
                  <td className="when">{fmtDateTime(r.createdAt)}</td>
                  <td>{r.actorType === "system" || r.actorName === "System" ? "Kinroot" : r.actorName}</td>
                  <td>
                    {r.label}
                    {restricted && (
                      <>
                        {" "}
                        <Status tone="restricted">Restricted</Status>
                      </>
                    )}
                  </td>
                  <td className="hide-sm">
                    <span className={`seal${i < checked ? " closed" : ""}`} title={`Seal ${r.hash}`}>
                      {i < checked ? (
                        <>
                          <Check size={13} aria-hidden /> Verified
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {q.hasNextPage && (
        <Button variant="line" className="mt-4" onClick={() => void q.fetchNextPage()}>
          Show older
        </Button>
      )}
    </Page>
  );
}
