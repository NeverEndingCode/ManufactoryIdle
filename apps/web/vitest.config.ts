import { defineConfig } from "vitest/config";

// Node by default; a component test opts in with a `// @vitest-environment jsdom` docblock.
// The timeouts are the API's PGlite budgets (apps/api/vitest.config.ts): the sync tests run
// buildServer on an in-process PGlite. `include` keeps e2e/ (Playwright) out.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
