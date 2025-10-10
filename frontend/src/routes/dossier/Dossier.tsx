// The client dossier: the client's structure on the board (roots down, the red string to each beneficial owner,
// before/after tags against onboarding) and the paper file beside it with folder tabs.
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../../api/endpoints";
import { stringsForOwner } from "../../graph/transforms";
import type { StringSpec } from "../../graph/model";
import { today } from "../../lib/dates";
import { useAuth } from "../../lib/auth";
import { useBoard, useBoardHandlers, useBoardScene } from "../../shell/board";
import { AsAt, BoardTools, FindPill, Legend } from "../../shell/chrome";
import { Drawer, type FolderTab } from "../../shell/Drawer";
import { NotAvailable } from "../NotFound";
import { DocumentsPanel, OwnersPanel, RestrictedPanel, RiskPanel, ScreeningPanel, SummaryPanel, TimelinePanel, type PanelProps } from "./panels";
import { useStructure } from "./structure";

export default function Dossier() {
  const { id = "", tab = "summary" } = useParams();
  const nav = useNavigate();
  const board = useBoard();
  const { can } = useAuth();
  const [compare, setCompare] = useState<string | null | undefined>(undefined);
  const [pinned, setPinned] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

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

  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3800);
  };

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
        flash(`${structure.names(partyId)} has no ownership or control path to ${client.data?.name}.`);
        return;
      }
      board.engine()?.setSelected(partyId);
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
  const tabs: FolderTab[] = [
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

  return (
    <>
      <AsAt asAt={today()} compare={compareFrom} compareLabel={compareFrom === c.onboardedOn ? "onboarding" : undefined} onToggle={() => setCompare(compareFrom ? null : (c.onboardedOn ?? null))} onPick={(d) => setCompare(d)} />
      <FindPill width={300} offset={170} />
      <BoardTools onThread={() => void pullThread(board.focused ?? structure?.ubo?.owners[0]?.partyId ?? null)} />
      <Legend />
      {toast && (
        <div className="chrome toast" role="status" style={{ bottom: 70, left: `calc((100% - ${board.occlusion.right}px) / 2)`, transform: "translateX(-50%)" }}>
          {toast}
        </div>
      )}
      <Drawer label={`Client dossier: ${c.name}`} tabs={tabs} active={tab} onTab={(t) => nav(`/clients/${id}/${t}`)} onClose={() => nav("/board")} pinned={pinned} onPin={() => setPinned(!pinned)}>
        {panel}
      </Drawer>
    </>
  );
}
