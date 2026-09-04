import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { computeExpansion } from "../graph/expand.js";
import { indexContent } from "../graph/index-content.js";
import { computeCapacity } from "../economy/capacity.js";
import { liquidCap } from "../economy/storage.js";
import { initialWorld, type WorldState } from "../state/world.js";
import { effectivePriority } from "./waterfall.js";
import { computeFlows, solveItems, solvePass } from "./fixpoint.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

/** Float64 noise budget for rate comparisons. */
const FLOATING_SLACK = 1e-9;

function setup(state: WorldState) {
  const capacity = computeCapacity(content, state);
  return {
    content,
    vectors: computeExpansion(content, state.tier, state.activeRecipe),
    state,
    capacityUnits: capacity.unitsByRecipe,
    entries: effectivePriority(content, state, capacity, 0),
    reserveFloor: 0,
  };
}

describe("computeFlows", () => {
  it("adds up production and consumption across every live recipe", () => {
    const state = initialWorld(content, 1, 0);
    const capacity = computeCapacity(content, state);
    const clocks = new Map([
      ["mine_iron", 1],
      ["smelt_iron", 1],
      ["make_plate", 1],
    ]);
    const flows = computeFlows(content, capacity.unitsByRecipe, clocks);
    // 2 miner units x 1 ore/s = 2 produced; 2 smelter units x 0.5 ore/s = 1 consumed.
    expect(flows.get("iron_ore")!.production).toBeCloseTo(2, 12);
    expect(flows.get("iron_ore")!.consumption).toBeCloseTo(1, 12);
    expect(flows.get("iron_ore")!.net).toBeCloseTo(1, 12);
    // 2 smelter units x 0.5 ingot/s = 1; 1 constructor unit x 0.5 ingot/s = 0.5.
    expect(flows.get("iron_ingot")!.net).toBeCloseTo(0.5, 12);
    // 1 constructor unit x 1/3 plate/s.
    expect(flows.get("iron_plate")!.production).toBeCloseTo(1 / 3, 12);
  });
});

describe("solvePass — the FULL throttle sweep", () => {
  it("throttles producers of an item at cap so its net rate is zero (spec C.2)", () => {
    const base = initialWorld(content, 1, 0);
    // iron_ingot at its combined cap: baseStorageCap 400 + baseQuantumCap 1600.
    const full: WorldState = {
      ...base,
      stored: { ...base.stored, iron_ingot: D(400) },
      quantum: { ...base.quantum, iron_ingot: D(1600) },
    };
    expect(liquidCap(content, full, "iron_ingot").toNumber()).toBe(2000);

    const args = setup(full);
    const pinned = new Set(["iron_ore", "iron_plate"]);
    const result = solvePass({ ...args, pinnedEmpty: pinned });

    // Before the sweep the smelters would run at clock 1, making 1 ingot/s while the
    // constructor consumes 0.5/s. The sweep halves them.
    expect(result.clocks.get("make_plate")).toBeCloseTo(1, 12);
    expect(result.clocks.get("smelt_iron")).toBeCloseTo(0.5, 12);
    expect(result.clocks.get("mine_iron")).toBeCloseTo(1, 12);

    expect(result.flows.get("iron_ingot")!.net).toBeCloseTo(0, 9);
    // Ore: 2/s produced, 2 smelter units x 0.5 clock x 0.5 ore/s = 0.5/s consumed.
    expect(result.flows.get("iron_ore")!.net).toBeCloseTo(1.5, 9);
    expect(result.itemStates.get("iron_ingot")).toBe("FULL");
    expect(result.itemStates.get("iron_ore")).toBe("EMPTY");
  });

  it("leaves a FULL item alone when it is already draining", () => {
    const base = initialWorld(content, 1, 0);
    const full: WorldState = {
      ...base,
      stored: { ...base.stored, iron_ore: D(600) },
      quantum: { ...base.quantum, iron_ore: D(2400) },
      // No miners assigned, so ore is consumed and never produced.
      assignment: { ...base.assignment, mine_iron: 0 },
    };
    const args = setup(full);
    const result = solvePass({ ...args, pinnedEmpty: new Set(["iron_ingot", "iron_plate"]) });
    expect(result.flows.get("iron_ore")!.net).toBeLessThanOrEqual(0);
  });

  it("never leaves an item at cap with a positive net rate (spec E.6)", () => {
    const base = initialWorld(content, 1, 0);
    for (const itemId of ["iron_ore", "iron_ingot", "iron_plate"]) {
      const cap = liquidCap(content, base, itemId);
      const full: WorldState = { ...base, quantum: { ...base.quantum, [itemId]: cap } };
      const args = setup(full);
      const result = solveItems({ ...args, seedPins: true });
      expect(result.pass.flows.get(itemId)!.net).toBeLessThanOrEqual(FLOATING_SLACK);
    }
  });
});

