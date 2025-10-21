// The trail: the path you took through the files in this tab, shown as a hop log in the bar. Opening a place
// already on the trail cuts the trail back to it (like walking back down a chain); a new place is added at the end.
import { useSyncExternalStore } from "react";

export type HopKind = "page" | "company" | "trust" | "person" | "partnership" | "restricted";
export interface Hop {
  key: string;
  path: string;
  label: string;
  kind: HopKind;
}

const MAX = 6;
const listeners = new Set<() => void>();
let owner = "";
let hops: Hop[] = [];

function storeKey() {
  return `kinroot.trail.${owner}`;
}
function save() {
  try {
    sessionStorage.setItem(storeKey(), JSON.stringify(hops));
  } catch {
    /* storage unavailable: the trail lasts for this page only */
  }
}
function load() {
  try {
    const raw = sessionStorage.getItem(storeKey());
    hops = raw ? (JSON.parse(raw) as Hop[]) : [];
  } catch {
    hops = [];
  }
}
function emit() {
  listeners.forEach((l) => l());
}

/** Each person (and firm) gets their own trail; switching user starts a fresh one. */
export function setTrailOwner(id: string): void {
  if (id === owner) return;
  owner = id;
  load();
  emit();
}

/** The key that identifies a place: a dossier's tabs are one place. */
export function hopKey(path: string): string {
  const m = path.match(/^\/clients\/([^/]+)(\/.*)?$/);
  return m ? `/clients/${m[1]}` : path.replace(/^\/settings\/.*/, "/settings");
}

export function recordHop(h: Hop): void {
  const key = hopKey(h.key);
  const at = hops.findIndex((x) => x.key === key);
  const hop = { ...h, key };
  if (at >= 0) hops = [...hops.slice(0, at), hop];
  else hops = [...hops, hop].slice(-MAX);
  save();
  emit();
}

export function clearTrail(): void {
  hops = [];
  save();
  emit();
}

export function useTrail(): Hop[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => hops,
    () => hops,
  );
}

/** Default names for the places that have no record of their own. */
export function placeName(path: string): string | null {
  if (path === "/board") return "Desk";
  if (path === "/clients") return "Clients";
  if (path === "/onboard") return "Onboard";
  if (path === "/fuse") return "Fuse or split";
  if (path === "/screening") return "Screening";
  if (path === "/alerts") return "Alerts";
  if (path === "/reports") return "Reports";
  if (path === "/ask") return "Ask the board";
  if (path === "/programme") return "Programme";
  if (path === "/activity") return "Activity log";
  if (path.startsWith("/settings")) return "Settings";
  if (path === "/waiting") return "Waiting";
  return null;
}
