// Suspicious-matter report cases: restricted. Only the compliance officer and named people see this route; everyone
// else gets the same "isn't available" page for restricted, missing and forbidden ids (tipping-off control).
// Sealed skeleton: the page turns to an ink ground in both themes, with a hatched restriction band, a giant deadline
// count and one centred document column.
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
import { businessDaysUntil, fmtDate, fmtDateTime } from "../lib/dates";
import { deadlineLook } from "../lib/format";
import { prefersReduced } from "../lib/theme";
import { useAuth } from "../lib/auth";
import { useBoardScene } from "../shell/board";
import { ChartBand, Status } from "../shell/chart";
import { DecisionBar, Masthead, Page, PageBody, SectionTabs, useHop } from "../shell/page";
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
  if (!id && !can("smr:read")) return <NotAvailable />;
  if (one.isError) return <NotAvailable />;
  if (id) return one.data ? <CaseFile c={one.data} onBack={can("smr:read") ? () => nav("/reports") : undefined} /> : null;
  if (!list.data) return null;
  return (
    <Page skeleton="sealed" label="Restricted cases" className="slab">
      <SealBand />
      <Masthead
        size="poster"
        restricted
        refLine={
          <>
            <Lock size={12} aria-hidden />
            <b>Restricted</b>
            <span className="sep">/</span>
            <span>visible to the compliance officer and named delegates</span>
          </>
        }
        title={
          <>
            Cases <span className="mast-count">{list.data.total}</span>
          </>
        }
        sub="Do not discuss these with the client or anyone outside each case’s list."
      />
      <PageBody className="sealed-col">
        <Table aria-label="Cases">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Case</TableHead>
              <TableHead scope="col">Report</TableHead>
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
                    <Link to={`/reports/${c.id}`} className="case-link">
                      <Lock size={13} aria-hidden />
                      <b>{c.title.split(" · ")[0]}</b>
                    </Link>
                    <small>{c.clientName}</small>
                  </td>
                  <td>{c.smrStatus === "draft" ? "Draft" : c.smrStatus === "submitted" ? "Filed" : "No report"}</td>
                  <td className="num">
                    <Status tone={d.tone}>{d.text.replace(" (3-day limit)", "")}</Status>
                  </td>
                </tr>
              );
            })}
          </TableBody>
        </Table>
        <Concerns />
      </PageBody>
    </Page>
  );
}

