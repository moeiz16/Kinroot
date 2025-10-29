// Alerts. The list is one queue of open alerts. An alert shows what happened and the client's chart compared with
// onboarding (new links marked, ended ones dashed), the evidence and the changes beside it, and what to do in the
// bar at the foot.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
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
  const [closing, setClosing] = useState<"resolved" | "dismissed" | null>(null);
  const [confirm, setConfirm] = useState<"rerate" | "review" | "ask" | null>(null);
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
      setClosing(null);
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
                  <span className="item-sub">{relativeDays(a.createdAt.slice(0, 10)).replace(/^./, (x) => x.toUpperCase())}</span>
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
            <Section title="Evidence">
              <ul className="evidence">
                {evidence.map((ev) => {
                  if (ev.type === "edge") {
                    const e = structure?.edges.find((x) => x.id === ev.id);
                    const gone = structure?.diff?.removed.find((x) => x.id === ev.id) ?? structure?.diff?.changed.find((x) => x.before.id === ev.id)?.before;
                    const text = e ? `${structure!.names(e.s)} → ${structure!.names(e.t)}${e.label ? ` · ${e.label}` : ""}` : gone ? `${structure!.names(gone.source)} → ${structure!.names(gone.target)} · ended` : "A link that has since ended";
                    return (
                      <li key={ev.id}>
                        {e ? (
                          <button type="button" className="reason-btn" onClick={() => onCite(ev.id)} title="Show on the chart">
                            {text}
                          </button>
                        ) : (
                          text
                        )}
                      </li>
                    );
                  }
                  return (
                    <li key={ev.id}>
                      {ev.type === "hit" ? (
                        <Link className="link" to={`/screening/${ev.id}`}>
                          Open the screening match
                        </Link>
                      ) : ev.type === "node" && structure?.nodes.some((n) => n.id === ev.id) ? (
                        <button type="button" className="reason-btn" onClick={() => onNode(ev.id)} title="Show on the chart">
                          {structure.names(ev.id)}
                        </button>
                      ) : (
                        "A party in the structure"
                      )}
                    </li>
                  );
                })}
                {!evidence.length && <li>Review was due {fmtDate(client.data?.nextReviewOn)}</li>}
              </ul>
            </Section>
          </aside>
        </div>
      )}
      {current && (
        <DecisionBar label="What to do">
          <div className="row">
            {current.kind === "review_due" && can("monitoring:manage") && (
              <Button variant="primary" onClick={() => setConfirm("review")}>
                Record review
              </Button>
            )}
            {current.kind !== "review_due" && can("risk:assess") && (
              <Button variant="primary" onClick={() => setConfirm("rerate")}>
                Re-rate
              </Button>
            )}
            <Button variant="line" onClick={() => setConfirm("ask")}>
              Ask the client
            </Button>
          </div>
          <span className="grow" />
          {can("monitoring:manage") ? (
            <div className="row">
              <Button variant="line" onClick={() => setClosing("resolved")}>
                Mark as handled
              </Button>
              <Button variant="quiet" onClick={() => setClosing("dismissed")}>
                Dismiss
              </Button>
            </div>
          ) : (
            <p className="note">The compliance officer closes alerts</p>
          )}
        </DecisionBar>
      )}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "rerate" ? `Re-rate ${current?.clientName}?` : confirm === "review" ? "Record the review as done?" : `Ask ${current?.clientName} for information?`}</AlertDialogTitle>
            <AlertDialogDescription>{confirm === "rerate" ? "The firm’s rules rate the client again with today’s structure." : confirm === "review" ? "The next review is scheduled." : "The client receives a request about this change."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => (confirm === "rerate" ? rerate.mutate() : confirm === "review" ? reviewed.mutate() : ask.mutate())}>{confirm === "rerate" ? "Re-rate" : confirm === "review" ? "Record review" : "Send request"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={!!closing} onOpenChange={(o) => !o && setClosing(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{closing === "dismissed" ? "Dismiss" : "Mark as handled"}</DialogTitle>
            <DialogDescription>{closing === "dismissed" ? "Why doesn’t this need action?" : "What was done?"}</DialogDescription>
          </DialogHeader>
          <label className="field">
            <span>Note</span>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="quiet" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!note.trim() || resolve.isPending} onClick={() => closing && resolve.mutate(closing)}>
              {closing === "dismissed" ? "Dismiss" : "Mark as handled"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
