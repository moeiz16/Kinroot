// Dossier tabs. Each is one table or one short list; detail about a party lives in the drawer.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Lock, RefreshCcw, Upload } from "lucide-react";
import { useRef, useState } from "react";
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
import type { AuditEntry, Case, Client, DocType, DocumentRec, Edd, PinnedAnswer, RiskAssessment, ScreeningHit } from "../../api/types";
import { dueIn, fmtDate, fmtDateTime, relativeDays } from "../../lib/dates";
import { bytes, likelihood, ratingLook } from "../../lib/format";
import { Section } from "../../shell/page";
import { hasId } from "./PartyDrawer";
import { useAuth } from "../../lib/auth";
import { RatingTag, Status } from "../../shell/chart";
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
  /** open the party drawer (and trace them) */
  onOpen?: (partyId: string) => void;
}

export function Cite({ id, label, onCite }: { id: string; label: string | undefined; onCite: (id: string) => void }) {
  if (!label) return null;
  return (
    <button className="cite" onClick={() => onCite(id)} aria-label={`Show link ${label} on the board`} title="Show on the chart">
      {label}
    </button>
  );
}

export function SummaryPanel(p: PanelProps) {
  const { client, structure, risk, docs, edd } = p;
  const ubo = structure?.ubo;
  const look = ratingLook(client.rating);
  const owners = ubo?.owners.filter((o) => o.isUbo) ?? [];
  const unexplained = ubo?.unexplainedPct ?? 0;
  const unknownOwnerNode = structure?.nodes.find((n) => n.kind === "unknown");
  const unknownParent = unknownOwnerNode ? structure?.edges.find((e) => e.s === unknownOwnerNode.id)?.t : undefined;
  const dd = edd?.required ? (edd.status === "approved" ? "Enhanced · complete" : "Enhanced · open") : client.status === "onboarding" ? "Onboarding" : "Standard";
  const open = (id: string) => (p.onOpen ? p.onOpen(id) : p.onThread(id));
  return (
    <div className="summary-grid">
      <div>
        <Section title="Beneficial owners">
          <div className="card">
            <Table>
              <TableBody>
                {owners.map((o) => (
                  <tr key={o.partyId} className="rowlink" onClick={() => open(o.partyId)}>
                    <td className="who">
                      <button className="rowbtn" onClick={(e) => (e.stopPropagation(), open(o.partyId))} aria-label={`${o.name}: show on the chart`}>
                        <b>{o.name}</b>
                      </button>
                      <small>{o.via === "control" || o.effectivePct == null ? "Control" : "Ownership"}</small>
                    </td>
                    <td className="num">{o.effectivePct ? `${o.effectivePct}%` : "—"}</td>
                    <td className="st num">{hasId(docs, o.partyId) ? <Status tone="clear">ID verified</Status> : <Status tone="review">Ask client</Status>}</td>
                  </tr>
                ))}
                {unexplained > 0 && (
                  <tr>
                    <td className="who">
                      <b className="muted">Not yet known</b>
                      <small>Owners of {unknownParent ? structure!.names(unknownParent) : "part of the structure"}</small>
                    </td>
                    <td className="num">≤ {unexplained}%</td>
                    <td className="st num">
                      <Status tone="review">Ask client</Status>
                    </td>
                  </tr>
                )}
                {!owners.length && !unexplained && (
                  <tr>
                    <td className="muted" colSpan={3}>
                      {client.kind === "individual" ? "The client is the beneficial owner." : "No one reaches the threshold."}
                    </td>
                  </tr>
                )}
              </TableBody>
            </Table>
          </div>
        </Section>
        {risk && (
          <Section title={`Why ${look.word.toLowerCase()}`} aside={`${risk.score} / 100`}>
            <ReasonList risk={risk} structure={structure} onCite={p.onCite} limit={3} />
          </Section>
        )}
      </div>
      <Section title="File">
        <dl className="facts card card-pad">
          <dt>Due diligence</dt>
          <dd>{dd}</dd>
          <dt>Next review</dt>
          <dd>{client.nextReviewOn ? dueIn(client.nextReviewOn).replace(/^./, (x) => x.toUpperCase()) : "—"}</dd>
          <dt>Fee earner</dt>
          <dd>{client.assignedTo?.fullName ?? "Unassigned"}</dd>
          <dt>Onboarded</dt>
          <dd>{client.onboardedOn ? fmtDate(client.onboardedOn) : "In progress"}</dd>
          {client.matterReference && (
            <>
              <dt>Matter</dt>
              <dd className="mono">{client.matterReference}</dd>
            </>
          )}
        </dl>
      </Section>
    </div>
  );
}

