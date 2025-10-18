// Dossier folder contents. Every panel is a ledger or a reasoned list; numbers are mono, reasons are serif.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Lock, RefreshCcw, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorMessage } from "../../api/client";
import { api } from "../../api/endpoints";
import type { AuditEntry, BeneficialOwner, Case, Client, DocType, DocumentRec, Edd, PinnedAnswer, RiskAssessment, ScreeningHit } from "../../api/types";
import { fmtDate, fmtDateTime, relativeDays } from "../../lib/dates";
import { bytes, likelihood, ratingLook } from "../../lib/format";
import { useAuth } from "../../lib/auth";
import { RatingTag, Status } from "../../shell/chrome";
import { HoldBox, SecondOpinionBox } from "./HoldBox";
import type { Structure } from "./structure";

export interface PanelProps {
  client: Client;
  structure: Structure | null;
  risk: RiskAssessment | null | undefined;
  edd: Edd | undefined;
  docs: DocumentRec[];
  hits: ScreeningHit[];
  onCite: (edgeId: string) => void;
  onParty: (partyId: string) => void;
  onThread: (partyId: string) => void;
}

export function Cite({ id, label, onCite }: { id: string; label: string | undefined; onCite: (id: string) => void }) {
  if (!label) return null;
  return (
    <button className="cite" onClick={() => onCite(id)} aria-label={`Show link ${label} on the board`}>
      {label}
    </button>
  );
}

function hasId(docs: DocumentRec[], partyId: string) {
  return docs.some((d) => d.partyId === partyId && ["passport", "drivers_licence", "birth_certificate", "company_extract", "trust_deed"].includes(d.docType));
}

function pathText(o: BeneficialOwner, names: (id: string) => string): ReactNode {
  const p = o.paths.find((x) => x.effectivePct != null) ?? o.paths[0];
  if (!p) return null;
  const via = p.nodeIds.slice(1, -1).map(names);
  if (o.via === "control" || p.effectivePct == null) return `Controls as ${o.controlRoles.join(" and ").toLowerCase()}${via.length ? ` of ${via[0]}` : ""}`;
  if (!via.length) return "Owns directly";
  return (
    <>
      Owns through{" "}
      {via.map((v, i) => (
        <span key={i}>
          {i > 0 && <span className="arr" aria-hidden> → </span>}
          {i > 0 && <span className="sr-only"> then </span>}
          {v}
        </span>
      ))}
    </>
  );
}

export function SummaryPanel(p: PanelProps) {
  const { client, structure, risk, docs } = p;
  const ubo = structure?.ubo;
  const look = ratingLook(client.rating);
  const owners = ubo?.owners.filter((o) => o.isUbo) ?? [];
  const unexplained = ubo?.unexplainedPct ?? 0;
  const unknownOwnerNode = structure?.nodes.find((n) => n.kind === "unknown");
  const unknownParent = unknownOwnerNode ? structure?.edges.find((e) => e.s === unknownOwnerNode.id)?.t : undefined;
  return (
    <div className="paras">
      <section className="para">
        <h2>
          Beneficial owners <span className="aside">{ubo?.thresholdPct ?? 25}% or more, or control</span>
        </h2>
        <Table>
          <TableBody>
            {owners.map((o, i) => (
              <tr key={o.partyId} className="rowlink" onClick={() => p.onThread(o.partyId)}>
                <td className="mark">{i === 0 && (o.effectivePct ?? 0) > 0 && <i aria-hidden />}</td>
                <td className="who">
                  <button className="rowbtn" onClick={() => p.onThread(o.partyId)} aria-label={`${o.name}: pull the thread on the board`}>
                    <b>{o.name}</b>
                  </button>
                  <small>{pathText(o, structure!.names)}</small>
                </td>
                <td className="num">{o.effectivePct ? `${o.effectivePct}%` : "—"}</td>
                <td className="st">{hasId(docs, o.partyId) ? <Status tone="clear">ID verified</Status> : <Status tone="review">Ask client</Status>}</td>
              </tr>
            ))}
            {unexplained > 0 && (
              <tr>
                <td className="mark" />
                <td className="who">
                  <b style={{ fontStyle: "italic", fontWeight: 500 }}>Not yet known</b>
                  <small>Owners of {unknownParent ? structure!.names(unknownParent) : "part of the structure"}</small>
                </td>
                <td className="num">≤ {unexplained}%</td>
                <td className="st">
                  <Status tone="review">Ask client</Status>
                </td>
              </tr>
            )}
            {!owners.length && !unexplained && (
              <tr>
                <td className="mark" />
                <td className="who" colSpan={3}>
                  <small>{client.kind === "individual" ? "The client is the beneficial owner." : "No one reaches the threshold. Record the senior managing officials instead."}</small>
                </td>
              </tr>
            )}
          </TableBody>
        </Table>
      </section>

      {risk && (
        <section className="para">
          <h2>
            Why this client is rated {look.word} <span className="aside mono">{risk.score} / 100</span>
          </h2>
          <ReasonList risk={risk} structure={structure} onCite={p.onCite} limit={4} />
          <MethodLine risk={risk} />
        </section>
      )}
    </div>
  );
}

