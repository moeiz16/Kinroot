// One chart per page. The provider lives in the shell; a page mounts <BoardStage /> inside its chart band and
// describes what it shows (a scene, traces); the engine does the drawing.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BoardEngine, webglAvailable, type Insets } from "../graph/engine";
import type { Scene, StringSpec } from "../graph/model";
import { ledgerTwin } from "../graph/transforms";
import { prefersReduced, useTheme } from "../lib/theme";

interface Handlers {
  onActivate?: (id: string) => void;
  onThread?: (id: string) => void;
}
interface BoardApi {
  engine: () => BoardEngine | null;
  show: (scene: Scene, opts?: { unfold?: boolean }) => Promise<void>;
  pull: (specs: StringSpec[], opts?: { animate?: boolean; dur?: number }) => Promise<void>;
  clearStrings: () => void;
  setOcclusion: (o: Partial<Insets>, animate?: boolean) => void;
  /** Extra room a route's own floating chrome needs (e.g. the Ask slip); only the fit changes, not other chrome. */
  setReserve: (o: Partial<Insets>) => void;
  setHandlers: (h: Handlers) => void;
  scene: Scene | null;
  occlusion: Insets;
  focused: string | null;
  setFocused: (id: string | null) => void;
  version: number;
  /** internal: lets the stage reach the latest route handlers */
  _wire: Wire;
}
interface Wire {
  handlers: React.MutableRefObject<Handlers>;
  attach: (e: BoardEngine | null) => void;
  setFocused: (id: string | null) => void;
  bump: () => void;
}
const BoardContext = createContext<BoardApi | null>(null);

// Room inside the chart canvas: the toolbar on top, the trace chip at the foot.
const CHROME = { top: 52, bottom: 52, left: 24, right: 24 };

