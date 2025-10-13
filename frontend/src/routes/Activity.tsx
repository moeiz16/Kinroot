// Activity log: a ledger sheet in which every row is sealed to the one before it. "Verify the chain" walks
// the seals row by row and closes each chain link.
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, Lock, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../api/endpoints";
import type { AuditEntry, AuditVerify } from "../api/types";
import { fmtDateTime } from "../lib/dates";
import { prefersReduced } from "../lib/theme";
import { useAuth } from "../lib/auth";
import { Status } from "../shell/chrome";
import { Sheet } from "../shell/Drawer";
import { NotAvailable } from "./NotFound";
import "./sheets.css";

const ACTIONS = [
  { v: "", label: "Every action" },
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
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [checked, setChecked] = useState(0);
  const [result, setResult] = useState<AuditVerify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["audit", action, from],
    queryFn: ({ pageParam }) => api.audit.list({ action: action || undefined, from: from || undefined, page: pageParam, pageSize: 40 }),
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
    <Sheet label="Activity log" wide>
      <div className="sheet-head">
        <div>
          <div className="eyebrow">Sealed record of every decision</div>
          <h1 className="title">Activity log</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-line" onClick={exportCsv}>
            <Download /> Export
          </button>
          <button className="btn btn-ink" onClick={verify} disabled={verifying}>
            <ShieldCheck /> {verifying ? "Checking the seals…" : "Verify the chain"}
          </button>
        </div>
      </div>
      <div className="sheet-tools">
        <label className="sort">
          <span className="muted">Action</span>
          <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTIONS.map((a) => (
              <option key={a.v} value={a.v}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sort">
          <span className="muted">From</span>
          <input type="date" className="input" style={{ width: 160, height: 34 }} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {total.toLocaleString("en-AU")} entries
        </span>
      </div>
      <div className="ledger-sheet" style={{ marginTop: 16 }}>
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col" style={{ width: 120 }}>When</th>
              <th scope="col" style={{ width: 150 }}>Who</th>
              <th scope="col">What</th>
              <th scope="col" style={{ width: 120 }}>Seal</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const restricted = !!r.metadata.restricted;
              return (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12.5 }}>{fmtDateTime(r.createdAt)}</td>
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
          </tbody>
        </table>
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
          <button className="btn btn-line" style={{ marginTop: 16 }} onClick={() => void q.fetchNextPage()}>
            Show older entries
          </button>
        )}
        <p className="note" style={{ marginTop: 16, display: "flex", gap: 6, alignItems: "center" }}>
          <Lock size={12} aria-hidden /> Entries about restricted cases appear only for people who can see those cases. They stay in the chain for everyone.
        </p>
      </div>
    </Sheet>
  );
}
