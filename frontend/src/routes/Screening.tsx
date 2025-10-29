// Screening. The list is one queue of possible matches. A match shows our record beside the list entry, field by
// field, with the likelihood between them; the chart below shows the party and the entry on a dotted line; the
// decision buttons sit in the bar at the foot and ask for a reason in a dialog.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { ChartBand, Status } from "../shell/chart";
import { DecisionBar, Page, PageHeader, QueuePager, Section, SectionTabs, useTitle } from "../shell/page";
import { Compare, type CompareRow } from "./Compare";
import { effectOf } from "./Fuse";
import { ReviewsHeader } from "./ReviewTabs";

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
    edges: [...model.edges, { id: `possible:${hit.id}`, s: entry.id, t: P, kind: "possible", label: "Possible match", labelAt: 0.3 }],
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
  const [ask, setAsk] = useState<"true_match" | "false_positive" | "escalate" | null>(null);
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
      toast(h.status === "true_match" ? (h.entry.listKind === "sanctions" ? "Confirmed. Work on the client is paused." : "Confirmed. Enhanced checks now apply.") : h.status === "false_positive" ? "Recorded as not a match." : "Escalated.");
      setReason("");
      setAsk(null);
      void qc.invalidateQueries({ queryKey: ["hits"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      const next = items.find((x) => x.id !== h.id);
      if (next) nav(`/screening/${next.id}`);
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const decide = (d: "true_match" | "false_positive" | "escalate") => {
    if (reason.trim().length < 10) {
      setErr("At least 10 characters.");
      return;
    }
    setErr(null);
    review.mutate(d);
  };

  const h = current;
  const party = scene?.nodes.find((n) => n.id === h?.partyId);
  useTitle(id && h ? h.partyName : null);
  const scale = Math.max(...(h?.reasons ?? []).map((x) => Math.abs(x.contribution)), 0.01);
  const rowOf = (field: string, ours: string | null | undefined, theirs: string | null | undefined, feature: RegExp): CompareRow => {
    const eff = effectOf(h?.reasons.find((r) => feature.test(r.feature)), scale);
    return { field, a: ours, b: theirs, mark: eff.glyph, word: eff.word };
  };
  const decidedAll = (all.data?.items ?? []).filter((x) => x.status !== "pending");
  if (!id)
    return (
      <Page label="Screening">
        <ReviewsHeader />
        <ul className="items">
          {items.map((x) => (
            <li key={x.id}>
              <Link to={`/screening/${x.id}`} className="item">
                <span className="item-ico" aria-hidden>
                  <ShieldAlert />
                </span>
                <span className="item-main">
                  <span className="item-title">{x.partyName}</span>
                  <span className="item-sub">
                    {x.entry.listKind === "pep" ? "PEP list" : "Sanctions list"} · “{x.entry.name}”
                  </span>
                </span>
                <span className="item-end">{likelihood(x.score)}</span>
              </Link>
            </li>
          ))}
          {!items.length && <li className="empty">No matches to review</li>}
        </ul>
        {decidedAll.length > 0 && (
          <Section title="Decided">
            <ul className="items">
              {decidedAll.slice(0, 12).map((x) => (
                <li key={x.id}>
                  <Link to={`/screening/${x.id}`} className="item">
                    <span className="item-main">
                      <span className="item-title">{x.partyName}</span>
                      <span className="item-sub">“{x.entry.name}”</span>
                    </span>
                    <span className="item-end">
                      <Status tone={x.status === "true_match" ? "high" : x.status === "escalated" ? "review" : "clear"}>{x.status === "true_match" ? "True match" : x.status === "escalated" ? "Escalated" : "Not a match"}</Status>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </Page>
    );
  const listWord = h?.entry.listKind === "pep" ? "PEP list" : "Sanctions list";
  return (
    <Page label="Screening match">
      <PageHeader
        back={{ to: "/screening", label: "Screening" }}
        title={h ? h.partyName : "Nothing to review"}
        status={h && <Status tone={h.status === "pending" ? (h.score >= 0.85 ? "high" : "review") : h.status === "true_match" ? "high" : "neutral"}>{h.status === "pending" ? `Possible ${h.entry.listKind === "pep" ? "PEP" : "sanctions"} match` : h.status === "true_match" ? "True match" : h.status === "escalated" ? "Escalated" : "Not a match"}</Status>}
        actions={
          <>
            {h && (
              <Button asChild variant="line">
                <Link to={`/clients/${h.clientId}/screening`}>Open client</Link>
              </Button>
            )}
            <QueuePager label="Matches to review" items={items.map((x) => ({ id: x.id, title: x.partyName, detail: `${x.entry.listKind === "pep" ? "PEP list" : "sanctions list"} · ${likelihood(x.score)}` }))} current={h?.id} onPick={(x) => nav(`/screening/${x}`)} />
          </>
        }
      />
      {h && (
        <SectionTabs
          label="Screening match"
          tabs={[
            { id: "match", label: "Comparison" },
            { id: "entry", label: "List entry" },
          ]}
          active={tab}
          onTab={setTab}
        >
          {tab === "entry" ? (
            <div className="card card-pad">
              <dl className="facts">
                <dt>Name</dt>
                <dd>{h.entry.name}</dd>
                <dt>Also known as</dt>
                <dd>{h.entry.aliases.join(", ") || "—"}</dd>
                <dt>Born</dt>
                <dd>{h.entry.birthDate ? fmtDate(h.entry.birthDate) : "—"}</dd>
                <dt>Countries</dt>
                <dd>{h.entry.countries.map((c) => COUNTRY[c] ?? c).join(", ")}</dd>
                <dt>Listed under</dt>
                <dd>{h.entry.programs.join(", ")}</dd>
                <dt>Source</dt>
                <dd>{listSourceLabel(h.entry.source)}</dd>
                <dt>Reference</dt>
                <dd className="mono">{h.entry.id}</dd>
              </dl>
            </div>
          ) : (
            <Compare
              a={<span className="cmp-k">Our record</span>}
              b={<span className="cmp-k">{listWord}</span>}
              score={Math.round(h.score * 100)}
              scoreWord="likely the same"
              rows={[
                rowOf("Name", h.partyName, h.entry.name, /name/),
                ...(party?.kind === "person" ? [rowOf("Born", party.sub?.startsWith("Born") ? party.sub.slice(5) : null, h.entry.birthDate ? fmtDate(h.entry.birthDate) : null, /dob/)] : []),
                rowOf("Country", party?.glyph && party.kind !== "person" ? (COUNTRY[party.glyph] ?? party.glyph) : null, h.entry.countries.map((c) => COUNTRY[c] ?? c).join(", "), /country|nationality/),
                ...(h.reasons.some((r) => /officer/.test(r.feature)) ? [rowOf("Officers", "Shared surname", "Shared surname", /officer/)] : []),
              ]}
            />
          )}
        </SectionTabs>
      )}
      {h && tab === "match" && <ChartBand label="The party and the list entry" height="short" legend={["person", "company", "owns", "controls"]} className="mt-5" />}
      {h && (
        <DecisionBar label="Decision">
          {h.status === "pending" ? (
            can("screening:review") ? (
              <div className="row">
                <Button variant="primary" onClick={() => setAsk("true_match")}>
                  True match
                </Button>
                <Button variant="line" onClick={() => setAsk("false_positive")}>
                  Not a match
                </Button>
                <Button variant="quiet" onClick={() => setAsk("escalate")}>
                  Escalate
                </Button>
              </div>
            ) : (
              <p className="note-info">The compliance officer decides this match</p>
            )
          ) : (
            <p className="note-info">
              {h.reviewedBy}: {h.reviewReason}
            </p>
          )}
        </DecisionBar>
      )}
      <Dialog open={!!ask} onOpenChange={(o) => !o && (setAsk(null), setErr(null))}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{ask === "true_match" ? "True match" : ask === "false_positive" ? "Not a match" : "Escalate"}</DialogTitle>
            <DialogDescription>{ask === "true_match" ? (h?.entry.listKind === "pep" ? "Enhanced checks will apply." : "Work on the client pauses.") : ask === "false_positive" ? "Closes this entry for this person." : "Sends it to the compliance officer."}</DialogDescription>
          </DialogHeader>
          <label className="field">
            <span>Reason</span>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!err} aria-describedby={err ? "hit-err" : undefined} placeholder="What you compared" />
          </label>
          {err && (
            <p className="note-error" id="hit-err" role="alert">
              {err}
            </p>
          )}
          <DialogFooter>
            <Button variant="quiet" onClick={() => setAsk(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => ask && decide(ask)} disabled={review.isPending}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