export function BoardProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<BoardEngine | null>(null);
  const handlers = useRef<Handlers>({});
  const pending = useRef<{ scene: Scene; unfold: boolean } | null>(null);
  // What the chart shows now, so a chart that mounts later (or remounts) picks it up.
  const last = useRef<{ scene: Scene; strings: StringSpec[] | null } | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [occlusion, setOcc] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
  const [focused, setFocused] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const occRef = useRef(occlusion);
  const reserveRef = useRef<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
  const insetsFor = (o: Insets): Insets => ({
    top: o.top + CHROME.top + reserveRef.current.top,
    right: o.right + CHROME.right + reserveRef.current.right,
    bottom: o.bottom + CHROME.bottom + reserveRef.current.bottom,
    left: o.left + CHROME.left + reserveRef.current.left,
  });

  const api = useMemo<Omit<BoardApi, "_wire">>(
    () => ({
      engine: () => engineRef.current,
      show: async (s, opts) => {
        setScene(s);
        last.current = { scene: s, strings: null };
        const e = engineRef.current;
        if (!e) {
          pending.current = { scene: s, unfold: !!opts?.unfold };
          return;
        }
        await e.setScene(s, { unfold: opts?.unfold });
        setVersion((v) => v + 1);
      },
      pull: async (specs, opts) => {
        if (last.current) last.current.strings = specs;
        await engineRef.current?.pull(specs, opts);
        setVersion((v) => v + 1);
      },
      clearStrings: () => engineRef.current?.clearStrings(),
      setOcclusion: (o, animate = true) => {
        const next = { ...occRef.current, ...o };
        if (JSON.stringify(next) === JSON.stringify(occRef.current)) return;
        occRef.current = next;
        setOcc(next);
        engineRef.current?.setInsets(insetsFor(next), animate);
      },
      setReserve: (r) => {
        const next = { ...reserveRef.current, ...r };
        if (JSON.stringify(next) === JSON.stringify(reserveRef.current)) return;
        reserveRef.current = next;
        engineRef.current?.setInsets(insetsFor(occRef.current), false);
      },
      setHandlers: (h) => {
        handlers.current = h;
      },
      scene: null,
      occlusion,
      focused: null,
      setFocused,
      version: 0,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const attach = useCallback((e: BoardEngine | null) => {
    engineRef.current = e;
    if (!e) return;
    const o = occRef.current;
    e.setInsets(insetsFor(o));
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      void e.setScene(p.scene, { unfold: p.unfold }).then(() => setVersion((v) => v + 1));
    } else if (last.current) {
      const l = last.current;
      void e
        .setScene(l.scene)
        .then(() => (l.strings ? e.pull(l.strings, { animate: false }) : undefined))
        .then(() => setVersion((v) => v + 1));
    }
  }, []);
  const wire = useMemo<Wire>(() => ({ handlers, attach, setFocused, bump: () => setVersion((v) => v + 1) }), [attach]);
  const value = useMemo(() => ({ ...api, scene, occlusion, focused, version, _wire: wire }), [api, scene, occlusion, focused, version, wire]);

  return (
    <BoardContext.Provider value={value}>
      {children}
    </BoardContext.Provider>
  );
}

export function useBoard(): BoardApi {
  const v = useContext(BoardContext);
  if (!v) throw new Error("useBoard outside BoardProvider");
  return v;
}

/** The chart canvas. Renders a text twin of whatever it shows, for screen readers. */
export function BoardStage({ label }: { label?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const board = useBoard();
  const theme = useTheme();
  const [canDraw] = useState(() => typeof window !== "undefined" && webglAvailable());

  useEffect(() => {
    if (!host.current || !canDraw) return;
    const w = board._wire;
    let throttle = 0;
    const engine = new BoardEngine(host.current, {
      reduced: prefersReduced(),
      ariaLabel: label,
      onActivate: (id) => w.handlers.current.onActivate?.(id),
      onThread: (id) => w.handlers.current.onThread?.(id),
      onFocusNode: (id) => w.setFocused(id),
      onChange: () => {
        if (throttle) return;
        throttle = window.setTimeout(() => {
          throttle = 0;
          w.bump();
        }, 120);
      },
    });
    w.attach(engine);
    if (import.meta.env.DEV) (window as unknown as { __board: BoardEngine }).__board = engine;
    const ro = new ResizeObserver(() => engine.resize());
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      w.attach(null);
      engine.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDraw, label]);

  useEffect(() => {
    board.engine()?.restyle();
  }, [theme, board.engine]); // eslint-disable-line react-hooks/exhaustive-deps

  const twin = board.scene ? ledgerTwin(board.scene.nodes, board.scene.edges) : [];
  return (
    <>
      <div ref={host} className="chart" data-testid="board" aria-hidden={canDraw ? undefined : "true"} />
      {twin.length > 0 && (
        <div className="sr-only" role="region" aria-label="Text version of the chart">
          <ul>
            {twin.map((t) => (
              <li key={t.id}>
                {t.label}
                {t.links.length ? `: ${t.links.join("; ")}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** Show a scene on the board while this component is mounted. */
export function useBoardScene(scene: Scene | null, opts: { unfold?: boolean; strings?: StringSpec[] | null; animateStrings?: boolean } = {}): void {
  const board = useBoard();
  const key = scene?.key ?? null;
  const stringsKey = JSON.stringify(opts.strings?.map((s) => s.ids) ?? null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (!sceneRef.current) return;
    let live = true;
    void board.show(sceneRef.current, { unfold: optsRef.current.unfold }).then(async () => {
      await new Promise((r) => setTimeout(r, 160));
      if (live && optsRef.current.strings?.length) await board.pull(optsRef.current.strings, { animate: optsRef.current.animateStrings !== false });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stringsKey, board.show, board.pull]);
}

export function useBoardHandlers(h: Handlers): void {
  const board = useBoard();
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    board.setHandlers({ onActivate: (id) => ref.current.onActivate?.(id), onThread: (id) => ref.current.onThread?.(id) });
    return () => board.setHandlers({});
  }, [board.setHandlers]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Tell the chart how much of it is covered by page chrome. */
export function useOcclusion(o: Partial<Insets>): void {
  const board = useBoard();
  const k = JSON.stringify(o);
  useEffect(() => {
    board.setOcclusion(JSON.parse(k) as Partial<Insets>);
  }, [k, board.setOcclusion]); // eslint-disable-line react-hooks/exhaustive-deps
}
