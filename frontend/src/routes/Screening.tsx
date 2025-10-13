// Screening review: the screened party on the board with the list entry hanging off it as a foreign card,
// joined by a dotted "possible match" seam. Decide in the drawer with a required reason.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { errorMessage } from "../api/client";
import { api } from "../api/endpoints";
import type { GraphPayload, ScreeningHit } from "../api/types";
import { applyPositions, layered } from "../graph/layout";
import type { BNode, Scene } from "../graph/model";
import { fromPayload } from "../graph/transforms";
import { fmtDate } from "../lib/dates";
import { COUNTRY, likelihood, listSourceLabel } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardScene } from "../shell/board";
import { BoardTools, Status } from "../shell/chrome";
import { Drawer } from "../shell/Drawer";
import { effectOf } from "./Fuse";
import "./sheets.css";

export function screeningScene(hit: ScreeningHit, g: GraphPayload): Scene {
  const model = fromPayload(g);
  const P = hit.partyId;
  const nodes = model.nodes.map((n) => {
    const out = model.edges.some((e) => e.s === P && e.t === n.id);
    return { ...n, level: n.id === P ? 1 : out ? 0 : 2, client: !!n.clientId && n.id !== P, sub: n.clientId ? "Client" : n.sub };
  });
  const placed = applyPositions(nodes, layered(nodes, model.edges, { rankSep: 170, nodeSep: 230 }));
  const party = placed.find((n) => n.id === P)!;
  const entry: BNode = {
    id: `list:${hit.entry.id}`,
    kind: "list",
    label: `“${hit.entry.name}”`,
    sub: `${hit.entry.listKind === "pep" ? "PEP list" : "Sanctions list"} · ${hit.entry.countries.map((c) => COUNTRY[c] ?? c).join(", ")}`,
    glyph: "≡",
    level: 1,
    flags: [{ text: listSourceLabel(hit.entry.source), level: "info" }],
    aria: `List entry ${hit.entry.name}, ${listSourceLabel(hit.entry.source)}`,
    x: party.x + 430,
    y: party.y,
  };
  return {
    key: `screen-${hit.id}`,
    nodes: [...placed, entry],
    edges: [...model.edges, { id: `possible:${hit.id}`, s: entry.id, t: P, kind: "possible", label: `possible match · ${likelihood(hit.score)}`, labelAt: 0.3 }],
  };
}