/** The hatched restriction band at the top of every sealed page. */
function SealBand() {
  return (
    <div className="seal-band" role="note">
      <Lock size={14} aria-hidden />
      <span>Restricted. Do not discuss this with the client or anyone outside this list.</span>
    </div>
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
    <section className="section concerns-band">
      <h2>
        Concerns from the team · {items.length} <span className="aside">The person who raised it only sees “received”</span>
      </h2>
      <ul className="concerns">
        {items.map((c) => (
          <li key={c.id}>
            <b>{c.summary}</b>
            <p>{c.details}</p>
            <small>
              {c.clientName ?? "No client named"} · raised by {c.raisedByName} · {fmtDate(c.receivedAt.slice(0, 10))}
            </small>
            <div className="concern-act">
              {c.caseId ? (
                <Button variant="link" onClick={() => nav(`/reports/${c.caseId}`)}>
                  Open its case →
                </Button>
              ) : c.clientId && can("smr:write") ? (
                <Button size="sm" disabled={open.isPending} onClick={() => open.mutate(c)}>
                  <Lock /> Open a case
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {open.isError && <p className="note-error">{errorMessage(open.error)}</p>}
    </section>
  );
}

function CaseFile({ c, onBack }: { c: Case; onBack?: () => void }) {
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
    return { key: `case-${c.id}`, nodes, edges: structure.edges.filter((e) => ids.has(e.s) && ids.has(e.t)).map((e, i) => ({ ...e, cite: i + 1 })) };
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
    { id: "evidence", label: "Evidence", count: full ? (smr.data?.attachments.length ?? 0) : undefined },
    ...(full ? [{ id: "draft", label: "Draft report" }] : []),
    { id: "access", label: "Access" },
  ];
  const regime = draft?.regime === "UK_SAR" ? "suspicious activity report" : "suspicious matter report";
  useHop(c.title.split(" · ")[0], "restricted");
  const days = businessDaysUntil(c.deadlineOn);
  return (
    <Page skeleton="sealed" label="Restricted case file" className="slab">
      <SealBand />
      <Masthead
        size="name"
        restricted
        refLine={
          <>
            <Lock size={12} aria-hidden />
            <b>Restricted</b>
            <span className="sep">/</span>
            <span>visible to {c.access ? c.access.map((a) => a.fullName).join(" and ") : "the people on this case"}</span>
          </>
        }
        title={c.title.split(" · ")[0]}
        sub={`${c.clientName} · opened ${fmtDate(c.openedAt.slice(0, 10))} by ${c.openedBy}`}
        stamps={<Status tone={d.tone}>{d.text}</Status>}
        tools={
          <>
            {c.smrStatus !== "submitted" && (
              <div className="deadline" aria-hidden>
                <span className="dl-num">{days < 0 ? -days : days}</span>
                <span className="dl-cap">{days < 0 ? "business days overdue" : days === 1 ? "business day to report" : "business days to report"}</span>
              </div>
            )}
            {onBack && (
              <Button variant="line" size="sm" onClick={onBack}>
                All cases
              </Button>
            )}
          </>
        }
      />
      <div className="sealed-col">
        <SectionTabs label="Restricted case file" tabs={tabs} active={tab} onTab={setTab}>
          {tab === "grounds" && (
            <div className="paras">
              <section className="para">
                <h2>Grounds for suspicion</h2>
                {full ? <p className="lede grounds">{c.grounds}</p> : <Redacted label="Grounds" lines={4} />}
                {!full && <p className="note">You have summary access to this case. The grounds and the draft report are visible to the compliance officer only.</p>}
              </section>
              <section className="para">
                <h2>Case history</h2>
                <ol className="timeline">
                  {(timeline.data ?? []).map((t, i) => (
                    <li key={i}>
                      <time className="mono">{fmtDateTime(t.at)}</time>
                      <span>
                        {t.label} <small>· {t.actorName}</small>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          )}
          {tab === "evidence" && (
            <>
              <h2 className="title">Evidence pinned from the chart</h2>
              {full ? (
                <ol className="reasons">
                  {(smr.data?.attachments ?? []).map((a, i) => (
                    <li key={i}>
                      <span>{a}</span>
                      <span />
                    </li>
                  ))}
                </ol>
              ) : (
                <Redacted label="Evidence" lines={3} />
              )}
            </>
          )}
          {tab === "draft" && draft && (
            <div className="draft">
              <h2 className="title">Draft {regime}</h2>
              <div className="meta">
                Version {draft.version} · saved {fmtDateTime(draft.updatedAt)} by {draft.updatedBy}
              </div>
              <label className="field">
                <span>Grounds for suspicion</span>
                <Textarea rows={4} value={draft.suspicionGrounds ?? ""} onChange={(e) => setDraft({ ...draft, suspicionGrounds: e.target.value })} readOnly={!can("smr:write")} />
              </label>
              <section className="section">
                <h2>Subjects</h2>
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
              </section>
              <section className="section">
                <h2>Transactions</h2>
                <Table>
                  <TableBody>
                    {draft.transactions.map((t, i) => (
                      <tr key={i}>
                        <td className="mono">{fmtDate(t.date)}</td>
                        <td>{t.description}</td>
                        <td className="num">
                          {t.currency} {Number(t.amount).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </TableBody>
                </Table>
              </section>
              <label className="field">
                <span>Narrative</span>
                <Textarea rows={6} value={draft.narrative ?? ""} onChange={(e) => setDraft({ ...draft, narrative: e.target.value })} readOnly={!can("smr:write")} />
              </label>
            </div>
          )}
          {tab === "access" && (
            <>
              <h2 className="title">Who can see this case</h2>
              <p className="lede">Restricted. Do not discuss this with the client or anyone outside this list.</p>
              <Table>
                <TableBody>
                  {(c.access ?? [{ userId: "you", fullName: "You", level: c.accessLevel }]).map((a) => (
                    <tr key={a.userId}>
                      <td className="who">
                        <b>{a.fullName}</b>
                      </td>
                      <td className="st">
                        <Status tone="restricted">{a.level === "full" ? "Full access" : "Summary only"}</Status>
                      </td>
                    </tr>
                  ))}
                </TableBody>
              </Table>
              <p className="note">
                Anyone else who opens a link to this case sees the same page as for a record that doesn’t exist.{" "}
                <Link className="link" to="/activity">
                  Case actions are sealed in the activity log.
                </Link>
              </p>
            </>
          )}
        </SectionTabs>
        <ChartBand label={full && subjects.size ? "Subjects of the report" : c.clientName} exhibit="Exhibit" title={full && subjects.size ? "Subjects of the report" : c.clientName} height="short" restricted legend={["person", "company", "owns", "controls"]} />
      </div>
      {full && draft && (
        <DecisionBar label="Report" className="sealed-decision">
          <div className="row">
            {can("smr:write") && tab === "draft" && (
              <Button variant="ink" onClick={() => save.mutate()} disabled={save.isPending}>
                Save the draft
              </Button>
            )}
            <Button onClick={() => exportDraft(c, draft)}>
              <Download /> Export for {draft.regime === "UK_SAR" ? "the NCA" : "AUSTRAC"}
            </Button>
            {can("smr:submit") && c.smrStatus !== "submitted" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="primary">
                    <FileCheck2 /> Mark as filed…
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Mark this report as filed?</AlertDialogTitle>
                    <AlertDialogDescription>Do this after you have lodged it with {draft.regime === "UK_SAR" ? "the NCA" : "AUSTRAC"}. Kinroot never lodges a report on the firm’s behalf. The step is sealed in the activity log.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Not yet</AlertDialogCancel>
                    <AlertDialogAction onClick={() => submit.mutate()}>Mark as filed</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <p className="note">Exports are drafts for the firm to lodge. Kinroot never lodges a report on the firm’s behalf.</p>
          </div>
        </DecisionBar>
      )}
    </Page>
  );
}
