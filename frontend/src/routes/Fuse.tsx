// Fuse or split: possible duplicate people and companies. The folio is the match file (caption with the queue
// position, the likelihood scale, field-by-field evidence, the decision at the foot); the exhibit shows both records
// stitched by a seam. Drag one record onto the other to fuse. Below 40 kept apart, 97+ fused automatically.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitFork, Merge, Move, Split } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { GraphPayload, MatchCandidate, MatchReason, PartyRecord } from "../api/types";
import { applyPositions, layered } from "../graph/layout";
import type { BEdge, BNode, Scene } from "../graph/model";
import { fromPayload } from "../graph/transforms";
import { fmtDate } from "../lib/dates";
import { addressText, likelihood } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardScene } from "../shell/board";
import { AsAt, BoardTools, FindTrigger, Status } from "../shell/chrome";
import { Caption, Decision, Folio, FolioTabs, QueuePager } from "../shell/Folio";
import { NotAvailable } from "./NotFound";

function mergePayloads(ps: GraphPayload[]): GraphPayload {
  const nodes = new Map<string, GraphPayload["nodes"][number]>();
  const edges = new Map<string, GraphPayload["edges"][number]>();
  ps.forEach((p) => {
    p.nodes.forEach((n) => nodes.set(n.key, n));
    p.edges.forEach((e) => edges.set(e.key, e));
  });
  return { attributes: { ...ps[0]!.attributes, focusId: null }, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Both records side by side, what each one is linked to above, and anything linked to both below. */
export function fuseScene(c: MatchCandidate, a: GraphPayload, b: GraphPayload, clientNames: Map<string, string>): Scene {
  const merged = mergePayloads([a, b]);
  const model = fromPayload(merged);
  const A = c.left.id;
  const B = c.right.id;
  const linked = (id: string, x: string) => model.edges.some((e) => (e.s === id && e.t === x) || (e.t === id && e.s === x));
  const levelOf = (n: BNode): number => {
    if (n.id === A || n.id === B) return 2;
    const both = linked(n.id, A) && linked(n.id, B);
    if (both) return 3;
    const isTarget = model.edges.some((e) => (e.s === A || e.s === B) && e.t === n.id);
    if (isTarget) return 1;
    const isOwner = model.edges.some((e) => (e.t === A || e.t === B) && e.s === n.id);
    if (isOwner) return 3;
    return 0;
  };
  const nodes = model.nodes.map((n) => ({ ...n, level: levelOf(n), client: !!n.clientId, sub: n.clientId ? "Client" : n.sub }));
  const pos = layered(nodes, model.edges, { rankSep: 170, nodeSep: 230 });
  let out = applyPositions(nodes, pos);
  const pa = out.find((n) => n.id === A)!;
  const pb = out.find((n) => n.id === B)!;
  const mid = (pa.x + pb.x) / 2;
  const gap = 150;
  out = out.map((n) => {
    if (n.id === A) return { ...n, x: mid - gap, cand: true, leftLabel: true, rec: `Record A · ${c.left.source === "manual" ? "entered by hand" : `from ${clientNames.get(c.clientIds[1] ?? c.clientIds[0] ?? "") ?? "the register"}`}`, sub: c.left.birthDate ? `Born ${fmtDate(c.left.birthDate)}` : n.sub };
    if (n.id === B) return { ...n, x: mid + gap, cand: true, rec: `Record B · ${c.right.source === "manual" ? "new this week" : "from the register"}`, sub: c.right.birthDate ? `Born ${fmtDate(c.right.birthDate)}` : n.sub };
    if (linked(n.id, A) && linked(n.id, B)) return { ...n, sub: `${n.sub ? n.sub + " · " : ""}linked to both`, x: mid };
    return n;
  });
  const edges: BEdge[] = model.edges.filter((e) => out.some((n) => n.id === e.s) && out.some((n) => n.id === e.t));
  return { key: `fuse-${c.id}`, nodes: out, edges };
}

const FIELD_FOR: [RegExp, string][] = [
  [/^dob/, "Birth date"],
  [/^address|postcode/, "Address"],
  [/^name/, "Name"],
  [/^id_/, "ID document"],
  [/^nationality/, "Nationality"],
  [/shared_company|linked/, "Linked to"],
  [/middle/, "Middle name"],
];
function fieldValue(r: PartyRecord, field: string): string | null {
  switch (field) {
    case "Birth date":
      return r.birthDate ? fmtDate(r.birthDate) : null;
    case "Address":
      return addressText(r.address);
    case "Name":
      return r.name;
    case "ID document":
      return r.identifiers.passport ? `Passport ${r.identifiers.passport.replace(/^PA/, "")}` : null;
    case "Nationality":
      return r.nationality ?? null;
    case "Middle name":
      return r.name.match(/\s([A-Z])\.\s/)?.[1] ? `${r.name.match(/\s([A-Z])\.\s/)![1]}.` : null;
    default:
      return null;
  }
}
/** Effect of one reason: a verdict glyph and a bar. `scale` is the largest |contribution| in this match file, so the
 * strongest reason fills the half-bar and the others are drawn relative to it (never shown as a number). */
export function effectOf(reason: MatchReason | undefined, scale = 0.5): { glyph: string; word: string; up: number; down: number } {
  if (!reason || reason.contribution === 0 || reason.value === -1 || /no shared|not provided|can.t compare/i.test(reason.label)) return { glyph: "—", word: reason?.label ?? "Can’t compare", up: 0, down: 0 };
  const w = Math.max(3, Math.min(50, Math.round((Math.abs(reason.contribution) / Math.max(scale, 1e-6)) * 50)));
  if (reason.direction === "against") return { glyph: "≠", word: reason.label, up: 0, down: w };
  return { glyph: /sound|similar|almost|short form|written differently|initial|month and year|partial|swapped|nearby|overlap/i.test(reason.label) ? "≈" : "=", word: reason.label, up: w, down: 0 };
}

/** Why a high-likelihood pair still waits for a person (the merge policy in resolution/model.py). */
export function heldBack(features: Record<string, number>): string | null {
  if (features.dob_exact === 0 && features.dob_transposed !== 1) return "the birth dates differ";
  if (features.id_agree === 0) return "the registration numbers differ";
  if ((features.address_token_overlap ?? -1) >= 0 && features.address_token_overlap! < 0.3 && features.postcode_agree === 0) return "the addresses differ";
  return null;
}

export default function Fuse() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const board = useBoard();
  const { can } = useAuth();
  const [tab, setTab] = useState("match");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const allowed = can("resolution:read");
  const list = useQuery({ queryKey: ["candidates", "pending"], queryFn: () => api.resolution.candidates({ pageSize: 50 }), enabled: allowed });
  const past = useQuery({ queryKey: ["candidates", "decided"], queryFn: () => api.resolution.candidates({ status: "all", pageSize: 50 }), enabled: allowed });
  const thresholds = useQuery({ queryKey: ["thresholds"], queryFn: api.resolution.thresholds, enabled: allowed });
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => api.clients.list({ pageSize: 200 }) });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const current = items.find((c) => c.id === id) ?? (id ? past.data?.items.find((c) => c.id === id) : undefined) ?? items[0];
  const idx = current ? items.findIndex((c) => c.id === current.id) : -1;
  const ga = useQuery({ queryKey: ["party-graph", current?.left.id], queryFn: () => api.parties.graph(current!.left.id, undefined, 1), enabled: !!current });
  const gb = useQuery({ queryKey: ["party-graph", current?.right.id], queryFn: () => api.parties.graph(current!.right.id, undefined, 1), enabled: !!current });
  const names = useMemo(() => new Map((clients.data?.items ?? []).map((c) => [c.id, c.name])), [clients.data]);
  const scene = useMemo(() => (current && ga.data && gb.data ? fuseScene(current, ga.data, gb.data, names) : null), [current, ga.data, gb.data, names]);
  useBoardScene(scene, { unfold: false });

  const next = useCallback(() => {
    const n = items[(idx + 1) % Math.max(1, items.length)];
    setNote("");
    setNoteError(false);
    if (n) nav(`/fuse/${n.id}`);
  }, [items, idx, nav]);

  const decide = useMutation({
    mutationFn: (d: "merge" | "not_match") => api.resolution.decide(current!.id, d, note),
    onSuccess: (out) => {
      toast(out.status === "merged" ? `Fused into one record. Both originals are kept, and you can split them again.` : "Kept apart. Your reason is in the activity log.");
      void qc.invalidateQueries({ queryKey: ["candidates"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      next();
    },
    onError: (e) => toast(errorMessage(e)),
  });
  const fuse = useCallback(async () => {
    if (!current || !can("resolution:decide") || current.status !== "pending") return;
    await board.engine()?.playFuse();
    decide.mutate("merge");
  }, [current, can, board, decide]);
  const keepApart = useCallback(() => {
    if (!current || !can("resolution:decide") || current.status !== "pending") return;
    if (note.trim().length < 3) {
      setNoteError(true);
      noteRef.current?.focus();
      return;
    }
    decide.mutate("not_match");
  }, [current, can, note, decide]);

  // The stitched seam with drag-to-fuse, once the scene is on the board.
  useEffect(() => {
    if (!scene || !current) return;
    const t = setTimeout(() => {
      board
        .engine()
        ?.setSeam(current.left.id, current.right.id, `<div class="k"><b>${Math.round(current.score.probability * 100)}</b><small>in 100 likely<br>the same ${current.left.kind === "person" ? "person" : "company"}</small></div>`, current.status === "pending" && can("resolution:decide") ? () => void fuse() : undefined);
    }, 120);
    return () => clearTimeout(t);
  }, [scene, current, board.version > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || document.querySelector("[role=dialog]")) return;
      if (e.key === "f" || e.key === "F") void fuse();
      else if (e.key === "k" || e.key === "K") keepApart();
      else if (e.key === "j" || e.key === "J") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fuse, keepApart, next]);

  const split = useMutation({
    mutationFn: async (c: MatchCandidate) => {
      if (current?.id === c.id) await board.engine()?.playSplit();
      return api.parties.split(c.left.id, [c.right.id], "Split after review");
    },
    onSuccess: () => {
      toast("Split into two records. Both decisions are in the activity log.");
      void qc.invalidateQueries({ queryKey: ["candidates"] });
    },
    onError: (e) => toast(errorMessage(e)),
  });

  const auto = Math.round((thresholds.data?.autoMerge ?? 0.97) * 100);
  const review = Math.round((thresholds.data?.review ?? 0.4) * 100);
  const decided = (past.data?.items ?? []).filter((c) => c.status !== "pending");
  // The strongest reason for a field, with exact-date evidence ahead of partial-date evidence.
  const reasonFor = (field: string) =>
    current?.score.reasons
      .filter((r) => FIELD_FOR.some(([re, f]) => f === field && re.test(r.feature)))
      .sort((a, b) => Number(b.feature === "dob_exact") - Number(a.feature === "dob_exact") || Math.abs(b.contribution) - Math.abs(a.contribution))[0];
  const fields = ["Birth date", "Address", "Name", "Linked to", "ID document", "Middle name"];

  if (!allowed) return <NotAvailable />;
  const kindWord = current?.left.kind === "person" ? "person" : "company";
  const pending = current?.status === "pending";
  return (
    <>
      <Folio label="Match file" width="normal">
        <Caption
          refLine={
            current ? (
              <>
                <span>Possible duplicate</span>
                <span className="sep">·</span>
                <span>Found in {current.clientIds.map((x) => names.get(x)).filter(Boolean).slice(0, 2).join(" and ") || "the client book"}</span>
              </>
            ) : (
              <span>Fuse or split</span>
            )
          }
          title={current ? `${current.left.name} and ${current.right.name}` : "Nothing to decide"}
          stamps={
            current && (
              <>
                <Status tone={pending ? "review" : "neutral"}>{pending ? "You decide" : `Decided: ${current.status.replace("_", " ")}`}</Status>
                <span className="meta">{likelihood(current.score.probability)} likely the same {kindWord}</span>
              </>
            )
          }
          tools={<QueuePager label="Possible duplicates" items={items.map((c) => ({ id: c.id, title: `${c.left.name} · ${c.right.name}`, detail: `${likelihood(c.score.probability)} · ${c.left.kind === "person" ? "person" : "company"}` }))} current={current?.id} onPick={(x) => nav(`/fuse/${x}`)} />}
        />
        <FolioTabs
          label="Match file"
          tabs={[
            { id: "match", label: "Match file" },
            { id: "a", label: "Record A" },
            { id: "b", label: "Record B" },
            { id: "past", label: "Past decisions", count: decided.length },
          ]}
          active={tab}
          onTab={setTab}
        >
          {!current ? (
            <p className="lede">Every possible duplicate has been decided. New ones appear here when a record is added or imported.</p>
          ) : tab === "a" || tab === "b" ? (
            <RecordView r={tab === "a" ? current.left : current.right} label={tab === "a" ? "Record A" : "Record B"} />
          ) : tab === "past" ? (
            <>
              <h2 className="title" style={{ fontSize: 23 }}>
                Past decisions
              </h2>
              <p className="note">Fusing keeps both original records. Split a fused record to unpick it.</p>
              <Table style={{ marginTop: 14 }}>
                <TableBody>
                  {decided.map((c) => (
                    <tr key={c.id}>
                      <td className="who">
                        <b>
                          {c.left.name} · {c.right.name}
                        </b>
                        <small>
                          {c.status === "auto_merged" ? "Fused automatically" : c.status === "merged" ? "Fused" : c.status === "deferred" ? "Deferred" : "Kept apart"} · {c.decidedBy ?? ""} · {likelihood(c.score.probability)}
                        </small>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {(c.status === "merged" || c.status === "auto_merged") && can("resolution:decide") && (
                          <Button size="sm" onClick={() => split.mutate(c)} disabled={split.isPending}>
                            <Split /> Split into two
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : (
            <div className="paras">
              <p className="lede" style={{ marginTop: 0 }}>
                {current.score.probability >= 0.75 ? "Probably the same " : "Possibly the same "}
                {kindWord}. {current.score.reasons.filter((r) => r.direction === "for" && !(r.feature === "dob_partial" && current.score.reasons.some((x) => x.feature === "dob_exact" && x.direction === "for"))).slice(0, 2).map((r, i) => (i === 0 ? r.label : r.label.charAt(0).toLowerCase() + r.label.slice(1))).join(" and ")}.{" "}
                {current.score.reasons.find((r) => r.direction === "against") ? `${current.score.reasons.find((r) => r.direction === "against")!.label}.` : ""}
                {pending && Math.round(current.score.probability * 100) >= auto && heldBack(current.score.features) ? ` Not fused automatically because ${heldBack(current.score.features)}: records that conflict always wait for a person.` : ""}
              </p>
              <section className="para">
                <h2>
                  Match likelihood <span className="aside">Why a person decides</span>
                </h2>
                <div className="scale" style={{ marginTop: 26 }} role="img" aria-label={`Match likelihood ${likelihood(current.score.probability)}. ${review} to ${auto} needs a person to decide.`}>
                  <div className="bar" style={{ gridTemplateColumns: `${review}fr ${auto - review}fr ${100 - auto}fr` }}>
                    <span className="z1">Kept apart</span>
                    <span className="z2">You decide</span>
                    <span className="z3" title="Fused automatically">
                      ✓
                    </span>
                    <i className="marker" style={{ left: `calc(${current.score.probability * 100}% - 1px)` }}>
                      <b>{Math.round(current.score.probability * 100)}</b>
                    </i>
                  </div>
                  <div className="ticks">
                    <span>
                      <span className="mono">0</span> · below {review} kept apart
                    </span>
                    <span>
                      {review}–{auto} you decide
                    </span>
                    <span>
                      {auto}+ fused for you <span className="mono">100</span>
                    </span>
                  </div>
                </div>
              </section>
              <section className="para">
                <h2>
                  What agrees and what does not <span className="aside">Longer bar, stronger evidence</span>
                </h2>
                <Table className="cmp">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">
                        <span className="sr-only">Field</span>
                      </TableHead>
                      <TableHead scope="col">Record A</TableHead>
                      <TableHead scope="col">Record B</TableHead>
                      <TableHead scope="col">Effect</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((f) => {
                      const r = reasonFor(f);
                      const va = f === "Linked to" ? (r ? r.label.replace(/^Both linked to /, "") : null) : fieldValue(current.left, f);
                      const vb = f === "Linked to" ? (r ? r.label.replace(/^Both linked to /, "") : null) : fieldValue(current.right, f);
                      if (!va && !vb && !r) return null;
                      let eff = effectOf(r, Math.max(...current.score.reasons.map((x) => Math.abs(x.contribution)), 0.01));
                      // No scored reason for this field, but both records have a value: say plainly whether they match.
                      if (f === "Birth date" && r && va && va === vb) eff = { ...eff, glyph: "=", word: "Same date of birth" };
                      if (!r && va && vb) eff = va.trim().toLowerCase() === vb.trim().toLowerCase() ? { glyph: "=", word: "The same", up: 0, down: 0 } : { glyph: "≠", word: "Different", up: 0, down: 0 };
                      return (
                        <tr key={f}>
                          <td className="f">{f}</td>
                          <td className={`v${va ? "" : " none"}${f === "Birth date" ? " mono" : ""}`}>{va ?? "Not provided"}</td>
                          <td className={`v${vb ? "" : " none"}${f === "Birth date" ? " mono" : ""}`}>{vb ?? "Not provided"}</td>
                          <td className="eff">
                            <span className="t">
                              <span className="g" aria-hidden>
                                {eff.glyph}
                              </span>
                              {eff.word}
                            </span>
                            <div className="push" aria-hidden>
                              {eff.up > 0 && <i className="up" style={{ width: `${eff.up}%` }} />}
                              {eff.down > 0 && <i className="down" style={{ width: `${eff.down}%` }} />}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </TableBody>
                </Table>
              </section>
            </div>
          )}
        </FolioTabs>
        {current && (
          <Decision label="Decision">
            {pending ? (
              can("resolution:decide") ? (
                <div className="stack">
                  <div className="row">
                    <Button variant="string" onClick={() => void fuse()} disabled={decide.isPending}>
                      <Merge /> Fuse into one {kindWord}
                    </Button>
                    <Button onClick={keepApart} disabled={decide.isPending}>
                      <Split /> Keep apart
                    </Button>
                    <div className="kb" aria-hidden style={{ marginLeft: "auto" }}>
                      <span>
                        <span className="kbd">F</span> fuse
                      </span>
                      <span>
                        <span className="kbd">K</span> keep apart
                      </span>
                      <span>
                        <span className="kbd">J</span> next pair
                      </span>
                    </div>
                  </div>
                  <Input
                    ref={noteRef}
                    aria-label="Reason"
                    aria-invalid={noteError}
                    aria-describedby={noteError ? "reason-err" : "fuse-note"}
                    placeholder="Reason (needed to keep apart)"
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setNoteError(false);
                    }}
                  />
                  {noteError && (
                    <p className="note-error" id="reason-err">
                      Give a reason before keeping them apart.
                    </p>
                  )}
                  <p className="note" id="fuse-note">
                    Fusing keeps both original records. You can split them again later, and both decisions are kept in the activity log.
                  </p>
                </div>
              ) : (
                <p className="note-info">Only the compliance officer decides whether two records are the same.</p>
              )
            ) : (
              <p className="note-info">
                Decided: {current.status.replace("_", " ")} by {current.decidedBy}.
              </p>
            )}
          </Decision>
        )}
      </Folio>
      <AsAt exhibit="Exhibit" title="Both records and what they are linked to" />
      <FindTrigger />
      {pending && (
        <div className="chrome board-hint" style={{ top: 76, left: 16 }}>
          <Move aria-hidden /> Drag one record onto the other to fuse.
        </div>
      )}
      <BoardTools minimap={false} extra={<button aria-label="Split a fused record" onClick={() => setTab("past")}><GitFork /></button>} />
    </>
  );
}

function RecordView({ r, label }: { r: PartyRecord; label: string }) {
  const rows: [string, string | undefined][] = [
    ["Name", r.name],
    ["Kind", r.kind],
    ["Birth date", r.birthDate ? fmtDate(r.birthDate) : undefined],
    ["Nationality", r.nationality],
    ["Jurisdiction", r.jurisdiction],
    ["Address", addressText(r.address) ?? undefined],
    ["Identifiers", Object.entries(r.identifiers).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(", ") || undefined],
    ["Source", r.source === "manual" ? "Entered by hand" : r.source === "seed" ? "Register extract" : r.source],
  ];
  return (
    <>
      <div className="eyebrow">{label} · as first recorded</div>
      <h2 className="title" style={{ fontSize: 25 }}>
        {r.name}
      </h2>
      <Table style={{ marginTop: 16 }}>
        <TableBody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row" style={{ width: 130, paddingTop: 10 }}>
                {k}
              </th>
              <td className={v ? "" : "muted"}>{v ?? "Not provided"}</td>
            </tr>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
