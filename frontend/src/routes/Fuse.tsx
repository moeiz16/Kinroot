// Fuse or split: possible duplicate people and companies. Drag one record onto the other to fuse, or decide in
// the match file. The likelihood scale shows why a person decides: below 40 kept apart, 97+ fused automatically.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitFork, Merge, Move, Split } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
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
import { BoardTools } from "../shell/chrome";
import { Drawer } from "../shell/Drawer";
import "./sheets.css";

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
export function effectOf(reason: MatchReason | undefined): { glyph: string; word: string; up: number; down: number } {
  if (!reason || reason.contribution === 0 || reason.value === -1) return { glyph: "—", word: "Can’t compare", up: 0, down: 0 };
  const w = Math.min(50, Math.round(Math.abs(reason.contribution) * 100));
  if (reason.direction === "against") return { glyph: "≠", word: reason.label, up: 0, down: w };
  return { glyph: /sound|similar|almost|short form|written differently|initial/i.test(reason.label) ? "≈" : "=", word: reason.label, up: w, down: 0 };
}

export default function Fuse() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const board = useBoard();
  const { can } = useAuth();
  const [tab, setTab] = useState("match");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [noteError, setNoteError] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ["candidates", "pending"], queryFn: () => api.resolution.candidates({ pageSize: 50 }) });
  const past = useQuery({ queryKey: ["candidates", "decided"], queryFn: () => api.resolution.candidates({ status: "all", pageSize: 50 }) });
  const thresholds = useQuery({ queryKey: ["thresholds"], queryFn: api.resolution.thresholds });
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
      setMsg(out.status === "merged" ? `Fused into one record. Both originals are kept, and you can split them again.` : "Kept apart. Your reason is in the activity log.");
      void qc.invalidateQueries({ queryKey: ["candidates"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      setTimeout(() => setMsg(null), 4000);
      next();
    },
    onError: (e) => setMsg(errorMessage(e)),
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
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
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
      setMsg("Split into two records. Both decisions are in the activity log.");
      void qc.invalidateQueries({ queryKey: ["candidates"] });
    },
    onError: (e) => setMsg(errorMessage(e)),
  });

  const auto = (thresholds.data?.autoMerge ?? 0.97) * 100;
  const review = (thresholds.data?.review ?? 0.4) * 100;
  const decided = (past.data?.items ?? []).filter((c) => c.status !== "pending");
  const reasonFor = (field: string) => current?.score.reasons.find((r) => FIELD_FOR.some(([re, f]) => f === field && re.test(r.feature)));
  const fields = ["Birth date", "Address", "Name", "Linked to", "ID document", "Middle name"];

  return (
    <>
      <div className="chrome queue-tray" style={{ top: 16, left: 16, right: board.occlusion.right + 16 }}>
        <div className="tray" role="list" aria-label="Possible duplicates waiting">
          <span className="cap">
            {items.length} possible
            <br />
            duplicates
          </span>
          {items.slice(0, 3).map((c) => (
            <button key={c.id} className="slip" role="listitem" aria-current={current?.id === c.id} onClick={() => nav(`/fuse/${c.id}`)}>
              <b>
                {c.left.name} · {c.right.name}
              </b>
              <small>
                {likelihood(c.score.probability)} · {c.left.kind === "person" ? "person" : "company"}
              </small>
            </button>
          ))}
          {items.length > 3 && (
            <button className="slip slip-more" onClick={() => nav(`/fuse/${items[3]!.id}`)} aria-label={`${items.length - 3} more`}>
              +{items.length - 3}
            </button>
          )}
        </div>
      </div>
      {current?.status === "pending" && (
        <div className="chrome board-hint" style={{ top: 100, left: 16 }}>
          <Move aria-hidden /> Drag one record onto the other to fuse, or decide in the match file.
        </div>
      )}
      <BoardTools minimap={false} extra={<button aria-label="Split a fused record" onClick={() => setTab("past")}><GitFork /></button>} />
      {msg && (
        <div className="chrome toast" role="status" style={{ bottom: 70, left: `calc((100% - ${board.occlusion.right}px) / 2)`, transform: "translateX(-50%)" }}>
          {msg}
        </div>
      )}
      <Drawer
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
          <>
            <h1 className="title">Nothing to decide</h1>
            <p className="lede">Every possible duplicate has been decided. New ones appear here when a record is added or imported.</p>
          </>
        ) : tab === "a" || tab === "b" ? (
          <RecordView r={tab === "a" ? current.left : current.right} label={tab === "a" ? "Record A" : "Record B"} />
        ) : tab === "past" ? (
          <>
            <h1 className="title" style={{ fontSize: 24 }}>
              Past decisions
            </h1>
            <p className="note">Fusing keeps both original records. Split a fused record to unpick it.</p>
            <table className="ledger" style={{ marginTop: 14 }}>
              <tbody>
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
                        <button className="btn btn-line btn-sm" onClick={() => split.mutate(c)} disabled={split.isPending}>
                          <Split /> Split into two
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <>
            <div className="eyebrow">
              Possible duplicate <span aria-hidden>·</span> {idx + 1} of {items.length} <span aria-hidden>·</span> Found in {current.clientIds.map((x) => names.get(x)).filter(Boolean).slice(0, 2).join(" and ") || "the client book"}
            </div>
            <h1 className="title" style={{ fontSize: 27 }}>
              {current.left.name} and {current.right.name}
            </h1>
            <p className="lede">
              {current.score.probability >= 0.75 ? "Probably the same " : "Possibly the same "}
              {current.left.kind === "person" ? "person" : "company"}. {current.score.reasons.filter((r) => r.direction === "for").slice(0, 2).map((r, i) => (i === 0 ? r.label : r.label.charAt(0).toLowerCase() + r.label.slice(1))).join(" and ")}.{" "}
              {current.score.reasons.find((r) => r.direction === "against") ? `${current.score.reasons.find((r) => r.direction === "against")!.label}.` : ""}
            </p>
            <div className="scale" style={{ marginTop: 22 }} role="img" aria-label={`Match likelihood ${likelihood(current.score.probability)}. ${review} to ${auto} needs a person to decide.`}>
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
            <section className="section">
              <h2>
                What agrees and what does not <span className="aside">Longer bar, stronger evidence</span>
              </h2>
              <table className="cmp">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Field</span>
                    </th>
                    <th scope="col">Record A</th>
                    <th scope="col">Record B</th>
                    <th scope="col">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((f) => {
                    const r = reasonFor(f);
                    const va = f === "Linked to" ? (r ? r.label.replace(/^Both linked to /, "") : null) : fieldValue(current.left, f);
                    const vb = f === "Linked to" ? (r ? r.label.replace(/^Both linked to /, "") : null) : fieldValue(current.right, f);
                    if (!va && !vb && !r) return null;
                    const eff = effectOf(r);
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
                </tbody>
              </table>
            </section>
            {current.status === "pending" ? (
              can("resolution:decide") ? (
                <div className="decide">
                  <div className="row">
                    <button className="btn btn-string" onClick={() => void fuse()} disabled={decide.isPending}>
                      <Merge /> Fuse into one {current.left.kind === "person" ? "person" : "company"}
                    </button>
                    <button className="btn btn-line" onClick={keepApart} disabled={decide.isPending}>
                      <Split /> Keep apart
                    </button>
                  </div>
                  <input
                    ref={noteRef}
                    className="input"
                    aria-label="Reason"
                    aria-invalid={noteError}
                    aria-describedby={noteError ? "reason-err" : undefined}
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
                  <p className="note">Fusing keeps both original records. You can split them again later, and both decisions are kept in the activity log.</p>
                  <div className="kb" aria-hidden>
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
              ) : (
                <p className="note-info" style={{ marginTop: 18 }}>
                  Only the compliance officer decides whether two records are the same.
                </p>
              )
            ) : (
              <div className="done-note">
                Decided: {current.status.replace("_", " ")} by {current.decidedBy}.
              </div>
            )}
          </>
        )}
      </Drawer>
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
      <h1 className="title" style={{ fontSize: 26 }}>
        {r.name}
      </h1>
      <table className="ledger" style={{ marginTop: 16 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row" style={{ width: 130, paddingTop: 10 }}>
                {k}
              </th>
              <td className={v ? "" : "muted"}>{v ?? "Not provided"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
