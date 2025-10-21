// Monitoring alerts. Without an id: a register of open alerts grouped per client. With an id, chart over record: the
// masthead, the client's structure compared with onboarding (links added since carry "+ New since"; removed ones
// fade and turn dashed), the alert record (what happened, the evidence, what changed) and what to do in the
// decision bar.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Alert } from "../api/types";
import { fmtDate, relativeDays, today } from "../lib/dates";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardScene } from "../shell/board";
import { ChartBand, Status } from "../shell/chart";
import { Band, DecisionBar, Masthead, Page, PageBody, QueuePager, SectionTabs, useHop } from "../shell/page";
import { Cite } from "./dossier/panels";
import { useStructure } from "./dossier/structure";

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
      toast(a.status === "dismissed" ? "Dismissed with your reason." : "Marked as handled.");
      setNote("");
      done();
      const next = items.find((x) => x.id !== a.id);
      nav(next ? `/alerts/${next.id}` : "/alerts");
    },
    onError: (e) => toast(errorMessage(e)),
  });
  const rerate = useMutation({ mutationFn: () => api.clients.assess(current!.clientId), onSuccess: (r) => toast(`Re-rated: ${r.score} out of 100.`), onError: (e) => toast(errorMessage(e)) });
  const ask = useMutation({ mutationFn: () => api.clients.communicate(current!.clientId, "information_request", `About: ${current!.title}`), onSuccess: () => toast("Request sent to the client."), onError: (e) => toast(errorMessage(e)) });
  const reviewed = useMutation({ mutationFn: () => api.clients.review(current!.clientId, { completed: true, note: note || "Periodic review completed." }), onSuccess: () => { toast("Review recorded. The next one is scheduled."); done(); }, onError: (e) => toast(errorMessage(e)) });

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

  useHop(id && current ? current.title : null, "page");
  const queue = groups.flat().map((a) => ({ id: a.id, title: a.title, detail: `${KIND[a.kind]} · ${relativeDays(a.createdAt.slice(0, 10))}`, group: a.clientName }));
  if (!id)
    return (
      <Page skeleton="register" label="Monitoring alerts">
        <Masthead
          size="poster"
          refLine={
            <>
              <b>Monitoring</b>
              <span className="sep">/</span>
              <span>registers, screening lists and review dates, watched for every client</span>
            </>
          }
          title={
            <>
              Alerts <span className="mast-count">{items.length}</span>
            </>
          }
        />
        <PageBody>
          {!items.length && <p className="lede">Kinroot watches registers, screening lists and review dates for every client, and files an alert here when something changes.</p>}
          {groups.map((g, gi) => (
            <Band key={g[0]!.clientId} n={String(gi + 1).padStart(2, "0")} title={g[0]!.clientName} aside={`${g.length} open`}>
              <ul className="register-list">
                {g.map((a) => (
                  <li key={a.id}>
                    <Link to={`/alerts/${a.id}`} className="register-row">
                      <span className="rr-kind">{KIND[a.kind]}</span>
                      <b className="rr-title">{a.title}</b>
                      <Status tone={SEV[a.severity].tone}>{SEV[a.severity].word}</Status>
                      <span className="rr-when mono">{relativeDays(a.createdAt.slice(0, 10))}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Band>
          ))}
        </PageBody>
      </Page>
    );
  return (
    <Page skeleton="chart" label="Alert">
      <Masthead
        size="name"
        refLine={
          current ? (
            <>
              <b>{KIND[current.kind]}</b>
              <span className="sep">/</span>
              <span>{relativeDays(current.createdAt.slice(0, 10))}</span>
              <span className="sep">/</span>
              <b>{current.clientName}</b>
            </>
          ) : (
            <b>Monitoring</b>
          )
        }
        title={current ? current.title : "No open alerts"}
        stamps={current && <Status tone={SEV[current.severity].tone}>{SEV[current.severity].word}</Status>}
        tools={<QueuePager label="Open alerts" items={queue} current={current?.id} onPick={(x) => nav(`/alerts/${x}`)} />}
      />
      {current && client.data && (
        <ChartBand
          label={`${client.data.name}: structure`}
          exhibit="Exhibit A"
          title={client.data.name}
          height="mid"
          compare={{ asAt: today(), compare: from, compareLabel: "onboarding", onToggle: () => setShowDiff(!showDiff) }}
          legend={["person", "company", "trust", "owns", "controls"]}
        />
      )}
      <SectionTabs
        label="Alert"
        tabs={[
          { id: "alert", label: "Alert" },
          { id: "changed", label: "What changed", count: structure?.diff?.summary.length || undefined },
        ]}
        active={tab}
        onTab={setTab}
        className="record"
      >
        {!current ? (
          <p className="lede">Kinroot watches registers, screening lists and review dates for every client, and files an alert here when something changes.</p>
        ) : tab === "changed" ? (
          <>
            <h2 className="title">What changed since onboarding</h2>
            <div className="meta">
              {client.data?.name} · compared with {fmtDate(client.data?.onboardedOn)}
            </div>
            <ol className="reasons">
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
        ) : (
          <div className="paras">
            <p className="lede alert-body">{current.body}</p>
            <section className="para">
              <h2>Evidence</h2>
              <ol className="reasons">
                {current.evidence.map((ev) => (
                  <li key={ev.id}>
                    <span>
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
                        <Button variant="link" onClick={() => nav(`/screening/${ev.id}`)}>
                          Open the screening match
                        </Button>
                      ) : ev.type === "node" && structure?.nodes.some((n) => n.id === ev.id) ? (
                        <>
                          {structure.names(ev.id)}{" "}
                          <Button variant="link" onClick={() => onNode(ev.id)}>
                            Show on the chart
                          </Button>
                        </>
                      ) : (
                        "A party in the structure"
                      )}
                    </span>
                    <span />
                  </li>
                ))}
                {!current.evidence.length && (
                  <li>
                    <span>Next review was due {fmtDate(client.data?.nextReviewOn)}.</span>
                    <span />
                  </li>
                )}
              </ol>
            </section>
            <section className="para">
              <h2>Suggested</h2>
              <p className="suggest">
                {current.kind === "review_due" ? "Complete the periodic review." : current.kind === "list_update_hit" ? "Review the screening match today." : "Re-rate the client and ask for the new owner’s details."}{" "}
                <Button variant="link" onClick={() => nav(`/clients/${current.clientId}/summary`)}>
                  Open the dossier →
                </Button>
              </p>
            </section>
          </div>
        )}
      </SectionTabs>
      {current && (
        <DecisionBar label="What to do">
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
        </DecisionBar>
      )}
    </Page>
  );
}

