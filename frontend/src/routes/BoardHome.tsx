// Home: the client constellation. The whole client book as one network; clients that share an officer, owner
// or address cluster together. A file tray of the next decisions sits on top; lenses recolour the pins.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/endpoints";
import type { Client, Cluster, GraphPayload, ScreeningHit, TrayItem } from "../api/types";
import { constellationLayout } from "../graph/layout";
import type { BEdge, BKind, BNode, Scene } from "../graph/model";
import { initials } from "../graph/transforms";
import { daysFromToday, fmtDate, today } from "../lib/dates";
import { ratingLook } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardHandlers, useBoardScene } from "../shell/board";
import { BoardTools, FindPill } from "../shell/chrome";
import "./board-home.css";

export type Lens = "risk" | "review" | "shared" | "screening";
const LENSES: { id: Lens; label: string }[] = [
  { id: "risk", label: "Risk" },
  { id: "review", label: "Review due" },
  { id: "shared", label: "Shared officers" },
  { id: "screening", label: "Screening" },
];
const clientKind: Record<Client["kind"], BKind> = { individual: "person", company: "company", trust: "trust", partnership: "partnership" };

export function constellationScene(payload: GraphPayload, clients: Client[], clusters: Cluster[], hits: ScreeningHit[], lens: Lens): { scene: Scene; dim: Set<string> | null; caption: string } {
  const byParty = new Map(clients.map((c) => [c.partyId, c]));
  const nodes: BNode[] = payload.nodes.map(({ key, attributes: a }) => {
    const c = byParty.get(key);
    if (c) {
      const due = c.nextReviewOn && c.nextReviewOn <= daysFromToday(60);
      const hit = hits.find((h) => h.clientId === c.id && h.status === "pending");
      return {
        id: key,
        kind: clientKind[c.kind],
        label: c.name,
        glyph: c.kind === "individual" ? initials(c.name) : c.kind === "trust" ? "T" : c.kind === "partnership" ? "P" : (c.jurisdiction || "AU").slice(0, 2),
        level: 0,
        pin: true,
        client: true,
        rating: c.rating,
        clientId: c.id,
        flags: lens === "screening" && hit ? [{ text: `▲ Possible ${hit.entry.listKind === "pep" ? "PEP" : "sanctions"} match`, level: "high" }] : [],
        tag: lens === "review" && due ? `Review ${fmtDate(c.nextReviewOn, { year: false })}${c.nextReviewOn! < today() ? " · overdue" : ""}` : undefined,
        aria: `${c.name}, client, rated ${ratingLook(c.rating).word}${due ? `, review due ${fmtDate(c.nextReviewOn)}` : ""}`,
        x: 0,
        y: 0,
      } satisfies BNode;
    }
    const cl = clusters.find((x) => x.partyIds.includes(key));
    return {
      id: key,
      kind: a.kind === "address" ? "address" : (a.kind as BKind),
      label: a.label,
      sub: lens === "shared" && cl ? cl.label : undefined,
      glyph: "",
      level: 1,
      pin: true,
      flags: [],
      aria: `${a.label}${cl ? `, ${cl.label}` : ""}`,
      x: 0,
      y: 0,
    } satisfies BNode;
  });
  const edges: BEdge[] = payload.edges.map((e) => ({ id: e.key, s: e.source, t: e.target, kind: "faint" }));
  const pos = constellationLayout(nodes, edges, 1180, 620);
  nodes.forEach((n) => Object.assign(n, pos.get(n.id)));
  let dim: Set<string> | null = null;
  const live = clients.filter((c) => c.status !== "exited");
  let caption = `${live.length} clients`;
  if (lens === "review") {
    const due = live.filter((c) => c.nextReviewOn && c.nextReviewOn <= daysFromToday(60));
    dim = new Set(due.map((c) => c.partyId));
    caption = `${due.length} reviews due in 60 days · ${due.filter((c) => c.nextReviewOn! < today()).length} overdue`;
  } else if (lens === "shared") {
    dim = new Set(clusters.flatMap((c) => [...c.partyIds, ...c.clientIds.map((id) => clients.find((x) => x.id === id)?.partyId ?? "")]));
    caption = `${clusters.length} groups of clients share an officer or address`;
  } else if (lens === "screening") {
    const flagged = live.filter((c) => hits.some((h) => h.clientId === c.id && h.status === "pending"));
    dim = new Set(flagged.map((c) => c.partyId));
    caption = `${flagged.length} clients with a possible match waiting`;
  } else {
    const n = (r: string) => live.filter((c) => c.rating === r).length;
    caption = `${live.length} clients · ${n("high")} high · ${n("medium")} review · ${n("low")} clear`;
  }
  return { scene: { key: `constellation-${lens}`, nodes, edges, layout: "given" }, dim, caption };
}

