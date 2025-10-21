// The client dossier, chart-over-record skeleton: the masthead (matter reference, the name in capitals, stamps), the
// structure chart full width (owners above the client, the trace to each beneficial owner, before/after tags against
// onboarding), section words over the record, and the sign-off in the decision bar at the foot of the window.
import { useQuery } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "../../api/endpoints";
import { stringsForOwner } from "../../graph/transforms";
import type { StringSpec } from "../../graph/model";
import { dueIn, fmtDate, today } from "../../lib/dates";
import { COUNTRY, KIND_LABEL } from "../../lib/format";
import { useAuth } from "../../lib/auth";
import { useBoard, useBoardHandlers, useBoardScene } from "../../shell/board";
import { ChartBand, RatingTag, Status } from "../../shell/chart";
import { DecisionBar, Masthead, Page, SectionTabs, useHop, type SectionTab } from "../../shell/page";
import { NotAvailable } from "../NotFound";
import { DocumentsPanel, OwnersPanel, RestrictedPanel, RiskPanel, ScreeningPanel, SummaryPanel, TimelinePanel, type PanelProps } from "./panels";
import { SignOffBox } from "./SignOffBox";
import { useStructure } from "./structure";

export default function Dossier() {
  const { id = "", tab = "summary" } = useParams();
  const nav = useNavigate();
  const board = useBoard();
  const { can } = useAuth();
  const [compare, setCompare] = useState<string | null | undefined>(undefined);
  const [pinned, setPinned] = useState(false);
  const [pulled, setPulled] = useState<StringSpec | null>(null);

  const client = useQuery({ queryKey: ["client", id], queryFn: () => api.clients.get(id), retry: false });
  const compareFrom = compare === undefined ? (client.data?.onboardedOn ?? null) : compare;
  const { structure } = useStructure(client.data ? id : undefined, compareFrom);
  const risk = useQuery({ queryKey: ["risk", id], queryFn: () => api.clients.risk(id), enabled: !!client.data });
  const edd = useQuery({ queryKey: ["edd", id], queryFn: () => api.clients.edd(id), enabled: !!client.data });
  const docs = useQuery({ queryKey: ["documents", id], queryFn: () => api.clients.documents(id), enabled: !!client.data });
  const hits = useQuery({ queryKey: ["hits", "client", id], queryFn: () => api.screening.hits({ clientId: id, status: "all" }), enabled: !!client.data });
  const audit = useQuery({ queryKey: ["timeline", id], queryFn: () => api.audit.list({ resourceId: id, pageSize: 40 }), enabled: !!client.data && can("audit:read") });
  const pins = useQuery({ queryKey: ["pins", id], queryFn: () => api.clients.pins(id), enabled: !!client.data });
  const cases = useQuery({ queryKey: ["cases"], queryFn: api.cases.list, enabled: can("smr:read") });
  const caseRec = cases.data?.items.find((c) => c.clientId === id && c.status === "open");

  useBoardScene(structure?.scene ?? null, { unfold: true, strings: structure?.strings });
  useEffect(() => {
    if (structure && client.data) board.engine()?.setSelected(client.data.partyId);
  }, [structure, client.data, board.engine, board.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPulled(structure?.strings[0] ?? null), [structure]);
  useHop(client.data?.name, client.data?.kind === "individual" ? "person" : client.data?.kind === "trust" ? "trust" : client.data?.kind === "partnership" ? "partnership" : "company");

  const pullThread = useCallback(
    async (partyId: string | null) => {
      if (!structure || !partyId) return;
      const owner = structure.ubo?.owners.find((o) => o.partyId === partyId);
      let specs: StringSpec[] = owner ? stringsForOwner(owner, structure.names) : [];
      if (!specs.length) {
        const t = await api.parties.thread(partyId).catch(() => null);
        const entry = t?.entries.find((e) => e.clientId === id);
        specs = (entry?.paths ?? []).map((p, i) => ({ ids: p.nodeIds, weight: i === 0 ? "full" : "faint", ...(i === 0 && p.effectivePct != null ? { tag: { anchor: p.nodeIds[0]!, eq: "effective", value: `${p.effectivePct}%` } } : {}) }));
      }
      if (!specs.length) {
        toast(`${structure.names(partyId)} has no ownership or control path to ${client.data?.name}.`);
        return;
      }
      board.engine()?.setSelected(partyId);
      setPulled(specs[0]!);
      await board.pull(specs);
    },
    [structure, board.engine, board.pull, id, client.data], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const onCite = useCallback(
    (edgeId: string) => {
      const e = structure?.edges.find((x) => x.id === edgeId);
      if (!e) return;
      board.engine()?.setDim([e.s, e.t]);
      board.engine()?.flyTo(e.s, 1);
      void board.pull([{ ids: [e.s, e.t], weight: "full" }], { dur: 700 });
      setTimeout(() => board.engine()?.setDim(null), 2600);
    },
    [structure, board.engine, board.pull], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useBoardHandlers({
    onActivate: (nodeId) => {
      const n = structure?.nodes.find((x) => x.id === nodeId);
      if (n?.clientId && n.clientId !== id && !n.client) {
        nav(`/clients/${n.clientId}/summary`);
        return;
      }
      void pullThread(nodeId);
    },
    onThread: (nodeId) => void pullThread(nodeId),
  });

  const counts = useMemo(
    () => ({
      owners: structure?.ubo?.owners.filter((o) => o.isUbo).length ?? 0,
      hits: hits.data?.items.filter((h) => h.status === "pending" || h.status === "true_match").length ?? 0,
      docs: docs.data?.length ?? 0,
    }),
    [structure, hits.data, docs.data],
  );

  if (client.isError) return <NotAvailable />;
  if (!client.data) return null;
  const c = client.data;
  const tabs: SectionTab[] = [
    { id: "summary", label: "Summary" },
    { id: "owners", label: "Owners", count: counts.owners || undefined },
    { id: "screening", label: "Screening", count: counts.hits || undefined },
    { id: "risk", label: "Risk" },
    { id: "documents", label: "Documents", count: counts.docs },
    { id: "timeline", label: "Timeline" },
    ...(caseRec ? [{ id: "restricted", label: "Restricted", locked: true }] : []),
  ];
  const props: PanelProps = { client: c, structure, risk: risk.data, edd: edd.data, docs: docs.data ?? [], hits: hits.data?.items ?? [], onCite, onParty: (pid) => board.engine()?.focusNode(pid), onThread: (pid) => void pullThread(pid) };
  const panel =
    tab === "owners" ? <OwnersPanel {...props} /> : tab === "screening" ? <ScreeningPanel {...props} /> : tab === "risk" ? <RiskPanel {...props} /> : tab === "documents" ? <DocumentsPanel {...props} /> : tab === "timeline" ? <TimelinePanel {...props} audit={audit.data?.items ?? []} pins={pins.data ?? []} /> : tab === "restricted" && caseRec ? <RestrictedPanel caseRec={caseRec} /> : <SummaryPanel {...props} />;
  const clientNode = structure?.nodes.find((n) => n.client);
  const trailHops = pulled ? pulled.ids.map((x) => structure?.names(x) ?? "") : [];
  const dd = edd.data?.required ? (edd.data.status === "approved" ? "Enhanced due diligence complete" : "Enhanced due diligence open") : c.status === "onboarding" ? "Onboarding in progress" : "Standard due diligence";

  return (
    <Page skeleton="chart" label={`Client dossier: ${c.name}`}>
      <Masthead
        size="name"
        refLine={
          <>
            <span>Client file</span>
            <b>{c.matterReference ?? c.id.slice(0, 8)}</b>
            <span className="sep">/</span>
            <span>Fee earner {c.assignedTo?.fullName ?? "unassigned"}</span>
            {c.sample && (
              <>
                <span className="sep">/</span>
                <span>Sample data</span>
              </>
            )}
          </>
        }
        title={c.name}
        sub={
          <span className="mast-facts">
            {clientNode?.sub && clientNode.sub !== "Client" ? <span>{clientNode.sub}</span> : null}
            <span>{KIND_LABEL[c.kind]}</span>
            <span>{COUNTRY[c.jurisdiction] ?? c.jurisdiction}</span>
            <span>{c.onboardedOn ? `Onboarded ${fmtDate(c.onboardedOn)}` : "Onboarding"}</span>
          </span>
        }
        stamps={
          <>
            <RatingTag r={c.rating} />
            {c.status === "blocked" ? <Status tone="high">Work paused: confirmed sanctions match</Status> : <Status tone={edd.data?.required && edd.data.status !== "approved" ? "review" : "neutral"}>{dd}</Status>}
            {c.nextReviewOn && (
              <span className="meta" title={fmtDate(c.nextReviewOn)}>
                Next periodic review {dueIn(c.nextReviewOn)}
              </span>
            )}
          </>
        }
        tools={
          <Button variant="line" size="sm" aria-pressed={pinned} aria-label={pinned ? "Unpin this dossier" : "Keep this dossier open"} onClick={() => setPinned(!pinned)} className={pinned ? "pressed" : undefined}>
            <Pin /> {pinned ? "Kept open" : "Keep open"}
          </Button>
        }
      />
      <ChartBand
        label="Ownership and control"
        exhibit="Exhibit A"
        title="Ownership and control"
        compare={{ asAt: today(), compare: compareFrom, compareLabel: compareFrom === c.onboardedOn ? "onboarding" : undefined, onToggle: () => setCompare(compareFrom ? null : (c.onboardedOn ?? null)), onPick: (d) => setCompare(d) }}
        tools={{ onThread: () => void pullThread(board.focused ?? structure?.ubo?.owners[0]?.partyId ?? null) }}
        trace={trailHops.length > 1 ? { hops: trailHops, end: pulled?.tag ? pulled.tag.value : undefined } : null}
      />
      <SectionTabs label={`Client dossier: ${c.name}`} tabs={tabs} active={tab} onTab={(t) => nav(`/clients/${id}/${t}`)} onEscape={pinned ? undefined : () => nav("/board")} className="record">
        {panel}
      </SectionTabs>
      {tab !== "restricted" && edd.data && (
        <DecisionBar label="Sign-off">
          <SignOffBox client={c} edd={edd.data} />
        </DecisionBar>
      )}
    </Page>
  );
}