function ActionsPanel(p: { alert: Alert; canManage: boolean; canAssess: boolean; note: string; setNote: (s: string) => void; onRerate: () => void; onAsk: () => void; onResolve: (o: "resolved" | "dismissed") => void; onReviewed: () => void }) {
  return (
    <div className="decide-grid">
      <div className="row">
        {p.alert.kind === "review_due" && p.canManage && (
          <Button variant="primary" onClick={p.onReviewed}>
            Record the review as done
          </Button>
        )}
        {p.alert.kind !== "review_due" && p.canAssess && (
          <Button variant="primary" onClick={p.onRerate}>
            Re-rate {p.alert.clientName.replace(/ Pty Ltd$/, "")}
          </Button>
        )}
        <Button onClick={p.onAsk}>Ask the client</Button>
      </div>
      {p.canManage ? (
        <>
          <label className="field">
            <span>Reason (needed to dismiss)</span>
            <Textarea rows={2} className="min-h-[56px]" value={p.note} onChange={(e) => p.setNote(e.target.value)} />
          </label>
          <div className="row">
            <Button variant="ink" onClick={() => p.onResolve("resolved")}>
              Mark as handled
            </Button>
            <Button variant="quiet" onClick={() => p.onResolve("dismissed")}>
              Dismiss…
            </Button>
          </div>
        </>
      ) : (
        <p className="note">The compliance officer closes alerts.</p>
      )}
    </div>
  );
}
