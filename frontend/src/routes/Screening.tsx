// Screening review, face-off skeleton: our record and the list entry face each other across the verdict column,
// zipped field by field; the chart below shows the screened party with the list entry beside it on a dotted
// "possible match" line; the decision (with a required reason) sits in the decision bar.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody } from "@/components/ui/table";
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
import { ChartBand, KindGlyph, Status } from "../shell/chart";
import { DecisionBar, Masthead, Page, PageBody, QueuePager, SectionTabs, useHop } from "../shell/page";
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
    x: party.x + 400,
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
  const party = scene?.nodes.find((n) => n.id === h?.partyId);
  useHop(id && h ? `${h.partyName} · list entry` : null, party?.kind === "company" ? "company" : party?.kind === "trust" ? "trust" : "person");
  const scale = Math.max(...(h?.reasons ?? []).map((x) => Math.abs(x.contribution)), 0.01);
  const row = (label: string, ours: string | null | undefined, theirs: string | null | undefined, feature: RegExp) => {
    const eff = effectOf(h?.reasons.find((r) => feature.test(r.feature)), scale);
    return (
      <tr key={label} className={eff.glyph === "≠" ? "differs" : eff.glyph === "—" ? "unknown" : "agrees"}>
        <td className={`za v${ours ? "" : " none"}`}>{ours ?? "Not on file"}</td>
        <th scope="row" className="zf">
          <span className="zf-name">{label}</span>
          <span className="zf-mark" aria-hidden>
            {eff.glyph}
          </span>
          <span className="zf-word">{eff.word}</span>
          <span className="push" aria-hidden>
            <i className="down" style={{ width: `${eff.down}%` }} />
            <i className="up" style={{ width: `${eff.up}%` }} />
          </span>
        </th>
        <td className={`zb v${theirs ? "" : " none"}`}>{theirs ?? "Not listed"}</td>
      </tr>
    );
  };
  if (!id)
    return (
      <Page skeleton="register" label="Screening">
        <Masthead
          size="poster"
          refLine={
            <>
              <b>Screening</b>
              <span className="sep">/</span>
              <span>sanctions and politically exposed persons, every party in every structure</span>
            </>
          }
          title={
            <>
              Screening <span className="mast-count">{items.length}</span>
            </>
          }
        />
        <PageBody>
          {!items.length && <p className="lede">Every screening match has a decision. New ones appear here after a list update or a new client.</p>}
          <ul className="register-list">
            {items.map((x) => (
              <li key={x.id}>
                <Link to={`/screening/${x.id}`} className="register-row">
                  <span className="rr-kind">{x.entry.listKind === "pep" ? "PEP list" : "Sanctions list"}</span>
                  <b className="rr-title">
                    {x.partyName} <span className="vs">against</span> “{x.entry.name}”
                  </b>
                  <span className="rr-score">
                    <b>{Math.round(x.score * 100)}</b> in 100
                  </span>
                  <span className="rr-when mono">found {fmtDate(x.createdAt.slice(0, 10))}</span>
                </Link>
              </li>
            ))}
          </ul>
        </PageBody>
      </Page>
    );
  const listWord = h?.entry.listKind === "pep" ? "PEP list" : "sanctions list";
  return (
    <Page skeleton="faceoff" label="Screening match">
      <Masthead
        size="name"
        refLine={
          h ? (
            <>
              <b>{h.entry.listKind === "pep" ? "Possible politically exposed person" : "Possible sanctions match"}</b>
              <span className="sep">/</span>
              <span>found {fmtDate(h.createdAt.slice(0, 10))}</span>
            </>
          ) : (
            <b>Screening</b>
          )
        }
        title={h ? `${h.partyName} · ${listWord} entry` : "Nothing to review"}
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
      <SectionTabs
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
            <h2 className="title">Decided matches</h2>
            <Table>
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
            <h2 className="title">{h.entry.name}</h2>
            <Table className="record-table">
              <TableBody>
                <tr><th scope="row">Also known as</th><td>{h.entry.aliases.join(", ") || "—"}</td></tr>
                <tr><th scope="row">Born</th><td className="mono">{h.entry.birthDate ?? "—"}</td></tr>
                <tr><th scope="row">Countries</th><td>{h.entry.countries.map((c) => COUNTRY[c] ?? c).join(", ")}</td></tr>
                <tr><th scope="row">Listed under</th><td>{h.entry.programs.join(", ")}</td></tr>
                <tr><th scope="row">Reference</th><td className="mono">{h.entry.id}</td></tr>
              </TableBody>
            </Table>
            <p className="note">Sample list entries are fictional and labelled as samples.</p>
          </>
        ) : tab === "party" ? (
          <>
            <div className="eyebrow">Our record</div>
            <h2 className="title">{h.partyName}</h2>
            <p className="meta">{party?.sub ?? ""}</p>
            <Button onClick={() => nav(`/clients/${h.clientId}/screening`)}>Open the client’s dossier</Button>
          </>
        ) : (
          <div className="faceoff">
            <div className="fo-head fo-a">
              <span className="micro">Our record</span>
              <b>
                <KindGlyph kind={party?.kind ?? "person"} size={16} />
                {h.partyName}
              </b>
              <small>{party?.sub ?? "In the client book"}</small>
            </div>
            <div className="fo-verdict slab">
              <div className="fo-num" aria-hidden>
                {Math.round(h.score * 100)}
              </div>
              <div className="fo-cap">in 100 likely the same</div>
              <p className="fo-what">A true sanctions match pauses work on the client and tells the compliance officer. A true PEP match turns on enhanced checks. Not a match closes this entry for this person until the list changes.</p>
            </div>
            <div className="fo-head fo-b listed">
              <span className="micro">{listSourceLabel(h.entry.source)}</span>
              <b>
                <span className="list-tag">List</span>“{h.entry.name}”
              </b>
              <small>{h.entry.listKind === "pep" ? "PEP list" : "Sanctions list"}</small>
            </div>
            <table className="zipper" aria-label="Our record against the list entry">
              <thead>
                <tr>
                  <th scope="col" className="za">
                    Our record
                  </th>
                  <th scope="col" className="zf">
                    Field and effect
                  </th>
                  <th scope="col" className="zb">
                    List entry
                  </th>
                </tr>
              </thead>
              <tbody>
                {row("Name", h.partyName, h.entry.name, /name/)}
                {row("Born", party?.sub?.startsWith("Born") ? party.sub.slice(5) : null, h.entry.birthDate, /dob/)}
                {row("Country", party?.glyph && party.kind !== "person" ? (COUNTRY[party.glyph] ?? party.glyph) : null, h.entry.countries.map((c) => COUNTRY[c] ?? c).join(", "), /country|nationality/)}
                {h.reasons.some((r) => /officer/.test(r.feature)) && row("Officers", "Shared surname", "Shared surname", /officer/)}
                <tr className="unknown">
                  <td className="za v none">Not checked yet</td>
                  <th scope="row" className="zf">
                    <span className="zf-name">Adverse media</span>
                    <span className="zf-word">No source connected</span>
                  </th>
                  <td className="zb v none">Not checked yet</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </SectionTabs>
      {h && <ChartBand label="The party and the list entry" exhibit="Exhibit" title="The party and the list entry" height="short" legend={["person", "company", "owns", "controls"]} />}
      {h && (
        <DecisionBar label="Decision">
          {h.status === "pending" ? (
            can("screening:review") ? (
              <div className="decide-grid">
                <label className="field">
                  <span>Reason (required)</span>
                  <Textarea rows={2} className="min-h-[64px]" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!err} aria-describedby={err ? "hit-err" : "hit-note"} placeholder="What you compared and why" />
                </label>
                <div className="row">
                  <Button variant="primary" onClick={() => decide("true_match")} disabled={review.isPending}>
                    True match
                  </Button>
                  <Button onClick={() => decide("false_positive")} disabled={review.isPending}>
                    Not a match
                  </Button>
                  <Button variant="quiet" onClick={() => decide("escalate")} disabled={review.isPending}>
                    Escalate
                  </Button>
                </div>
                {err ? (
                  <p className="note-error" id="hit-err" role="alert">
                    {err}
                  </p>
                ) : (
                  <p className="note" id="hit-note">
                    A true sanctions match freezes the matter and notifies the compliance officer.
                  </p>
                )}
              </div>
            ) : (
              <p className="note-info">The compliance officer reviews screening matches. You’ll see the outcome here once it is decided.</p>
            )
          ) : (
            <p className="note-info">
              Decided by {h.reviewedBy}: {h.reviewReason}
            </p>
          )}
        </DecisionBar>
      )}
    </Page>
  );
}