export function MethodLine({ risk }: { risk: RiskAssessment }) {
  const ch = risk.challenger;
  return (
    <div className="method">
      <span>
        Risk method <b>{risk.methodologyVersion.replace("KR-RM-", "v")}</b>
        {risk.override ? `, rating set by ${risk.override.byName}` : ", rated by the firm's rules"}
      </span>
      {ch && (
        <span>
          Second opinion: <b>{ratingLook(ch.rating).word}</b> ({ch.agreement === "agree" ? "agrees" : "disagrees, sent to review"})
        </span>
      )}
    </div>
  );
}

export function ReasonList({ risk, structure, onCite, limit }: { risk: RiskAssessment; structure: Structure | null; onCite: (id: string) => void; limit?: number }) {
  const reasons = limit ? risk.reasons.slice(0, limit) : risk.reasons;
  return (
    <ol className="reasons">
      {reasons.map((r) => (
        <li key={r.code + r.message}>
          <span>
            {r.message}{" "}
            {r.evidence
              .filter((e) => e.type === "edge")
              .map((e) => (
                <Cite key={e.id} id={e.id} label={structure?.cites.get(e.id)} onCite={onCite} />
              ))}
          </span>
          <span className={`w${r.points > 0 ? " up" : ""}`}>{r.points > 0 ? `+${r.points}` : `−${Math.abs(r.points)}`}</span>
        </li>
      ))}
    </ol>
  );
}

