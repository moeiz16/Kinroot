// Duplicates (fuse or split). The list is one queue of possible duplicates. A pair shows Record A beside Record B,
// field by field, with the likelihood and the policy scale between them; the chart shows both records and what
// they are linked to (drag one onto the other to fuse). Below 40 kept apart, 97+ fused automatically; in between a
// person decides in the bar at the foot. Fused records can be split again from Decided.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitMerge, Merge, Split } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
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
import { ChartBand, Status } from "../shell/chart";
import { DecisionBar, Page, PageHeader, QueuePager, Section, SectionTabs, useTitle } from "../shell/page";
import { Compare, type CompareRow } from "./Compare";
import { NotAvailable } from "./NotFound";
import { ReviewsHeader } from "./ReviewTabs";

function mergePayloads(ps: GraphPayload[]): GraphPayload {
  const nodes = new Map<string, GraphPayload["nodes"][number]>();
  const edges = new Map<string, GraphPayload["edges"][number]>();
  ps.forEach((p) => {
    p.nodes.forEach((n) => nodes.set(n.key, n));
    p.edges.forEach((e) => edges.set(e.key, e));
  });
  return { attributes: { ...ps[0]!.attributes, focusId: null }, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Many companies hanging off one record (a nominee's directorships) fold into one "N companies" plate. */
export function collapseLeaves(m: { nodes: BNode[]; edges: BEdge[] }, around: string[], min = 7): { nodes: BNode[]; edges: BEdge[] } {
  let { nodes, edges } = m;
  for (const id of around) {
    const degree = (x: string) => edges.filter((e) => e.s === x || e.t === x).length;
    const leaves = edges.filter((e) => e.s === id && nodes.find((n) => n.id === e.t)?.kind === "company" && degree(e.t) === 1).map((e) => e.t);
    if (leaves.length < min) continue;
    const gone = new Set(leaves);
    const stack: BNode = { id: `stack-${id}`, kind: "stack", label: `${leaves.length} companies`, glyph: String(leaves.length), level: 0, flags: [], aria: `${leaves.length} companies`, x: 0, y: 0 };
    nodes = [...nodes.filter((n) => !gone.has(n.id)), stack];
    edges = [...edges.filter((e) => !gone.has(e.t)), { id: `e-stack-${id}`, s: id, t: stack.id, kind: "ctrl", label: "Director" }];
  }
  return { nodes, edges };
}

/** Both records side by side, what each one is linked to above, and anything linked to both below. */
export function fuseScene(c: MatchCandidate, a: GraphPayload, b: GraphPayload, _clientNames?: Map<string, string>): Scene {
  const merged = mergePayloads([a, b]);
  const model = collapseLeaves(fromPayload(merged), [c.left.id, c.right.id]);
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
  const pa = out.find((n) => n.id === A);
  const pb = out.find((n) => n.id === B);
  // After a merge one record is folded into the other: draw what is there, without the pair layout.
  if (!pa || !pb) return { key: `fuse-${c.id}`, nodes: out, edges: model.edges.filter((e) => out.some((n) => n.id === e.s) && out.some((n) => n.id === e.t)) };
  const mid = (pa.x + pb.x) / 2;
  const gap = 170;
  out = out.map((n) => {
    if (n.id === A) return { ...n, x: mid - gap, cand: true, rec: "Record A", sub: c.left.birthDate ? `Born ${fmtDate(c.left.birthDate)}` : n.sub };
    if (n.id === B) return { ...n, x: mid + gap, cand: true, rec: "Record B", sub: c.right.birthDate ? `Born ${fmtDate(c.right.birthDate)}` : n.sub };
    if (linked(n.id, A) && linked(n.id, B)) return { ...n, x: mid };
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
  const [apart, setApart] = useState(false);
  const [merging, setMerging] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
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
      toast(out.status === "merged" ? "Merged. You can split them again." : "Kept apart.");
      setApart(false);
      setMerging(false);
      void qc.invalidateQueries({ queryKey: ["candidates"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      next();
    },
    onError: (e) => toast(errorMessage(e)),
  });
  const [splitting, setSplitting] = useState<MatchCandidate | null>(null);
  const fuse = useCallback(async () => {
    setMerging(false);
    if (!current || !can("resolution:decide") || current.status !== "pending") return;
    await board.engine()?.playFuse();
    decide.mutate("merge");
  }, [current, can, board, decide]);
  const keepApart = useCallback(() => {
    if (!current || !can("resolution:decide") || current.status !== "pending") return;
    if (!apart) {
      setApart(true);
      return;
    }
    if (note.trim().length < 3) {
      setNoteError(true);
      noteRef.current?.focus();
      return;
    }
    decide.mutate("not_match");
  }, [current, can, note, decide, apart]);

  // The stitched seam with drag-to-fuse, once the scene is on the board.
  useEffect(() => {
    if (!scene || !current || !scene.nodes.some((n) => n.id === current.left.id) || !scene.nodes.some((n) => n.id === current.right.id)) return;
    const t = setTimeout(() => {
      board
        .engine()
        ?.setSeam(current.left.id, current.right.id, "", current.status === "pending" && can("resolution:decide") ? () => setMerging(true) : undefined);
    }, 120);
    return () => clearTimeout(t);
  }, [scene, current, board.version > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || document.querySelector("[role=dialog]")) return;
      if (e.key === "f" || e.key === "F") setMerging(true);
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
      toast("Split into two records.");
      setSplitting(null);
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

  useTitle(id && current ? current.left.name : null);
  if (!allowed) return <NotAvailable />;
  const kindWord = current?.left.kind === "person" ? "person" : "company";
  const pending = current?.status === "pending";
  if (!id)
    return (
      <Page label="Duplicates">
        <ReviewsHeader />
        <ul className="items">
          {items.map((c) => (
            <li key={c.id}>
              <Link to={`/fuse/${c.id}`} className="item">
                <span className="item-ico" aria-hidden>
                  <GitMerge />
                </span>
                <span className="item-main">
                  <span className="item-title">
                    {c.left.name} and {c.right.name}
                  </span>
                  <span className="item-sub">{c.clientIds.map((x) => names.get(x)).filter(Boolean).slice(0, 2).join(" · ") || (c.left.kind === "person" ? "Person" : "Company")}</span>
                </span>
                <span className="item-end">{likelihood(c.score.probability)}</span>
              </Link>
            </li>
          ))}
          {!items.length && <li className="empty">No duplicates to decide</li>}
        </ul>
        {decided.length > 0 && (
          <Section title="Decided">
            <ul className="items">
              {decided.slice(0, 12).map((c) => (
                <li key={c.id}>
                  <Link to={`/fuse/${c.id}`} className="item">
                    <span className="item-main">
                      <span className="item-title">
                        {c.left.name} and {c.right.name}
                      </span>
                      <span className="item-sub">{c.clientIds.map((x) => names.get(x)).filter(Boolean).slice(0, 2).join(" · ") || (c.left.kind === "person" ? "Person" : "Company")}</span>
                    </span>
                    <span className="item-end">
                      {c.status === "auto_merged" ? "Merged automatically" : c.status === "merged" ? "Merged" : c.status === "deferred" ? "Deferred" : "Kept apart"}
                      {(c.status === "merged" || c.status === "auto_merged") && can("resolution:decide") && (
                        <Button
                          size="sm"
                          variant="line"
                          onClick={(e) => {
                            e.preventDefault();
                            setSplitting(c);
                          }}
                        >
                          <Split /> Split
                        </Button>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </Page>
    );
  const scale = current ? Math.max(...current.score.reasons.map((x) => Math.abs(x.contribution)), 0.01) : 1;
  const p = current ? Math.round(current.score.probability * 100) : 0;
  const held = current && pending && p >= auto ? heldBack(current.score.features) : null;
  const rows: CompareRow[] = current
    ? fields
        .map((f): CompareRow | null => {
          const r = reasonFor(f);
          const va = f === "Linked to" ? (r ? r.label.replace(/^Both linked to /, "") : null) : fieldValue(current.left, f);
          const vb = f === "Linked to" ? (r ? r.label.replace(/^Both linked to /, "") : null) : fieldValue(current.right, f);
          if (!va && !vb && !r) return null;
          let eff = effectOf(r, scale);
          if (f === "Birth date" && r && va && va === vb) eff = { ...eff, glyph: "=", word: "Same date of birth" };
          if (!r && va && vb) eff = va.trim().toLowerCase() === vb.trim().toLowerCase() ? { glyph: "=", word: "The same", up: 0, down: 0 } : { glyph: "≠", word: "Different", up: 0, down: 0 };
          return { field: f, a: va, b: vb, mark: eff.glyph, word: eff.word };
        })
        .filter((x): x is CompareRow => x !== null)
    : [];
  return (
    <Page label="Possible duplicate">
      <PageHeader
        back={{ to: "/fuse", label: "Duplicates" }}
        title={current ? `${current.left.name} and ${current.right.name}` : "Nothing to decide"}
        status={
          current &&
          (pending ? (
            <span title={held ? `Not fused automatically: ${held}` : undefined}>
              <Status tone="review">Same {kindWord}?</Status>
            </span>
          ) : (
            <Status tone="neutral">{current.status === "auto_merged" ? "Merged automatically" : current.status === "merged" ? "Merged" : current.status === "deferred" ? "Deferred" : "Kept apart"}</Status>
          ))
        }
        actions={pending && <QueuePager label="Possible duplicates" items={items.map((c) => ({ id: c.id, title: `${c.left.name} · ${c.right.name}`, detail: `${likelihood(c.score.probability)} · ${c.left.kind === "person" ? "person" : "company"}` }))} current={current?.id} onPick={(x) => nav(`/fuse/${x}`)} />}
      />
      {current && (
        <SectionTabs
          label="Possible duplicate"
          tabs={[
            { id: "match", label: "Comparison" },
            { id: "a", label: "Record A" },
            { id: "b", label: "Record B" },
          ]}
          active={tab}
          onTab={setTab}
        >
          {tab === "a" || tab === "b" ? (
            <RecordView r={tab === "a" ? current.left : current.right} />
          ) : (
            <Compare
              a={<span className="cmp-k">Record A</span>}
              b={<span className="cmp-k">Record B</span>}
              score={p}
              scoreWord={`likely the same ${kindWord}`}
              rows={rows}
              extra={
                <div className="scale" role="img" aria-label={`Match likelihood ${p} in 100. Below ${review} kept apart, ${auto} and above fused automatically, in between you decide.`}>
                  <div className="bar" style={{ gridTemplateColumns: `${review}fr ${auto - review}fr ${100 - auto}fr` }}>
                    <span className="z1">Apart</span>
                    <span className="z2">You decide</span>
                    <span className="z3">Auto</span>
                    <i className="marker" style={{ left: `calc(${p}% - 1px)` }} />
                  </div>
                  {held && <p className="note held">Held for you: {held}</p>}
                </div>
              }
            />
          )}
        </SectionTabs>
      )}
      {current && tab === "match" && <ChartBand label="Both records and what they are linked to" height="mid" legend={["person", "company", "owns", "controls"]} className="mt-5" foot={pending && can("resolution:decide") ? <span className="chip">Drag one onto the other to merge</span> : null} />}
      {current && (
        <DecisionBar label="Decision">
          {pending ? (
            can("resolution:decide") ? (
              <div className="row">
                <Button variant="primary" onClick={() => setMerging(true)} disabled={decide.isPending} title="F">
                  <Merge /> Merge
                </Button>
                <Button variant="line" onClick={keepApart} disabled={decide.isPending} title="K">
                  <Split /> Keep apart
                </Button>
                <Button variant="quiet" onClick={next} title="J">
                  Next
                </Button>
              </div>
            ) : (
              <p className="note-info">The compliance officer decides</p>
            )
          ) : (
            <>
              <p className="note-info">{current.decidedBy ? `Decided by ${current.decidedBy === "System" ? "Kinroot" : current.decidedBy}` : "Decided"}</p>
              {(current.status === "merged" || current.status === "auto_merged") && can("resolution:decide") && (
                <Button variant="line" onClick={() => setSplitting(current)}>
                  <Split /> Split
                </Button>
              )}
            </>
          )}
        </DecisionBar>
      )}
      <AlertDialog open={merging} onOpenChange={setMerging}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge into one {kindWord}?</AlertDialogTitle>
            <AlertDialogDescription>Both original records are kept. You can split them again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void fuse()}>Merge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!splitting} onOpenChange={(o) => !o && setSplitting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Split into two records?</AlertDialogTitle>
            <AlertDialogDescription>
              {splitting?.left.name} and {splitting?.right.name} become separate again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => splitting && split.mutate(splitting)}>Split</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={apart} onOpenChange={(o) => (setApart(o), setNoteError(false))}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Keep apart</DialogTitle>
            <DialogDescription>Why are they different?</DialogDescription>
          </DialogHeader>
          <label className="field">
            <span>Reason</span>
            <Textarea
              ref={noteRef}
              rows={3}
              aria-invalid={noteError}
              aria-describedby={noteError ? "reason-err" : undefined}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setNoteError(false);
              }}
            />
          </label>
          {noteError && (
            <p className="note-error" id="reason-err" role="alert">
              Give a reason.
            </p>
          )}
          <DialogFooter>
            <Button variant="quiet" onClick={() => setApart(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={keepApart} disabled={decide.isPending}>
              Keep apart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function RecordView({ r }: { r: PartyRecord }) {
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
    <div className="card card-pad">
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd className={v ? undefined : "muted"}>{v ?? "Not provided"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
