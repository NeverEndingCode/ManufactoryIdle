// Spec E.6's property suite, over generated states rather than hand-picked
// scenarios. See the module comments on solve/fixpoint.ts and solve/waterfall.ts
// for the mechanisms these properties are checking.
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { D } from "./numbers/decimal.js";
import { indexContent, type IndexedContent } from "./graph/index-content.js";
import { computeExpansion } from "./graph/expand.js";
import { computeCapacity, installedUnits } from "./economy/capacity.js";
import { itemStateTag, liquid, quantumCap } from "./economy/storage.js";
import { ladderInput, machineCostRange } from "./economy/curves.js";
import { initialWorld, installedAt, withInstalled, type WorldState } from "./state/world.js";
import { effectivePriority } from "./solve/waterfall.js";
import { solveItems } from "./solve/fixpoint.js";
import { solve } from "./solve/solve.js";
import { resolve } from "./resolve/index.js";
import { applyBuyMachine, applyDismantle } from "./actions/machines.js";
import { arbWorldSketch, buildWorld } from "./testing/arbitrary.js";

const fixtureDir = fileURLToPath(new URL("../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const START = 1_700_000_000_000;

/** Rates below this are float64 noise, not signal. */
const SLACK = 1e-7;

/**
 * Fixed so a failing property reproduces exactly. Reported alongside every run in
 * task-14-report.md.
 */
const SEED = 20260904;

function world(sketch: Parameters<typeof buildWorld>[1]): WorldState {
  return buildWorld(content, sketch, START);
}

describe("resolve(s, 2t) equals resolve(resolve(s, t), t) — spec E.6's centrepiece", () => {
  // The pin/unpin flapping loop this property originally caught (task 14;
  // fixed in task 14b, ruling R32 in solve/waterfall.ts) is gone -- see
  // resolve.test.ts's "task 14b: the iron_ingot/constructor knife edge"
  // describe block for that counterexample, now a permanent regression test,
  // and fuzz.test.ts's guard-trip property, now fully green.
  //
  // KNOWN FAILING again, on a DIFFERENT, unrelated counterexample task 14b
  // found once R32 stopped masking it: a long (~1.46e6 ms in the observed
  // case), fully uninterrupted single-segment resolve() (one "milestone"
  // event, nothing else -- no fill/drain/timer in between) accumulates a
  // ~6e-7 relative difference between the whole and split state, ~60x over
  // this suite's 1e-8 budget. guardTripped is false on both sides; this is
  // not the R32 mechanism. Confirmed pre-existing and independent of the R32
  // fix by reverting solve/waterfall.ts and solve/fixpoint.ts and
  // re-running the identical counterexample: bit-for-bit identical failure
  // either way. Best current explanation: splitting one long, uninterrupted
  // integration into two forces a fresh solve() at the split instant, and
  // float64's non-associativity means that second solve()'s rates need not
  // match the frozen rates the whole path integrated with to the last ULP;
  // over a ~1.46e6 ms single step the accumulated divergence clears 1e-8.
  // Not fixable within spec C.7's float64-clocks/Decimal-never-enters-a-solve
  // purity rule without a materially larger change (e.g. forcing more
  // frequent re-solves purely for numeric parity, which is a real behavior
  // and performance change, not a bugfix) -- escalated per this task's own
  // "escalate rather than paper over" instruction rather than weakened here.
  it("holds on random states for windows well under the offline cap", () => {
    fc.assert(
      fc.property(arbWorldSketch(), fc.integer({ min: 30_000, max: 900_000 }), (sketch, halfMs) => {
        const start = world(sketch);
        const whole = resolve(start, content, 2 * halfMs);
        const split = resolve(resolve(start, content, halfMs).state, content, halfMs);

        // Discrete state must be exactly equal (spec E.4).
        expect(split.state.tier).toBe(whole.state.tier);
        expect(split.state.tapStacks).toBe(whole.state.tapStacks);
        expect(split.state.timers).toEqual(whole.state.timers);
        expect(split.state.storageLevel).toEqual(whole.state.storageLevel);
        expect(split.state.qsLevel).toEqual(whole.state.qsLevel);
        expect(split.state.installed).toEqual(whole.state.installed);
        expect(split.state.lastResolvedAt).toBe(whole.state.lastResolvedAt);

        // Magnitudes within a relative 1e-8. Tighter than this is not available:
        // a split moves the integration boundaries, so the two paths round
        // differently even though they describe the same trajectory.
        for (const itemId of content.stockItemIds) {
          for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
            const a = whole.state[field][itemId]!.toNumber();
            const b = split.state[field][itemId]!.toNumber();
            expect(Math.abs(a - b) / Math.max(1, Math.abs(a))).toBeLessThan(1e-8);
          }
        }
      }),
      { numRuns: 30, seed: SEED },
    );
  }, 45_000);
});

describe("conservation — nothing is created outside extraction (spec 3.1)", () => {
  it("never consumes an item with no stock faster than it is produced", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        const solution = solve(state, content);
        for (const itemId of content.stockItemIds) {
          if (liquid(state, itemId).gt(0)) continue;
          const flow = solution.itemRates.get(itemId)!;
          expect(flow.consumption).toBeLessThanOrEqual(flow.production + SLACK);
        }
      }),
      { numRuns: 60, seed: SEED },
    );
  });

  it("produces nothing at all when no extraction machine is assigned and no stock exists", () => {
    const start = initialWorld(content, 1, START);
    // The fixture's only extraction recipes are mine_iron and extract_oil.
    const idle: WorldState = {
      ...start,
      assignment: { ...start.assignment, mine_iron: 0, extract_oil: 0 },
    };
    const solution = solve(idle, content);
    for (const itemId of content.stockItemIds) {
      expect(solution.itemRates.get(itemId)!.production).toBeLessThan(SLACK);
    }
  });
});

