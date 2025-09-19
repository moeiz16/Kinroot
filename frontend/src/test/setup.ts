import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { setFetch } from "../api/client";
import { mockFetch, resetMock } from "../api/mock/adapter";

// Sigma's programs reference these constructors at import time.
const g = globalThis as unknown as Record<string, unknown>;
g.WebGL2RenderingContext ??= class {};
g.WebGLRenderingContext ??= class {};
// jsdom has no WebGL, layout observers or media queries: the board falls back to its text twin.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })) as unknown as typeof window.matchMedia;
Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });

beforeEach(() => {
  resetMock();
  localStorage.clear();
  document.cookie = "kr_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  setFetch(mockFetch);
});
afterEach(() => cleanup());
