// Kinroot web app entry. Fonts are bundled offline (@fontsource); the API is /api/v1 via the dev proxy.
import "@fontsource/spectral/400.css";
import "@fontsource/spectral/500.css";
import "@fontsource/spectral/600.css";
import "@fontsource/spectral/400-italic.css";
import "@fontsource/spectral/500-italic.css";
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/red-hat-mono/400.css";
import "@fontsource/red-hat-mono/500.css";
import "@fontsource/red-hat-mono/600.css";
import "./styles/index.css";
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