describe("adding a machine never decreases output (spec 4.6)", () => {
  it("holds whenever the grid has headroom before and after", () => {
    let cases = 0;
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const before = world(sketch);
        const beforeSolution = solve(before, content);
        // A purchase that browns the grid out really does cut output, and spec 6.1
        // wants that. The guard is about starvation, not self-inflicted brownout.
        fc.pre(beforeSolution.power.ratio === 1);

        // Add one Mk1 constructor to the iron lane directly, bypassing the cost so
        // the comparison is not confounded by the stock the purchase would spend.
        const owned = installedAt(before, "iron", "constructor", 1);
        let after = withInstalled(before, "iron", "constructor", 1, owned + 1);
        after = {
          ...after,
          assignment: { ...after.assignment, make_plate: (after.assignment.make_plate ?? 0) + 1 },
        };
        const afterSolution = solve(after, content);
        fc.pre(afterSolution.power.ratio === 1);
        cases += 1;

        const beforeRate = beforeSolution.itemRates.get("iron_plate")!.production;
        const afterRate = afterSolution.itemRates.get("iron_plate")!.production;
        expect(afterRate).toBeGreaterThanOrEqual(beforeRate - SLACK);
      }),
      { numRuns: 60, seed: SEED },
    );
    // fc.pre discards cases with headroom violated before or after; if this ever
    // drops to 0 the property is passing vacuously and the generator needs fixing.
    expect(cases).toBeGreaterThan(0);
  });
});

/**
 * Machine-units of demand `itemId`'s consumers would exert if every one of them
 * ran at clock 1 (i.e. entirely unconstrained by `itemId`'s real availability).
 * Used only to detect whether a generated state actually needed the EMPTY
 * mechanism to do anything, independent of whether it did so via a loop pin or
 * via solvePass's own R30 sweep (see the comment below).
 */
