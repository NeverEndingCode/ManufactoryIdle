import { defineConfig } from "vitest/config";

// Every API test starts an in-process PGlite (Postgres compiled to WASM) and migrates it.
// A cold start is ~1 s locally but measured over 10 s on a shared 2-core CI runner while
// the other packages' suites run alongside it, which tripped vitest's default hook timeout.
// These are budgets against a hang, not performance targets.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