describe("solveItems — the EMPTY fixed point (spec C.3)", () => {
  it("discovers the pins one at a time when unseeded", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: false });
    // Every stockpile is zero, so consumption must be clamped to production for any
    // item something pulls through.
    expect(result.passes).toBeGreaterThanOrEqual(1);
    expect(result.pass.flows.get("iron_ingot")!.net).toBeGreaterThanOrEqual(-FLOATING_SLACK);
    expect(result.pass.flows.get("iron_ore")!.net).toBeGreaterThanOrEqual(-FLOATING_SLACK);
  });

  it("terminates within |items| passes", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: false });
    expect(result.passes).toBeLessThanOrEqual(content.itemIds.length);
  });

  it("seeds every empty item and converges in a single pass", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: true });
    expect(result.passes).toBe(1);
    expect(result.pinnedEmpty.has("iron_ore")).toBe(true);
    expect(result.pinnedEmpty.has("iron_ingot")).toBe(true);
  });

  it("does not pin an item that has stock to draw on", () => {
    const base = initialWorld(content, 1, 0);
    const withStock: WorldState = { ...base, stored: { ...base.stored, iron_ingot: D(500) } };
    const result = solveItems({ ...setup(withStock), seedPins: true });
    expect(result.pinnedEmpty.has("iron_ingot")).toBe(false);
    expect(result.pass.itemStates.get("iron_ingot")).toBe("FLOWING");
  });

  it("lets a stocked item drain faster than it is produced (spec C.2)", () => {
    const base = initialWorld(content, 1, 0);
    // No smelters at all, but a bank of ingots: the constructor should still run.
    const draining: WorldState = {
      ...base,
      stored: { ...base.stored, iron_ingot: D(5000) },
      assignment: { ...base.assignment, smelt_iron: 0 },
    };
    const result = solveItems({ ...setup(draining), seedPins: true });
    expect(result.pass.clocks.get("make_plate")).toBeCloseTo(1, 12);
    expect(result.pass.flows.get("iron_ingot")!.net).toBeCloseTo(-0.5, 12);
  });

  it("records the order pins were added, for the explain command", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: false });
    expect(Array.isArray(result.pinOrder)).toBe(true);
    expect(new Set(result.pinOrder).size).toBe(result.pinOrder.length);
  });

  it("agrees with the unseeded fixed point on the fixture start state", () => {
    const state = initialWorld(content, 1, 0);
    const seeded = solveItems({ ...setup(state), seedPins: true });
    const unseeded = solveItems({ ...setup(state), seedPins: false });
    for (const itemId of content.stockItemIds) {
      expect(seeded.pass.flows.get(itemId)!.net).toBeCloseTo(
        unseeded.pass.flows.get(itemId)!.net,
        9,
      );
    }
  });

  it("never produces a NaN or infinite rate", () => {
    const state = initialWorld(content, 1, 0);
    const result = solveItems({ ...setup(state), seedPins: true });
    for (const flow of result.pass.flows.values()) {
      expect(Number.isFinite(flow.production)).toBe(true);
      expect(Number.isFinite(flow.consumption)).toBe(true);
      expect(Number.isFinite(flow.net)).toBe(true);
    }
    for (const clock of result.pass.clocks.values()) {
      expect(clock).toBeGreaterThanOrEqual(0);
      expect(clock).toBeLessThanOrEqual(1 + FLOATING_SLACK);
    }
  });
});