export default function Screening() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const board = useBoard();
  const { can } = useAuth();
  const [tab, setTab] = useState("match");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const pending = useQuery({ queryKey: ["hits", "pending"], queryFn: () => api.screening.hits({ pageSize: 100 }) });
  const all = useQuery({ queryKey: ["hits", "all"], queryFn: () => api.screening.hits({ status: "all", pageSize: 100 }) });
  const items = pending.data?.items ?? [];
  const current = (id ? all.data?.items.find((h) => h.id === id) : undefined) ?? items[0];
  const g = useQuery({ queryKey: ["party-graph", current?.partyId], queryFn: () => api.parties.graph(current!.partyId, undefined, 1), enabled: !!current });
  const scene = useMemo(() => (current && g.data ? screeningScene(current, g.data) : null), [current, g.data]);
  useBoardScene(scene);
  useEffect(() => {
    if (scene && current) setTimeout(() => board.engine()?.setSelected(current.partyId), 100);
  }, [scene, current, board.version > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const review = useMutation({
    mutationFn: (d: "true_match" | "false_positive" | "escalate") => api.screening.review(current!.id, d, reason),
    onSuccess: (h) => {
      setMsg(h.status === "true_match" ? (h.entry.listKind === "sanctions" ? "Confirmed. Work on the client is paused and the compliance officer has been told." : "Confirmed. Enhanced checks for a politically exposed person now apply.") : h.status === "false_positive" ? "Recorded as not a match." : "Escalated to the compliance officer.");
      setReason("");
      void qc.invalidateQueries({ queryKey: ["hits"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      const next = items.find((x) => x.id !== h.id);
      if (next) nav(`/screening/${next.id}`);
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const decide = (d: "true_match" | "false_positive" | "escalate") => {
    if (reason.trim().length < 10) {
      setErr("Give a reason of at least 10 characters.");
      return;
    }
    setErr(null);
    review.mutate(d);
  };

  const h = current;
  const row = (label: string, ours: string | null | undefined, theirs: string | null | undefined, feature: RegExp) => {
    const eff = effectOf(h?.reasons.find((r) => feature.test(r.feature)), Math.max(...(h?.reasons ?? []).map((x) => Math.abs(x.contribution)), 0.01));
    return (
      <tr key={label}>
        <td className="f">{label}</td>
        <td className={`v${ours ? "" : " none"}`}>{ours ?? "Not on file"}</td>
        <td className={`v${theirs ? "" : " none"}`}>{theirs ?? "Not listed"}</td>
        <td className="eff">
          <span className="t">
            <span className="g">{eff.glyph}</span>
            {eff.word}
          </span>
          <div className="push" aria-hidden>
            {eff.up > 0 && <i className="up" style={{ width: `${eff.up}%` }} />}
            {eff.down > 0 && <i className="down" style={{ width: `${eff.down}%` }} />}
          </div>
        </td>
      </tr>
    );
  };
  const party = scene?.nodes.find((n) => n.id === h?.partyId);
  return (
    <>
      <div className="chrome queue-tray" style={{ top: 16, left: 16, right: board.occlusion.right + 16 }}>
        <div className="tray" role="list" aria-label="Matches to review">
          <span className="cap">
            {items.length} to
            <br />
            review
          </span>
          {items.map((x) => (
            <button key={x.id} className="slip" role="listitem" aria-current={h?.id === x.id} onClick={() => nav(`/screening/${x.id}`)}>
              <b>{x.partyName}</b>
              <small>
                {x.entry.listKind === "pep" ? "PEP list" : "sanctions list"} · {likelihood(x.score)}
              </small>
            </button>
          ))}
        </div>
      </div>
      <BoardTools minimap={false} />
      {msg && (
        <div className="chrome toast" role="status" style={{ bottom: 70, left: `calc((100% - ${board.occlusion.right}px) / 2)`, transform: "translateX(-50%)" }}>
          {msg}
        </div>
      )}
      <Drawer
        label="Screening match"
        tabs={[
          { id: "match", label: "Match" },
          { id: "party", label: "Party" },
          { id: "entry", label: "List entry" },
          { id: "history", label: "History", count: (all.data?.items ?? []).filter((x) => x.status !== "pending").length },
        ]}
        active={tab}
        onTab={setTab}
      >
        {!h ? (
          <>
            <h1 className="title">Nothing to review</h1>
            <p className="lede">Every screening match has a decision. New ones appear here after a list update or a new client.</p>
          </>
        ) : tab === "history" ? (
          <>
            <h1 className="title" style={{ fontSize: 24 }}>
              Decided matches
            </h1>
            <table className="ledger" style={{ marginTop: 14 }}>
              <tbody>
                {(all.data?.items ?? [])
                  .filter((x) => x.status !== "pending")
                  .map((x) => (
                    <tr key={x.id}>
                      <td className="who">
                        <b>
                          {x.partyName} · “{x.entry.name}”
                        </b>
                        <small>{x.reviewReason ?? "Reason recorded"}</small>
                      </td>
                      <td className="st">
                        <Status tone={x.status === "true_match" ? "high" : x.status === "escalated" ? "review" : "clear"}>{x.status === "true_match" ? "True match" : x.status === "escalated" ? "Escalated" : "Not a match"}</Status>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        ) : tab === "entry" ? (
          <>
            <div className="eyebrow">{listSourceLabel(h.entry.source)}</div>
            <h1 className="title" style={{ fontSize: 26 }}>
              {h.entry.name}
            </h1>
            <table className="ledger" style={{ marginTop: 14 }}>
              <tbody>
                <tr><th scope="row" style={{ width: 130 }}>Also known as</th><td>{h.entry.aliases.join(", ") || "—"}</td></tr>
                <tr><th scope="row">Born</th><td className="mono">{h.entry.birthDate ?? "—"}</td></tr>
                <tr><th scope="row">Countries</th><td>{h.entry.countries.map((c) => COUNTRY[c] ?? c).join(", ")}</td></tr>
                <tr><th scope="row">Listed under</th><td>{h.entry.programs.join(", ")}</td></tr>
                <tr><th scope="row">Reference</th><td className="mono">{h.entry.id}</td></tr>
              </tbody>
            </table>
            <p className="note" style={{ marginTop: 12 }}>Sample list entries are fictional and labelled as samples.</p>
          </>
        ) : tab === "party" ? (
          <>
            <div className="eyebrow">Our record</div>
            <h1 className="title" style={{ fontSize: 26 }}>
              {h.partyName}
            </h1>
            <p className="meta">{party?.sub ?? ""}</p>
            <button className="btn btn-line" onClick={() => nav(`/clients/${h.clientId}/screening`)}>
              Open the client’s dossier
            </button>
          </>
        ) : (
          <>
            <div className="eyebrow">{h.entry.listKind === "pep" ? "Possible politically exposed person" : "Possible sanctions match"}</div>
            <h1 className="title" style={{ fontSize: 27 }}>
              {h.partyName} <span className="muted" style={{ fontWeight: 400 }}>·</span> {h.entry.listKind === "pep" ? "PEP list entry" : "sanctions list entry"}
            </h1>
            <div className="rating-row" style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
              <Status tone={h.score >= 0.85 ? "high" : "review"}>{h.status === "pending" ? "Review" : h.status.replace("_", " ")}</Status>
              <span className="mono">{likelihood(h.score)}</span>
              <span className="muted" style={{ fontSize: 12.5 }}>found {fmtDate(h.createdAt.slice(0, 10))}</span>
            </div>
            <section className="section">
              <table className="cmp">
                <thead>
                  <tr>
                    <th scope="col"><span className="sr-only">Field</span></th>
                    <th scope="col">Our record</th>
                    <th scope="col">List entry</th>
                    <th scope="col">Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {row("Name", h.partyName, h.entry.name, /name/)}
                  {row("Born", party?.sub?.startsWith("Born") ? party.sub.slice(5) : null, h.entry.birthDate, /dob/)}
                  {row("Country", party?.glyph && party.kind !== "person" ? (COUNTRY[party.glyph] ?? party.glyph) : null, h.entry.countries.map((c) => COUNTRY[c] ?? c).join(", "), /country|nationality/)}
                  {h.reasons.some((r) => /officer/.test(r.feature)) && row("Officers", "Shared surname", "Shared surname", /officer/)}
                  <tr>
                    <td className="f">Adverse media</td>
                    <td className="v none" colSpan={3}>
                      Not checked yet: no source connected
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
            {h.status === "pending" ? (
              can("screening:review") ? (
                <div className="decide">
                  <div className="row">
                    <button className="btn btn-string" onClick={() => decide("true_match")} disabled={review.isPending}>
                      True match
                    </button>
                    <button className="btn btn-line" onClick={() => decide("false_positive")} disabled={review.isPending}>
                      Not a match
                    </button>
                    <button className="btn btn-quiet" onClick={() => decide("escalate")} disabled={review.isPending}>
                      Escalate
                    </button>
                  </div>
                  <label className="field">
                    <span>Reason (required)</span>
                    <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!err} aria-describedby={err ? "hit-err" : "hit-note"} placeholder="What you compared and why" />
                  </label>
                  {err && (
                    <p className="note-error" id="hit-err" role="alert">
                      {err}
                    </p>
                  )}
                  <p className="note" id="hit-note">
                    A true sanctions match freezes the matter and notifies the compliance officer.
                  </p>
                </div>
              ) : (
                <p className="note-info" style={{ marginTop: 18 }}>
                  The compliance officer reviews screening matches. You’ll see the outcome here once it is decided.
                </p>
              )
            ) : (
              <div className="done-note">
                Decided by {h.reviewedBy}: {h.reviewReason}
              </div>
            )}
          </>
        )}
      </Drawer>
    </>
  );
}
