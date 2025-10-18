// App shell: the ink spine (like a case binder's spine), then one working surface on every screen: the folio
// (the written record) bound to the exhibit (the board). The binding between them is a resize handle.
// Phones: the folio is the screen, a File | Board switch shows the exhibit, and a five-icon bar replaces the spine.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  ClipboardCheck,
  FileLock2,
  Folders,
  GitMerge,
  Inbox,
  LogOut,
  Menu,
  Moon,
  ScanSearch,
  ScrollText,
  Search,
  Settings2,
  ShieldAlert,
  Sun,
  UserPlus,
  Waypoints,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "../api/endpoints";
import type { Me } from "../api/types";
import { useAuth } from "../lib/auth";
import { useLiveEvents } from "../lib/events";
import { applyTheme, useTheme } from "../lib/theme";
import { PHONE, useMedia } from "../lib/useMedia";
import { BoardProvider, BoardStage } from "./board";
import { Logo } from "./chrome";
import { CommandPalette, openFind } from "./CommandPalette";
import { FolioContext, type FolioWidth } from "./Folio";

interface RailItem {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
  locked?: boolean;
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

function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export function railItems(can: (p: string) => boolean, counts: Record<string, number | undefined>) {
  const work: RailItem[] = [
    { to: "/board", label: "Board", icon: <Waypoints /> },
    { to: "/clients", label: "Clients", icon: <Folders /> },
    ...(can("clients:onboard") ? [{ to: "/onboard", label: "Onboard a client", icon: <UserPlus /> }] : []),
  ];
  const queues: RailItem[] = [
    ...(can("resolution:read") ? [{ to: "/fuse", label: "Fuse or split", icon: <GitMerge />, count: counts.mergeQueue }] : []),
    { to: "/screening", label: "Screening", icon: <ShieldAlert />, count: can("screening:review") ? counts.screeningBacklog : undefined },
    { to: "/alerts", label: "Monitoring alerts", icon: <BellRing />, count: counts.openAlerts },
    ...(can("smr:read") ? [{ to: "/reports", label: "Reports (restricted)", icon: <FileLock2 />, locked: true }] : []),
    ...(can("assistant:use") ? [{ to: "/ask", label: "Ask the board", icon: <ScanSearch /> }] : []),
  ];
  const records: RailItem[] = [
    { to: "/programme", label: "Compliance programme", icon: <ClipboardCheck /> },
    ...(can("audit:read") ? [{ to: "/activity", label: "Activity log", icon: <ScrollText /> }] : []),
  ];
  return { work, queues, records };
}

export function Spine() {
  const { me, can, signOut, setMe } = useAuth();
  const counts = useCounts();
  const nav = useNavigate();
  const theme = useTheme();
  const { pathname } = useLocation();
  if (!me) return null;
  const { work, queues, records } = railItems(can, counts);
  const isOn = (to: string) => pathname === to || pathname.startsWith(`${to.replace(/\/firm$/, "")}/`);
  const link = (i: RailItem) => (
    <Tip key={i.to} text={i.count ? `${i.label} · ${i.count} waiting` : i.label}>
      {/* A plain Link: the tooltip's Slot merges class names as strings, so the active state is worked out here. */}
      <Link to={i.to} className={`rail${isOn(i.to) ? " on" : ""}`} aria-current={isOn(i.to) ? "page" : undefined} aria-label={i.count ? `${i.label}, ${i.count} waiting` : i.label}>
        {i.icon}
        {!!i.count && (
          <span className="count" aria-hidden>
            {i.count}
          </span>
        )}
      </Link>
    </Tip>
  );
  const org = me.activeOrg;
  const stamp = org ? initials(org.name.replace(/\(.*\)/, "").trim()) : "—";
  return (
    <nav className="spine" aria-label="Main">
      <Link to="/board" className="mark" aria-label="Kinroot: the board">
        <Logo light />
      </Link>
      <Tip text="Find  ( / )">
        <button type="button" className="rail" aria-label="Find a person, company or trust" onClick={() => openFind()}>
          <Search />
        </button>
      </Tip>
      <div className="sep" />
      {work.map(link)}
      <div className="sep" />
      {queues.map(link)}
      <div className="sep" />
      {records.map(link)}
      <div className="grow" />
      {link({ to: "/settings/firm", label: "Settings", icon: <Settings2 /> })}
      <DropdownMenu>
        <Tip text={org?.name ?? "Firm"}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="stamp" aria-label={`Firm: ${org?.name}. Switch firm`}>
              {stamp}
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent side="right" align="end" sideOffset={12} className="min-w-[260px]">
          <DropdownMenuLabel>Your firms</DropdownMenuLabel>
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
                <span>
                  <b className="block font-bold">{o.name}</b>
                  <small className="text-muted">
                    {o.roleLabel} · {o.country === "AU" ? "Australia" : "United Kingdom"}
                  </small>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <Tip text={`${me.user.fullName}, ${me.membership?.roleLabel ?? ""}`}>
          <DropdownMenuTrigger asChild>
            <button type="button" className="who" aria-label={`${me.user.fullName}. Account menu`} style={{ background: me.user.avatarColor }}>
              {initials(me.user.fullName)}
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent side="right" align="end" sideOffset={12} className="min-w-[220px]">
          <DropdownMenuLabel>
            <b className="block font-bold">{me.user.fullName}</b>
            <small className="font-normal text-muted">{me.membership?.roleLabel}</small>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => applyTheme(theme === "dark" ? "light" : "dark", true)}>
            {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light board" : "Dark board"}
          </DropdownMenuItem>
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
    </nav>
  );
}

function BottomBar({ onMore }: { onMore: () => void }) {
  const counts = useCounts();
  const waiting = (counts.screeningBacklog ?? 0) + (counts.mergeQueue ?? 0) + (counts.openAlerts ?? 0);
  const items = [
    { to: "/board", label: "Board", icon: <Waypoints /> },
    { to: "/clients", label: "Clients", icon: <Folders /> },
    { to: "/waiting", label: "Waiting", icon: <Inbox />, count: waiting },
    { to: "/ask", label: "Ask", icon: <ScanSearch /> },
  ];
  return (
    <nav className="bottom-bar" aria-label="Main menu">
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive ? "on" : "")}>
          {i.icon}
          {i.label}
          {!!i.count && <span className="count">{i.count}</span>}
        </NavLink>
      ))}
      <button type="button" onClick={onMore}>
        <Menu />
        More
      </button>
    </nav>
  );
}

