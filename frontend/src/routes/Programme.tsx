// Compliance programme: the partners' brief in one card, the obligations as rows with a status and one number
// (open a row to see the clients it refers to), the client book's rating mix as one bar, and patterns worth knowing.
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Printer } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { api } from "../api/endpoints";
import type { Client, Dashboard } from "../api/types";
import { daysFromToday, fmtDate, today, tranche2Line } from "../lib/dates";
import { plural } from "../lib/format";
import { useAuth } from "../lib/auth";
import { Status, type Tone } from "../shell/chart";
import { Page, PageHeader, Section, useTitle } from "../shell/page";

interface Row {
  id: string;
  title: string;
  value: string;
  tone: Tone;
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
  const { can } = useAuth();
  const [active, setActive] = useState<string | null>(null);
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => api.clients.list({ pageSize: 200 }) });
  const training = useQuery({ queryKey: ["training"], queryFn: api.training.list });
  const insights = useQuery({ queryKey: ["insights"], queryFn: api.insights, enabled: can("insights:read") });
  useTitle("Programme");
  const all = clients.data?.items ?? [];
  const d = dash.data;
  const c = d?.counts ?? {};
  const live = all.filter((x) => x.status !== "exited");
  const t = training.data ?? [];
  const trained = t.filter((x) => x.status !== "overdue").length;
  const rows: Row[] = d
    ? [
        { id: "cdd", title: "Customer due diligence", value: `${live.filter((x) => x.status === "active").length} of ${live.length} complete`, tone: live.some((x) => x.status === "onboarding") ? "review" : "clear", owner: "Fee earners", clients: (x) => x.status === "onboarding" },
        { id: "monitor", title: "Ongoing monitoring", value: plural(c.openAlerts ?? 0, "open alert"), tone: c.openAlerts ? "review" : "clear", owner: "Compliance officer", clients: (x) => x.flags.length > 0 },
        { id: "reviews", title: "Periodic reviews", value: `${c.reviewsOverdue ?? 0} overdue · ${c.reviewsDueSoon ?? 0} due soon`, tone: c.reviewsOverdue ? "high" : c.reviewsDueSoon ? "review" : "clear", owner: "Fee earners", clients: (x) => !!x.nextReviewOn && x.nextReviewOn <= daysFromToday(30) },
        { id: "screening", title: "Screening", value: `${c.screeningBacklog ?? 0} to review`, tone: c.screeningBacklog ? "review" : "clear", owner: "Compliance officer", clients: (x) => x.flags.includes("sanctions_review") },
        { id: "edd", title: "Enhanced due diligence", value: `${c.eddInProgress ?? 0} open · ${c.awaitingSignoff ?? 0} to sign`, tone: c.awaitingSignoff ? "review" : "clear", owner: "Compliance officer and partners", clients: (x) => x.eddRequired },
        { id: "reporting", title: "Reporting", value: can("smr:read") ? `${c.smrDrafts ?? 0} in draft` : "Compliance officer", tone: can("smr:read") && c.smrDrafts ? "review" : "neutral", owner: "Compliance officer", clients: () => false },
        { id: "records", title: "Record keeping", value: "Kept 7 years", tone: "clear", owner: "Firm administrator", clients: (x) => x.status === "exited" },
        { id: "training", title: "Training", value: `${trained} of ${t.length} trained`, tone: trained < t.length ? "review" : "clear", owner: "Firm administrator", clients: () => false },
        { id: "method", title: "Risk method", value: "3 differences", tone: "review", owner: "Compliance officer", clients: (x) => ["Tasman Ridge Pty Ltd", "Coralline Logistics Pty Ltd", "Ironbark Ventures Pty Ltd"].includes(x.name) },
      ]
    : [];
  const mix = d?.ratingMix ?? { low: 0, medium: 0, high: 0 };
  const total = mix.low + mix.medium + mix.high || 1;
  return (
    <Page label="Compliance programme" narrow>
      <PageHeader
        title="Programme"
        actions={
          <Button variant="line" className="no-print" onClick={() => window.print()}>
            <Printer /> Print
          </Button>
        }
      />
      <section className="card card-pad brief-card" aria-label="Partners’ brief">
        <p className="brief">{d ? partnersBrief(d, can("smr:read")) : "…"}</p>
        <div className="mix" role="img" aria-label={`${mix.low} clear, ${mix.medium} review, ${mix.high} high`}>
          <span className="mix-bar">
            <i className="clear" style={{ width: `${(mix.low / total) * 100}%` }} />
            <i className="review" style={{ width: `${(mix.medium / total) * 100}%` }} />
            <i className="high" style={{ width: `${(mix.high / total) * 100}%` }} />
          </span>

        </div>
      </section>
      <Section>
        <ol className="items obligations-list" aria-label="Obligations">
          {rows.map((r) => {
            const lit = all.filter(r.clients);
            const open = active === r.id;
            return (
              <li key={r.id} className={open ? "open" : undefined}>
                <button type="button" className="item" aria-expanded={open} aria-pressed={open} onClick={() => setActive(open ? null : r.id)}>
                  <Status tone={r.tone}>{r.value}</Status>
                  <span className="item-main">
                    <span className="item-title">{r.title}</span>
                  </span>
                  <span className="item-end">
                    <span className="hide-sm">{r.owner}</span>
                    <ChevronDown className="chev" aria-hidden />
                  </span>
                </button>
                {open && (
                  <div className="ob-clients">
                    {lit.length ? (
                      lit.map((x) => (
                        <Link key={x.id} to={`/clients/${x.id}/summary`} className="chip">
                          {x.name.replace(/ Pty Ltd$| Ltd$/, "")}
                        </Link>
                      ))
                    ) : (
                      <span className="note">No clients</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </Section>
      {insights.data && insights.data.length > 0 && (
        <Section title="Patterns">
          <ul className="items">
            {insights.data.map((i) => (
              <li key={i.id} className="item" title={i.body}>
                <Status tone={i.tone === "risk" ? "high" : i.tone === "progress" ? "clear" : "review"}>{i.tone === "risk" ? "Risk" : i.tone === "progress" ? "Progress" : "Watch"}</Status>
                <span className="item-main">
                  <span className="item-title">{i.title}</span>
                </span>
                <span className="item-end">
                  {i.href?.startsWith("/") && (
                    <Link className="link" to={i.href}>
                      Show
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <p className="note brief-foot">
        {d?.regime.name} · {tranche2Line()} · Designed to support your AML/CTF programme · {fmtDate(today())}
      </p>
    </Page>
  );
}
