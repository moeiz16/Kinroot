// App shell: ink-black icon spine (like a case binder's spine) + the always-present board + route content.
// Phones get a five-icon bottom bar instead of the spine.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Me } from "../api/types";
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
  Settings2,
  ShieldAlert,
  Sun,
  UserPlus,
  Waypoints,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../api/endpoints";
import { useAuth } from "../lib/auth";
import { useLiveEvents } from "../lib/events";
import { applyTheme, useTheme } from "../lib/theme";
import { BoardProvider, BoardStage } from "./board";
import { Logo } from "./chrome";

interface RailItem {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
  locked?: boolean;
  match?: string[];
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
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const show = () => {
    const r = ref.current?.firstElementChild?.getBoundingClientRect();
    if (r) setPos({ x: r.right + 10, y: r.top + r.height / 2 });
  };
  return (
    <span ref={ref} onPointerEnter={show} onPointerLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)} style={{ display: "contents" }}>
      {children}
      {pos && (
        <span className="tip" role="presentation" style={{ left: pos.x, top: pos.y, transform: "translateY(-50%)" }}>
          {text}
        </span>
      )}
    </span>
  );
}

export function Spine() {
  const { me, can, signOut, setMe } = useAuth();
  const counts = useCounts();
  const nav = useNavigate();
  const theme = useTheme();
  const [menu, setMenu] = useState<"firm" | "me" | null>(null);
  if (!me) return null;
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
  const link = (i: RailItem) => (
    <Tip key={i.to} text={i.label}>
      <NavLink to={i.to} className={({ isActive }) => (isActive ? "on" : "")} aria-label={i.count ? `${i.label}, ${i.count} waiting` : i.label}>
        {i.icon}
        {!!i.count && (
          <span className="count" aria-hidden>
            {i.count}
          </span>
        )}
      </NavLink>
    </Tip>
  );
  const org = me.activeOrg;
  const stamp = org ? initials(org.name.replace(/\(.*\)/, "").trim()) : "—";
  return (
    <nav className="spine" aria-label="Main">
      <div className="mark">
        <Logo light />
      </div>
      {work.map(link)}
      <div className="sep" />
      {queues.map(link)}
      <div className="sep" />
      {records.map(link)}
      <div className="grow" />
      {link({ to: "/settings/firm", label: "Settings", icon: <Settings2 />, match: ["/settings"] })}
      <Tip text={org?.name ?? "Firm"}>
        <button className="stamp" aria-label={`Firm: ${org?.name}. Switch firm`} aria-expanded={menu === "firm"} onClick={() => setMenu(menu === "firm" ? null : "firm")}>
          {stamp}
        </button>
      </Tip>
      <Tip text={`${me.user.fullName}, ${me.membership?.roleLabel ?? ""}`}>
        <button className="who" aria-label={`${me.user.fullName}. Account menu`} aria-expanded={menu === "me"} onClick={() => setMenu(menu === "me" ? null : "me")} style={{ background: me.user.avatarColor }}>
          {initials(me.user.fullName)}
        </button>
      </Tip>
      {menu && (
        <Popover onClose={() => setMenu(null)}>
          {menu === "firm" ? (
            <>
              <div className="eyebrow" style={{ padding: "4px 12px 8px" }}>
                Your firms
              </div>
              {me.orgs.map((o) => (
                <button
                  key={o.id}
                  className="pop-item"
                  aria-current={o.id === org?.id}
                  onClick={async () => {
                    setMenu(null);
                    if (o.id === org?.id) return;
                    setMe(await api.auth.switchOrg(o.id));
                    nav("/board");
                    location.reload();
                  }}
                >
                  <b>{o.name}</b>
                  <small>
                    {o.roleLabel} · {o.country === "AU" ? "Australia" : "United Kingdom"}
                  </small>
                </button>
              ))}
            </>
          ) : (
            <>
              <div style={{ padding: "6px 12px 10px", borderBottom: "1px solid var(--rule)" }}>
                <b style={{ display: "block" }}>{me.user.fullName}</b>
                <small className="muted">{me.membership?.roleLabel}</small>
              </div>
              <button className="pop-item row" onClick={() => applyTheme(theme === "dark" ? "light" : "dark", true)}>
                {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />} {theme === "dark" ? "Light board" : "Dark board"}
              </button>
              <button
                className="pop-item row"
                onClick={async () => {
                  await signOut();
                  nav("/sign-in");
                }}
              >
                <LogOut size={16} /> Sign out
              </button>
            </>
          )}
        </Popover>
      )}
    </nav>
  );
}

function Popover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="popover" role="menu">
      {children}
    </div>
  );
}

function BottomBar() {
  const counts = useCounts();
  const waiting = (counts.screeningBacklog ?? 0) + (counts.mergeQueue ?? 0) + (counts.openAlerts ?? 0);
  const items = [
    { to: "/board", label: "Board", icon: <Waypoints /> },
    { to: "/clients", label: "Clients", icon: <Folders /> },
    { to: "/waiting", label: "Waiting", icon: <Inbox />, count: waiting },
    { to: "/ask", label: "Ask", icon: <ScanSearch /> },
    { to: "/more", label: "More", icon: <Menu /> },
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
    </nav>
  );
}

export function AppShell() {
  const auth = useAuth();
  const qc = useQueryClient();
  // Right after signing in, the cache already holds the session before the provider re-renders.
  const me = auth.me ?? qc.getQueryData<Me | null>(["me"]) ?? null;
  const loading = auth.loading && !me;
  const loc = useLocation();
  useLiveEvents(!!me);
  if (loading) return <div className="board" aria-busy="true" />;
  if (!me) return <Navigate to={`/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return (
    <BoardProvider>
      <a className="skip" href="#work">
        Skip to the work area
      </a>
      <div className="app">
        <Spine />
        <main className="stage" id="work" tabIndex={-1}>
          <BoardStage />
          <Outlet />
        </main>
        <BottomBar />
      </div>
    </BoardProvider>
  );
}