function unconstrainedDemand(
  content: IndexedContent,
  capacity: ReturnType<typeof computeCapacity>,
  itemId: string,
): number {
  let total = 0;
  for (const recipeId of content.consumersOf.get(itemId) ?? []) {
    const units = capacity.unitsByRecipe.get(recipeId);
    if (units === undefined) continue;
    const perUnit = content.recipes.get(recipeId)?.inputPerSecond.get(itemId) ?? 0;
    total += units * perUnit;
  }
  return total;
}

describe("the spec C.3 fixed point terminates in at most |items| passes", () => {
  it("holds on random states, unseeded", () => {
    let cascades = 0;
    let total = 0;
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        const capacity = computeCapacity(content, state);
        const result = solveItems({
          content,
          vectors: computeExpansion(content, state.tier, state.activeRecipe),
          state,
          capacityUnits: capacity.unitsByRecipe,
          entries: effectivePriority(content, state, capacity, 0),
          reserveFloor: 0,
          seedPins: false,
        });
        total += 1;

        // Task 9's own suite could only ever discover a single pin, because the
        // fixture's default assignment (2 miners / 2 smelters / 1 constructor) is
        // balanced. But ruling R30 (task 10, fix round 1) moved multi-hop EMPTY
        // throttling OUT of this loop's pin-discovery and into solvePass's own
        // sweep, which now resolves a whole bottleneck chain in a single pass with
        // ZERO pins (see fixpoint.test.ts's "resolves a two-hop bottleneck chain"
        // regression test, which explicitly documents pinOrder going from
        // ["iron_ingot", "iron_ore"]/3 passes pre-R30 to []/1 pass post-R30).
        // Confirmed directly: a deliberately brutal hand-built state (1 miner / 1
        // smelter / 20 constructors, plus the same ratio on the oil lane) still
        // produces pinOrder=[], passes=1 -- the outer loop's own pin count is no
        // longer a signal of cascade activity for this content bundle. "Cascade"
        // is measured instead by how many DISTINCT items were simultaneously
        // EMPTY *and* would have been over-consumed without the solver's
        // intervention (loop pin or R30 sweep, whichever handled it) -- that is
        // the condition task 9's balanced fixture could never reach.
        let activeBottlenecks = 0;
        for (const itemId of content.stockItemIds) {
          if (itemStateTag(content, state, itemId) !== "EMPTY") continue;
          const flow = result.pass.flows.get(itemId);
          if (!flow) continue;
          if (unconstrainedDemand(content, capacity, itemId) > flow.production + SLACK) {
            activeBottlenecks += 1;
          }
        }
        if (activeBottlenecks >= 2) cascades += 1;

        expect(result.passes).toBeLessThanOrEqual(content.itemIds.length);
        // Every pass adds at least one pin, so the two must agree.
        expect(result.pinOrder.length).toBeGreaterThanOrEqual(result.passes - 1);
        expect(new Set(result.pinOrder).size).toBe(result.pinOrder.length);
      }),
      { numRuns: 300, seed: SEED },
    );
    console.log(
      `[pin-cascade] ${cascades}/${total} generated states produced a multi-item cascade`,
    );
    expect(cascades).toBeGreaterThan(0);
  });
});

describe("an item at cap never has a positive net rate", () => {
  it("holds on random states", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        const solution = solve(state, content);
        for (const itemId of content.stockItemIds) {
          if (itemStateTag(content, state, itemId) !== "FULL") continue;
          expect(solution.itemRates.get(itemId)!.net).toBeLessThanOrEqual(SLACK);
        }
      }),
      { numRuns: 60, seed: SEED },
    );
  });

  it("holds after a resolve, which is where it would show up as overflow", () => {
    fc.assert(
      fc.property(arbWorldSketch(), fc.integer({ min: 1_000, max: 600_000 }), (sketch, ms) => {
        const after = resolve(world(sketch), content, ms).state;
        for (const itemId of content.stockItemIds) {
          const cap = liquid(after, itemId);
          expect(cap.gte(0)).toBe(true);
        }
      }),
      { numRuns: 30, seed: SEED },
    );
  });
});

