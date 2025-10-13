import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AppRoutes } from "../app/App";
import { makeQueryClient } from "../app/queryClient";
import { AuthProvider } from "../lib/auth";

export function signInAs(userId: string | null) {
  if (userId) {
    localStorage.setItem("kinroot.mock.session", JSON.stringify({ userId, orgId: "org-harbourline" }));
    localStorage.setItem("kinroot.session", "1"); // this browser has signed in before
  }
}

export function renderApp(path: string, userId: string | null = "u-daniel") {
  signInAs(userId);
  const qc = makeQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}