/** Phones: everything the spine holds that the bottom bar doesn't, in a sheet from the bottom. */
function MoreSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can, signOut, me } = useAuth();
  const counts = useCounts();
  const { work, queues, records } = railItems(can, counts);
  const links = [...work.slice(2), ...queues.filter((q) => q.to !== "/ask"), ...records, { to: "/settings/firm", label: "Settings", icon: <Settings2 /> }];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>More</SheetTitle>
          <SheetDescription>{me?.activeOrg?.name}</SheetDescription>
        </SheetHeader>
        <ul className="more-list">
          {links.map((l) => (
            <li key={l.to}>
              <Link to={l.to} onClick={() => onOpenChange(false)}>
                {l.icon}
                {l.label}
              </Link>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => void signOut().then(() => location.assign("/sign-in"))}>
              <LogOut /> Sign out
            </button>
          </li>
        </ul>
      </SheetContent>
    </Sheet>
  );
}

const SIZE: Record<Exclude<FolioWidth, "full">, number> = { narrow: 36, normal: 44, wide: 60 };

export function AppShell() {
  const auth = useAuth();
  const qc = useQueryClient();
  // Right after signing in, the cache already holds the session before the provider re-renders.
  const me = auth.me ?? qc.getQueryData<Me | null>(["me"]) ?? null;
  const loading = auth.loading && !me;
  const loc = useLocation();
  const phone = useMedia(PHONE);
  const [folioEl, setFolioEl] = useState<HTMLElement | null>(null);
  const [width, setWidthState] = useState<FolioWidth>("normal");
  const [view, setView] = useState<"file" | "board">("file");
  const [more, setMore] = useState(false);
  const group = useRef<ImperativePanelGroupHandle>(null);
  useLiveEvents(!!me);

  const setWidth = useCallback((w: FolioWidth) => setWidthState(w), []);
  useEffect(() => {
    if (width === "full") return;
    // The panels register after the first paint; until then the group has no layout to change.
    const apply = () => {
      try {
        group.current?.setLayout([SIZE[width], 100 - SIZE[width]]);
        return true;
      } catch {
        return false;
      }
    };
    if (apply()) return;
    const raf = requestAnimationFrame(() => void apply());
    return () => cancelAnimationFrame(raf);
  }, [width, phone, folioEl]);
  // A new record starts at the top of the folio; on phones it opens on the file.
  useEffect(() => {
    if (folioEl) folioEl.scrollTop = 0;
    setView("file");
  }, [loc.pathname, folioEl]);
  const folio = useMemo(() => ({ el: folioEl, setWidth }), [folioEl, setWidth]);

  if (loading) return <div className="board" aria-busy="true" />;
  if (!me) return <Navigate to={`/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  const exhibit = (
    <section className="exhibit" aria-label="Exhibit: the board">
      <BoardStage />
      <Outlet />
    </section>
  );
  return (
    <BoardProvider>
      <FolioContext.Provider value={folio}>
        <TooltipProvider delayDuration={250}>
          <a className="skip" href="#folio">
            Skip to the file
          </a>
          <div className="app">
            <Spine />
            <main className="stage" id="work" data-folio={width === "full" ? "full" : undefined} data-view={phone ? view : undefined}>
              {phone ? (
                <>
                  <div className="folio" id="folio" ref={setFolioEl} tabIndex={-1} />
                  {exhibit}
                  {width !== "full" && (
                    <ToggleGroup type="single" className="view-switch" value={view} onValueChange={(v) => v && setView(v as "file" | "board")} aria-label="Show">
                      <ToggleGroupItem value="file">File</ToggleGroupItem>
                      <ToggleGroupItem value="board">Board</ToggleGroupItem>
                    </ToggleGroup>
                  )}
                </>
              ) : (
                <ResizablePanelGroup direction="horizontal" ref={group}>
                  <ResizablePanel id="folio-panel" order={1} defaultSize={SIZE.normal} minSize={28} maxSize={72} className="folio-panel">
                    <div className="folio" id="folio" ref={setFolioEl} tabIndex={-1} />
                  </ResizablePanel>
                  <ResizableHandle aria-label="Resize the file" />
                  <ResizablePanel id="exhibit-panel" order={2} defaultSize={100 - SIZE.normal} minSize={22} className="relative">
                    {exhibit}
                  </ResizablePanel>
                </ResizablePanelGroup>
              )}
            </main>
            <BottomBar onMore={() => setMore(true)} />
          </div>
          <MoreSheet open={more} onOpenChange={setMore} />
          <CommandPalette />
          <Toaster />
        </TooltipProvider>
      </FolioContext.Provider>
    </BoardProvider>
  );
}
