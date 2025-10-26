// Sign-off: one button in the dossier header. It opens a dialog with the enhanced checks, a note and the decision.
// Signed-off files show a status instead; files that need no enhanced checks show nothing.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, PenLine, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "../../api/client";
import { api } from "../../api/endpoints";
import type { Client, Edd } from "../../api/types";
import { useAuth } from "../../lib/auth";
import { Status } from "../../shell/chart";

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
      toast("Signed off.");
      refresh();
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  const request = useMutation({
    mutationFn: () => api.clients.communicate(client.id, "information_request", "Please provide the outstanding documents for your file."),
    onSuccess: () => toast("Request sent to the client."),
    onError: (e) => setMsg(errorMessage(e)),
  });
  if (!edd || !edd.required) return null;
  if (edd.status === "approved")
    return (
      <span title={`Approved by ${edd.signoffs.map((s) => s.byName).join(" and ")}`}>
        <Status tone="clear">Signed off</Status>
      </span>
    );
  const measures = edd.measures.filter((m) => m.key !== "senior_approval");
  const stage: "compliance" | "senior" | null = edd.status === "awaiting_compliance" ? "compliance" : edd.status === "awaiting_senior" ? "senior" : null;
  const canSign = stage === "compliance" ? can("signoff:compliance") : stage === "senior" ? can("signoff:senior") && client.assignedTo?.id !== me?.user.id : false;
  const title = stage === "senior" ? "Partner approval" : "Sign off";
  const who = stage === "senior" ? "A partner who doesn’t act for this client approves." : "The compliance officer signs off once the checks are in.";
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setMsg(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={canSign ? "primary" : "line"}>
          <PenLine /> {stage === "senior" ? "Approve" : "Sign off"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{who}</DialogDescription>
        </DialogHeader>
        <ul className="checklist" aria-label="Enhanced checks">
          {measures.map((m) => (
            <li key={m.key} className={m.status !== "todo" ? "done" : undefined}>
              <span className="ck" aria-hidden>
                {m.status !== "todo" && <Check size={12} strokeWidth={3} />}
              </span>
              {m.label}
              <span className="sr-only">{m.status !== "todo" ? ": received" : ": waiting"}</span>
            </li>
          ))}
        </ul>
        {canSign && (
          <label className="field">
            <span>Note</span>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked" />
          </label>
        )}
        {msg && (
          <p role="alert" className="note-error">
            {msg}
          </p>
        )}
        <DialogFooter>
          {can("clients:write") && (
            <Button variant="line" onClick={() => request.mutate()} disabled={request.isPending}>
              <Send /> Ask the client
            </Button>
          )}
          <Button variant="primary" disabled={!canSign || sign.isPending} title={canSign ? undefined : "Not your step"} onClick={() => stage && sign.mutate(stage)}>
            {stage === "senior" ? "Approve" : "Sign off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
