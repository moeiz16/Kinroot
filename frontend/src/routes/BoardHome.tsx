// Home: what waits on the signed-in person (one row per decision, earliest due first) beside the client book, the
// whole book as one network clustered by shared officers, owners and addresses. Lenses re-light it; hovering a row
// lights its client; clicking a client opens its dossier.
import { useQuery } from "@tanstack/react-query";
import { BellRing, CalendarClock, GitMerge, Lock, PenLine, Scale, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "../api/endpoints";
import type { Client, Cluster, GraphPayload, ScreeningHit, TrayItem } from "../api/types";
import { constellationLayout } from "../graph/layout";
import type { BEdge, BKind, BNode, Scene } from "../graph/model";
import { initials } from "../graph/transforms";
import { daysBetween, daysFromToday, fmtDate, today } from "../lib/dates";
import { deadlineLook, ratingLook } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useBoard, useBoardHandlers, useBoardScene } from "../shell/board";
import { ChartBand } from "../shell/chart";
import { Page, PageHeader } from "../shell/page";

export type Lens = "risk" | "review" | "shared" | "screening";
const LENSES: { id: Lens; label: string }[] = [
  { id: "risk", label: "By risk" },
  { id: "review", label: "Reviews due" },
  { id: "shared", label: "Shared people" },
  { id: "screening", label: "Matches" },
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
        flags: lens === "screening" && hit ? [{ text: "Possible match", level: "high" }] : [],
        tag: lens === "review" && due ? (c.nextReviewOn! < today() ? "Overdue" : fmtDate(c.nextReviewOn, { year: false })) : undefined,
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
      sub: undefined,
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
    caption = `${due.length} reviews due in 60 days`;
  } else if (lens === "shared") {
    dim = new Set(clusters.flatMap((c) => [...c.partyIds, ...c.clientIds.map((id) => clients.find((x) => x.id === id)?.partyId ?? "")]));
    caption = `${clusters.length} groups share an officer or address`;
  } else if (lens === "screening") {
    const flagged = live.filter((c) => hits.some((h) => h.clientId === c.id && h.status === "pending"));
    dim = new Set(flagged.map((c) => c.partyId));
    caption = `${flagged.length} with a possible match`;
  } else {
    const n = (r: string) => live.filter((c) => c.rating === r).length;
    caption = `${live.length} clients · ${n("high")} high`;
  }
  return { scene: { key: `constellation-${lens}`, nodes, edges, layout: "given" }, dim, caption };
}

const TRAY_WORD: Record<TrayItem["kind"], string> = { signoff: "Sign-off", hit_review: "Screening", merge_review: "Duplicate", disagreement: "Second opinion", alert: "Alert", review_due: "Review" };
const TRAY_ICON: Record<TrayItem["kind"] | "report", ReactNode> = {
  signoff: <PenLine />,
  hit_review: <ShieldAlert />,
  merge_review: <GitMerge />,
  disagreement: <Scale />,
  alert: <BellRing />,
  review_due: <CalendarClock />,
  report: <Lock />,
};

