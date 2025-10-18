// Suspicious-matter report cases: restricted. Only the compliance officer and named people see this route; everyone
// else gets the same "isn't available" page for restricted, missing and forbidden ids (tipping-off control).
// The restriction belongs to the record: the whole folio caption carries the hatch and the lock.
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
import { AsAt, BoardTools, Status } from "../shell/chrome";
import { Caption, Decision, Folio, FolioBody, FolioTabs } from "../shell/Folio";
import { NotAvailable } from "./NotFound";
import { useStructure } from "./dossier/structure";

/** Black bars sweep across each restricted field, then the lock fades in (Redact). */
export function Redacted({ lines = 3, label }: { lines?: number; label: string }) {
  const reduced = prefersReduced();
  return (
    <div role="img" aria-label={`${label}: restricted`} className="redacted-block">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="redact" style={{ ["--d" as string]: `${reduced ? 0 : i * 40}ms`, width: `${[92, 78, 64, 85][i % 4]}%`, display: "block", height: 14, margin: "8px 0" }}>
          .
        </span>
      ))}
      <span className="redact-lock" style={{ ["--d" as string]: `${reduced ? 0 : lines * 40 + 220}ms`, display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, fontWeight: 600 }}>
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
  return (
    <>
      <div className="restricted-edges" aria-hidden />
      {id ? (
        one.data && <CaseFile c={one.data} onBack={can("smr:read") ? () => nav("/reports") : undefined} />
      ) : (
        list.data && (
          <Folio label="Restricted cases" width="normal">
            <Caption restricted refLine={<span>Restricted · visible to the compliance officer and named delegates</span>} title={`Cases · ${list.data.total}`} sub="Do not discuss these with the client or anyone outside each case’s list." />
            <FolioBody>
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
                          <Link to={`/reports/${c.id}`} className="inline-flex items-center gap-1.5 text-ink no-underline">
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
            </FolioBody>
          </Folio>
        )
      )}
    </>
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
    <section className="section" style={{ marginTop: 26 }}>
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
            <div style={{ marginTop: 8 }}>
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
  // The board shows only the case's pinned parties; everything else is hidden.
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
  return (
    <>
      <Folio label="Restricted case file" width="normal">
        <Caption
          restricted
          refLine={
            <>
              <Lock size={12} aria-hidden />
              <b>Restricted</b>
              <span className="sep">·</span>
              <span>visible to {c.access ? c.access.map((a) => a.fullName).join(" and ") : "the people on this case"}</span>
              <span className="sep">·</span>
              <span>do not discuss with the client</span>
            </>
          }
          title={c.title.split(" · ")[0]}
          sub={`${c.clientName} · opened ${fmtDate(c.openedAt.slice(0, 10))} by ${c.openedBy}`}
          stamps={<Status tone={d.tone}>{d.text}</Status>}
          tools={
            onBack && (
              <Button variant="quiet" size="sm" onClick={onBack}>
                All cases
              </Button>
            )
          }
        />
        <FolioTabs label="Restricted case file" tabs={tabs} active={tab} onTab={setTab}>
          {tab === "grounds" && (
            <div className="paras">
              <section className="para" style={{ marginTop: 0 }}>
                <h2>Grounds for suspicion</h2>
                {full ? <p className="lede" style={{ marginTop: 0 }}>{c.grounds}</p> : <Redacted label="Grounds" lines={4} />}
                {!full && <p className="note" style={{ marginTop: 14 }}>You have summary access to this case. The grounds and the draft report are visible to the compliance officer only.</p>}
              </section>
              <section className="para">
                <h2>Case history</h2>
                <ol className="timeline" style={{ marginTop: 0 }}>
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
              <h2 className="title" style={{ fontSize: 23 }}>
                Evidence pinned from the board
              </h2>
              {full ? (
                <ul className="reasons" style={{ listStyle: "none", marginTop: 14 }}>
                  {(smr.data?.attachments ?? []).map((a, i) => (
                    <li key={i} style={{ gridTemplateColumns: "26px 1fr" }}>
                      <span className="mono muted">{i + 1}</span>
                      <span style={{ fontSize: 14.5 }}>{a}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Redacted label="Evidence" lines={3} />
              )}
            </>
          )}
          {tab === "draft" && draft && (
            <>
              <h2 className="title" style={{ fontSize: 23 }}>
                Draft {regime}
              </h2>
              <div className="meta">
                Version {draft.version} · saved {fmtDateTime(draft.updatedAt)} by {draft.updatedBy}
              </div>
              <label className="field" style={{ marginTop: 16 }}>
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
                        <td className="mono" style={{ width: 110 }}>{fmtDate(t.date)}</td>
                        <td>{t.description}</td>
                        <td className="num">
                          {t.currency} {Number(t.amount).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </TableBody>
                </Table>
              </section>
              <label className="field" style={{ marginTop: 18 }}>
                <span>Narrative</span>
                <Textarea rows={6} value={draft.narrative ?? ""} onChange={(e) => setDraft({ ...draft, narrative: e.target.value })} readOnly={!can("smr:write")} />
              </label>
            </>
          )}
          {tab === "access" && (
            <>
              <h2 className="title" style={{ fontSize: 23 }}>
                Who can see this case
              </h2>
              <p className="lede" style={{ fontSize: 15 }}>
                Restricted. Do not discuss this with the client or anyone outside this list.
              </p>
              <Table style={{ marginTop: 14 }}>
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
              <p className="note" style={{ marginTop: 12 }}>
                Anyone else who opens a link to this case sees the same page as for a record that doesn’t exist.{" "}
                <Link className="link" to="/activity">
                  Case actions are sealed in the activity log.
                </Link>
              </p>
            </>
          )}
        </FolioTabs>
        {full && draft && (
          <Decision label="Report">
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
                    <Button variant="string">
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
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              Exports are drafts for the firm to lodge. Kinroot never lodges a report on the firm’s behalf.
            </p>
          </Decision>
        )}
      </Folio>
      <AsAt exhibit="Exhibit" title={full && subjects.size ? "Subjects of the report" : c.clientName} />
      <BoardTools minimap={false} />
    </>
  );
}
