// Screening review: a human disposition of each possible match. The folio is the match record (our record against
// the list entry, field by field, and the decision with a required reason at the foot); the exhibit shows the
// screened party with the list entry hanging off it as a foreign card, joined by a dotted "possible match" seam.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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
import { AsAt, BoardTools, FindTrigger, Status } from "../shell/chrome";
import { Caption, Decision, Folio, FolioTabs, QueuePager } from "../shell/Folio";
import { effectOf } from "./Fuse";

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
      toast(h.status === "true_match" ? (h.entry.listKind === "sanctions" ? "Confirmed. Work on the client is paused and the compliance officer has been told." : "Confirmed. Enhanced checks for a politically exposed person now apply.") : h.status === "false_positive" ? "Recorded as not a match." : "Escalated to the compliance officer.");
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
  const listWord = h?.entry.listKind === "pep" ? "PEP list" : "sanctions list";
  return (
    <>
      <Folio label="Screening match" width="normal">
        <Caption
          refLine={
            h ? (
              <>
                <span>{h.entry.listKind === "pep" ? "Possible politically exposed person" : "Possible sanctions match"}</span>
                <span className="sep">·</span>
                <span>found {fmtDate(h.createdAt.slice(0, 10))}</span>
              </>
            ) : (
              <span>Screening</span>
            )
          }
          title={
            h ? (
              <>
                {h.partyName} <span className="muted" style={{ fontWeight: 400 }}>·</span> {listWord} entry
              </>
            ) : (
              "Nothing to review"
            )
          }
          stamps={
            h && (
              <>
                <Status tone={h.score >= 0.85 ? "high" : "review"}>{h.status === "pending" ? "Review" : h.status.replace("_", " ")}</Status>
                <span className="meta">{likelihood(h.score)} likely the same</span>
              </>
            )
          }
          tools={<QueuePager label="Matches to review" items={items.map((x) => ({ id: x.id, title: x.partyName, detail: `${x.entry.listKind === "pep" ? "PEP list" : "sanctions list"} · ${likelihood(x.score)}` }))} current={h?.id} onPick={(x) => nav(`/screening/${x}`)} />}
        />
        <FolioTabs
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
            <p className="lede">Every screening match has a decision. New ones appear here after a list update or a new client.</p>
          ) : tab === "history" ? (
            <>
              <h2 className="title" style={{ fontSize: 23 }}>
                Decided matches
              </h2>
              <Table style={{ marginTop: 14 }}>
                <TableBody>
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
                </TableBody>
              </Table>
            </>
          ) : tab === "entry" ? (
            <>
              <div className="eyebrow">{listSourceLabel(h.entry.source)}</div>
              <h2 className="title" style={{ fontSize: 25 }}>
                {h.entry.name}
              </h2>
              <Table style={{ marginTop: 14 }}>
                <TableBody>
                  <tr><th scope="row" style={{ width: 130 }}>Also known as</th><td>{h.entry.aliases.join(", ") || "—"}</td></tr>
                  <tr><th scope="row">Born</th><td className="mono">{h.entry.birthDate ?? "—"}</td></tr>
                  <tr><th scope="row">Countries</th><td>{h.entry.countries.map((c) => COUNTRY[c] ?? c).join(", ")}</td></tr>
                  <tr><th scope="row">Listed under</th><td>{h.entry.programs.join(", ")}</td></tr>
                  <tr><th scope="row">Reference</th><td className="mono">{h.entry.id}</td></tr>
                </TableBody>
              </Table>
              <p className="note" style={{ marginTop: 12 }}>Sample list entries are fictional and labelled as samples.</p>
            </>
          ) : tab === "party" ? (
            <>
              <div className="eyebrow">Our record</div>
              <h2 className="title" style={{ fontSize: 25 }}>
                {h.partyName}
              </h2>
              <p className="meta">{party?.sub ?? ""}</p>
              <Button onClick={() => nav(`/clients/${h.clientId}/screening`)}>Open the client’s dossier</Button>
            </>
          ) : (
            <div className="paras">
              <section className="para" style={{ marginTop: 0 }}>
                <h2>
                  Our record against the list entry <span className="aside">Longer bar, stronger evidence</span>
                </h2>
                <Table className="cmp">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col"><span className="sr-only">Field</span></TableHead>
                      <TableHead scope="col">Our record</TableHead>
                      <TableHead scope="col">List entry</TableHead>
                      <TableHead scope="col">Effect</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
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
                  </TableBody>
                </Table>
              </section>
              <section className="para">
                <h2>What a decision does</h2>
                <p className="lede" style={{ marginTop: 0, fontSize: 15 }}>
                  A true sanctions match pauses work on the client and tells the compliance officer. A true PEP match turns on enhanced checks. Not a match closes this entry for this person until the list changes.
                </p>
              </section>
            </div>
          )}
        </FolioTabs>
        {h && (
          <Decision label="Decision">
            {h.status === "pending" ? (
              can("screening:review") ? (
                <div className="stack">
                  <label className="field">
                    <span>Reason (required)</span>
                    <Textarea rows={2} className="min-h-[64px]" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!err} aria-describedby={err ? "hit-err" : "hit-note"} placeholder="What you compared and why" />
                  </label>
                  {err && (
                    <p className="note-error" id="hit-err" role="alert">
                      {err}
                    </p>
                  )}
                  <div className="row">
                    <Button variant="string" onClick={() => decide("true_match")} disabled={review.isPending}>
                      True match
                    </Button>
                    <Button onClick={() => decide("false_positive")} disabled={review.isPending}>
                      Not a match
                    </Button>
                    <Button variant="quiet" onClick={() => decide("escalate")} disabled={review.isPending}>
                      Escalate
                    </Button>
                  </div>
                  <p className="note" id="hit-note">
                    A true sanctions match freezes the matter and notifies the compliance officer.
                  </p>
                </div>
              ) : (
                <p className="note-info">The compliance officer reviews screening matches. You’ll see the outcome here once it is decided.</p>
              )
            ) : (
              <p className="note-info">
                Decided by {h.reviewedBy}: {h.reviewReason}
              </p>
            )}
          </Decision>
        )}
      </Folio>
      <AsAt exhibit="Exhibit" title="The party and the list entry" />
      <FindTrigger />
      <BoardTools minimap={false} />
    </>
  );
}
