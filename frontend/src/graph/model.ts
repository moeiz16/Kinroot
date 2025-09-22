// The board's own scene model: what the evidence layer draws. Built from graphology payloads by transforms.ts.

export type BKind = "person" | "company" | "trust" | "partnership" | "unknown" | "stack" | "address" | "list";
export type FlagLevel = "review" | "high" | "info";

export interface BNode {
  id: string;
  kind: BKind;
  label: string;
  sub?: string;
  glyph: string;
  level: number;
  /** id of the node this one unfolds out of (the party it owns or controls, one level up) */
  from?: string;
  client?: boolean;
  ubo?: boolean;
  pep?: boolean;
  flags: { text: string; level: FlagLevel }[];
  since?: string; // "+ New since 3 Mar"
  removed?: string; // "– Removed 2 Sep"
  tag?: string; // paper tag hanging off the pin ("Review 3 Mar")
  rec?: string; // "Record A · from Bellmere"
  badge?: number; // numbered citation badge
  cand?: boolean;
  leftLabel?: boolean;
  pin?: boolean; // constellation pin (smaller)
  rating?: "low" | "medium" | "high" | null;
  clientId?: string | null;
  aria: string;
  x: number; // layout px (y grows downward)
  y: number;
}

export type BEdgeKind = "own" | "ctrl" | "unknown" | "faint" | "possible";
export interface BEdge {
  id: string;
  s: string; // interested party (owner / controller)
  t: string; // subject
  kind: BEdgeKind;
  label?: string;
  labelAt?: number;
  pct?: number | null;
  added?: string;
  removed?: string;
  curve?: boolean; // a back edge in a circular holding
  cite?: number; // numbered assistant citation
  citation?: string; // "E-07"
  source?: string; // "ASIC extract"
  validFrom?: string | null;
}

export interface StringSpec {
  /** node ids from the owner up to the client */
  ids: string[];
  weight?: "full" | "faint";
  tag?: { anchor: string; eq: string; value: string };
  steps?: { eq: string; value: string }[];
}

export interface Scene {
  key: string;
  nodes: BNode[];
  edges: BEdge[];
  focusId?: string | null;
  layout?: "layered" | "given";
}