export function OwnersPanel(p: PanelProps) {
  const { structure, docs, hits } = p;
  if (!structure) return <p className="muted">Loading the structure…</p>;
  const owners = new Map((structure.ubo?.owners ?? []).map((o) => [o.partyId, o]));
  const rows = structure.nodes.filter((n) => !n.client).sort((a, b) => a.level - b.level || a.x - b.x);
  return (
    <>
      <h2 className="title" style={{ fontSize: 23 }}>
        Everyone in the structure
      </h2>
      <p className="lede" style={{ fontSize: 15 }}>
        The same structure as the board, as a register. Each link shows where it came from.
      </p>
      <Table className="owners-ledger" style={{ marginTop: 18 }}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Party</TableHead>
            <TableHead scope="col">How they connect</TableHead>
            <TableHead scope="col" className="num">
              Share
            </TableHead>
            <TableHead scope="col">Checks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((n) => {
            const o = owners.get(n.id);
            const links = structure.edges.filter((e) => e.s === n.id);
            const hit = hits.find((h) => h.partyId === n.id);
            return (
              <tr key={n.id} className="rowlink">
                <td className="who">
                  <button className="rowbtn" onClick={() => p.onParty(n.id)}>
                    <b style={o?.isUbo ? { color: "var(--string)" } : undefined}>{n.label}</b>
                  </button>
                  <small>{n.kind === "unknown" ? "Not yet known" : n.kind === "stack" ? n.sub : n.sub}</small>
                </td>
                <td>
                  {links.map((e) => (
                    <div key={e.id} className="link-line">
                      {e.removed ? "Was " : ""}
                      {e.kind === "own" ? `owns ${e.label}` : e.kind === "unknown" ? `holds ${e.label}` : (e.label ?? "").toLowerCase()} of {structure.names(e.t)}{" "}
                      {e.citation && (
                        <span className="src mono">
                          <Cite id={e.id} label={e.citation} onCite={p.onCite} /> · {e.source ?? "register"}
                          {e.validFrom ? ` ${fmtDate(e.validFrom, { year: true })}` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </td>
                <td className="num">{o?.effectivePct ? `${o.effectivePct}%` : "—"}</td>
                <td className="st">
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                    {o?.isUbo && <Status tone="high" glyph="●">Beneficial owner</Status>}
                    {n.kind === "person" || n.kind === "company" || n.kind === "trust" ? hasId(docs, n.id) ? <Status tone="clear">ID verified</Status> : <Status tone="review">Ask client</Status> : <Status tone="unknown">Not yet known</Status>}
                    {n.pep && <Status tone="review">PEP</Status>}
                    {hit && <Status tone={hit.status === "true_match" ? "high" : hit.status === "pending" ? "review" : "clear"}>{hit.status === "pending" ? "Possible match" : hit.status === "true_match" ? "Confirmed match" : "Not a match"}</Status>}
                  </div>
                </td>
              </tr>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

export function ScreeningPanel(p: PanelProps) {
  const { structure, hits, client, risk } = p;
  const { can } = useAuth();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api.clients.screen(client.id),
    onSuccess: () => {
      setMsg("Screening finished. No new matches.");
      void qc.invalidateQueries({ queryKey: ["hits"] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  const parties = (structure?.nodes ?? []).filter((n) => ["person", "company", "trust", "partnership"].includes(n.kind));
  const lastScreened = risk?.assessedAt.slice(0, 10);
  const cell = (partyId: string, list: "sanctions" | "pep") => {
    const h = hits.find((x) => x.partyId === partyId && x.entry.listKind === list && x.status !== "false_positive");
    if (!h) return <Status tone="clear">No match</Status>;
    if (h.status === "pending")
      return (
        <Badge asChild tone="high">
          <Link to={`/screening/${h.id}`}>
            <span className="g">▲</span>Possible match · {likelihood(h.score)}
          </Link>
        </Badge>
      );
    return <Status tone={h.status === "true_match" ? "high" : "review"}>{h.status === "true_match" ? (list === "pep" ? "Confirmed PEP" : "Confirmed match") : "Escalated"}</Status>;
  };
  return (
    <>
      <h2 className="title" style={{ fontSize: 23 }}>
        Screening
      </h2>
      <div className="meta">
        Last screened {lastScreened ? fmtDate(lastScreened) : "not yet"} · re-screened automatically on every list update
      </div>
      <Table style={{ marginTop: 18 }}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Party</TableHead>
            <TableHead scope="col">Sanctions lists</TableHead>
            <TableHead scope="col">PEP lists</TableHead>
            <TableHead scope="col">Adverse media</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {parties.map((n) => (
            <tr key={n.id}>
              <td className="who">
                <b>{n.label}</b>
                <small>{n.client ? "Client" : n.kind === "person" ? "Person" : "Entity"}</small>
              </td>
              <td>{cell(n.id, "sanctions")}</td>
              <td>{cell(n.id, "pep")}</td>
              <td>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  Not checked yet: no source connected
                </span>
              </td>
            </tr>
          ))}
        </TableBody>
      </Table>
      {can("screening:run") && (
        <div style={{ marginTop: 18, display: "flex", gap: 12, alignItems: "center" }}>
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            <RefreshCcw /> {run.isPending ? "Screening…" : "Screen again now"}
          </Button>
          {msg && <span role="status">{msg}</span>}
        </div>
      )}
    </>
  );
}

export function RiskPanel(p: PanelProps) {
  const { risk, client, edd, structure } = p;
  const { can } = useAuth();
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ["risk-history", client.id], queryFn: () => api.clients.riskHistory(client.id) });
  const [override, setOverride] = useState<{ rating: "low" | "medium" | "high"; reason: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const ov = useMutation({
    mutationFn: () => api.clients.override(client.id, override!.rating, override!.reason),
    onSuccess: () => {
      setOverride(null);
      setMsg(null);
      toast("Rating changed. Your reason is in the activity log.");
      void qc.invalidateQueries({ queryKey: ["risk", client.id] });
      void qc.invalidateQueries({ queryKey: ["client", client.id] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  const measure = useMutation({
    mutationFn: (key: string) => api.clients.eddMeasure(client.id, key, { status: "done", note: "Evidence received and checked." }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["edd", client.id] }),
  });
  if (!risk) return <p className="muted">This client has not been rated yet. Finish onboarding to see the first rating.</p>;
  return (
    <>
      <h2 className="title" style={{ fontSize: 25 }}>
        Rated {ratingLook(risk.override?.rating ?? risk.rating).word}, {risk.score} out of 100
      </h2>
      <div className="meta">
        Assessed {fmtDate(risk.assessedAt.slice(0, 10))} · thresholds Clear &lt; 30 ≤ Review &lt; 60 ≤ High
      </div>
      <section className="section">
        <h2>Every reason, with points</h2>
        <ReasonList risk={risk} structure={structure} onCite={p.onCite} />
        <MethodLine risk={risk} />
        {risk.challenger?.agreement === "disagree" && (
          <p className="note-info" style={{ marginTop: 12 }}>
            The second opinion rates this client {ratingLook(risk.challenger.rating).word}. The firm’s rules stay the decision of record; the compliance officer reviews the difference.
          </p>
        )}
      </section>
      {edd?.required && (
        <section className="section">
          <h2>Enhanced checks</h2>
          {edd.triggers.map((t) => (
            <p key={t.code} style={{ margin: "0 0 10px", fontFamily: "var(--f-serif)", fontSize: 15.5 }}>
              Triggered because {t.message.charAt(0).toLowerCase() + t.message.slice(1)}
            </p>
          ))}
          <Table>
            <TableBody>
              {edd.measures.map((m) => (
                <tr key={m.key}>
                  <td className="who">
                    <b>{m.label}</b>
                    {m.completedBy && <small>Done by {m.completedBy} {m.completedAt ? `on ${fmtDate(m.completedAt.slice(0, 10))}` : ""}</small>}
                  </td>
                  <td className="st" style={{ textAlign: "right" }}>
                    {m.status === "done" ? (
                      <Status tone="clear">Done</Status>
                    ) : m.key !== "senior_approval" && can("edd:manage") ? (
                      <Button size="sm" onClick={() => measure.mutate(m.key)}>
                        Mark as received
                      </Button>
                    ) : (
                      <Status tone="review">Waiting</Status>
                    )}
                  </td>
                </tr>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      <SecondOpinionBox client={client} risk={risk} />
      <HoldBox client={client} />
      {can("risk:override") && (
        <section className="section">
          <h2>Change the rating</h2>
          <Dialog open={!!override} onOpenChange={(o) => setOverride(o ? { rating: client.rating ?? "medium", reason: "" } : null)}>
            <DialogTrigger asChild>
              <Button>Set the rating by hand</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[520px]">
              <DialogHeader>
                <DialogTitle>Set the rating for {client.name}</DialogTitle>
                <DialogDescription>The firm’s rules stay on record beside your rating. Lowering a rating needs a reason of at least 20 characters.</DialogDescription>
              </DialogHeader>
              {override && (
                <div className="grid gap-3.5">
                  <ToggleGroup type="single" aria-label="New rating" value={override.rating} onValueChange={(v) => v && setOverride({ ...override, rating: v as "low" | "medium" | "high" })} className="justify-start">
                    {(["low", "medium", "high"] as const).map((r) => (
                      <ToggleGroupItem key={r} value={r} className="px-3">
                        {ratingLook(r).glyph} {ratingLook(r).word}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <label className="field">
                    <span>Reason</span>
                    <Textarea value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
                  </label>
                  {msg && <p className="note-error" role="alert">{msg}</p>}
                </div>
              )}
              <DialogFooter>
                <Button variant="quiet" onClick={() => setOverride(null)}>
                  Cancel
                </Button>
                <Button variant="string" onClick={() => ov.mutate()} disabled={ov.isPending}>
                  Save the rating
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      )}
      {history.data && history.data.length > 1 && (
        <section className="section">
          <h2>Earlier ratings</h2>
          <Table>
            <TableBody>
              {history.data.slice(1).map((h) => (
                <tr key={h.id}>
                  <td className="mono" style={{ width: 120 }}>{fmtDate(h.assessedAt.slice(0, 10))}</td>
                  <td>
                    <RatingTag r={h.override?.rating ?? h.rating} small />
                  </td>
                  <td className="num">{h.score} / 100</td>
                </tr>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </>
  );
}

const DOC_LABEL: Record<DocType, string> = { passport: "Passport", drivers_licence: "Driver licence", birth_certificate: "Birth certificate", trust_deed: "Trust deed", company_extract: "Company extract", other: "Document" };

export function DocumentsPanel(p: PanelProps) {
  const { client, docs, structure } = p;
  const { can } = useAuth();
  const qc = useQueryClient();
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (f: File) => api.clients.upload(client.id, f, client.partyId, "other"),
    onSuccess: (d) => {
      setMsg(null);
      toast(`${d.fileName} added.`);
      void qc.invalidateQueries({ queryKey: ["documents", client.id] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  const take = (files: FileList | null) => {
    const f = files?.[0];
    if (f) upload.mutate(f);
  };
  return (
    <>
      <h2 className="title" style={{ fontSize: 23 }}>
        Documents
      </h2>
      <div className="meta">Kept until 7 years after the relationship ends</div>
      <ul className="doc-list">
        {docs.map((d) => (
          <li key={d.id}>
            <FileText aria-hidden />
            <div>
              <b>{DOC_LABEL[d.docType]}</b> <span className="muted">· {structure?.names(d.partyId) ?? ""}</span>
              <small>
                {d.fileName} · {bytes(d.sizeBytes)} · added by {d.uploadedBy} on {fmtDate(d.uploadedAt.slice(0, 10))}
              </small>
            </div>
            <Status tone="clear">Verified</Status>
          </li>
        ))}
        {!docs.length && <li className="muted">No documents yet.</li>}
      </ul>
      {can("identity:verify") && (
        <div
          className={`dropzone${over ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer.files);
          }}
        >
          <Upload aria-hidden />
          <span>
            Drop an identity document or register extract here, or{" "}
            <Button variant="link" onClick={() => inputRef.current?.click()}>
              choose a file
            </Button>
            . PDF, PNG or JPG up to 10 MB.
          </span>
          <input ref={inputRef} type="file" accept=".pdf,.png,.jpg,.jpeg" hidden onChange={(e) => take(e.target.files)} />
        </div>
      )}
      {msg && <p role="status">{msg}</p>}
    </>
  );
}

interface TimelineEvent {
  date: string;
  text: string;
  who?: string;
  edgeId?: string;
  note?: string;
  cites?: string[];
}
export function TimelinePanel(p: PanelProps & { audit: AuditEntry[]; pins?: PinnedAnswer[] }) {
  const { structure, client, hits, audit, pins = [] } = p;
  const events: TimelineEvent[] = [];
  for (const a of pins) events.push({ date: a.pinnedAt, text: `Answer pinned: “${a.question}”`, who: a.pinnedByName, note: a.answer.replace(/\s*\[\d+\]/g, ""), cites: a.citations.map((c) => c.id) });
  for (const e of structure?.edges ?? []) {
    if (!e.validFrom || e.kind === "unknown") continue;
    const verb = e.kind === "own" ? `took ${e.label} of` : `became ${(e.label ?? "").toLowerCase()} of`;
    events.push({ date: e.validFrom, text: `${structure!.names(e.s)} ${verb} ${structure!.names(e.t)}`, edgeId: e.id });
  }
  for (const h of hits) events.push({ date: h.createdAt.slice(0, 10), text: `Screening found a possible ${h.entry.listKind === "pep" ? "PEP" : "sanctions"} match for ${h.partyName}${h.status !== "pending" ? `; reviewed as ${h.status.replace("_", " ")}` : ""}` });
  for (const a of audit) events.push({ date: a.createdAt, text: a.label, who: a.actorName });
  if (client.onboardedOn) events.push({ date: client.onboardedOn, text: `${client.name} onboarded` });
  events.sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <h2 className="title" style={{ fontSize: 23 }}>
        Timeline
      </h2>
      <p className="lede" style={{ fontSize: 15 }}>
        The same structure told as dated events, newest first.
      </p>
      <ol className="timeline">
        {events.slice(0, 60).map((e, i) => (
          <li key={i}>
            <time className="mono">{e.date.length > 10 ? fmtDateTime(e.date) : fmtDate(e.date)}</time>
            <span>
              {e.text}
              {e.edgeId && structure?.cites.get(e.edgeId) && (
                <>
                  {" "}
                  <Cite id={e.edgeId} label={structure.cites.get(e.edgeId)} onCite={p.onCite} />
                </>
              )}
              {e.who && <small> · {e.who}</small>}
              {e.note && <span className="pin-note">{e.note}</span>}
              {e.cites && structure && e.cites.some((id) => structure.cites.get(id)) && (
                <span className="pin-cites">
                  {e.cites
                    .filter((id) => structure.cites.get(id))
                    .map((id) => (
                      <Cite key={id} id={id} label={structure.cites.get(id)} onCite={p.onCite} />
                    ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

export function RestrictedPanel({ caseRec }: { caseRec: Case }) {
  return (
    <div className="restricted-panel">
      <div className="restricted-band">
        <Lock size={14} aria-hidden /> Restricted. Do not discuss this with the client or anyone outside this list.
      </div>
      <div className="eyebrow">Case · visible to {caseRec.access?.map((a) => a.fullName).join(" and ") ?? "the compliance officer"}</div>
      <h2 className="title" style={{ fontSize: 23 }}>
        {caseRec.title.split(" · ")[0]}
      </h2>
      <p className="meta">
        Opened {fmtDate(caseRec.openedAt.slice(0, 10))} by {caseRec.openedBy} · report due {fmtDate(caseRec.deadlineOn)} ({relativeDays(caseRec.deadlineOn)})
      </p>
      <p className="lede" style={{ fontSize: 15 }}>
        Work on this file continues as normal. Steps that could alert the client wait for the compliance officer’s go-ahead.
      </p>
      <Button asChild variant="ink" style={{ marginTop: 16 }}>
        <Link to={`/reports/${caseRec.id}`}>
          <Lock /> Open the case file
        </Link>
      </Button>
    </div>
  );
}
