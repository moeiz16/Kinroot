// The folio: the written record that sits beside the board on every screen. Routes render their record into it
// through a portal; the shell owns where it sits and how wide it is. Four parts, always in this order:
// caption (a legal file caption), folder tabs, the body, and the decision block at the foot.
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, ListFilter } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { prefersReduced } from "../lib/theme";

export type FolioWidth = "narrow" | "normal" | "wide" | "full";
interface FolioApi {
  el: HTMLElement | null;
  setWidth: (w: FolioWidth) => void;
}
export const FolioContext = createContext<FolioApi>({ el: null, setWidth: () => undefined });
export const useFolio = () => useContext(FolioContext);

/** Render a route's record into the folio. `width` asks the shell for room: narrow, normal, wide or the full stage. */
export function Folio({ label, width = "normal", className, children }: { label: string; width?: FolioWidth; className?: string; children: ReactNode }) {
  const { el, setWidth } = useFolio();
  useEffect(() => setWidth(width), [width, setWidth]);
  if (!el) return null;
  return createPortal(
    <section className={cn("folio-doc folio-settle", className)} aria-label={label}>
      {children}
    </section>,
    el,
  );
}

/** The file caption: a mono reference line, the serif title, a row of stamps, and tools on the right. */
export function Caption({ refLine, title, sub, stamps, tools, restricted, level = 1 }: { refLine?: ReactNode; title: ReactNode; sub?: ReactNode; stamps?: ReactNode; tools?: ReactNode; restricted?: boolean; level?: 1 | 2 }) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <header className={cn("file-caption", restricted && "restricted")}>
      {refLine && <div className="ref">{refLine}</div>}
      <H>{title}</H>
      {sub && <div className="sub">{sub}</div>}
      {stamps && <div className="stamps">{stamps}</div>}
      {tools && <div className="tools">{tools}</div>}
    </header>
  );
}

export interface FolderTab {
  id: string;
  label: string;
  count?: number;
  locked?: boolean;
}

/** Folder tabs over the body. `[` and `]` move between tabs; Esc runs `onEscape` (for example, back to the board). */
export function FolioTabs({ label, tabs, active, onTab, onEscape, children }: { label: string; tabs: FolderTab[]; active: string; onTab: (id: string) => void; onEscape?: () => void; children: ReactNode }) {
  const reduced = prefersReduced();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
      if (document.querySelector("[role=dialog]")) return;
      const i = tabs.findIndex((x) => x.id === active);
      if (e.key === "]" && i < tabs.length - 1) onTab(tabs[i + 1]!.id);
      else if (e.key === "[" && i > 0) onTab(tabs[i - 1]!.id);
      else if (e.key === "Escape" && onEscape) onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, active, onTab, onEscape]);
  return (
    <Tabs value={active} onValueChange={onTab} className="flex-1">
      <TabsList aria-label={`${label} sections`}>
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id} className={t.locked ? "locked" : undefined}>
            {t.locked && (
              <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4">
                <rect x="4" y="11" width="16" height="10" rx="1" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            )}
            {t.label}
            {t.count != null && <span className="n">{t.count}</span>}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={active} forceMount className="folio-body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={active} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.14, ease: "easeOut" }}>
            {children}
          </motion.div>
        </AnimatePresence>
      </TabsContent>
    </Tabs>
  );
}

/** A plain body for folios without tabs. */
export function FolioBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("folio-body", className)}>{children}</div>;
}

/** The decision block: sticky at the foot of the folio, framed like the signature block of a document. */
export function Decision({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="decision" aria-label={label}>
      {children}
    </section>
  );
}

export interface QueueItem {
  id: string;
  title: string;
  detail?: string;
  group?: string;
}

/** Where you are in a queue ("2 of 7"), previous / next, and the whole queue in a searchable list. */
export function QueuePager({ label, items, current, onPick }: { label: string; items: QueueItem[]; current: string | undefined; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const i = items.findIndex((x) => x.id === current);
  const go = (n: number) => {
    const next = items[(n + items.length) % items.length];
    if (next) onPick(next.id);
  };
  const groups = [...new Set(items.map((x) => x.group ?? ""))];
  if (!items.length) return null;
  return (
    <div className="pager" role="group" aria-label={label}>
      <button type="button" aria-label="Previous in the queue" onClick={() => go(i - 1)}>
        <ChevronLeft size={16} />
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="pos" aria-label={`${label}: ${i + 1} of ${items.length}. Show the queue`}>
            <ListFilter size={13} aria-hidden />
            {i >= 0 ? i + 1 : "–"} of {items.length}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[380px] p-0">
          <Command>
            <CommandInput placeholder="Find in this queue" />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              {groups.map((g) => (
                <CommandGroup key={g || "all"} heading={g || label}>
                  {items
                    .filter((x) => (x.group ?? "") === g)
                    .map((x) => (
                      <CommandItem
                        key={x.id}
                        value={`${x.title} ${x.detail ?? ""} ${x.id}`}
                        onSelect={() => {
                          setOpen(false);
                          onPick(x.id);
                        }}
                        data-current={x.id === current || undefined}
                      >
                        <span className="min-w-0">
                          <b className="block truncate font-bold">{x.title}</b>
                          {x.detail && <small className="block truncate text-muted">{x.detail}</small>}
                        </span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <button type="button" aria-label="Next in the queue" onClick={() => go(i + 1)}>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