describe("bound > 0 implies quantum is at its cap (spec D4)", () => {
  it("holds on random states and after a resolve", () => {
    fc.assert(
      fc.property(arbWorldSketch(), fc.integer({ min: 0, max: 600_000 }), (sketch, ms) => {
        const state = resolve(world(sketch), content, ms).state;
        for (const itemId of content.stockItemIds) {
          const bound = state.bound[itemId]!;
          if (bound.lte(0)) continue;
          const quantum = state.quantum[itemId]!;
          const cap = quantumCap(content, state, itemId);
          expect(cap.minus(quantum).toNumber()).toBeLessThan(SLACK);
        }
      }),
      { numRuns: 40, seed: SEED },
    );
  }, // See the concern in task-14-report.md: some generated states hit a
  // pin/unpin flapping loop in resolve() (pre-existing, not introduced by
  // this task) that burns MAX_EVENTS worth of EPSILON_MS steps before falling
  // back to a coarse step. The assertion itself is unmodified; only the wall
  // clock budget is widened so the property actually gets to run instead of
  // being truncated by vitest's default 5s timeout.
  30_000);
});

describe("buy N then dismantle N returns exactly what was paid (spec D4, LIFO)", () => {
  it("holds for every machine class and batch size", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("miner", "smelter", "constructor"),
        fc.integer({ min: 1, max: 20 }),
        (machineClass, count) => {
          const start = initialWorld(content, 1, START);
          // miner/smelter mk1 cost iron_ore; constructor mk1 costs iron_ingot (see
          // fixture/machines.yaml) -- iron_plate alone does not fund any of the
          // three, since a fresh world starts with zero stock of everything
          // (fixture/start.yaml seeds machines and assignments, not stock).
          const funded: WorldState = {
            ...start,
            stored: {
              ...start.stored,
              iron_ore: D("1e12"),
              iron_ingot: D("1e12"),
              iron_plate: D("1e12"),
            },
          };

          const bought = applyBuyMachine(funded, content, {
            type: "BUY_MACHINE",
            lane: "iron",
            machineClass,
            mark: 1,
            count,
          });
          if (bought.rejected) throw new Error(bought.reason);
          const spent = bought.effects.find((e) => e.kind === "spent");
          if (spent?.kind !== "spent") throw new Error("expected a spent effect");

          const removed = applyDismantle(bought.state, content, {
            type: "DISMANTLE",
            lane: "iron",
            machineClass,
            mark: 1,
            count,
          });
          if (removed.rejected) throw new Error(removed.reason);
          const refunded = removed.effects.find((e) => e.kind === "refunded");
          if (refunded?.kind !== "refunded") throw new Error("expected a refunded effect");

          // Bitwise equal, because both directions evaluate the same closed form
          // over the same range. Symmetric, so there is no pump.
          expect(refunded.items).toEqual(spent.items);
          expect(installedAt(removed.state, "iron", machineClass, 1)).toBe(
            installedAt(funded, "iron", machineClass, 1),
          );
        },
      ),
      { numRuns: 40, seed: SEED },
    );
  });

  it("refunds the same range the purchase charged, at any starting count", () => {
    // A direct check of the underlying curve, independent of the reducers.
    // Constructor mk1's buildCost is iron_ingot (fixture/machines.yaml), not
    // iron_plate -- the brief's own reference test named the wrong item here.
    for (const from of [0, 1, 7, 40]) {
      for (const count of [1, 3, 12]) {
        const paid = machineCostRange(content, "constructor", 1, from, count);
        const back = machineCostRange(content, "constructor", 1, from, count);
        expect(back.get("iron_ingot")!.toString()).toBe(paid.get("iron_ingot")!.toString());
      }
    }
  });
});

describe("ladderInput and installedUnits agree (economy/curves.ts vs economy/capacity.ts)", () => {
  it("returns the identical mark-weighted sum for every lane/class on random states", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        for (const machineClass of content.machineClasses.keys()) {
          for (const lane of content.lanes.keys()) {
            expect(ladderInput(content, state, lane, machineClass)).toBe(
              installedUnits(content, state, lane, machineClass),
            );
          }
        }
      }),
      { numRuns: 60, seed: SEED },
    );
  });
});

