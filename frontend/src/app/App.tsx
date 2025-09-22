import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider } from "../lib/auth";
import { AppShell } from "../shell/AppShell";
import { makeQueryClient } from "./queryClient";

const Landing = lazy(() => import("../routes/Landing"));
const SignIn = lazy(() => import("../routes/auth/SignIn"));
const SignUp = lazy(() => import("../routes/auth/SignUp"));
const AcceptInvite = lazy(() => import("../routes/auth/AcceptInvite"));
const BoardHome = lazy(() => import("../routes/BoardHome"));
const Clients = lazy(() => import("../routes/Clients"));
const Dossier = lazy(() => import("../routes/dossier/Dossier"));
const Onboard = lazy(() => import("../routes/Onboard"));
const Fuse = lazy(() => import("../routes/Fuse"));
const Screening = lazy(() => import("../routes/Screening"));
const Alerts = lazy(() => import("../routes/Alerts"));
const Reports = lazy(() => import("../routes/Reports"));
const Ask = lazy(() => import("../routes/Ask"));
const Programme = lazy(() => import("../routes/Programme"));
const Activity = lazy(() => import("../routes/Activity"));
const Settings = lazy(() => import("../routes/Settings"));
const Waiting = lazy(() => import("../routes/Waiting"));
const More = lazy(() => import("../routes/More"));
const NotFound = lazy(() => import("../routes/NotFound"));

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Page><Landing /></Page>} />
      <Route path="/sign-in" element={<Page><SignIn /></Page>} />
      <Route path="/sign-up" element={<Page><SignUp /></Page>} />
      <Route path="/invite/:token" element={<Page><AcceptInvite /></Page>} />
      <Route element={<AppShell />}>
        <Route path="/board" element={<Page><BoardHome /></Page>} />
        <Route path="/clients" element={<Page><Clients /></Page>} />
        <Route path="/clients/:id" element={<Page><Dossier /></Page>} />
        <Route path="/clients/:id/:tab" element={<Page><Dossier /></Page>} />
        <Route path="/onboard" element={<Page><Onboard /></Page>} />
        <Route path="/fuse" element={<Page><Fuse /></Page>} />
        <Route path="/fuse/:id" element={<Page><Fuse /></Page>} />
        <Route path="/screening" element={<Page><Screening /></Page>} />
        <Route path="/screening/:id" element={<Page><Screening /></Page>} />
        <Route path="/alerts" element={<Page><Alerts /></Page>} />
        <Route path="/alerts/:id" element={<Page><Alerts /></Page>} />
        <Route path="/reports" element={<Page><Reports /></Page>} />
        <Route path="/reports/:id" element={<Page><Reports /></Page>} />
        <Route path="/ask" element={<Page><Ask /></Page>} />
        <Route path="/programme" element={<Page><Programme /></Page>} />
        <Route path="/activity" element={<Page><Activity /></Page>} />
        <Route path="/settings" element={<Navigate to="/settings/firm" replace />} />
        <Route path="/settings/:section" element={<Page><Settings /></Page>} />
        <Route path="/waiting" element={<Page><Waiting /></Page>} />
        <Route path="/more" element={<Page><More /></Page>} />
        <Route path="*" element={<Page><NotFound /></Page>} />
      </Route>
    </Routes>
  );
}

export function App() {
  const [qc] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
