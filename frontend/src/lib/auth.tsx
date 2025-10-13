// Session state: who is signed in, in which firm, with which permissions. Refreshes the session at most every
// 5 minutes while the person is active; a 401 sends them to sign-in and remembers where they were.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { setUnauthenticatedHandler } from "../api/client";
import { api } from "../api/endpoints";
import type { Me } from "../api/types";

interface AuthValue {
  me: Me | null;
  loading: boolean;
  can: (perm: string) => boolean;
  signIn: (email: string, password: string) => Promise<Me>;
  signOut: () => Promise<void>;
  setMe: (me: Me) => void;
}
const AuthContext = createContext<AuthValue | null>(null);

// Public pages only ask "who is signed in?" when this browser signed in before, so a first visit to the landing
// page or sign-in makes no request that is bound to fail.
const HINT = "kinroot.session";
const PUBLIC = (path: string) => path === "/" || path === "/sign-up" || path.startsWith("/sign-in") || path.startsWith("/invite");
function hinted(): boolean {
  try {
    return localStorage.getItem(HINT) === "1";
  } catch {
    return false;
  }
}
function setHint(on: boolean) {
  try {
    if (on) localStorage.setItem(HINT, "1");
    else localStorage.removeItem(HINT);
  } catch {
    /* storage unavailable: the app still works, public pages simply skip the check */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const m = await api.auth.me();
        setHint(true);
        return m;
      } catch (e) {
        setHint(false);
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
    enabled: !PUBLIC(location.pathname) || hinted(),
  });
  const me = meQuery.isError ? null : (meQuery.data ?? null);

  useEffect(() => {
    setUnauthenticatedHandler((code) => {
      setHint(false);
      qc.setQueryData(["me"], null);
      if (!location.pathname.startsWith("/sign-in") && !["/", "/sign-up"].includes(location.pathname) && !location.pathname.startsWith("/invite")) {
        const next = encodeURIComponent(location.pathname + location.search);
        location.assign(`/sign-in?next=${next}${code === "session_expired" ? "&expired=1" : ""}`);
      }
    });
    return () => setUnauthenticatedHandler(null);
  }, [qc]);

  // Rolling refresh while active.
  const last = useRef(Date.now());
  useEffect(() => {
    if (!me) return;
    const onActivity = () => {
      if (Date.now() - last.current > 5 * 60_000) {
        last.current = Date.now();
        api.auth.refresh().catch(() => undefined);
      }
    };
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [me]);

  const setMe = useCallback(
    (m: Me) => {
      setHint(true);
      qc.setQueryData(["me"], m);
    },
    [qc],
  );
  const signIn = useCallback(
    async (email: string, password: string) => {
      await api.auth.csrf().catch(() => undefined);
      const m = await api.auth.login(email, password);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      setHint(true);
      qc.setQueryData(["me"], m);
      return m;
    },
    [qc],
  );
  const signOut = useCallback(async () => {
    await api.auth.logout().catch(() => undefined);
    setHint(false);
    qc.setQueryData(["me"], null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
  }, [qc]);
  const value = useMemo<AuthValue>(
    () => ({ me, loading: meQuery.isLoading, can: (p) => !!me?.membership?.permissions.includes(p), signIn, signOut, setMe }),
    [me, meQuery.isLoading, signIn, signOut, setMe],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

export const DEMO_PASSWORD = "Kinroot-demo-2025!";
export const DEMO_PEOPLE = [
  { email: "daniel@harbourline.example", name: "Daniel Cho", role: "Compliance officer" },
  { email: "tom@harbourline.example", name: "Tom Nguyen", role: "Fee earner" },
  { email: "margaret@harbourline.example", name: "Margaret Ellis", role: "Partner" },
  { email: "ruth@harbourline.example", name: "Ruth Adeyemi", role: "Independent reviewer" },
];