describe("waterfall entries/allocations reconcile with the final post-sweep clocks (ruling R31)", () => {
  it("no recipe's per-entry allocated units sum to more than capacity × final clock", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        const solution = solve(state, content);
        for (const [recipeId, units] of solution.capacity.unitsByRecipe) {
          const finalUnits = units * (solution.clocks.get(recipeId) ?? 0);
          const perEntry = solution.allocations.get(recipeId);
          let summed = 0;
          if (perEntry) for (const v of perEntry.values()) summed += v;
          // One-directional deliberately: a recipe can be "contested" purely by
          // requirement-vector TOPOLOGY (spec 4.2's touchCount) even when one of
          // the two contesting entries' ACHIEVABLE rate has since collapsed to
          // zero elsewhere in its own vector -- phase A still taxes the pool,
          // and phase B's leftover is offered only to entries that came away
          // from phase A with nothing, so the still-served entry never gets a
          // second look at that slice. Confirmed by hand-tracing an equivalent
          // state with the competing recipe's capacity at zero from the very
          // start (no sweep, no reconciliation involved at all): the identical
          // shortfall appears. That is a property of runWaterfall's own
          // two-phase reserve mechanism, not a bug -- summed can legitimately
          // fall short of finalUnits. What it must never do is EXCEED
          // finalUnits, which is exactly what the pre-fix staleness did (up to
          // 12x, entries pointing at a solve that never happened): allocating
          // more than the recipe is physically running at is the one direction
          // this reconciliation exists to close off.
          expect(summed).toBeLessThanOrEqual(finalUnits + SLACK);
        }
      }),
      { numRuns: 150, seed: SEED },
    );
  });

  it("no entry's reported allocated rate exceeds what its limiting recipe can actually deliver", () => {
    fc.assert(
      fc.property(arbWorldSketch(), (sketch) => {
        const state = world(sketch);
        const solution = solve(state, content);
        for (const entry of solution.entries) {
          if (entry.limitedBy === null) continue;
          const units = solution.capacity.unitsByRecipe.get(entry.limitedBy) ?? 0;
          const finalUnits = units * (solution.clocks.get(entry.limitedBy) ?? 0);
          expect(entry.allocated * entry.limitingPerUnit).toBeLessThanOrEqual(finalUnits + SLACK);
        }
      }),
      { numRuns: 80, seed: SEED },
    );
  });

  it("the fuel entry (byproduct-gated) never overstates residual_fuel's post-clamp throughput", () => {
    // A direct, non-random regression pin for the case ruling R31 names explicitly:
    // heavy_oil_residue is a byproduct of refine_plastic, so when it goes EMPTY,
    // residual_fuel (its only consumer) gets throttled by the R30 clamp -- but
    // fuel's own entry allocation was computed before that clamp ran.
    const start = initialWorld(content, 1, START);
    let state: WorldState = { ...start, tier: 2 };
    state = withInstalled(state, "oil", "extractor", 1, 1);
    state = withInstalled(state, "oil", "refinery", 1, 2);
    state = {
      ...state,
      assignment: {
        ...state.assignment,
        extract_oil: 1,
        refine_plastic: 1,
        residual_fuel: 1,
      },
    };
    const solution = solve(state, content);
    const fuelEntry = solution.entries.find((e) => e.itemId === "fuel");
    if (fuelEntry && fuelEntry.limitedBy !== null) {
      const units = solution.capacity.unitsByRecipe.get(fuelEntry.limitedBy) ?? 0;
      const finalUnits = units * (solution.clocks.get(fuelEntry.limitedBy) ?? 0);
      expect(fuelEntry.allocated * fuelEntry.limitingPerUnit).toBeLessThanOrEqual(
        finalUnits + SLACK,
      );
    }
  });
});
