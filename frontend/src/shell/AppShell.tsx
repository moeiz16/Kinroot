// App shell: one quiet top bar over every screen. The mark, five plain words (Home, Clients, Reviews, Reports for
// the people who may see them, Programme), Search, Ask and the account menu (firms, Activity log, Settings, theme,
// sign out). On phones the words move into a Menu sheet. See DESIGN.md §2.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LogOut, Menu, MessageSquareText, Moon, Search, Settings, ScrollText, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "../api/endpoints";
import type { Me } from "../api/types";
import { useAuth } from "../lib/auth";
import { useLiveEvents } from "../lib/events";
import { applyTheme, useTheme } from "../lib/theme";
import { BoardProvider } from "./board";
import { Mark } from "./chart";
import { CommandPalette, openFind } from "./CommandPalette";

export interface NavItem {
  to: string;
  label: string;
  count?: number;
  locked?: boolean;
  /** other routes that belong to this word */
  also?: string[];
}

export function useCounts() {
  const { me } = useAuth();
  const { data } = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard, enabled: !!me, staleTime: 30_000 });
  return data?.counts ?? {};
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Where Reviews opens for this person: the first queue they can work. */
export function reviewsHome(can: (p: string) => boolean): string {
  return can("screening:review") || !can("resolution:read") ? "/screening" : "/fuse";
}

/** The top-level words, and the account items, for this person. */
export function navItems(can: (p: string) => boolean, counts: Record<string, number | undefined>) {
  const reviews = (can("screening:review") ? (counts.screeningBacklog ?? 0) : 0) + (can("resolution:read") ? (counts.mergeQueue ?? 0) : 0) + (counts.openAlerts ?? 0);
  const main: NavItem[] = [
    { to: "/board", label: "Home", also: ["/waiting"] },
    { to: "/clients", label: "Clients", also: ["/onboard"] },
    { to: reviewsHome(can), label: "Reviews", count: reviews || undefined, also: ["/screening", "/fuse", "/alerts"] },
    ...(can("smr:read") ? [{ to: "/reports", label: "Reports", locked: true }] : []),
    { to: "/programme", label: "Programme" },
  ];
  const account: NavItem[] = [
    ...(can("assistant:use") ? [{ to: "/ask", label: "Ask" }] : []),
    ...(can("audit:read") ? [{ to: "/activity", label: "Activity log" }] : []),
    { to: "/settings/firm", label: "Settings", also: ["/settings"] },
  ];
  return { main, account };
}

function isOn(it: NavItem, pathname: string) {
  return [it.to, ...(it.also ?? [])].some((p) => pathname === p || pathname.startsWith(`${p.replace(/\/firm$/, "")}/`));
}

function MainNav() {
  const { can } = useAuth();
  const counts = useCounts();
  const { pathname } = useLocation();
  const { main } = navItems(can, counts);
  return (
    <nav className="mainnav" aria-label="Main">
      <ul>
        {main.map((it) => (
          <li key={it.label}>
            <Link to={it.to} aria-current={isOn(it, pathname) ? "page" : undefined} aria-label={it.count ? `${it.label}, ${it.count} waiting` : undefined}>
              {it.locked && <Lock aria-hidden />}
              {it.label}
              {!!it.count && <span className="count" aria-hidden>{it.count}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Account() {
  const { me, signOut, setMe, can } = useAuth();
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
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-[260px]">
        <DropdownMenuLabel>
          <span className="block font-medium">{me.user.fullName}</span>
          <small className="font-normal text-muted">{me.membership?.roleLabel}</small>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {me.orgs.length > 1 && (
          <>
            <DropdownMenuRadioGroup
              value={org?.id}
              onValueChange={async (id) => {
                if (id === org?.id) return;
                setMe(await api.auth.switchOrg(id));
                nav("/board");
                location.reload();
              }}
            >
              {me.orgs.map((o) => (
                <DropdownMenuRadioItem key={o.id} value={o.id}>
                  {o.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {can("audit:read") && (
          <DropdownMenuItem onSelect={() => nav("/activity")}>
            <ScrollText /> Activity log
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => nav("/settings/firm")}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => applyTheme(theme === "dark" ? "light" : "dark", true)}>
          {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light mode" : "Dark mode"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            await signOut();
            nav("/sign-in");
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Phones: the same words in a sheet. */
function PhoneMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can, me, signOut } = useAuth();
  const counts = useCounts();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const theme = useTheme();
  const { main, account } = navItems(can, counts);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[300px] p-4" aria-describedby={undefined}>
        <SheetHeader className="p-0">
          <SheetTitle>{me?.activeOrg?.name ?? "Menu"}</SheetTitle>
        </SheetHeader>
        <nav className="phone-nav" aria-label="Menu">
          {main.map((it) => (
            <Link key={it.label} to={it.to} aria-current={isOn(it, pathname) ? "page" : undefined}>
              {it.label}
              {!!it.count && <span className="muted">{it.count}</span>}
            </Link>
          ))}
          <hr />
          {account.map((it) => (
            <Link key={it.label} to={it.to} aria-current={isOn(it, pathname) ? "page" : undefined}>
              {it.label}
            </Link>
          ))}
          <hr />
          <a
            href="#theme"
            onClick={(e) => {
              e.preventDefault();
              applyTheme(theme === "dark" ? "light" : "dark", true);
            }}
          >
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </a>
          <a
            href="#sign-out"
            onClick={async (e) => {
              e.preventDefault();
              await signOut();
              nav("/sign-in");
            }}
          >
            Sign out
          </a>
        </nav>
      </SheetContent>
    </Sheet>
  );
}

function TopBar() {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [pathname]);
  return (
    <header className="topbar">
      <button type="button" className="bar-icon menu-btn" aria-label="Menu" onClick={() => setMenu(true)}>
        <Menu />
      </button>
      <Link to="/board" className="wordmark" aria-label="Kinroot home">
        <Mark />
        <span className="wm">Kinroot</span>
      </Link>
      <MainNav />
      <div className="bar-grow" />
      <div className="bar-actions">
        <button type="button" className="bar-search" onClick={() => openFind()} aria-label="Find a person, company or trust">
          <Search aria-hidden />
          <span>Search</span>
          <span className="kbd" aria-hidden>
            /
          </span>
        </button>
        {can("assistant:use") && (
          <Link to="/ask" className="bar-ask" aria-current={pathname === "/ask" ? "page" : undefined} aria-label="Ask">
            <MessageSquareText aria-hidden />
            <span>Ask</span>
          </Link>
        )}
        <Account />
      </div>
      <PhoneMenu open={menu} onOpenChange={setMenu} />
    </header>
  );
}

export function AppShell(): ReactNode {
  const auth = useAuth();
  const qc = useQueryClient();
  // Right after signing in, the cache already holds the session before the provider re-renders.
  const me = auth.me ?? qc.getQueryData<Me | null>(["me"]) ?? null;
  const loading = auth.loading && !me;
  const loc = useLocation();
  useLiveEvents(!!me);
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
          <TopBar />
          <main className="page-host" id="main" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
        <CommandPalette />
        <Toaster />
      </TooltipProvider>
    </BoardProvider>
  );
}