const TRAY_WORD: Record<TrayItem["kind"], string> = { signoff: "Sign-off", hit_review: "Screening", merge_review: "Fuse or split", disagreement: "Second opinion", alert: "Alert", review_due: "Review" };

/** Where a tray slip opens in this app (the API's href uses its own route names). */
export function trayHref(t: TrayItem): string {
  switch (t.kind) {
    case "hit_review":
      return `/screening/${t.id}`;
    case "merge_review":
      return `/fuse/${t.id}`;
    case "alert":
      return `/alerts/${t.id}`;
    case "signoff":
    case "disagreement":
      return t.clientId ? `/clients/${t.clientId}/risk` : "/board";
    case "review_due":
      return t.clientId ? `/clients/${t.clientId}/summary` : "/alerts";
  }
}

export function FileTray({ items, caption, current }: { items: TrayItem[]; caption: string; current?: string }) {
  return (
    <div className="tray" role="list" aria-label={caption}>
      <span className="cap">{caption}</span>
      {items.map((t) => (
        <Link key={t.id} to={trayHref(t)} className="slip" role="listitem" aria-current={current === t.id}>
          <span className="k">{TRAY_WORD[t.kind]}</span>
          <b>{t.title}</b>
          <small>{t.subtitle}</small>
        </Link>
      ))}
    </div>
  );
}

export default function BoardHome() {
  const { me } = useAuth();
  const nav = useNavigate();
  const board = useBoard();
  const [params, setParams] = useSearchParams();
  const lens = (params.get("lens") as Lens) || "risk";
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null);
  const payload = useQuery({ queryKey: ["constellation"], queryFn: api.graph.constellation });
  const clients = useQuery({ queryKey: ["clients", "all"], queryFn: () => api.clients.list({ pageSize: 200 }) });
  const clusters = useQuery({ queryKey: ["clusters"], queryFn: () => api.graph.clusters() });
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const hits = useQuery({ queryKey: ["hits", "pending"], queryFn: () => api.screening.hits({ pageSize: 100 }) });

  const built = useMemo(
    () => (payload.data && clients.data ? constellationScene(payload.data, clients.data.items, clusters.data ?? [], hits.data?.items ?? [], lens) : null),
    [payload.data, clients.data, clusters.data, hits.data, lens],
  );
  useBoardScene(built?.scene ?? null);
  // Lens dimming (a caption click narrows to one cluster).
  const dimKey = selectedCluster ?? JSON.stringify(built ? [...(built.dim ?? [])] : null);
  const engineReady = board.version > 0;
  useEffect(() => {
    const cl = clusters.data?.find((c) => c.id === selectedCluster);
    const ids = cl ? new Set([...cl.partyIds, ...cl.clientIds.map((id) => clients.data?.items.find((c) => c.id === id)?.partyId ?? "")]) : built?.dim;
    const t = setTimeout(() => board.engine()?.setDim(ids ?? null), 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimKey, engineReady]);

  useBoardHandlers({
    onActivate: (id) => {
      const c = clients.data?.items.find((x) => x.partyId === id);
      if (c) {
        board.engine()?.flyTo(id, 0.7);
        setTimeout(() => nav(`/clients/${c.id}/summary`), 380);
        return;
      }
      const cl = clusters.data?.find((x) => x.partyIds.includes(id));
      if (cl) setSelectedCluster(selectedCluster === cl.id ? null : cl.id);
    },
  });

  const tray = dash.data?.fileTray ?? [];
  const first = me?.user.fullName.split(" ")[0];
  return (
    <>
      <FindPill phoneVisible />
      <div className="chrome home-tray" style={{ top: 72, left: 16, right: 16 }}>
        <FileTray items={tray} caption={tray.length ? `${tray.length} waiting for you` : `Nothing waiting for ${first ?? "you"}`} />
      </div>
      <BoardTools minimap />
      <div className="chrome lenses" style={{ bottom: 16, left: "calc(50% + 40px)", transform: "translateX(-50%)" }} role="group" aria-label="Lens">
        <span className="board-caption">Lens</span>
        {LENSES.map((l) => (
          <button
            key={l.id}
            className="lens"
            aria-pressed={lens === l.id}
            onClick={() => {
              setSelectedCluster(null);
              setParams(l.id === "risk" ? {} : { lens: l.id });
            }}
          >
            {l.label}
          </button>
        ))}
        <span className="lens-cap" role="status">
          {built?.caption ?? "Loading the client book…"}
        </span>
      </div>
      {lens === "shared" && clusters.data && (
        <div className="chrome cluster-list" style={{ right: 16, bottom: 72 }}>
          <div className="board-caption" style={{ marginBottom: 6 }}>
            Select a group to highlight it
          </div>
          {clusters.data.slice(0, 5).map((c) => (
            <button key={c.id} className="cluster-cap" aria-pressed={selectedCluster === c.id} onClick={() => setSelectedCluster(selectedCluster === c.id ? null : c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
