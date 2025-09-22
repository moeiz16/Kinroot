// Live updates from the API's SSE stream (GET /api/v1/events/stream). Each event refreshes the queries it affects.
// Not used with the offline fixtures, which have no server to push from.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export const EVENT_KEYS: Record<string, string[][]> = {
  "graph.synced": [["graph"], ["ubo"], ["constellation"], ["clusters"]],
  "screening.hit": [["hits"], ["dashboard"]],
  "screening.reviewed": [["hits"], ["dashboard"]],
  "resolution.candidate": [["candidates"], ["dashboard"]],
  "resolution.merged": [["candidates"], ["graph"], ["constellation"]],
  "risk.assessed": [["risk"], ["clients"], ["dashboard"]],
  "edd.updated": [["edd"], ["dashboard"]],
  "alert.raised": [["alerts"], ["dashboard"]],
  "review.due": [["alerts"], ["dashboard"]],
  "case.updated": [["cases"], ["case"]],
};

export function useLiveEvents(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined" || import.meta.env.VITE_API_MOCK === "1") return;
    const es = new EventSource("/api/v1/events/stream", { withCredentials: true });
    const handlers = Object.entries(EVENT_KEYS).map(([name, keys]) => {
      const h = () => keys.forEach((queryKey) => void qc.invalidateQueries({ queryKey }));
      es.addEventListener(name, h);
      return [name, h] as const;
    });
    return () => {
      handlers.forEach(([n, h]) => es.removeEventListener(n, h));
      es.close();
    };
  }, [enabled, qc]);
}
