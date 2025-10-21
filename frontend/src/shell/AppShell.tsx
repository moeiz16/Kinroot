// App shell: the trail bar on top of every screen, and the page beneath it. No sidebar, no spine, no dock.
// The bar holds the wordmark, the trail (your path through the files as a chain of shapes), the tallies of what is
// waiting on you, Find, the Index (a full-screen sheet of every destination; also the phone navigation) and your
// account. See DESIGN.md §3.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import { motion } from "motion/react";
import { LayoutGrid, LogOut, Moon, Search, Sun, X } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "../api/endpoints";
import type { Me } from "../api/types";
import { useAuth } from "../lib/auth";
import { useLiveEvents } from "../lib/events";
import { applyTheme, prefersReduced, useTheme } from "../lib/theme";
import { BoardProvider } from "./board";
import { KindGlyph, Mark } from "./chart";
import { CommandPalette, openFind } from "./CommandPalette";
import { clearTrail, placeName, recordHop, setTrailOwner, useTrail, type Hop } from "./trail";

export interface NavItem {
  to: string;
  label: string;
  count?: number;
  locked?: boolean;
  key?: string;
}

export function useCounts() {
  const { me } = useAuth();
  const { data } = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard, enabled: !!me, staleTime: 30_000 });
  return data?.counts ?? {};
}

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Every destination, grouped the way the Index shows them. */
export function navItems(can: (p: string) => boolean, counts: Record<string, number | undefined>) {
  const work: NavItem[] = [
    { to: "/board", label: "Desk", key: "D" },
    { to: "/clients", label: "Clients", key: "C" },
    ...(can("clients:onboard") ? [{ to: "/onboard", label: "Onboard a client", key: "O" }] : []),
  ];
  const decide: NavItem[] = [
    ...(can("resolution:read") ? [{ to: "/fuse", label: "Fuse or split", count: counts.mergeQueue }] : []),
    { to: "/screening", label: "Screening", count: can("screening:review") ? counts.screeningBacklog : undefined },
    { to: "/alerts", label: "Monitoring alerts", count: counts.openAlerts },
    ...(can("smr:read") ? [{ to: "/reports", label: "Reports (restricted)", locked: true }] : []),
    ...(can("assistant:use") ? [{ to: "/ask", label: "Ask the board" }] : []),
  ];
  const record: NavItem[] = [
    { to: "/programme", label: "Compliance programme" },
    ...(can("audit:read") ? [{ to: "/activity", label: "Activity log" }] : []),
    { to: "/settings/firm", label: "Settings" },
  ];
  return { work, decide, record };
}

