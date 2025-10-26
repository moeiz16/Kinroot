// Alerts. The list is one queue of open alerts. An alert shows what happened and the client's chart compared with
// onboarding (new links marked, ended ones dashed), the evidence and the changes beside it, and what to do in the
// bar at the foot.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { Alert } from "../api/types";
import { fmtDate, relativeDays, today } from "../lib/dates";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardScene } from "../shell/board";
import { ChartBand, Status } from "../shell/chart";
import { DecisionBar, Page, PageHeader, QueuePager, Section, useTitle } from "../shell/page";
import { ReviewsHeader } from "./ReviewTabs";
import { Cite } from "./dossier/panels";
import { useStructure } from "./dossier/structure";

const SEV = { critical: { tone: "high", word: "Act now" }, warning: { tone: "review", word: "This week" }, info: { tone: "neutral", word: "FYI" } } as const;
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
  const [note, setNote] = useState("");
  const [showDiff, setShowDiff] = useState(true);
  const [dismissing, setDismissing] = useState(false);
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
      toast(a.status === "dismissed" ? "Dismissed." : "Marked as handled.");
      setNote("");
      setDismissing(false);
      done();
      const next = items.find((x) => x.id !== a.id);
      nav(next ? `/alerts/${next.id}` : "/alerts");
    },
    onError: (e) => toast(errorMessage(e)),
  });
  const rerate = useMutation({ mutationFn: () => api.clients.assess(current!.clientId), onSuccess: (r) => toast(`Re-rated: ${r.score} / 100.`), onError: (e) => toast(errorMessage(e)) });
  const ask = useMutation({ mutationFn: () => api.clients.communicate(current!.clientId, "information_request", `About: ${current!.title}`), onSuccess: () => toast("Request sent to the client."), onError: (e) => toast(errorMessage(e)) });
  const reviewed = useMutation({ mutationFn: () => api.clients.review(current!.clientId, { completed: true, note: note || "Periodic review completed." }), onSuccess: () => { toast("Review recorded."); done(); }, onError: (e) => toast(errorMessage(e)) });

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

  useTitle(id && current ? current.title : null);
  const queue = groups.flat().map((a) => ({ id: a.id, title: a.title, detail: `${KIND[a.kind]} · ${relativeDays(a.createdAt.slice(0, 10))}`, group: a.clientName }));
  if (!id)
    return (
      <Page label="Alerts">
        <ReviewsHeader />
        <ul className="items">
          {groups.flat().map((a) => (
            <li key={a.id}>
              <Link to={`/alerts/${a.id}`} className="item">
                <span className="item-ico" aria-hidden>
                  <BellRing />
                </span>
                <span className="item-main">
                  <span className="item-title">{a.title}</span>
                  <span className="item-sub">
                    {a.clientName} · {KIND[a.kind]}
                  </span>
                </span>
                <span className="item-end">
                  <Status tone={SEV[a.severity].tone}>{SEV[a.severity].word}</Status>
                </span>
              </Link>
            </li>
          ))}
          {!items.length && <li className="empty">No open alerts</li>}
        </ul>
      </Page>
    );
  const changes = structure?.diff?.summary ?? [];
  const evidence = current?.evidence ?? [];
  return (
    <Page label="Alert">
      <PageHeader
        back={{ to: "/alerts", label: "Alerts" }}
        title={current ? current.title : "No open alerts"}
        status={current && <Status tone={SEV[current.severity].tone}>{SEV[current.severity].word}</Status>}
        actions={
          <>
            {current && (
              <Button asChild variant="line">
                <Link to={`/clients/${current.clientId}/summary`}>Open client</Link>
              </Button>
            )}
            <QueuePager label="Open alerts" items={queue} current={current?.id} onPick={(x) => nav(`/alerts/${x}`)} />
          </>
        }
      />
      {current && (
        <div className="alert-grid">
          <div className="alert-main">
            <p className="alert-body">{current.body}</p>
            {client.data && <ChartBand label={`${client.data.name}: structure`} height="mid" compare={{ asAt: today(), compare: from, compareLabel: "onboarding", onToggle: () => setShowDiff(!showDiff) }} legend={["person", "company", "trust", "owns", "controls"]} />}
          </div>
          <aside className="alert-side">
            {(evidence.length > 0 || current.kind === "review_due") && (
              <Section title="Evidence">
                <ul className="evidence">
                  {evidence.map((ev) => (
                    <li key={ev.id}>
                      {ev.type === "edge" ? (
                        <>
                          {(() => {
                            const e = structure?.edges.find((x) => x.id === ev.id);
                            if (e) return `${structure!.names(e.s)} → ${structure!.names(e.t)} · ${e.label ?? ""}`;
                            const gone = structure?.diff?.removed.find((x) => x.id === ev.id) ?? structure?.diff?.changed.find((x) => x.before.id === ev.id)?.before;
                            return gone ? `${structure!.names(gone.source)} → ${structure!.names(gone.target)} · ended` : "A link that has since ended";
                          })()}{" "}
                          {structure?.cites.get(ev.id) && <Cite id={ev.id} label={structure.cites.get(ev.id)} onCite={onCite} />}
                        </>
                      ) : ev.type === "hit" ? (
                        <Link className="link" to={`/screening/${ev.id}`}>
                          Open the screening match
                        </Link>
                      ) : ev.type === "node" && structure?.nodes.some((n) => n.id === ev.id) ? (
                        <button type="button" className="link" onClick={() => onNode(ev.id)}>
                          {structure.names(ev.id)}
                        </button>
                      ) : (
                        "A party in the structure"
                      )}
                    </li>
                  ))}
                  {!evidence.length && <li>Review was due {fmtDate(client.data?.nextReviewOn)}</li>}
                </ul>
              </Section>
            )}
            <Section title="Changed since onboarding">
              <ul className="evidence">
                {changes.map((s, i) => {
                  const e = [...(structure?.diff?.added ?? []), ...(structure?.diff?.removed ?? []), ...(structure?.diff?.changed.map((c) => c.after) ?? [])][i];
                  return (
                    <li key={i}>
                      {s} {e && structure?.cites.get(e.id) && <Cite id={e.id} label={structure.cites.get(e.id)} onCite={onCite} />}
                    </li>
                  );
                })}
                {!changes.length && <li className="muted">{showDiff ? "Nothing" : "Turn on Changes"}</li>}
              </ul>
            </Section>
          </aside>
        </div>
      )}
      {current && (
        <DecisionBar label="What to do">
          <div className="row">
            {current.kind === "review_due" && can("monitoring:manage") && (
              <Button variant="primary" onClick={() => reviewed.mutate()}>
                Record review
              </Button>
            )}
            {current.kind !== "review_due" && can("risk:assess") && (
              <Button variant="primary" onClick={() => rerate.mutate()}>
                Re-rate
              </Button>
            )}
            <Button variant="line" onClick={() => ask.mutate()}>
              Ask the client
            </Button>
          </div>
          <span className="grow" />
          {can("monitoring:manage") ? (
            <div className="row">
              <Button variant="line" onClick={() => resolve.mutate("resolved")}>
                Mark as handled
              </Button>
              <Button variant="quiet" onClick={() => setDismissing(true)}>
                Dismiss…
              </Button>
            </div>
          ) : (
            <p className="note">The compliance officer closes alerts</p>
          )}
        </DecisionBar>
      )}
      <Dialog open={dismissing} onOpenChange={setDismissing}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Dismiss</DialogTitle>
            <DialogDescription>Why doesn’t this need action?</DialogDescription>
          </DialogHeader>
          <label className="field">
            <span>Reason</span>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="quiet" onClick={() => setDismissing(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!note.trim() || resolve.isPending} onClick={() => resolve.mutate("dismissed")}>
              Dismiss
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
