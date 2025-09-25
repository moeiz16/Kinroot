// Compliance programme: a printable paper sheet organised by obligation, with numbers inside sentences instead of
// KPI cards. Selecting a row shows the clients it refers to on the board.
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/endpoints";
import type { Client, Dashboard } from "../api/types";
import { daysFromToday, fmtDate, today, tranche2Line } from "../lib/dates";
import { plural } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardScene } from "../shell/board";
import { Sheet } from "../shell/Drawer";
import { constellationScene } from "./BoardHome";
import "./sheets.css";

interface Row {
  id: string;
  title: string;
  sentence: string;
  owner: string;
  clients: (c: Client) => boolean;
}

export function partnersBrief(d: Dashboard, canSeeReports: boolean): string {
  const c = d.counts;
  const s1 = `${plural(c.highRisk ?? 0, "client is", "clients are")} rated high risk${c.screeningBacklog ? ` and ${plural(c.screeningBacklog, "screening match", "screening matches")} ${c.screeningBacklog === 1 ? "is" : "are"} open` : ""}.`;
  const s2 = `${plural(c.reviewsOverdue ?? 0, "periodic review is", "periodic reviews are")} overdue and ${plural(c.awaitingSignoff ?? 0, "file waits", "files wait")} for sign-off.`;
  const s3 = canSeeReports && c.smrDrafts ? `One restricted matter needs the compliance officer this week.` : c.trainingOverdue ? `${plural(c.trainingOverdue, "person is", "people are")} overdue for AML/CTF training.` : "Training is up to date.";
  return `${s1.charAt(0).toUpperCase()}${s1.slice(1)} ${s2} ${s3}`;
}

