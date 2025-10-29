import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Web app on :3020; /api is proxied to the Django API on :8020 so session and CSRF cookies are same-origin.
// SSE (/api/v1/events/stream) passes through the same proxy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 3020,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8020", changeOrigin: false },
    },
  },
  preview: {
    port: 3020,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8020", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: { output: { manualChunks: { graph: ["sigma", "graphology", "graphology-layout-forceatlas2"], react: ["react", "react-dom", "react-router", "@tanstack/react-query", "radix-ui", "cmdk", "sonner", "react-resizable-panels", "@tanstack/react-table"] } } },
  },
  test: {
    environment: "jsdom",
    exclude: ["e2e/**", "node_modules/**"],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
  },
});