/** The tallies: what waits on you, in mono numbers with words. */
function Tallies() {
  const { can } = useAuth();
  const counts = useCounts();
  const items = [
    can("screening:review") && { to: "/screening", n: counts.screeningBacklog ?? 0, word: "to screen" },
    can("resolution:read") && { to: "/fuse", n: counts.mergeQueue ?? 0, word: "to fuse" },
    { to: "/alerts", n: counts.openAlerts ?? 0, word: "alerts" },
  ].filter(Boolean) as { to: string; n: number; word: string }[];
  return (
    <ul className="tallies" aria-label="Waiting on you">
      {items.map((t) => (
        <li key={t.to}>
          <Link to={t.to} aria-label={`${t.n} ${t.word}`}>
            <b>{t.n}</b>
            <span>{t.word}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function hopKind(h: Hop) {
  return h.kind === "company" || h.kind === "trust" || h.kind === "person" || h.kind === "partnership" || h.kind === "restricted" ? h.kind : "page";
}

/** The trail: hops joined by elbows. The last is where you are. */
function TrailHops() {
  const all = useTrail();
  const { pathname } = useLocation();
  if (!all.length) return <div className="trail" />;
  // The last four places; earlier ones fold into a count.
  const hops = all.slice(-4);
  const folded = all.length - hops.length;
  return (
    <nav className="trail" aria-label="Your trail">
      <ol>
        {folded > 0 && (
          <li className="hop more">
            <span title={all.slice(0, folded).map((h) => h.label).join(" → ")}>+{folded}</span>
          </li>
        )}
        {hops.map((h, i) => {
          const here = i === hops.length - 1;
          return (
            <Fragment key={h.key}>
              {(i > 0 || folded > 0) && (
                <li className="elbow" aria-hidden>
                  <svg width="18" height="20" viewBox="0 0 18 20">
                    <path d="M1 6 H9 V14 H17" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </li>
              )}
              <li className={cn("hop", here && "here")}>
                {here && h.path === pathname ? (
                  <span aria-current="page">
                    <KindGlyph kind={hopKind(h)} size={13} />
                    <span className="hl">{h.label}</span>
                  </span>
                ) : (
                  <Link to={h.path}>
                    <KindGlyph kind={hopKind(h)} size={13} />
                    <span className="hl">{h.label}</span>
                  </Link>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

const indexListeners = new Set<() => void>();
export function openIndex(): void {
  indexListeners.forEach((l) => l());
}

/** The Index: every destination as a poster word, in three columns. Falls from the top. */
function IndexSheet() {
  const { me, can, signOut } = useAuth();
  const counts = useCounts();
  const theme = useTheme();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const reduced = prefersReduced();
  useEffect(() => {
    const show = () => setOpen(true);
    indexListeners.add(show);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
      if (e.key === "." && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      indexListeners.delete(show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => setOpen(false), [pathname]);
  const { work, decide, record } = navItems(can, counts);
  const cols: [string, NavItem[]][] = [
    ["Work", work],
    ["Decide", decide],
    ["Record", record],
  ];
  let n = 0;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="index-veil" />
        <DialogPrimitive.Content className="index-sheet" aria-describedby={undefined}>
          <div className="index-top">
            <DialogPrimitive.Title className="index-title">Index</DialogPrimitive.Title>
            <span className="index-firm">
              {me?.activeOrg?.name} · {me?.membership?.roleLabel}
            </span>
            <DialogPrimitive.Close className="index-close" aria-label="Close the index">
              <X />
              <span>Close</span>
            </DialogPrimitive.Close>
          </div>
          <nav className="index-cols" aria-label="Main">
            {cols.map(([title, items]) => (
              <section key={title} className="index-col">
                <h2>{title}</h2>
                <ol>
                  {items.map((it) => {
                    const i = n++;
                    const on = pathname === it.to || pathname.startsWith(`${it.to.replace(/\/firm$/, "")}/`);
                    return (
                      <motion.li key={it.to} initial={reduced ? false : { opacity: 0, y: -14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduced ? 0 : 0.04 * i, duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}>
                        <Link to={it.to} aria-current={on ? "page" : undefined} className={cn("index-link", on && "on")} aria-label={it.count ? `${it.label}, ${it.count} waiting` : it.label}>
                          <span className="il-n">{String(i + 1).padStart(2, "0")}</span>
                          <span className="il-word">
                            {it.locked && <KindGlyph kind="restricted" size={22} />}
                            {it.label}
                          </span>
                          {!!it.count && <span className="il-count">{it.count}</span>}
                        </Link>
                      </motion.li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </nav>
          <div className="index-foot">
            <button type="button" onClick={() => applyTheme(theme === "dark" ? "light" : "dark", true)}>
              {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light pages" : "Dark pages"}
            </button>
            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                await signOut();
                clearTrail();
                nav("/sign-in");
              }}
            >
              <LogOut /> Sign out
            </button>
            <span className="index-keys">
              <span className="kbd">.</span> Index · <span className="kbd">/</span> Find · <span className="kbd">[</span> <span className="kbd">]</span> Sections
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Account() {
  const { me, signOut, setMe } = useAuth();
  const nav = useNavigate();
  const theme = useTheme();
  if (!me) return null;
  const org = me.activeOrg;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="acct" aria-label={`${me.user.fullName}, ${org?.name}. Account menu`}>
          <span className="acct-i" style={{ background: me.user.avatarColor }}>
            {initials(me.user.fullName)}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="min-w-[280px]">
        <DropdownMenuLabel>
          <b className="block">{me.user.fullName}</b>
          <small className="font-normal text-muted">{me.membership?.roleLabel}</small>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="micro">Your firms</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={org?.id}
          onValueChange={async (id) => {
            if (id === org?.id) return;
            setMe(await api.auth.switchOrg(id));
            clearTrail();
            nav("/board");
            location.reload();
          }}
        >
          {me.orgs.map((o) => (
            <DropdownMenuRadioItem key={o.id} value={o.id}>
              <span>
                <b className="block">{o.name}</b>
                <small className="text-muted">
                  {o.roleLabel} · {o.country === "AU" ? "Australia" : "United Kingdom"}
                </small>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => applyTheme(theme === "dark" ? "light" : "dark", true)}>
          {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light pages" : "Dark pages"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            await signOut();
            clearTrail();
            nav("/sign-in");
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrailBar() {
  return (
    <header className="trailbar">
      <Link to="/board" className="wordmark" aria-label="Kinroot: your desk">
        <Mark />
        <span className="wm">Kinroot</span>
      </Link>
      <TrailHops />
      <Tallies />
      <div className="bar-actions">
        <button type="button" className="bar-btn find" onClick={() => openFind()} aria-label="Find a person, company or trust">
          <Search />
          <span>Find</span>
          <span className="kbd" aria-hidden>
            /
          </span>
        </button>
        <button type="button" className="bar-btn index" onClick={() => openIndex()} aria-label="Open the index of every page">
          <LayoutGrid />
          <span>Index</span>
        </button>
        <Account />
      </div>
    </header>
  );
}

/** Static places name themselves on the trail; records (a client, a match) name themselves from their page. */
function PlaceHops() {
  const { pathname } = useLocation();
  useEffect(() => {
    const name = placeName(pathname);
    if (name) recordHop({ key: pathname, path: pathname, label: name, kind: "page" });
  }, [pathname]);
  return null;
}

export function AppShell(): ReactNode {
  const auth = useAuth();
  const qc = useQueryClient();
  // Right after signing in, the cache already holds the session before the provider re-renders.
  const me = auth.me ?? qc.getQueryData<Me | null>(["me"]) ?? null;
  const loading = auth.loading && !me;
  const loc = useLocation();
  useLiveEvents(!!me);
  // Before any page records its hop (layout effects run before every passive effect).
  useLayoutEffect(() => {
    if (me) setTrailOwner(`${me.user.id}:${me.activeOrg?.id ?? ""}`);
  }, [me]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [loc.pathname]);

  if (loading) return <div className="app" aria-busy="true" />;
  if (!me) return <Navigate to={`/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return (
    <BoardProvider>
      <TooltipProvider delayDuration={250}>
        <a className="skip" href="#main">
          Skip to the page
        </a>
        <div className="app">
          <TrailBar />
          <PlaceHops />
          <main className="page-host" id="main" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
        <IndexSheet />
        <CommandPalette />
        <Toaster />
      </TooltipProvider>
    </BoardProvider>
  );
}