export default function Programme() {
  const { me, can } = useAuth();
  const board = useBoard();
  const [active, setActive] = useState<string | null>(null);
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => api.clients.list({ pageSize: 200 }) });
  const training = useQuery({ queryKey: ["training"], queryFn: api.training.list });
  const insights = useQuery({ queryKey: ["insights"], queryFn: api.insights, enabled: can("insights:read") });
  const payload = useQuery({ queryKey: ["constellation"], queryFn: api.graph.constellation });
  const clusters = useQuery({ queryKey: ["clusters"], queryFn: () => api.graph.clusters() });
  const all = clients.data?.items ?? [];
  const built = useMemo(() => (payload.data && clients.data ? constellationScene(payload.data, all, clusters.data ?? [], [], "risk") : null), [payload.data, clients.data, clusters.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useBoardScene(built?.scene ?? null);

  const d = dash.data;
  const c = d?.counts ?? {};
  const live = all.filter((x) => x.status !== "exited");
  const t = training.data ?? [];
  const rows: Row[] = d
    ? [
        { id: "cdd", title: "Customer due diligence", sentence: `${live.filter((x) => x.status === "active").length} of ${live.length} clients complete. ${plural(live.filter((x) => x.status === "onboarding").length, "file is", "files are")} waiting for identity documents.`, owner: "Fee earners", clients: (x) => x.status === "onboarding" },
        { id: "monitor", title: "Ongoing monitoring", sentence: `${plural(c.openAlerts ?? 0, "alert is", "alerts are")} open. Registers and lists are re-checked automatically.`, owner: "Compliance officer", clients: (x) => x.flags.length > 0 },
        { id: "reviews", title: "Periodic reviews", sentence: `${c.reviewsOverdue ?? 0} overdue ▲, ${c.reviewsDueSoon ?? 0} due in the next 30 days ◆.`, owner: "Fee earners", clients: (x) => !!x.nextReviewOn && x.nextReviewOn <= daysFromToday(30) },
        { id: "screening", title: "Screening", sentence: `${plural(c.screeningBacklog ?? 0, "match is", "matches are")} waiting for review.`, owner: "Compliance officer", clients: (x) => x.flags.includes("sanctions_review") },
        { id: "edd", title: "Enhanced due diligence", sentence: `${plural(c.eddInProgress ?? 0, "client has", "clients have")} enhanced checks open; ${c.awaitingSignoff ?? 0} ${c.awaitingSignoff === 1 ? "waits" : "wait"} for sign-off.`, owner: "Compliance officer and partners", clients: (x) => x.eddRequired },
        { id: "reporting", title: "Reporting", sentence: can("smr:read") ? `${plural(c.smrDrafts ?? 0, "report", "reports")} in draft (restricted).` : "Handled by the compliance officer.", owner: "Compliance officer", clients: () => false },
        { id: "records", title: "Record keeping", sentence: "All records are kept for 7 years after the relationship ends ●. Nothing has been disposed of.", owner: "Firm administrator", clients: (x) => x.status === "exited" },
        { id: "training", title: "Training", sentence: `${t.filter((x) => x.status !== "overdue").length} of ${t.length} staff trained this year${t.some((x) => x.status === "overdue") ? " ◆" : " ●"}.`, owner: "Firm administrator", clients: () => false },
        { id: "method", title: "Risk method", sentence: "Rules v1.0 approved. The second opinion agrees on 90% of clients; 3 differences are with the compliance officer.", owner: "Compliance officer", clients: (x) => ["Tasman Ridge Pty Ltd", "Coralline Logistics Pty Ltd", "Ironbark Ventures Pty Ltd"].includes(x.name) },
      ]
    : [];
  useEffect(() => {
    const r = rows.find((x) => x.id === active);
    const ids = r ? all.filter(r.clients).map((x) => x.partyId) : null;
    const tm = setTimeout(() => board.engine()?.setDim(ids), 60);
    return () => clearTimeout(tm);
  }, [active, all.length, board.version > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const mix = d?.ratingMix ?? { low: 0, medium: 0, high: 0 };
  return (
    <Sheet label="Compliance programme" width={700}>
      <div className="sheet-head">
        <div>
          <div className="eyebrow">Compliance programme · {me?.activeOrg?.name}</div>
          <h1 className="title">Where the firm stands</h1>
        </div>
        <button className="btn btn-line no-print" onClick={() => window.print()}>
          <Printer /> Print brief
        </button>
      </div>
      <div className="eyebrow" style={{ marginTop: 18 }}>
        Partners’ brief
      </div>
      <p className="brief">{d ? partnersBrief(d, can("smr:read")) : "Gathering the numbers…"}</p>
      <div role="list">
        {rows.map((r) => (
          <div key={r.id} role="listitem" className={`prog-row${active === r.id ? " active" : ""}`}>
            <h3>
              <button className="rowbtn" aria-pressed={active === r.id} onClick={() => setActive(active === r.id ? null : r.id)}>
                {r.title}
              </button>
            </h3>
            <p>{r.sentence}</p>
            <span className="owner">{r.owner}</span>
          </div>
        ))}
      </div>
      <section className="section">
        <h2>
          Clients by rating <span className="aside">{live.length} clients</span>
        </h2>
        <div className="glyph-strip" role="img" aria-label={`${mix.low} clear, ${mix.medium} review, ${mix.high} high`}>
          {Array.from({ length: mix.low }, (_, i) => <span key={`l${i}`} className="clear">●</span>)}
          {Array.from({ length: mix.medium }, (_, i) => <span key={`m${i}`} className="review">◆</span>)}
          {Array.from({ length: mix.high }, (_, i) => <span key={`h${i}`} className="high">▲</span>)}
        </div>
        <p className="note" style={{ marginTop: 8 }}>
          ● Clear {mix.low} · ◆ Review {mix.medium} · ▲ High {mix.high}
        </p>
      </section>
      {insights.data && (
        <section className="section">
          <h2>Patterns worth knowing</h2>
          <ol className="reasons">
            {insights.data.map((i) => (
              <li key={i.id}>
                <span>
                  <b style={{ fontWeight: 600 }}>{i.title}.</b> {i.body}
                </span>
                <span className="w">{i.tone === "risk" ? "▲" : i.tone === "progress" ? "●" : "◆"}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="note" style={{ marginTop: 24 }}>
        {d?.regime.name}. {tranche2Line()} Designed to support your AML/CTF programme; the firm remains responsible for it. Printed {fmtDate(today())}.
      </p>
    </Sheet>
  );
}
