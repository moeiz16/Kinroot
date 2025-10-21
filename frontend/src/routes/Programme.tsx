// Compliance programme, brief skeleton: the partners' brief typeset large with its numbers marked, the obligations
// as a numbered two-up list, and the client strip: selecting an obligation lights the clients it refers to.
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { api } from "../api/endpoints";
import type { Client, Dashboard } from "../api/types";
import { daysFromToday, fmtDate, today, tranche2Line } from "../lib/dates";
import { plural } from "../lib/format";
import { useAuth } from "../lib/auth";
import { KindGlyph } from "../shell/chart";
import { Band, Masthead, Page, PageBody } from "../shell/page";

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
  const [active, setActive] = useState<string | null>(null);
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => api.clients.list({ pageSize: 200 }) });
  const training = useQuery({ queryKey: ["training"], queryFn: api.training.list });
  const insights = useQuery({ queryKey: ["insights"], queryFn: api.insights, enabled: can("insights:read") });
  const all = clients.data?.items ?? [];

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
  const lit = rows.find((x) => x.id === active);
  const mix = d?.ratingMix ?? { low: 0, medium: 0, high: 0 };
  return (
    <Page skeleton="brief" label="Compliance programme">
      <Masthead
        size="poster"
        refLine={
          <>
            <b>Compliance programme</b>
            <span className="sep">/</span>
            <span>{me?.activeOrg?.name}</span>
            <span className="sep">/</span>
            <span>as at {fmtDate(today())}</span>
          </>
        }
        title="Where the firm stands"
        tools={
          <Button className="no-print" onClick={() => window.print()}>
            <Printer /> Print brief
          </Button>
        }
      />
      <PageBody>
        <section className="brief-block" aria-label="Partners’ brief">
          <span className="micro">Partners’ brief</span>
          <p className="brief">{d ? marked(partnersBrief(d, can("smr:read"))) : "Gathering the numbers…"}</p>
        </section>
        <Band n="01" title="The obligations" aside="Select one to light its clients below">
          <ol className="obligations-list" aria-label="Obligations">
            {rows.map((r, i) => (
              <li key={r.id} className={`prog-row${active === r.id ? " active" : ""}`}>
                <span className="prog-n" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3>
                  <button className="rowbtn" aria-pressed={active === r.id} onClick={() => setActive(active === r.id ? null : r.id)}>
                    <b>{r.title}</b>
                  </button>
                </h3>
                <p>{r.sentence}</p>
                <span className="owner">{r.owner}</span>
              </li>
            ))}
          </ol>
        </Band>
        <Band n="02" title="Clients by rating" aside={lit ? `${all.filter(lit.clients).length} lit for ${lit.title.toLowerCase()}` : `${live.length} clients`}>
          <ul className="client-strip" aria-label="Clients">
            {live.map((x) => {
              const on = lit ? lit.clients(x) : false;
              return (
                <li key={x.id} className={`cs r-${x.rating ?? "none"}${on ? " lit" : ""}${lit && !on ? " dim" : ""}`}>
                  <Link to={`/clients/${x.id}/summary`} title={x.name}>
                    <KindGlyph kind={x.kind === "individual" ? "person" : x.kind} size={12} />
                    <span className="cs-g" aria-hidden>
                      {x.rating === "high" ? "▲" : x.rating === "medium" ? "◆" : "●"}
                    </span>
                    <span className="cs-n">{x.name.replace(/ Pty Ltd$| Ltd$/, "")}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="glyph-strip" role="img" aria-label={`${mix.low} clear, ${mix.medium} review, ${mix.high} high`}>
            {Array.from({ length: mix.low }, (_, i) => <span key={`l${i}`} className="clear">●</span>)}
            {Array.from({ length: mix.medium }, (_, i) => <span key={`m${i}`} className="review">◆</span>)}
            {Array.from({ length: mix.high }, (_, i) => <span key={`h${i}`} className="high">▲</span>)}
          </div>
          <p className="note">
            ● Clear {mix.low} · ◆ Review {mix.medium} · ▲ High {mix.high}
          </p>
        </Band>
        {insights.data && (
          <Band n="03" title="Patterns worth knowing">
            <ol className="reasons">
              {insights.data.map((i) => (
                <li key={i.id}>
                  <span>
                    <b>{i.title}.</b> {i.body}{" "}
                    {i.href?.startsWith("/") && (
                      <Link className="link" to={i.href}>
                        Show me
                      </Link>
                    )}
                  </span>
                  <span className="w">{i.tone === "risk" ? "▲" : i.tone === "progress" ? "●" : "◆"}</span>
                </li>
              ))}
            </ol>
          </Band>
        )}
        <p className="note brief-foot">
          {d?.regime.name}. {tranche2Line()} Designed to support your AML/CTF programme; the firm remains responsible for it. Printed {fmtDate(today())}.
        </p>
      </PageBody>
    </Page>
  );
}

/** Numbers in the brief are set in moss on a lichen marker. */
function marked(text: string): ReactNode[] {
  return text.split(/(\d+(?:\.\d+)?%?)/g).map((part, i) => (/^\d/.test(part) ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}
