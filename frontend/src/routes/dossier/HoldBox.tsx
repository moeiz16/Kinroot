// Compliance-officer controls on a dossier: pausing client-facing steps (a hold) and settling a difference between
// the firm's rules and the second-opinion check. Both are only rendered for people with the permission.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PauseCircle, PlayCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "../../api/client";
import { api } from "../../api/endpoints";
import type { Client, RiskAssessment } from "../../api/types";
import { fmtDate } from "../../lib/dates";
import { useAuth } from "../../lib/auth";
import { ratingLook } from "../../lib/format";
import { Status } from "../../shell/chrome";

/** One neutral wording for every hold, so the hold itself never hints at a restricted matter. */
export function HoldBox({ client }: { client: Client }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const allowed = can("signoff:compliance");
  const holds = useQuery({ queryKey: ["holds", client.id], queryFn: () => api.clients.holds(client.id), enabled: allowed });
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const done = (m: string) => {
    setMsg(m);
    setNote("");
    void qc.invalidateQueries({ queryKey: ["holds", client.id] });
  };
  const place = useMutation({ mutationFn: () => api.clients.placeHold(client.id, note.trim()), onSuccess: () => done("Client-facing steps are paused. The team sees the usual go-ahead message."), onError: (e) => setMsg(errorMessage(e)) });
  const release = useMutation({ mutationFn: () => api.clients.releaseHolds(client.id, note.trim()), onSuccess: (r) => done(r.released ? "Client-facing steps can go ahead again." : "Nothing was paused."), onError: (e) => setMsg(errorMessage(e)) });
  if (!allowed || !holds.data) return null;
  const active = holds.data.holds;
  return (
    <section className="section hold-box">
      <h2>
        Client-facing steps <span className="aside">Requests, exit notices and closing the matter</span>
      </h2>
      {active.length ? (
        <>
          <p style={{ margin: "0 0 10px" }}>
            <Status tone="review">Paused</Status>{" "}
            <span className="muted" style={{ fontSize: 13 }}>
              Anyone who tries is told the step needs the compliance officer’s go-ahead.
            </span>
          </p>
          <ul className="hold-list">
            {active.map((h) => (
              <li key={h.id}>
                <span>{h.reason === "restricted" ? "Paused while a restricted matter is open" : h.note || "Paused by hand"}</span>
                <small>
                  {h.placedByName} · {fmtDate(h.placedAt.slice(0, 10))}
                </small>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p style={{ margin: "0 0 10px" }}>
          <Status tone="clear">Can go ahead</Status>
        </p>
      )}
      <label className="field" style={{ marginTop: 10 }}>
        <span>{active.length ? "Note for releasing" : "Note for pausing"} (kept in the activity log)</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={active.length ? "Why the steps can go ahead" : "Why the steps should wait"} />
      </label>
      <div className="row" style={{ display: "flex", gap: 8, marginTop: 10 }}>
        {active.length ? (
          <Button disabled={!note.trim() || release.isPending} onClick={() => release.mutate()}>
            <PlayCircle /> Let steps go ahead
          </Button>
        ) : (
          <Button disabled={!note.trim() || place.isPending} onClick={() => place.mutate()}>
            <PauseCircle /> Pause client-facing steps
          </Button>
        )}
      </div>
      {msg && (
        <p role="status" className="note" style={{ marginTop: 10 }}>
          {msg}
        </p>
      )}
    </section>
  );
}

const OUTCOMES = [
  { id: "keep_rules", label: "Keep the rules’ rating" },
  { id: "override_to_challenger", label: "Use the second opinion" },
  { id: "methodology_issue", label: "Flag the risk method" },
] as const;

/** When the second-opinion check disagrees, the compliance officer settles it here with a reason. */
export function SecondOpinionBox({ client, risk }: { client: Client; risk: RiskAssessment }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const ch = risk.challenger;
  const allowed = !!ch && ch.agreement === "disagree" && !!ch.disagreementId && can("risk:override");
  const open = useQuery({ queryKey: ["disagreements", "open"], queryFn: () => api.risk.disagreements("open"), enabled: allowed });
  const resolve = useMutation({
    mutationFn: (outcome: (typeof OUTCOMES)[number]["id"]) => api.risk.resolveDisagreement(ch!.disagreementId!, outcome, note.trim()),
    onSuccess: () => {
      setMsg("Settled. Your reason is in the activity log.");
      setNote("");
      void qc.invalidateQueries({ queryKey: ["risk", client.id] });
      void qc.invalidateQueries({ queryKey: ["client", client.id] });
      void qc.invalidateQueries({ queryKey: ["disagreements"] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  if (!allowed || !open.data?.items.some((d) => d.id === ch!.disagreementId)) return msg ? <p role="status" className="note">{msg}</p> : null;
  return (
    <section className="section">
      <h2>
        Settle the difference <span className="aside">The rules stay the decision of record until you decide</span>
      </h2>
      <p style={{ margin: "0 0 10px", fontFamily: "var(--f-serif)", fontSize: 15.5 }}>
        The rules rate {client.name} {ratingLook(risk.rating).word}; the second-opinion check says {ratingLook(ch.rating).word} ({Math.round(ch.probabilityHigh * 100)} in 100 for high risk).
      </p>
      <label className="field">
        <span>Reason (at least 10 characters)</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked and why" />
      </label>
      <div className="row" style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {OUTCOMES.map((o) => (
          <Button key={o.id} variant={o.id === "keep_rules" ? "ink" : "line"} disabled={note.trim().length < 10 || resolve.isPending} onClick={() => resolve.mutate(o.id)}>
            {o.label}
          </Button>
        ))}
      </div>
      {msg && (
        <p role="status" className="note" style={{ marginTop: 10 }}>
          {msg}
        </p>
      )}
    </section>
  );
}
