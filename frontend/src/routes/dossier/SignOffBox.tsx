// Compliance officer sign-off: a document frame with the enhanced checks as three short bars.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PenLine, Send } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../../api/client";
import { api } from "../../api/endpoints";
import type { Client, Edd } from "../../api/types";
import { useAuth } from "../../lib/auth";

export function SignOffBox({ client, edd }: { client: Client; edd: Edd | undefined }) {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["edd", client.id] });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
    void qc.invalidateQueries({ queryKey: ["timeline", client.id] });
  };
  const sign = useMutation({
    mutationFn: (stage: "compliance" | "senior") => api.clients.signoff(client.id, { stage, decision: "approve", note }),
    onSuccess: () => {
      setOpen(false);
      setMsg("Signed off. The decision is sealed in the activity log.");
      refresh();
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  const request = useMutation({
    mutationFn: () => api.clients.communicate(client.id, "information_request", "Please provide the outstanding documents for your file."),
    onSuccess: () => setMsg("Request sent to the client."),
    onError: (e) => setMsg(errorMessage(e)),
  });
  if (!edd) return null;
  const measures = edd.measures.filter((m) => m.key !== "senior_approval");
  const done = measures.filter((m) => m.status !== "todo").length;
  const waiting = measures.filter((m) => m.status === "todo").map((m) => m.label.toLowerCase());
  const stage: "compliance" | "senior" | null = edd.status === "awaiting_compliance" ? "compliance" : edd.status === "awaiting_senior" ? "senior" : null;
  const canSign = stage === "compliance" ? can("signoff:compliance") : stage === "senior" ? can("signoff:senior") && client.assignedTo?.id !== me?.user.id : false;
  const heading = edd.status === "approved" ? "Signed off" : stage === "senior" ? "Partner approval" : "Compliance officer sign-off";
  const body = !edd.required
    ? "No enhanced checks are needed for this client. Standard due diligence applies."
    : edd.status === "approved"
      ? `Approved by ${edd.signoffs.map((s) => s.byName).join(" and ")}.`
      : stage === "senior"
        ? client.assignedTo?.id === me?.user.id && can("signoff:senior")
          ? "The compliance officer signed off. You act for this client, so another partner gives the approval."
          : "The compliance officer signed off. A partner who doesn't act for this client approves next."
        : `${done} of ${measures.length} enhanced checks received.${waiting.length ? ` Waiting on ${waiting.slice(0, 2).join(" and ")}.` : " Ready for sign-off."}`;
  return (
    <section className="signoff" aria-label={heading}>
      {edd.required && (
        <div className="checks" role="img" aria-label={`${done} of ${measures.length} enhanced checks received`}>
          {measures.map((m) => (
            <span key={m.key} className={m.status !== "todo" ? "done" : ""} />
          ))}
        </div>
      )}
      <h3>{heading}</h3>
      <p>{body}</p>
      {open && (
        <label className="field" style={{ marginBottom: 12 }}>
          <span>Note for the record</span>
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked and why you are satisfied" />
        </label>
      )}
      <div className="row" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {edd.status !== "approved" && can("clients:write") && (
          <button className="btn btn-ink" onClick={() => request.mutate()} disabled={request.isPending}>
            <Send /> Request from client
          </button>
        )}
        {edd.status !== "approved" && (
          <button
            className={`btn ${open ? "btn-string" : "btn-line"}`}
            aria-disabled={!canSign}
            disabled={!canSign || sign.isPending}
            title={canSign ? undefined : stage ? "Only the right person can sign this stage" : "Waiting on the enhanced checks"}
            onClick={() => (open ? stage && sign.mutate(stage) : setOpen(true))}
          >
            <PenLine /> {open ? "Confirm sign-off" : stage === "senior" ? "Approve as partner" : "Sign off"}
          </button>
        )}
      </div>
      {msg && (
        <p role="status" style={{ marginTop: 12, marginBottom: 0, color: "var(--ink-2)" }}>
          {msg}
        </p>
      )}
    </section>
  );
}
