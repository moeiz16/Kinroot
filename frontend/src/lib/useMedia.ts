import { useSyncExternalStore } from "react";

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof matchMedia === "undefined") return () => undefined;
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => (typeof matchMedia === "undefined" ? false : matchMedia(query).matches),
    () => false,
  );
}
export const PHONE = "(max-width: 760px)";
