// The Desk (home), desk skeleton: a poster with the count of decisions waiting on the signed-in person, the ticket
// rail (every waiting decision as a ticket, earliest due first), and the book chart: the whole client book as one
// network, clustered by shared officers, owners and addresses. Lenses recolour it; hovering a ticket lights its client.
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BellRing, CalendarClock, ChevronLeft, ChevronRight, FileLock2, GitMerge, PenLine, Scale, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { ChartBand, Status } from "../shell/chart";
import { Page } from "../shell/page";
import { prefersReduced } from "../lib/theme";

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
const TRAY_ICON: Record<TrayItem["kind"] | "report", ReactNode> = {
  signoff: <PenLine size={14} />,
  hit_review: <ShieldAlert size={14} />,
  merge_review: <GitMerge size={14} />,
  disagreement: <Scale size={14} />,
  alert: <BellRing size={14} />,
  review_due: <CalendarClock size={14} />,
  report: <FileLock2 size={14} />,
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
    rows.push({ id: `report:${c.id}`, kind: "report", word: "Report (restricted)", title: c.title.split(" · ")[0]!, subtitle: "Suspicious matter report · restricted", dueOn: c.deadlineOn, due: { text: look.text.replace(" (3-day limit)", ""), late: look.tone === "high" }, href: `/reports/${c.id}`, clientId: null });
  }
  return rows.sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));
}

/** The ticket rail: each waiting decision as a ticket, earliest due first. `vertical` stacks them (phones, Waiting). */
export function Tickets({ rows, caption, onHover, vertical }: { rows: DocketRow[]; caption: string; onHover?: (r: DocketRow | null) => void; vertical?: boolean }) {
  const reduced = prefersReduced();
  const rail = useRef<HTMLOListElement>(null);
  const scroll = (dir: number) => rail.current?.scrollBy({ left: dir * 560, behavior: reduced ? "auto" : "smooth" });
  return (
    <section className={`tickets${vertical ? " vertical" : ""}`} aria-label="Waiting decisions">
      {!vertical && rows.length > 4 && (
        <div className="tickets-nav">
          <span className="k">
            {rows.length} tickets · earliest due first
          </span>
          <button type="button" aria-label="Earlier tickets" onClick={() => scroll(-1)}>
            <ChevronLeft />
          </button>
          <button type="button" aria-label="Later tickets" onClick={() => scroll(1)}>
            <ChevronRight />
          </button>
        </div>
      )}
      <ol ref={rail} className="ticket-rail" aria-label={caption}>
        {rows.map((r, i) => (
          <li key={r.id} className={reduced ? undefined : "ticket-in"} style={reduced ? undefined : { animationDelay: `${Math.min(i, 8) * 40}ms` }}>
            <Link to={r.href} className={`ticket k-${r.kind}${r.due.late ? " late" : ""}`} onMouseEnter={() => onHover?.(r)} onMouseLeave={() => onHover?.(null)} onFocus={() => onHover?.(r)} onBlur={() => onHover?.(null)}>
              <span className="t-kind">
                <span className="g" aria-hidden>
                  {TRAY_ICON[r.kind]}
                </span>
                {r.word}
              </span>
              <b className="t-title">{r.title}</b>
              <small className="t-sub">{r.subtitle}</small>
              <span className="t-due">
                <span className="k">Due</span>
                <span className="v">
                  {r.due.late && <span aria-hidden>▲ </span>}
                  {r.dueOn ? r.due.text : "No deadline"}
                </span>
                <ArrowRight aria-hidden />
              </span>
            </Link>
          </li>
        ))}
        {!rows.length && <li className="ticket-empty">Nothing is waiting. New decisions appear here as soon as they arrive.</li>}
      </ol>
    </section>
  );
}

export default function BoardHome() {
  const { me, can } = useAuth();
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
  const first = me?.user.fullName.split(" ")[0];
  const caption = rows.length ? `${rows.length} waiting for you` : `Nothing waiting for ${first ?? "you"}`;
  const late = rows.filter((r) => r.due.late).length;
  const live = clients.data?.items.filter((c) => c.status !== "exited").length ?? 0;
  const hover = (r: DocketRow | null) => {
    const partyId = r?.clientId ? clients.data?.items.find((c) => c.id === r.clientId)?.partyId : undefined;
    board.engine()?.setSelected(partyId ?? null);
  };
  return (
    <Page skeleton="desk" label="Desk">
      <header className="desk-poster">
        <div className="mast-ref">
          <b>{me?.activeOrg?.name}</b>
          <span className="sep">/</span>
          <span>Desk as at {fmtDate(today())}</span>
        </div>
        <h1 className="dp-title">
          <span className="dp-num set">{rows.length}</span>{" "}
          <span className="dp-words set">{rows.length ? "waiting for you" : `Nothing waiting for ${first ?? "you"}`}</span>
        </h1>
        <div className="dp-foot">
          <p className="dp-sub">{me?.membership?.roleLabel ? `Decisions for ${me.user.fullName}, ${me.membership.roleLabel}. Earliest due first.` : "Earliest due first."}</p>
          <div className="dp-stamps">
            {late > 0 && <Status tone="high">{late} late</Status>}
            <Status tone="neutral" glyph="○">
              {live} clients in the book
            </Status>
          </div>
        </div>
      </header>
      <Tickets rows={rows} caption={caption} onHover={hover} />
      <ChartBand
        label="The client book"
        exhibit="Exhibit"
        title="The client book"
        height="book"
        legend={["company", "trust", "person", "shared"]}
        tools={{}}
        bar={
          <div className="lenses">
            <span className="k" id="lens-label">
              Lens
            </span>
            <ToggleGroup
              type="single"
              aria-labelledby="lens-label"
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
          </div>
        }
        foot={
          <span className="lens-cap" role="status">
            {built?.caption ?? "Loading the client book…"}
          </span>
        }
      >
        {lens === "shared" && clusters.data && (
          <div className="cluster-list">
            <div className="k">Select a group to highlight it</div>
            {clusters.data.slice(0, 5).map((c) => (
              <button key={c.id} type="button" className="cluster-cap" aria-pressed={selectedCluster === c.id} onClick={() => setSelectedCluster(selectedCluster === c.id ? null : c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        )}
      </ChartBand>
    </Page>
  );
}
