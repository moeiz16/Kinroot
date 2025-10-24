// Kinroot web app entry. Fonts are bundled offline (@fontsource); the API is /api/v1 via the dev proxy.
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/500.css";
import "./styles/index.css";
import "./routes/pages.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setFetch } from "./api/client";
import { App } from "./app/App";
import { applyTheme, initialTheme, prefersReduced } from "./lib/theme";

applyTheme(initialTheme());
prefersReduced();

async function boot() {
  // Offline fixtures only when explicitly asked for (development without the API). The real API is the default.
  if (import.meta.env.VITE_API_MOCK === "1") {
    const { mockFetch } = await import("./api/mock/adapter");
    setFetch(mockFetch);
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void boot();
