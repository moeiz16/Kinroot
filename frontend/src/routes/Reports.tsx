// Suspicious-matter report cases: restricted. Only the compliance officer and named people see this route; everyone
// else gets the same "isn't available" page for restricted, missing and forbidden ids (tipping-off control).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileCheck2, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Case, SmrDraft } from "../api/types";
import { businessDaysUntil, fmtDate, fmtDateTime } from "../lib/dates";
import { prefersReduced } from "../lib/theme";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardScene } from "../shell/board";
import { BoardTools, Status } from "../shell/chrome";
import { Drawer, Sheet } from "../shell/Drawer";
import { NotAvailable } from "./NotFound";
import { useStructure } from "./dossier/structure";
import "./sheets.css";

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

export function deadlineLook(c: Case): { tone: "high" | "review" | "neutral"; text: string } {
  if (c.smrStatus === "submitted") return { tone: "neutral", text: "Filed" };
  const n = businessDaysUntil(c.deadlineOn);
  if (n < 0) return { tone: "high", text: `Overdue by ${-n} day${n === -1 ? "" : "s"}` };
  if (n === 0) return { tone: "high", text: "Due today (3-day limit)" };
  return { tone: n <= 1 ? "high" : "review", text: `Due in ${n} business day${n === 1 ? "" : "s"} (3-day limit)` };
}

