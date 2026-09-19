// The fuzzer: random states through solve()/resolve(), asserting no NaN, no
// negative stock, and that the MAX_EVENTS/EPSILON guards never trip on
// legitimate input. Task 14 found one class of generated state where that
// last guarantee did not hold (a pin/unpin flapping loop at a knife-edge
// EMPTY equilibrium); task 14b root-caused and fixed it in
// solve/waterfall.ts (ruling R32) -- see that file's module comment.
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { indexContent } from "./graph/index-content.js";
import { liquid, liquidCap } from "./economy/storage.js";
import { solve } from "./solve/solve.js";
import { resolve } from "./resolve/index.js";
import { serializeWorld, deserializeWorld } from "./state/serialize.js";
import { arbWorldSketch, buildWorld } from "./testing/arbitrary.js";

const fixtureDir = fileURLToPath(new URL("../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const START = 1_700_000_000_000;

/** Same fixed seed as properties.test.ts, so a failure here reproduces too. */
const SEED = 20260904;

describe("fuzzing solve", () => {
  it("never returns a NaN, an infinite rate, or a clock outside [0, 1]", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const solution = solve(buildWorld(content, sketch, START), content);
        for (const [, clock] of solution.clocks) {
          expect(Number.isFinite(clock)).toBe(true);
          expect(clock).toBeGreaterThanOrEqual(0);
          expect(clock).toBeLessThanOrEqual(1 + 1e-9);
        }
        for (const [, flow] of solution.itemRates) {
          expect(Number.isFinite(flow.production)).toBe(true);
          expect(Number.isFinite(flow.consumption)).toBe(true);
          expect(flow.production).toBeGreaterThanOrEqual(0);
          expect(flow.consumption).toBeGreaterThanOrEqual(0);
        }
        expect(Number.isFinite(solution.power.ratio)).toBe(true);
        expect(solution.power.ratio).toBeGreaterThanOrEqual(0);
        expect(solution.power.ratio).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100, seed: SEED },
    );
  });
});

describe("fuzzing resolve", () => {
  it("never produces a negative stockpile, a NaN, or an overfilled buffer", () => {
    fc.assert(
      fc.property(
        arbWorldSketch(),
        fc.integer({ min: 0, max: 8 * 60 * 60 * 1000 }),
        (sketch, elapsedMs) => {
          const after = resolve(buildWorld(content, sketch, START), content, elapsedMs).state;
          for (const itemId of content.stockItemIds) {
            for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
              const value = after[field][itemId]!;
              expect(Number.isNaN(value.toNumber())).toBe(false);
              expect(value.gte(0)).toBe(true);
            }
            const cap = liquidCap(content, after, itemId);
            expect(liquid(after, itemId).lte(cap.plus(1e-6))).toBe(true);
          }
        },
      ),
      { numRuns: 60, seed: SEED },
    );
  }, 60_000);

  // Used to fail on a narrow slice of generated states (task 14; fixed in
  // task 14b, ruling R32 in solve/waterfall.ts): a pin/unpin flapping loop at
  // a knife-edge EMPTY equilibrium burned through MAX_EVENTS worth of
  // near-zero-duration steps before the coarse fallback engaged. See
  // resolve.test.ts's "task 14b: the iron_ingot/constructor knife edge"
  // describe block for the concrete counterexample this generator surfaced.
  it(
    "does not trip the spec C.7 guards on legitimate input",
    () => {
      fc.assert(
        fc.property(
          arbWorldSketch(),
          fc.integer({ min: 0, max: 8 * 60 * 60 * 1000 }),
          (sketch, elapsedMs) => {
            const result = resolve(buildWorld(content, sketch, START), content, elapsedMs);
            expect(result.summary.guardTripped).toBe(false);
          },
        ),
        { numRuns: 60, seed: SEED },
      );
    },
    60_000,
  );

  it(
    "round-trips every resolved state through serialization",
    () => {
      fc.assert(
        fc.property(
          arbWorldSketch(),
          fc.integer({ min: 0, max: 600_000 }),
          (sketch, elapsedMs) => {
            const after = resolve(buildWorld(content, sketch, START), content, elapsedMs).state;
            const text = serializeWorld(after);
            expect(serializeWorld(deserializeWorld(text))).toBe(text);
          },
        ),
        { numRuns: 40, seed: SEED },
      );
    },
    30_000,
  );
});

// Phase 2. A net rate must be either meaningfully non-zero or exactly zero — never a
// cancellation crumb in between.
//
// Ruling R30's EMPTY clamp throttles an over-consumed item's consumers by
// `production / consumption`, whose entire purpose is to make the two equal. It then
// re-derives the flows by summing the scaled terms, and in float `sum(cᵢ · factor)` is
// not `(sum cᵢ) · factor` — so the pair lands a few ULPs apart and `net` comes out as
// noise instead of zero. Measured in the wild: 3.552713678800501e-15, exactly 16 ×
// Number.EPSILON, and 1.1102230246251565e-16 against flows of 0.99225.
//
// `resolve` reads that crumb as a real rate. For an item resting at zero it schedules an
// "unpin" a nanosecond out, integrates a nanosecond of 3.5e-15/s, reads the resulting
// 1e-24 as stock, schedules a "drain" back to zero, and repeats — 117.7 loop iterations
// per resolve, 99% of the simulator's wall clock, at 108 ms a call.
//
// The property is stated over random states rather than one reproduction because the
// crumb only appears at particular instants of particular configurations; the invariant
// is what matters, not the example.
describe("flows do not carry cancellation crumbs", () => {
  it("never reports a net that is non-zero but negligible beside its own flows", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const solution = solve(buildWorld(content, sketch, START), content);
        for (const [itemId, flow] of solution.itemRates) {
          if (flow.net === 0) continue;
          const scale = Math.max(Math.abs(flow.production), Math.abs(flow.consumption));
          if (scale === 0) continue;
          expect(
            Math.abs(flow.net) / scale,
            `${itemId}: net ${flow.net} against production ${flow.production} and ` +
              `consumption ${flow.consumption} is neither zero nor a real rate`,
          ).toBeGreaterThan(1e-12);
        }
      }),
      { seed: SEED, numRuns: 400 },
    );
  });
});
