// Theme and motion preferences. Light is the default; `?theme=dark` and `?still` (settled, reduced motion)
// work like the prototype so screenshots and demos can pin a state.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "kinroot.theme";
const listeners = new Set<() => void>();

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: keep the choice for this visit only */
  }
}

export function initialTheme(): Theme {
  const q = new URLSearchParams(location.search).get("theme");
  if (q === "dark" || q === "light") return q;
  const saved = safeGet(KEY);
  if (saved === "dark" || saved === "light") return saved;
  return "light";
}

export function applyTheme(t: Theme, persist = false): void {
  document.documentElement.dataset.theme = t;
  if (persist) safeSet(KEY, t);
  listeners.forEach((l) => l());
}
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    currentTheme,
    () => "light",
  );
}

let reducedCache: boolean | null = null;
export function prefersReduced(): boolean {
  if (reducedCache !== null) return reducedCache;
  const still = typeof location !== "undefined" && new URLSearchParams(location.search).has("still");
  const media = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  reducedCache = still || media;
  if (reducedCache && typeof document !== "undefined") document.documentElement.classList.add("reduced");
  return reducedCache;
}
export function useReduced(): boolean {
  return prefersReduced();
}
