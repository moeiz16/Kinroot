import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Web app on :3020; /api is proxied to the Django API on :8020 so session and CSRF cookies are same-origin.
// SSE (/api/v1/events/stream) passes through the same proxy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  build: { outDir: "dist", sourcemap: true },
});
