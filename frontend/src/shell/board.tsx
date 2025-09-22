// The board is mounted once behind every app route. Routes describe what it shows (a scene, strings) and how
// much of it is covered by a drawer or sheet; the engine does the drawing.
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

const CHROME = { top: 76, bottom: 64, left: 16, right: 16 };

export function BoardProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<BoardEngine | null>(null);
  const handlers = useRef<Handlers>({});
  const pending = useRef<{ scene: Scene; unfold: boolean } | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [occlusion, setOcc] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
  const [focused, setFocused] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const occRef = useRef(occlusion);

  const api = useMemo<Omit<BoardApi, "_wire">>(
    () => ({
      engine: () => engineRef.current,
      show: async (s, opts) => {
        setScene(s);
        const e = engineRef.current;
        if (!e) {
          pending.current = { scene: s, unfold: !!opts?.unfold };
          return;
        }
        await e.setScene(s, { unfold: opts?.unfold });
        setVersion((v) => v + 1);
      },
      pull: async (specs, opts) => {
        await engineRef.current?.pull(specs, opts);
        setVersion((v) => v + 1);
      },
      clearStrings: () => engineRef.current?.clearStrings(),
      setOcclusion: (o, animate = true) => {
        const next = { ...occRef.current, ...o };
        if (JSON.stringify(next) === JSON.stringify(occRef.current)) return;
        occRef.current = next;
        setOcc(next);
        engineRef.current?.setInsets({ top: next.top + CHROME.top, right: next.right + CHROME.right, bottom: next.bottom + CHROME.bottom, left: next.left + CHROME.left }, animate);
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
    e.setInsets({ top: o.top + CHROME.top, right: o.right + CHROME.right, bottom: o.bottom + CHROME.bottom, left: o.left + CHROME.left });
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      void e.setScene(p.scene, { unfold: p.unfold }).then(() => setVersion((v) => v + 1));
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

/** The always-present board. Renders a text twin of whatever it shows, for screen readers. */
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
      <div ref={host} className="board" data-testid="board" aria-hidden={canDraw ? undefined : "true"} />
      {twin.length > 0 && (
        <div className="sr-only" role="region" aria-label="Text version of the board">
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

/** Tell the board how much of it is covered (drawer on the right, sheet on the left, bottom sheet on phones). */
export function useOcclusion(o: Partial<Insets>): void {
  const board = useBoard();
  const k = JSON.stringify(o);
  useEffect(() => {
    board.setOcclusion(JSON.parse(k) as Partial<Insets>);
  }, [k, board.setOcclusion]); // eslint-disable-line react-hooks/exhaustive-deps
}
