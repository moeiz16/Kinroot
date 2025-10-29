// Suspicious-matter report cases: restricted. Only the compliance officer and named people see this route; everyone
// else gets the same "isn't available" page for restricted, missing and forbidden ids (tipping-off control).
// The list is one table with deadlines; a case has tabs (grounds, evidence, draft, access) and the report actions.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileCheck2, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Case, Concern, SmrDraft } from "../api/types";
import { fmtDate, fmtDateTime } from "../lib/dates";
import { deadlineLook } from "../lib/format";
import { prefersReduced } from "../lib/theme";
import { useAuth } from "../lib/auth";
import { useBoardScene } from "../shell/board";
import { ChartBand, Status } from "../shell/chart";
import { DecisionBar, Page, PageHeader, Section, SectionTabs, useTitle } from "../shell/page";
import { NotAvailable } from "./NotFound";
import { useStructure } from "./dossier/structure";

/** Black bars sweep across each restricted field, then the lock fades in (Redact). */
export function Redacted({ lines = 3, label }: { lines?: number; label: string }) {
  const reduced = prefersReduced();
  return (
    <div role="img" aria-label={`${label}: restricted`} className="redacted-block">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="redact" style={{ ["--d" as string]: `${reduced ? 0 : i * 40}ms`, width: `${[92, 78, 64, 85][i % 4]}%` }}>
          .
        </span>
      ))}
      <span className="redact-lock" style={{ ["--d" as string]: `${reduced ? 0 : lines * 40 + 220}ms` }}>
        <Lock size={13} aria-hidden /> Restricted
      </span>
    </div>
  );
}


