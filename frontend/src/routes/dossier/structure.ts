// One client's structure, ready for the board: graph + beneficial owners (+ optional before/after diff),
// laid out roots-down, with the default red string to the strongest owner.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../../api/endpoints";
import type { GraphPayload, UboResult, GraphDiff } from "../../api/types";
import { applyPositions, layered } from "../../graph/layout";
import type { BEdge, BNode, Scene, StringSpec } from "../../graph/model";
import { applyDiff, fromPayload, primaryOwner, shortDate, stringsForOwner } from "../../graph/transforms";

export interface Structure {
  scene: Scene;
  nodes: BNode[];
  edges: BEdge[];
  names: (id: string) => string;
  cites: Map<string, string>;
  strings: StringSpec[];
  payload: GraphPayload;
  ubo: UboResult | undefined;
  diff: GraphDiff | undefined;
}

/** The dossier draws parties and their interests; registered addresses belong to the client book's shared-address
 * clusters, so they are left out of a single client's structure (and its ledger twin). */
export function withoutAddresses(p: GraphPayload): GraphPayload {
  const addr = new Set(p.nodes.filter((n) => n.attributes.kind === "address").map((n) => n.key));
  if (!addr.size) return p;
  return { ...p, nodes: p.nodes.filter((n) => !addr.has(n.key)), edges: p.edges.filter((e) => !addr.has(e.source) && !addr.has(e.target)) };
}

export function buildStructure(raw: GraphPayload, ubo: UboResult | undefined, diff: GraphDiff | undefined, compareLabel: string | null, key: string): Structure {
  const payload = withoutAddresses(raw);
  let model = fromPayload(payload, { ubo });
  if (diff && compareLabel) model = applyDiff(model, diff, compareLabel);
  const nodes = applyPositions(model.nodes, layered(model.nodes, model.edges));
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const names = (id: string) => label.get(id) ?? "Unknown";
  const cites = new Map(model.edges.filter((e) => e.citation).map((e) => [e.id, e.citation!]));
  const primary = primaryOwner(ubo);
  const strings = primary ? stringsForOwner(primary, names) : [];
  return { scene: { key, nodes, edges: model.edges }, nodes, edges: model.edges, names, cites, strings, payload, ubo, diff };
}

export function useStructure(clientId: string | undefined, compareFrom: string | null = null) {
  const graph = useQuery({ queryKey: ["graph", clientId], queryFn: () => api.clients.graph(clientId!), enabled: !!clientId });
  const ubo = useQuery({ queryKey: ["ubo", clientId], queryFn: () => api.clients.ubo(clientId!), enabled: !!clientId });
  const diff = useQuery({ queryKey: ["diff", clientId, compareFrom], queryFn: () => api.clients.diff(clientId!, compareFrom!, new Date().toISOString().slice(0, 10)), enabled: !!clientId && !!compareFrom });
  const structure = useMemo(() => {
    if (!graph.data || !clientId) return null;
    if (compareFrom && !diff.data) return null;
    return buildStructure(graph.data, ubo.data, compareFrom ? diff.data : undefined, compareFrom ? shortDate(compareFrom) : null, `client-${clientId}${compareFrom ? `-vs-${compareFrom}` : ""}`);
  }, [graph.data, ubo.data, diff.data, clientId, compareFrom]);
  return { structure, loading: graph.isLoading, error: graph.error ?? null, ubo: ubo.data };
}