function exportDraft(c: Case, d: SmrDraft) {
  const text = [
    `DRAFT FOR THE FIRM TO LODGE · ${d.regime === "AUSTRAC_SMR" ? "AUSTRAC suspicious matter report" : "UK suspicious activity report"}`,
    `Case: ${c.title}`,
    `Grounds for suspicion:\n${d.suspicionGrounds}`,
    `Subjects:\n${d.subjects.map((s) => `- ${s.name} (${s.role})`).join("\n")}`,
    `Transactions:\n${d.transactions.map((t) => `- ${t.date} ${t.currency} ${t.amount.toLocaleString("en-AU")} ${t.description}`).join("\n")}`,
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
  const board = useBoard();
  const list = useQuery({ queryKey: ["cases"], queryFn: api.cases.list, enabled: can("smr:read"), retry: false });
  const caseId = id ?? list.data?.items[0]?.id;
  const one = useQuery({ queryKey: ["case", caseId], queryFn: () => api.cases.get(caseId!), enabled: !!caseId, retry: false });
  if (!id && !can("smr:read")) return <NotAvailable />;
  if (one.isError) return <NotAvailable />;
  return (
    <>
      <div className="restricted-edges" aria-hidden style={{ left: board.occlusion.left, right: board.occlusion.right }} />
      <div className="chrome restricted-band" style={{ top: 0, left: board.occlusion.left, right: board.occlusion.right, zIndex: 15 }} role="note">
        <Lock size={14} aria-hidden /> Restricted{one.data?.access ? ` · visible to ${one.data.access.map((a) => a.fullName).join(" and ")}` : ""} · do not discuss with the client
      </div>
      {can("smr:read") && !id && list.data && (
        <Sheet label="Cases" width={420}>
          <div style={{ height: 30 }} />
          <h1 className="title">Cases · {list.data.total}</h1>
          <ul className="client-rows">
            {list.data.items.map((c) => {
              const d = deadlineLook(c);
              return (
                <li key={c.id}>
                  <button className="client-row" style={{ width: "100%", gridTemplateColumns: "22px 1fr", background: "none", border: 0, borderBottom: "1px solid var(--rule)", textAlign: "left" }} onClick={() => nav(`/reports/${c.id}`)}>
                    <Lock size={16} aria-hidden style={{ marginTop: 3 }} />
                    <span>
                      <span className="cr-name">{c.title.split(" · ")[0]}</span>
                      <span className="cr-meta">{c.clientName}</span>
                      <span className="cr-status">
                        {c.smrStatus === "draft" ? "Draft" : c.smrStatus === "submitted" ? "Filed" : "No report"} · {d.text}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Sheet>
      )}
      {one.data && <CaseFile c={one.data} onBack={id && can("smr:read") ? () => nav("/reports") : undefined} />}
    </>
  );
}

function CaseFile({ c }: { c: Case; onBack?: () => void }) {
  const [tab, setTab] = useState("grounds");
  const qc = useQueryClient();
  const board = useBoard();
  const { can } = useAuth();
  const full = c.accessLevel === "full";
  const smr = useQuery({ queryKey: ["smr", c.id], queryFn: () => api.cases.smr(c.id), enabled: full, retry: false });
  const timeline = useQuery({ queryKey: ["case-timeline", c.id], queryFn: () => api.cases.timeline(c.id) });
  const { structure } = useStructure(c.clientId, null);
  const [draft, setDraft] = useState<SmrDraft | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
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
      setMsg("Draft saved.");
      void qc.invalidateQueries({ queryKey: ["smr", c.id] });
    },
    onError: (e) => setMsg(e instanceof ApiError && e.code === "stale_version" ? "Someone else saved this draft. Reload to see their changes." : errorMessage(e)),
  });
  const submit = useMutation({
    mutationFn: () => api.cases.submit(c.id),
    onSuccess: (r) => {
      setMsg(`Marked as filed. Reference ${r.reference}.`);
      void qc.invalidateQueries({ queryKey: ["case", c.id] });
      void qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  const d = deadlineLook(c);
  const tabs = [
    { id: "grounds", label: "Grounds" },
    { id: "evidence", label: "Evidence", count: full ? (smr.data?.attachments.length ?? 0) : undefined },
    ...(full ? [{ id: "draft", label: "Draft report" }] : []),
    { id: "access", label: "Access" },
  ];
  return (
    <>
      <BoardTools minimap={false} />
      {msg && (
        <div className="chrome toast" role="status" style={{ bottom: 70, left: `calc((100% - ${board.occlusion.right}px) / 2)`, transform: "translateX(-50%)" }}>
          {msg}
        </div>
      )}
      <Drawer label="Restricted case file" tabs={tabs} active={tab} onTab={setTab}>
        <div className="eyebrow">
          <Lock size={12} aria-hidden /> {c.title.split(" · ")[0]} <span aria-hidden>·</span> {c.clientName}
        </div>
        {tab === "grounds" && (
          <>
            <h1 className="title" style={{ fontSize: 26 }}>
              Grounds for suspicion
            </h1>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
              <Status tone={d.tone}>{d.text}</Status>
              <span className="meta">Opened {fmtDate(c.openedAt.slice(0, 10))} by {c.openedBy}</span>
            </div>
            {full ? <p className="lede">{c.grounds}</p> : <Redacted label="Grounds" lines={4} />}
            {!full && <p className="note" style={{ marginTop: 14 }}>You have summary access to this case. The grounds and the draft report are visible to the compliance officer only.</p>}
            <section className="section">
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
          </>
        )}
        {tab === "evidence" && (
          <>
            <h1 className="title" style={{ fontSize: 24 }}>
              Evidence pinned from the board
            </h1>
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
            <h1 className="title" style={{ fontSize: 24 }}>
              Draft {draft.regime === "AUSTRAC_SMR" ? "suspicious matter report" : "suspicious activity report"}
            </h1>
            <div className="meta">
              Version {draft.version} · saved {fmtDateTime(draft.updatedAt)} by {draft.updatedBy}
            </div>
            <label className="field" style={{ marginTop: 16 }}>
              <span>Grounds for suspicion</span>
              <textarea className="textarea" rows={4} value={draft.suspicionGrounds ?? ""} onChange={(e) => setDraft({ ...draft, suspicionGrounds: e.target.value })} readOnly={!can("smr:write")} />
            </label>
            <section className="section">
              <h2>Subjects</h2>
              <table className="ledger">
                <tbody>
                  {draft.subjects.map((s) => (
                    <tr key={s.partyId}>
                      <td className="who">
                        <b>{s.name}</b>
                      </td>
                      <td>{s.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="section">
              <h2>Transactions</h2>
              <table className="ledger">
                <tbody>
                  {draft.transactions.map((t, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ width: 110 }}>{fmtDate(t.date)}</td>
                      <td>{t.description}</td>
                      <td className="num">
                        {t.currency} {t.amount.toLocaleString("en-AU")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <label className="field" style={{ marginTop: 18 }}>
              <span>Narrative</span>
              <textarea className="textarea" rows={6} value={draft.narrative ?? ""} onChange={(e) => setDraft({ ...draft, narrative: e.target.value })} readOnly={!can("smr:write")} />
            </label>
            <div className="decide">
              <div className="row">
                {can("smr:write") && (
                  <button className="btn btn-ink" onClick={() => save.mutate()} disabled={save.isPending}>
                    Save the draft
                  </button>
                )}
                <button className="btn btn-line" onClick={() => exportDraft(c, draft)}>
                  <Download /> Export for AUSTRAC
                </button>
                {can("smr:submit") && c.smrStatus !== "submitted" && (
                  <button className="btn btn-string" onClick={() => window.confirm("Mark this report as filed with AUSTRAC? Do this after you have lodged it.") && submit.mutate()}>
                    <FileCheck2 /> Mark as filed…
                  </button>
                )}
              </div>
              <p className="note">Exports are drafts for the firm to lodge. Kinroot never lodges a report on the firm’s behalf.</p>
            </div>
          </>
        )}
        {tab === "access" && (
          <>
            <h1 className="title" style={{ fontSize: 24 }}>
              Who can see this case
            </h1>
            <p className="lede" style={{ fontSize: 15 }}>
              Restricted. Do not discuss this with the client or anyone outside this list.
            </p>
            <table className="ledger" style={{ marginTop: 14 }}>
              <tbody>
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
              </tbody>
            </table>
            <p className="note" style={{ marginTop: 12 }}>
              Anyone else who opens a link to this case sees the same page as for a record that doesn’t exist. <Link className="link" to="/activity">Case actions are sealed in the activity log.</Link>
            </p>
          </>
        )}
      </Drawer>
    </>
  );
}