function exportDraft(c: Case, d: SmrDraft) {
  const text = [
    `DRAFT FOR THE FIRM TO LODGE · ${d.regime === "AUSTRAC_SMR" ? "AUSTRAC suspicious matter report" : "UK suspicious activity report"}`,
    `Case: ${c.title}`,
    `Grounds for suspicion:\n${d.suspicionGrounds}`,
    `Subjects:\n${d.subjects.map((s) => `- ${s.name} (${s.role})`).join("\n")}`,
    `Transactions:\n${d.transactions.map((t) => `- ${t.date} ${t.currency} ${Number(t.amount).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${t.description}`).join("\n")}`,
    `Narrative:\n${d.narrative}`,
    `Prepared in Kinroot. Kinroot does not lodge reports on the firm's behalf.`,
  ].join("\n\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = `${c.title.split(" · ")[0]}-draft.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function Reports() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ["cases"], queryFn: api.cases.list, enabled: can("smr:read"), retry: false });
  const one = useQuery({ queryKey: ["case", id], queryFn: () => api.cases.get(id!), enabled: !!id, retry: false });
  useTitle(id ? null : "Reports");
  if (!id && !can("smr:read")) return <NotAvailable />;
  if (one.isError) return <NotAvailable />;
  if (id) return one.data ? <CaseFile c={one.data} canList={can("smr:read")} /> : null;
  if (!list.data) return null;
  return (
    <Page label="Restricted cases">
      <PageHeader title="Reports" count={list.data.total} status={<SealBand />} />
      <div className="card table-card">
        <Table aria-label="Cases">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Case</TableHead>
              <TableHead scope="col" className="hide-sm">
                Report
              </TableHead>
              <TableHead scope="col" className="num">
                Due
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.items.map((c) => {
              const d = deadlineLook(c);
              return (
                <tr key={c.id} className="rowlink" onClick={() => nav(`/reports/${c.id}`)}>
                  <td className="who">
                    <Link to={`/reports/${c.id}`}>{c.title.split(" · ")[0]}</Link>
                    <small>{c.clientName}</small>
                  </td>
                  <td className="hide-sm">{c.smrStatus === "draft" ? "Draft" : c.smrStatus === "submitted" ? "Filed" : "None"}</td>
                  <td className="num">
                    <Status tone={d.tone}>{d.text.replace(" (3-day limit)", "").replace(/^Due in /, "")}</Status>
                  </td>
                </tr>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <Concerns />
    </Page>
  );
}

/** One quiet line on every restricted page. */
function SealBand() {
  return (
    <span className="seal-band" title="Do not discuss with the client or anyone outside the case’s list.">
      <Lock size={13} aria-hidden />
      Restricted
    </span>
  );
}

/** Concerns raised by staff: only the compliance officer sees them; the person who raised one only ever sees
 * "received". Opening a case places the usual neutral hold on the client. */
function Concerns() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const concerns = useQuery({ queryKey: ["concerns"], queryFn: api.concerns.triage, enabled: can("smr:read") });
  const open = useMutation({
    mutationFn: (c: Concern) => api.cases.create({ clientId: c.clientId!, title: c.summary, grounds: c.details, concernIds: [c.id] }),
    onSuccess: (k) => {
      void qc.invalidateQueries({ queryKey: ["cases"] });
      void qc.invalidateQueries({ queryKey: ["concerns"] });
      nav(`/reports/${k.id}`);
    },
  });
  const items = concerns.data ?? [];
  if (!items.length) return null;
  return (
    <Section title="Concerns from the team" aside={String(items.length)}>
      <ul className="items">
        {items.map((c) => (
          <li key={c.id} className="item">
            <span className="item-main">
              <span className="item-title" title={c.details}>
                {c.summary}
              </span>
              <span className="item-sub">
                {c.clientName ?? "No client named"} · {c.raisedByName} · {fmtDate(c.receivedAt.slice(0, 10))}
              </span>
            </span>
            <span className="item-end">
              {c.caseId ? (
                <Link className="link" to={`/reports/${c.caseId}`}>
                  Open case
                </Link>
              ) : c.clientId && can("smr:write") ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="line" disabled={open.isPending}>
                      Open a case
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Open a restricted case?</AlertDialogTitle>
                      <AlertDialogDescription>Client-facing steps for {c.clientName ?? "the client"} pause with the usual neutral wording.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => open.mutate(c)}>Open case</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {open.isError && <p className="note-error">{errorMessage(open.error)}</p>}
    </Section>
  );
}

function CaseFile({ c, canList }: { c: Case; canList: boolean }) {
  const [tab, setTab] = useState("grounds");
  const qc = useQueryClient();
  const { can } = useAuth();
  const full = c.accessLevel === "full";
  const smr = useQuery({ queryKey: ["smr", c.id], queryFn: () => api.cases.smr(c.id), enabled: full, retry: false });
  const timeline = useQuery({ queryKey: ["case-timeline", c.id], queryFn: () => api.cases.timeline(c.id) });
  const { structure } = useStructure(c.clientId, null);
  const [draft, setDraft] = useState<SmrDraft | null>(null);
  useEffect(() => {
    if (smr.data) setDraft(smr.data);
  }, [smr.data]);
  // The chart shows only the case's pinned parties; everything else is hidden.
  const subjects = useMemo(() => new Set(smr.data?.subjects.map((s) => s.partyId) ?? []), [smr.data]);
  const scene = useMemo(() => {
    if (!structure) return null;
    if (!full || !subjects.size) return structure.scene;
    const nodes = structure.nodes.filter((n) => subjects.has(n.id));
    const ids = new Set(nodes.map((n) => n.id));
    return { key: `case-${c.id}`, nodes, edges: structure.edges.filter((e) => ids.has(e.s) && ids.has(e.t)) };
  }, [structure, subjects, full, c.id]);
  useBoardScene(scene, { unfold: false });
  const save = useMutation({
    mutationFn: () => api.cases.saveSmr(c.id, draft!),
    onSuccess: (d) => {
      setDraft(d);
      toast("Draft saved.");
      void qc.invalidateQueries({ queryKey: ["smr", c.id] });
    },
    onError: (e) => toast(e instanceof ApiError && e.code === "stale_version" ? "Someone else saved this draft. Reload to see their changes." : errorMessage(e)),
  });
  const submit = useMutation({
    mutationFn: () => api.cases.submit(c.id),
    onSuccess: (r) => {
      toast(`Marked as filed. Reference ${r.reference}.`);
      void qc.invalidateQueries({ queryKey: ["case", c.id] });
      void qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e) => toast(errorMessage(e)),
  });
  const d = deadlineLook(c);
  const tabs = [
    { id: "grounds", label: "Grounds" },
    { id: "evidence", label: "Evidence", count: full ? smr.data?.attachments.length || undefined : undefined },
    ...(full ? [{ id: "draft", label: "Draft report" }] : []),
    { id: "access", label: "Access" },
  ];
  const regulator = draft?.regime === "UK_SAR" ? "the NCA" : "AUSTRAC";
  useTitle(c.title.split(" · ")[0]);
  return (
    <Page label="Restricted case file">
      <PageHeader back={canList ? { to: "/reports", label: "Reports" } : undefined} title={c.title.split(" · ")[0]} status={<Status tone={d.tone}>{d.text.replace(" (3-day limit)", "")}</Status>} actions={<SealBand />} />
      <SectionTabs label="Restricted case file" tabs={tabs} active={tab} onTab={setTab}>
        {tab === "grounds" && (
          <div className="summary-grid">
            <div className="card card-pad">{full ? <p className="grounds">{c.grounds}</p> : <Redacted label="Grounds" lines={4} />}</div>
            <Section title="History" className="mt-0">
              <ol className="timeline">
                {(timeline.data ?? []).map((t, i) => (
                  <li key={i}>
                    <time>{fmtDateTime(t.at)}</time>
                    <span>
                      {t.label} <small>· {t.actorName}</small>
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
          </div>
        )}
        {tab === "evidence" &&
          (full ? (
            <ul className="items">
              {(smr.data?.attachments ?? []).map((a, i) => (
                <li key={i} className="item">
                  <span className="item-main">
                    <span className="item-title">{a}</span>
                  </span>
                </li>
              ))}
              {!smr.data?.attachments.length && <li className="empty">Nothing pinned yet</li>}
            </ul>
          ) : (
            <div className="card card-pad">
              <Redacted label="Evidence" lines={3} />
            </div>
          ))}
        {tab === "draft" && draft && (
          <div className="draft card card-pad">
            <p className="note">
              Saved {fmtDateTime(draft.updatedAt)} by {draft.updatedBy}
            </p>
            <label className="field">
              <span>Grounds for suspicion</span>
              <Textarea rows={4} value={draft.suspicionGrounds ?? ""} onChange={(e) => setDraft({ ...draft, suspicionGrounds: e.target.value })} readOnly={!can("smr:write")} />
            </label>
            <Section title="Subjects">
              <Table>
                <TableBody>
                  {draft.subjects.map((s) => (
                    <tr key={s.partyId}>
                      <td className="who">
                        <b>{s.name}</b>
                      </td>
                      <td>{s.role}</td>
                    </tr>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Transactions">
              <Table>
                <TableBody>
                  {draft.transactions.map((t, i) => (
                    <tr key={i}>
                      <td>{fmtDate(t.date)}</td>
                      <td>{t.description}</td>
                      <td className="num">
                        {t.currency} {Number(t.amount).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <label className="field">
              <span>Narrative</span>
              <Textarea rows={6} value={draft.narrative ?? ""} onChange={(e) => setDraft({ ...draft, narrative: e.target.value })} readOnly={!can("smr:write")} />
            </label>
          </div>
        )}
        {tab === "access" && (
          <div className="card">
            <Table>
              <TableBody>
                {(c.access ?? [{ userId: "you", fullName: "You", level: c.accessLevel }]).map((a) => (
                  <tr key={a.userId}>
                    <td className="who">
                      <b>{a.fullName}</b>
                    </td>
                    <td className="st num">
                      <Status tone="restricted">{a.level === "full" ? "Full access" : "Summary only"}</Status>
                    </td>
                  </tr>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionTabs>
      {tab !== "draft" && <ChartBand label={full && subjects.size ? "Subjects of the report" : c.clientName} height="short" restricted legend={["person", "company", "owns", "controls"]} className="mt-5" />}
      {full && draft && (
        <DecisionBar label="Report">
          <div className="row">
            {can("smr:write") && tab === "draft" && (
              <Button variant="line" onClick={() => save.mutate()} disabled={save.isPending}>
                Save
              </Button>
            )}
            <Button variant="line" onClick={() => exportDraft(c, draft)} title={`A draft for the firm to lodge with ${regulator}`}>
              <Download /> Export
            </Button>
            {can("smr:submit") && c.smrStatus !== "submitted" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="primary">
                    <FileCheck2 /> Mark as filed
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Mark as filed?</AlertDialogTitle>
                    <AlertDialogDescription>Only after you have lodged it with {regulator}. Kinroot never lodges reports.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Not yet</AlertDialogCancel>
                    <AlertDialogAction onClick={() => submit.mutate()}>Mark as filed</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </DecisionBar>
      )}
    </Page>
  );
}
