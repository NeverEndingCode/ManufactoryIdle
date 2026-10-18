import { defineConfig, devices } from "@playwright/test";

// Spec W-23: Chromium only. The webServer entries start the API's guest-only PGlite dev
// server (P-12, no Docker) and `vite preview`, which proxies /api and /auth to it (W-2).
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: [
    {
      command: "pnpm --filter @manufactory/api dev",
      url: "http://127.0.0.1:8787/api/health",
      env: { PORT: "8787" },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm run build && pnpm run preview",
      url: "http://127.0.0.1:4173/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