export function MethodLine({ risk }: { risk: RiskAssessment }) {
  const ch = risk.challenger;
  return (
    <p className="note method">
      {risk.override ? `Set by ${risk.override.byName}` : `Firm rules ${risk.methodologyVersion.replace("KR-RM-", "v")}`}
      {ch && ` · second opinion ${ch.agreement === "agree" ? "agrees" : `says ${ratingLook(ch.rating).word.toLowerCase()}`}`}
    </p>
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
          <span className={`w${r.points > 0 ? " up" : ""}`} aria-label={`${r.points > 0 ? "plus" : "minus"} ${Math.abs(r.points)} points`}>{r.points > 0 ? `+${r.points}` : `−${Math.abs(r.points)}`}</span>
        </li>
      ))}
    </ol>
  );
}

export function OwnersPanel(p: PanelProps) {
  const { structure, docs, hits } = p;
  if (!structure) return null;
  const owners = new Map((structure.ubo?.owners ?? []).map((o) => [o.partyId, o]));
  const rows = structure.nodes.filter((n) => !n.client).sort((a, b) => a.level - b.level || a.x - b.x);
  const open = (id: string) => (p.onOpen ? p.onOpen(id) : p.onParty(id));
  return (
    <div className="card">
      <Table className="owners-ledger" aria-label="Everyone in the structure">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Party</TableHead>
            <TableHead scope="col" className="hide-sm">
              Connection
            </TableHead>
            <TableHead scope="col" className="num">
              Share
            </TableHead>
            <TableHead scope="col">Checks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((n) => {
            const o = owners.get(n.id);
            const links = structure.edges.filter((e) => e.s === n.id && !e.removed);
            const hit = hits.find((h) => h.partyId === n.id && h.status !== "false_positive");
            return (
              <tr key={n.id} className="rowlink" onClick={() => open(n.id)}>
                <td className="who">
                  <button className="rowbtn" onClick={(e) => (e.stopPropagation(), open(n.id))}>
                    <b>{n.label}</b>
                  </button>
                  {o?.isUbo && <small>Beneficial owner</small>}
                </td>
                <td className="hide-sm">
                  {links.slice(0, 2).map((e) => (
                    <div key={e.id} className="link-line">
                      {e.kind === "own" ? `Owns ${e.label}` : e.kind === "unknown" ? `Holds ${e.label}` : (e.label ?? "")} of {structure.names(e.t)} {e.citation && <Cite id={e.id} label={e.citation} onCite={p.onCite} />}
                    </div>
                  ))}
                </td>
                <td className="num">{o?.effectivePct ? `${o.effectivePct}%` : "—"}</td>
                <td className="st">
                  {hit ? (
                    <Status tone={hit.status === "true_match" ? "high" : "review"}>{hit.status === "pending" ? "Possible match" : hit.status === "true_match" ? "Confirmed match" : "Escalated"}</Status>
                  ) : n.kind === "person" || n.kind === "company" || n.kind === "trust" ? (
                    hasId(docs, n.id) ? (
                      <Status tone="clear">ID verified</Status>
                    ) : (
                      <Status tone="review">Ask client</Status>
                    )
                  ) : (
                    <Status tone="unknown">Not yet known</Status>
                  )}
                </td>
              </tr>
            );
          })}
        </TableBody>
      </Table>
    </div>
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
      setMsg("No new matches.");
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
          <Link to={`/screening/${h.id}`} title={`${likelihood(h.score)} likely the same`}>
            <span className="g" aria-hidden />
            Possible match
          </Link>
        </Badge>
      );
    return <Status tone={h.status === "true_match" ? "high" : "review"}>{h.status === "true_match" ? (list === "pep" ? "Confirmed PEP" : "Confirmed match") : "Escalated"}</Status>;
  };
  return (
    <>
      <div className="tab-bar">
        <span className="note">Last screened {lastScreened ? fmtDate(lastScreened) : "not yet"}</span>
        {msg && (
          <span role="status" className="note">
            {msg}
          </span>
        )}
        <span className="grow" />
        {can("screening:run") && (
          <Button variant="line" size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
            <RefreshCcw /> {run.isPending ? "Screening…" : "Screen again"}
          </Button>
        )}
      </div>
      <div className="card">
        <Table aria-label="Screening">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Party</TableHead>
              <TableHead scope="col">Sanctions</TableHead>
              <TableHead scope="col">PEP</TableHead>
              <TableHead scope="col" className="hide-sm">
                Adverse media
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parties.map((n) => (
              <tr key={n.id}>
                <td className="who">
                  <b>{n.label}</b>
                </td>
                <td>{cell(n.id, "sanctions")}</td>
                <td>{cell(n.id, "pep")}</td>
                <td className="hide-sm">
                  <span className="muted" title="No source connected">
                    Not connected
                  </span>
                </td>
              </tr>
            ))}
          </TableBody>
        </Table>
      </div>
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
      toast("Rating changed.");
      void qc.invalidateQueries({ queryKey: ["risk", client.id] });
      void qc.invalidateQueries({ queryKey: ["client", client.id] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  const measure = useMutation({
    mutationFn: (key: string) => api.clients.eddMeasure(client.id, key, { status: "done", note: "Evidence received and checked." }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["edd", client.id] }),
  });
  if (!risk) return <p className="muted">Not rated yet.</p>;
  return (
    <>
      <div className="tab-bar">
        <span className="score">
          <b>{risk.score}</b> / 100
        </span>
        <RatingTag r={risk.override?.rating ?? risk.rating} />
        <span className="note">{fmtDate(risk.assessedAt.slice(0, 10))}</span>
        <span className="grow" />
        {can("risk:override") && (
          <Dialog open={!!override} onOpenChange={(o) => setOverride(o ? { rating: client.rating ?? "medium", reason: "" } : null)}>
            <DialogTrigger asChild>
              <Button variant="line" size="sm">
                Change rating
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader>
                <DialogTitle>Change the rating</DialogTitle>
                <DialogDescription>The firm’s rating stays on record beside yours.</DialogDescription>
              </DialogHeader>
              {override && (
                <div className="grid gap-3.5">
                  <ToggleGroup type="single" aria-label="New rating" value={override.rating} onValueChange={(v) => v && setOverride({ ...override, rating: v as "low" | "medium" | "high" })} className="justify-start">
                    {(["low", "medium", "high"] as const).map((r) => (
                      <ToggleGroupItem key={r} value={r} className="px-3">
                        {ratingLook(r).word}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <label className="field">
                    <span>Reason</span>
                    <Textarea value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} placeholder="At least 20 characters to lower a rating" />
                  </label>
                  {msg && (
                    <p className="note-error" role="alert">
                      {msg}
                    </p>
                  )}
                </div>
              )}
              <DialogFooter>
                <Button variant="quiet" onClick={() => setOverride(null)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => ov.mutate()} disabled={ov.isPending}>
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
      <Section title="Reasons">
        <ReasonList risk={risk} structure={structure} onCite={p.onCite} />
        <MethodLine risk={risk} />
      </Section>
      {edd?.required && (
        <Section title="Enhanced checks" aside={edd.triggers[0] ? edd.triggers[0].message : undefined}>
          <div className="card">
            <Table>
              <TableBody>
                {edd.measures.map((m) => (
                  <tr key={m.key}>
                    <td className="who">
                      <b>{m.label}</b>
                      {m.completedBy && <small>{m.completedBy}</small>}
                    </td>
                    <td className="st num">
                      {m.status === "done" ? (
                        <Status tone="clear">Done</Status>
                      ) : m.key !== "senior_approval" && can("edd:manage") ? (
                        <Button size="sm" variant="line" onClick={() => measure.mutate(m.key)}>
                          Mark received
                        </Button>
                      ) : (
                        <Status tone="review">Waiting</Status>
                      )}
                    </td>
                  </tr>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}
      <SecondOpinionBox client={client} risk={risk} />
      <HoldBox client={client} />
      {history.data && history.data.length > 1 && (
        <Section title="Earlier ratings">
          <div className="card">
            <Table>
              <TableBody>
                {history.data.slice(1).map((h) => (
                  <tr key={h.id}>
                    <td style={{ width: 140 }}>{fmtDate(h.assessedAt.slice(0, 10))}</td>
                    <td>
                      <RatingTag r={h.override?.rating ?? h.rating} small />
                    </td>
                    <td className="num">{h.score} / 100</td>
                  </tr>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
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
      <div className="card">
        <ul className="doc-list">
          {docs.map((d) => (
            <li key={d.id}>
              <FileText aria-hidden />
              <div>
                <b>{DOC_LABEL[d.docType]}</b>
                <small>
                  {structure?.names(d.partyId) ?? ""} · {fmtDate(d.uploadedAt.slice(0, 10))}
                </small>
              </div>
              <span className="muted hide-sm" title={`${d.fileName} · ${bytes(d.sizeBytes)} · ${d.uploadedBy}`}>
                {bytes(d.sizeBytes)}
              </span>
              <Status tone="clear">Verified</Status>
            </li>
          ))}
          {!docs.length && <li className="empty">No documents yet</li>}
        </ul>
      </div>
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
            Drop a file or{" "}
            <Button variant="link" onClick={() => inputRef.current?.click()}>
              choose one
            </Button>
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
      <ol className="timeline">
        {events.slice(0, 60).map((e, i) => (
          <li key={i}>
            <time>{e.date.length > 10 ? fmtDateTime(e.date) : fmtDate(e.date)}</time>
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
    <div className="card card-pad restricted-panel">
      <div className="flex items-center gap-2">
        <Lock size={16} aria-hidden />
        <b>{caseRec.title.split(" · ")[0]}</b>
      </div>
      <p className="note">
        Report due {fmtDate(caseRec.deadlineOn)} ({relativeDays(caseRec.deadlineOn)}) · visible to {caseRec.access?.map((a) => a.fullName).join(" and ") ?? "the compliance officer"}
      </p>
      <Button asChild variant="line" size="sm" className="mt-3 w-fit">
        <Link to={`/reports/${caseRec.id}`}>Open the case</Link>
      </Button>
    </div>
  );
}
