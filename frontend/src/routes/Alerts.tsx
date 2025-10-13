// Monitoring alerts, grouped per client. Selecting one switches the board into the before/after overlay for that
// client: links added since the compare date carry "+ New since"; removed ones fade and turn dashed.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Alert } from "../api/types";
import { fmtDate, relativeDays, today } from "../lib/dates";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardScene } from "../shell/board";
import { AsAt, BoardTools, Legend, Status } from "../shell/chrome";
import { Drawer } from "../shell/Drawer";
import { Cite } from "./dossier/panels";
import { useStructure } from "./dossier/structure";
import "./sheets.css";

const SEV = { critical: { tone: "high", word: "Act now" }, warning: { tone: "review", word: "Look this week" }, info: { tone: "neutral", word: "For your information" } } as const;
const KIND: Record<Alert["kind"], string> = {
  list_update_hit: "List update",
  ownership_change: "Ownership change",
  officer_change: "Officer change",
  address_change: "Address change",
  risk_change: "Rating change",
  review_due: "Periodic review",
  model_drift: "Pattern check",
};

export default function Alerts() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const board = useBoard();
  const { can } = useAuth();
  const [tab, setTab] = useState("alert");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const alerts = useQuery({ queryKey: ["alerts", "open"], queryFn: () => api.monitoring.alerts({ pageSize: 100 }) });
  const items = useMemo(() => alerts.data?.items ?? [], [alerts.data]);
  const current = items.find((a) => a.id === id) ?? items[0];
  const client = useQuery({ queryKey: ["client", current?.clientId], queryFn: () => api.clients.get(current!.clientId), enabled: !!current });
  const from = showDiff ? (client.data?.onboardedOn ?? null) : null;
  const { structure } = useStructure(current?.clientId, from);
  useBoardScene(structure?.scene ?? null, { unfold: false });

  const groups = useMemo(() => {
    const m = new Map<string, Alert[]>();
    items.forEach((a) => m.set(a.clientId, [...(m.get(a.clientId) ?? []), a]));
    return [...m.values()];
  }, [items]);

  const done = () => {
    void qc.invalidateQueries({ queryKey: ["alerts"] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const resolve = useMutation({
    mutationFn: (outcome: "resolved" | "dismissed") => api.monitoring.resolve(current!.id, outcome, note),
    onSuccess: (a) => {
      setMsg(a.status === "dismissed" ? "Dismissed with your reason." : "Marked as handled.");
      setNote("");
      done();
      const next = items.find((x) => x.id !== a.id);
      nav(next ? `/alerts/${next.id}` : "/alerts");
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  const rerate = useMutation({ mutationFn: () => api.clients.assess(current!.clientId), onSuccess: (r) => setMsg(`Re-rated: ${r.score} out of 100.`), onError: (e) => setMsg(errorMessage(e)) });
  const ask = useMutation({ mutationFn: () => api.clients.communicate(current!.clientId, "information_request", `About: ${current!.title}`), onSuccess: () => setMsg("Request sent to the client."), onError: (e) => setMsg(errorMessage(e)) });
  const reviewed = useMutation({ mutationFn: () => api.clients.review(current!.clientId, { completed: true, note: note || "Periodic review completed." }), onSuccess: () => { setMsg("Review recorded. The next one is scheduled."); done(); }, onError: (e) => setMsg(errorMessage(e)) });

  const onCite = (edgeId: string) => {
    const e = structure?.edges.find((x) => x.id === edgeId);
    if (!e) return;
    board.engine()?.setDim([e.s, e.t]);
    void board.pull([{ ids: [e.s, e.t] }], { dur: 700 });
    setTimeout(() => board.engine()?.setDim(null), 2600);
  };

  const onNode = (nodeId: string) => {
    board.engine()?.setDim([nodeId]);
    board.engine()?.flyTo(nodeId, 1);
    setTimeout(() => board.engine()?.setDim(null), 2600);
  };

  return (
    <>
      <div className="chrome queue-tray" style={{ top: 92, left: 16, right: board.occlusion.right + 16 }}>
        <div className="tray" role="list" aria-label="Open alerts">
          <span className="cap">
            {items.length} open
            <br />
            alerts
          </span>
          {groups.map((g) => (
            <button key={g[0]!.clientId} className="slip" role="listitem" aria-current={current?.clientId === g[0]!.clientId} onClick={() => nav(`/alerts/${g[0]!.id}`)}>
              <span className="k">
                <span aria-hidden>{g[0]!.severity === "critical" ? "▲" : g[0]!.severity === "warning" ? "◆" : "●"}</span> {KIND[g[0]!.kind]}
                {g.length > 1 ? ` +${g.length - 1}` : ""}
              </span>
              <b>{g[0]!.clientName.replace(/ Pty Ltd$/, "")}</b>
              <small>{g[0]!.title}</small>
            </button>
          ))}
        </div>
      </div>
      {current && client.data && <AsAt asAt={today()} compare={from} compareLabel="onboarding" onToggle={() => setShowDiff(!showDiff)} />}
      <BoardTools />
      <Legend />
      {msg && (
        <div className="chrome toast" role="status" style={{ bottom: 70, left: `calc((100% - ${board.occlusion.right}px) / 2)`, transform: "translateX(-50%)" }}>
          {msg}
        </div>
      )}
      <Drawer
        label="Alert"
        tabs={[
          { id: "alert", label: "Alert" },
          { id: "changed", label: "What changed", count: structure?.diff?.summary.length || undefined },
          { id: "actions", label: "Actions" },
        ]}
        active={tab}
        onTab={setTab}
      >
        {!current ? (
          <>
            <h1 className="title">No open alerts</h1>
            <p className="lede">Kinroot watches registers, screening lists and review dates for every client, and files an alert here when something changes.</p>
          </>
        ) : tab === "changed" ? (
          <>
            <h1 className="title" style={{ fontSize: 24 }}>
              What changed since onboarding
            </h1>
            <div className="meta">
              {client.data?.name} · compared with {fmtDate(client.data?.onboardedOn)}
            </div>
            <ol className="reasons" style={{ marginTop: 16 }}>
              {(structure?.diff?.summary ?? []).map((s, i) => {
                const e = [...(structure?.diff?.added ?? []), ...(structure?.diff?.removed ?? []), ...(structure?.diff?.changed.map((c) => c.after) ?? [])][i];
                return (
                  <li key={i}>
                    <span>
                      {s} {e && <Cite id={e.id} label={structure?.cites.get(e.id) ?? "Show"} onCite={onCite} />}
                    </span>
                    <span />
                  </li>
                );
              })}
              {!structure?.diff?.summary.length && (
                <li>
                  <span>The structure has not changed since onboarding.</span>
                  <span />
                </li>
              )}
            </ol>
          </>
        ) : tab === "actions" ? (
          <ActionsPanel
            alert={current}
            canManage={can("monitoring:manage")}
            canAssess={can("risk:assess")}
            note={note}
            setNote={setNote}
            onRerate={() => rerate.mutate()}
            onAsk={() => ask.mutate()}
            onResolve={(o) => resolve.mutate(o)}
            onReviewed={() => reviewed.mutate()}
          />
        ) : (
          <>
            <div className="eyebrow">
              {KIND[current.kind]} <span aria-hidden>·</span> {relativeDays(current.createdAt.slice(0, 10))}
            </div>
            <h1 className="title" style={{ fontSize: 27 }}>
              {current.title}
            </h1>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
              <Status tone={SEV[current.severity].tone}>{SEV[current.severity].word}</Status>
              <span className="meta">{current.clientName}</span>
            </div>
            <p className="lede">{current.body}</p>
            <section className="section">
              <h2>Evidence</h2>
              <ul className="reasons" style={{ listStyle: "none" }}>
                {current.evidence.map((ev) => (
                  <li key={ev.id} style={{ gridTemplateColumns: "1fr" }}>
                    <span style={{ fontFamily: "var(--f-sans)", fontSize: 14 }}>
                      {ev.type === "edge" ? (
                        <>
                          {(() => {
                            const e = structure?.edges.find((x) => x.id === ev.id);
                            if (e) return `${structure!.names(e.s)} → ${structure!.names(e.t)} · ${e.label ?? ""}${e.added ? ` · ${e.added}` : e.removed ? ` · ${e.removed}` : ""}`;
                            const gone = structure?.diff?.removed.find((x) => x.id === ev.id) ?? structure?.diff?.changed.find((x) => x.before.id === ev.id)?.before;
                            return gone ? `${structure!.names(gone.source)} → ${structure!.names(gone.target)} · ${gone.label} · no longer in place` : "A link that has since ended";
                          })()}{" "}
                          {structure?.cites.get(ev.id) && <Cite id={ev.id} label={structure.cites.get(ev.id)} onCite={onCite} />}
                        </>
                      ) : ev.type === "hit" ? (
                        <button className="link" onClick={() => nav(`/screening/${ev.id}`)}>
                          Open the screening match
                        </button>
                      ) : ev.type === "node" && structure?.nodes.some((n) => n.id === ev.id) ? (
                        <>
                          {structure.names(ev.id)}{" "}
                          <button className="link" onClick={() => onNode(ev.id)}>
                            Show on the board
                          </button>
                        </>
                      ) : (
                        "A party in the structure"
                      )}
                    </span>
                  </li>
                ))}
                {!current.evidence.length && (
                  <li style={{ gridTemplateColumns: "1fr" }}>
                    <span style={{ fontSize: 14 }}>Next review was due {fmtDate(client.data?.nextReviewOn)}.</span>
                  </li>
                )}
              </ul>
            </section>
            <p style={{ marginTop: 18 }}>
              <b>Suggested:</b> {current.kind === "review_due" ? "complete the periodic review." : current.kind === "list_update_hit" ? "review the screening match today." : "re-rate the client and ask for the new owner’s details."}
            </p>
            <button className="btn btn-ink" onClick={() => setTab("actions")}>
              Choose what to do
            </button>
            <button className="link" style={{ marginLeft: 16 }} onClick={() => nav(`/clients/${current.clientId}/summary`)}>
              Open dossier →
            </button>
          </>
        )}
      </Drawer>
    </>
  );
}

function ActionsPanel(p: { alert: Alert; canManage: boolean; canAssess: boolean; note: string; setNote: (s: string) => void; onRerate: () => void; onAsk: () => void; onResolve: (o: "resolved" | "dismissed") => void; onReviewed: () => void }) {
  return (
    <>
      <h1 className="title" style={{ fontSize: 24 }}>
        What to do
      </h1>
      <div className="decide">
        <div className="row">
          {p.alert.kind === "review_due" && p.canManage && (
            <button className="btn btn-string" onClick={p.onReviewed}>
              Record the review as done
            </button>
          )}
          {p.alert.kind !== "review_due" && p.canAssess && (
            <button className="btn btn-string" onClick={p.onRerate}>
              Re-rate {p.alert.clientName.replace(/ Pty Ltd$/, "")}
            </button>
          )}
          <button className="btn btn-line" onClick={p.onAsk}>
            Ask the client
          </button>
        </div>
        {p.canManage ? (
          <>
            <label className="field">
              <span>Reason (needed to dismiss)</span>
              <textarea className="textarea" value={p.note} onChange={(e) => p.setNote(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn btn-ink" onClick={() => p.onResolve("resolved")}>
                Mark as handled
              </button>
              <button className="btn btn-quiet" onClick={() => p.onResolve("dismissed")}>
                Dismiss…
              </button>
            </div>
          </>
        ) : (
          <p className="note">The compliance officer closes alerts.</p>
        )}
      </div>
    </>
  );
}
