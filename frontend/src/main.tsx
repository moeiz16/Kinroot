// Kinroot web app entry. Fonts are bundled offline (@fontsource); the API is /api/v1 via the dev proxy.
import "@fontsource/besley/400.css";
import "@fontsource/besley/500.css";
import "@fontsource/besley/600.css";
import "@fontsource/besley/400-italic.css";
import "@fontsource/besley/500-italic.css";
import "@fontsource/ysabeau-office/400.css";
import "@fontsource/ysabeau-office/500.css";
import "@fontsource/ysabeau-office/600.css";
import "@fontsource/ysabeau-office/700.css";
import "@fontsource/ysabeau-office/400-italic.css";
import "@fontsource/sometype-mono/400.css";
import "@fontsource/sometype-mono/500.css";
import "@fontsource/sometype-mono/600.css";
import "./styles/index.css";
import "./routes/sheets.css";
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
