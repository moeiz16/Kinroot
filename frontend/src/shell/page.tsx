// Page skeleton primitives. A screen picks a skeleton (desk, register, chart, faceoff, sealed, brief, form) and
// composes: a masthead (reference line, the title in capitals, stamps), section words, the body and, where a decision
// is made, a decision bar pinned to the foot of the window. See DESIGN.md §4.
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, ListFilter } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { prefersReduced } from "../lib/theme";
import { recordHop, type HopKind } from "./trail";

export type Skeleton = "desk" | "register" | "chart" | "faceoff" | "sealed" | "brief" | "form";

/** A screen. Renders inline in the page under the trail bar; `skeleton` picks the layout (DESIGN.md §4). */
export function Page({ skeleton, label, className, children }: { skeleton: Skeleton; label: string; className?: string; children: ReactNode }) {
  return (
    <section className={cn("page", `sk-${skeleton}`, className)} aria-label={label} data-skeleton={skeleton}>
      {children}
    </section>
  );
}

/** Put this page on the trail (the hop log in the bar). */
export function useHop(label: string | null | undefined, kind: HopKind = "page", key?: string): void {
  const { pathname } = useLocation();
  useEffect(() => {
    if (label) recordHop({ key: key ?? pathname, path: pathname, label, kind });
  }, [label, kind, key, pathname]);
}

/** The masthead: a mono reference line, the title set in capitals, stamps and tools. */
export function Masthead({
  refLine,
  title,
  sub,
  stamps,
  tools,
  restricted,
  level = 1,
  size = "page",
  className,
}: {
  refLine?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  stamps?: ReactNode;
  tools?: ReactNode;
  restricted?: boolean;
  level?: 1 | 2;
  size?: "page" | "name" | "poster";
  className?: string;
}) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <header className={cn("mast", `mast-${size}`, restricted && "restricted", className)}>
      {refLine && <div className="mast-ref">{refLine}</div>}
      <div className="mast-row">
        <H className="mast-title">
          <span className="set">{title}</span>
        </H>
        {tools && <div className="mast-tools">{tools}</div>}
      </div>
      {sub && <div className="mast-sub">{sub}</div>}
      {stamps && <div className="mast-stamps">{stamps}</div>}
    </header>
  );
}

export interface SectionTab {
  id: string;
  label: string;
  count?: number;
  locked?: boolean;
}

/** Section words: big tabs over the record. `[` and `]` move between them; Esc runs `onEscape`. */
export function SectionTabs({ label, tabs, active, onTab, onEscape, children, className }: { label: string; tabs: SectionTab[]; active: string; onTab: (id: string) => void; onEscape?: () => void; children: ReactNode; className?: string }) {
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
    <Tabs value={active} onValueChange={onTab} className={cn("sections", className)}>
      <TabsList aria-label={`${label} sections`}>
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id} className={t.locked ? "locked" : undefined}>
            {t.locked && (
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.6">
                <rect x="4" y="11" width="16" height="10" rx="1" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            )}
            {t.label}
            {t.count != null && <sup className="n">{t.count}</sup>}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={active} forceMount className="section-body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={active} initial={{ opacity: 0, y: reduced ? 0 : 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.2, ease: [0.2, 0.8, 0.2, 1] }}>
            {children}
          </motion.div>
        </AnimatePresence>
      </TabsContent>
    </Tabs>
  );
}

/** A plain body for pages without section words. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("page-body", className)}>{children}</div>;
}

/** The decision bar: pinned to the foot of the window while the page is open. */
export function DecisionBar({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("decision slab", className)} aria-label={label}>
      <div className="decision-in">{children}</div>
    </section>
  );
}

/** A band heading inside a page: a numbered mono index and a Syne word. */
export function Band({ n, title, aside, children, className, id }: { n?: string; title: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string; id?: string }) {
  return (
    <section className={cn("band", className)} id={id}>
      <header className="band-head">
        {n && <span className="band-n">{n}</span>}
        <h2>{title}</h2>
        {aside && <div className="band-aside">{aside}</div>}
      </header>
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
            <span>
              <b>{i >= 0 ? i + 1 : "–"}</b> of {items.length}
            </span>
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
