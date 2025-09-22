// The dossier drawer: paper that slides out beside the board, with notched folder tabs sitting on the board.
// Desktop: right edge, 540 px (resizable 480–640). Phone: a bottom sheet with peek · half · full detents.
import { AnimatePresence, motion } from "motion/react";
import { Pin, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PHONE, useMedia } from "../lib/useMedia";
import { prefersReduced } from "../lib/theme";
import { useBoard } from "./board";

export interface FolderTab {
  id: string;
  label: string;
  count?: number;
  locked?: boolean;
}

interface DrawerProps {
  label: string;
  tabs: FolderTab[];
  active: string;
  onTab: (id: string) => void;
  onClose?: () => void;
  pinned?: boolean;
  onPin?: () => void;
  children: ReactNode;
  tools?: boolean;
}

const DETENTS = { peek: 120, half: 0.52, full: 0.9 } as const;
type Detent = keyof typeof DETENTS;

export function Drawer({ label, tabs, active, onTab, onClose, pinned, onPin, children, tools = true }: DrawerProps) {
  const board = useBoard();
  const phone = useMedia(PHONE);
  const reduced = prefersReduced();
  const [width, setWidth] = useState(540);
  const [detent, setDetent] = useState<Detent>("half");
  const id = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const sheetPx = typeof window === "undefined" ? 400 : detent === "peek" ? DETENTS.peek : Math.round((window.innerHeight - 60) * DETENTS[detent]);
  useEffect(() => {
    if (phone) board.setOcclusion({ right: 0, bottom: sheetPx });
    else board.setOcclusion({ right: width, bottom: 0 });
  }, [phone, width, sheetPx, board.setOcclusion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => board.setOcclusion({ right: 0, bottom: 0 }), [board.setOcclusion]); // eslint-disable-line react-hooks/exhaustive-deps

  // [ and ] move between folder tabs; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      const i = tabs.findIndex((x) => x.id === active);
      if (e.key === "]" && i < tabs.length - 1) onTab(tabs[i + 1]!.id);
      else if (e.key === "[" && i > 0) onTab(tabs[i - 1]!.id);
      else if (e.key === "Escape" && onClose && !pinned) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, active, onTab, onClose, pinned]);

  const startResize = (e: React.PointerEvent) => {
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => setWidth(Math.max(480, Math.min(640, w0 + (x0 - ev.clientX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (n < 0 || n >= tabs.length) return;
    e.preventDefault();
    onTab(tabs[n]!.id);
    tabRefs.current[tabs[n]!.id]?.focus();
  };

  return (
    <motion.aside
      className="drawer"
      aria-label={label}
      style={{ ["--drawer-w" as string]: `${width}px`, ...(phone ? { ["--sheet-h" as string]: `${sheetPx}px` } : {}) }}
      initial={reduced ? { opacity: 0 } : phone ? { y: "100%" } : { x: "100%" }}
      animate={reduced ? { opacity: 1 } : phone ? { y: 0 } : { x: 0 }}
      exit={reduced ? { opacity: 0 } : phone ? { y: "100%" } : { x: "100%" }}
      transition={reduced ? { duration: 0.12 } : { duration: 0.36, ease: [0.32, 0.72, 0, 1] }}
    >
      {!phone && <div className="drawer-resize" onPointerDown={startResize} aria-hidden />}
      {phone && (
        <button className="grip" aria-label={`Sheet size: ${detent}. Change size`} onClick={() => setDetent((d) => (d === "peek" ? "half" : d === "half" ? "full" : "peek"))} />
      )}
      <div className="tabs" role="tablist" aria-label={`${label} sections`}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            id={`${id}-tab-${t.id}`}
            className={`tab${t.locked ? " locked" : ""}`}
            role="tab"
            aria-selected={t.id === active}
            aria-controls={`${id}-panel`}
            tabIndex={t.id === active ? 0 : -1}
            onClick={() => onTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.locked && (
              <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4">
                <rect x="4" y="11" width="16" height="10" rx="1" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            )}
            {t.label}
            {t.count != null && <span className="n">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="paper" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active}`} tabIndex={-1}>
        <div className="paper-inner">
          {tools && (onPin || onClose) && (
            <div className="paper-tools">
              {onPin && (
                <button className="iconbtn" aria-pressed={!!pinned} aria-label={pinned ? "Unpin this dossier" : "Pin this dossier open"} onClick={onPin} style={pinned ? { color: "var(--string)" } : undefined}>
                  <Pin />
                </button>
              )}
              {onClose && (
                <button className="iconbtn" aria-label="Close" onClick={onClose}>
                  <X />
                </button>
              )}
            </div>
          )}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={active} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.14, ease: "easeOut" }}>
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </motion.aside>
  );
}

/** Paper sheet for list-heavy routes: slides over the board from the spine; the board stays visible on the right. */
export function Sheet({ label, children, width = 660, wide }: { label: string; children: ReactNode; width?: number; wide?: boolean }) {
  const board = useBoard();
  const phone = useMedia(PHONE);
  const reduced = prefersReduced();
  const w = wide ? Math.min(1000, typeof window !== "undefined" ? window.innerWidth - 64 - 200 : 1000) : width;
  useEffect(() => {
    board.setOcclusion({ left: phone ? 0 : w });
    return () => board.setOcclusion({ left: 0 });
  }, [phone, w, board.setOcclusion]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <motion.section
      className={`sheet${wide ? " wide" : ""}`}
      aria-label={label}
      style={{ width: phone ? "100%" : w }}
      initial={reduced ? { opacity: 0 } : { x: -40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={reduced ? { duration: 0.12 } : { duration: 0.36, ease: [0.32, 0.72, 0, 1] }}
    >
      <div className="sheet-inner">{children}</div>
    </motion.section>
  );
}
