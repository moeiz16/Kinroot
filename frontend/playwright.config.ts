// End-to-end checks against the running app (make dev, demo clock: KINROOT_DEMO_TODAY=2025-10-10).
// PW_CHROMIUM may point at an already installed Chromium; otherwise run `npx playwright install chromium` once.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.KINROOT_WEB ?? "http://localhost:3020",
    launchOptions: { args: ["--mute-audio"], executablePath: process.env.PW_CHROMIUM || undefined },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, grepInvert: /@phone/ },
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }, grep: /@phone/ },
  ],
});
