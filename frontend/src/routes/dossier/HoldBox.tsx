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
import { Status } from "../../shell/chart";
import { Section } from "../../shell/page";

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
  const place = useMutation({ mutationFn: () => api.clients.placeHold(client.id, note.trim()), onSuccess: () => done("Paused."), onError: (e) => setMsg(errorMessage(e)) });
  const release = useMutation({ mutationFn: () => api.clients.releaseHolds(client.id, note.trim()), onSuccess: (r) => done(r.released ? "They can go ahead." : "Nothing was paused."), onError: (e) => setMsg(errorMessage(e)) });
  if (!allowed || !holds.data) return null;
  const active = holds.data.holds;
  return (
    <Section title="Client-facing steps" aside={active.length ? undefined : "Can go ahead"}>
      <div className="card card-pad grid gap-3">
        {active.length > 0 && (
          <ul className="hold-list">
            {active.map((h) => (
              <li key={h.id}>
                <Status tone="review">Paused</Status>
                <span>{h.reason === "restricted" ? "Waiting for the compliance officer" : h.note || "Paused by hand"}</span>
                <small className="muted">
                  {h.placedByName} · {fmtDate(h.placedAt.slice(0, 10))}
                </small>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-[220px] flex-1" value={note} onChange={(e) => setNote(e.target.value)} placeholder={active.length ? "Why they can go ahead" : "Why they should wait"} aria-label={active.length ? "Note for releasing" : "Note for pausing"} />
          {active.length ? (
            <Button variant="line" disabled={!note.trim() || release.isPending} onClick={() => release.mutate()}>
              <PlayCircle /> Let them go ahead
            </Button>
          ) : (
            <Button variant="line" disabled={!note.trim() || place.isPending} onClick={() => place.mutate()}>
              <PauseCircle /> Pause
            </Button>
          )}
        </div>
        {msg && (
          <p role="status" className="note">
            {msg}
          </p>
        )}
      </div>
    </Section>
  );
}

const OUTCOMES = [
  { id: "keep_rules", label: "Keep the rules" },
  { id: "override_to_challenger", label: "Use second opinion" },
  { id: "methodology_issue", label: "Flag the method" },
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
      setMsg("Settled.");
      setNote("");
      void qc.invalidateQueries({ queryKey: ["risk", client.id] });
      void qc.invalidateQueries({ queryKey: ["client", client.id] });
      void qc.invalidateQueries({ queryKey: ["disagreements"] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  if (!allowed || !open.data?.items.some((d) => d.id === ch!.disagreementId)) return msg ? <p role="status" className="note">{msg}</p> : null;
  return (
    <Section title="Settle the difference" aside={`Rules: ${ratingLook(risk.rating).word} · second opinion: ${ratingLook(ch.rating).word}`}>
      <div className="card card-pad grid gap-3">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (at least 10 characters)" aria-label="Reason" />
        <div className="flex flex-wrap gap-2">
          {OUTCOMES.map((o) => (
            <Button key={o.id} variant={o.id === "keep_rules" ? "primary" : "line"} disabled={note.trim().length < 10 || resolve.isPending} onClick={() => resolve.mutate(o.id)}>
              {o.label}
            </Button>
          ))}
        </div>
        {msg && (
          <p role="status" className="note">
            {msg}
          </p>
        )}
      </div>
    </Section>
  );
}