/** Where a docket entry opens: the API's href is a route in this app; the kind decides when it is missing. */
export function trayHref(t: TrayItem): string {
  if (t.href && t.href.startsWith("/")) return t.href;
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

export interface DocketRow {
  id: string;
  kind: TrayItem["kind"] | "report";
  word: string;
  title: string;
  subtitle: string;
  dueOn: string | null;
  due: { text: string; late: boolean };
  href: string;
  clientId: string | null;
}

/** "Due today", "3 days late", "in 4 days", or "—": computed from today at runtime. */
export function dueText(dueOn: string | null): { text: string; late: boolean } {
  if (!dueOn) return { text: "—", late: false };
  const n = daysBetween(today(), dueOn);
  if (n === 0) return { text: "Due today", late: false };
  if (n < 0) return { text: `${-n} day${n === -1 ? "" : "s"} late`, late: true };
  return { text: n === 1 ? "Tomorrow" : `In ${n} days`, late: false };
}

/** The docket: tray items plus, for people who can see them, restricted report deadlines. Earliest first. */
export function docketRows(tray: TrayItem[], cases: { id: string; title: string; clientId: string; deadlineOn: string; smrStatus: string; status: string }[]): DocketRow[] {
  const rows: DocketRow[] = tray.map((t) => ({ id: `${t.kind}:${t.id}`, kind: t.kind, word: TRAY_WORD[t.kind], title: t.title, subtitle: t.subtitle, dueOn: t.dueOn, due: dueText(t.dueOn), href: trayHref(t), clientId: t.clientId }));
  for (const c of cases) {
    if (c.status !== "open" || c.smrStatus === "submitted") continue;
    const look = deadlineLook(c as never);
    rows.push({ id: `report:${c.id}`, kind: "report", word: "Report", title: c.title.split(" · ")[0]!, subtitle: "Restricted", dueOn: c.deadlineOn, due: { text: look.text.replace(" (3-day limit)", ""), late: look.tone === "high" }, href: `/reports/${c.id}`, clientId: null });
  }
  return rows.sort((a, b) => (a.dueOn || "9999").localeCompare(b.dueOn || "9999"));
}

/** What waits on you, earliest due first: one row per decision (title, kind and when it is due). */
/** "Sign-off needed: Lumen Trade Pty Ltd" → "Lumen Trade Pty Ltd": the kind is said once, underneath. */
export function rowTitle(r: DocketRow, clientName?: string): string {
  const bare = r.title.replace(/^[^:]{3,40}:\s*/, "");
  return clientName && !r.title.includes(clientName) ? `${bare} · ${clientName}` : bare;
}

export function Tickets({ rows, caption, onHover, clientNames }: { rows: DocketRow[]; caption: string; onHover?: (r: DocketRow | null) => void; vertical?: boolean; clientNames?: Map<string, string> }) {
  return (
    <ol className="items" aria-label={caption}>
      {rows.map((r) => (
        <li key={r.id}>
          <Link to={r.href} className="item" onMouseEnter={() => onHover?.(r)} onMouseLeave={() => onHover?.(null)} onFocus={() => onHover?.(r)} onBlur={() => onHover?.(null)}>
            <span className="item-ico" aria-hidden>
              {TRAY_ICON[r.kind]}
            </span>
            <span className="item-main">
              <span className="item-title">{rowTitle(r, r.clientId ? clientNames?.get(r.clientId) : undefined)}</span>
              <span className="item-sub">{r.word}</span>
            </span>
            <span className="item-end">{r.dueOn ? <span className={r.due.late ? "late" : undefined}>{r.due.text}</span> : null}</span>
          </Link>
        </li>
      ))}
      {!rows.length && <li className="empty">Nothing waiting</li>}
    </ol>
  );
}

export default function BoardHome() {
  const { can } = useAuth();
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
  const cases = useQuery({ queryKey: ["cases"], queryFn: api.cases.list, enabled: can("smr:read") });

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

  const rows = useMemo(() => docketRows(dash.data?.fileTray ?? [], cases.data?.items ?? []), [dash.data, cases.data]);
  const caption = rows.length ? `${rows.length} waiting for you` : "Nothing waiting";
  const names = useMemo(() => new Map((clients.data?.items ?? []).map((c) => [c.id, c.name])), [clients.data]);
  const hover = (r: DocketRow | null) => {
    const partyId = r?.clientId ? clients.data?.items.find((c) => c.id === r.clientId)?.partyId : undefined;
    board.engine()?.setSelected(partyId ?? null);
  };
  return (
    <Page label="Home" className="home-page">
      <PageHeader title="Waiting for you" count={rows.length} />
      <div className="home">
        <div className="home-list">
          <Tickets rows={rows} caption={caption} onHover={hover} clientNames={names} />
        </div>
        <ChartBand
          label="The client book"
          height="book"
          legend={["company", "trust", "person", "shared"]}
          bar={
            <ToggleGroup
              type="single"
              aria-label="Lens"
              value={lens}
              onValueChange={(v) => {
                if (!v) return;
                setSelectedCluster(null);
                setParams(v === "risk" ? {} : { lens: v });
              }}
            >
              {LENSES.map((l) => (
                <ToggleGroupItem key={l.id} value={l.id}>
                  {l.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
          foot={
            <>
              <span className="chip" role="status">
                {built?.caption ?? "Loading"}
              </span>
              {lens === "shared" &&
                clusters.data?.slice(0, 4).map((c) => (
                  <button key={c.id} type="button" className="chip" aria-pressed={selectedCluster === c.id} onClick={() => setSelectedCluster(selectedCluster === c.id ? null : c.id)}>
                    {c.label}
                  </button>
                ))}
            </>
          }
        />
      </div>
    </Page>
  );
}
