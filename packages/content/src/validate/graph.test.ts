import { describe, expect, it } from "vitest";
import {
  checkByproductOutlets,
  checkBuildCostsSatisfiable,
  checkConsumers,
  checkProducers,
} from "./graph.js";
import type { Bundle } from "../schema.js";

function bundle(): Bundle {
  return {
    version: "t.v1",
    lanes: [{ id: "iron", name: "Iron", order: 0, unlockTier: 0 }],
    items: [
      { id: "ore", lane: "iron", tier: 0, name: "Ore", fluid: false, terminal: false, baseStorageCap: 600, baseQuantumCap: 2400 },
      { id: "ingot", lane: "iron", tier: 0, name: "Ingot", fluid: false, terminal: false, baseStorageCap: 400, baseQuantumCap: 1600 },
      { id: "plate", lane: "iron", tier: 1, name: "Plate", fluid: false, terminal: true, baseStorageCap: 300, baseQuantumCap: 1200 },
      { id: "slag", lane: "iron", tier: 1, name: "Slag", fluid: true, terminal: false, baseStorageCap: 100, baseQuantumCap: 400 },
    ],
    machineClasses: [
      {
        id: "miner",
        name: "Miner",
        ladder: { step: 1.5, interval: 10 },
        marks: [
          { mark: 1, name: "Mk.1", rateMultiplier: 1, buildCostMultiplier: 1, powerDraw: 5, buildCost: [{ item: "plate", amount: 10 }], unlockTier: 1 },
        ],
      },
    ],
    recipes: [
      { id: "mine", name: "Mine", lane: "iron", machineClass: "miner", inputs: [], outputs: [{ item: "ore", rate: "60", byproduct: false }], powerOutput: 0, isAlternate: false, unlockTier: 0 },
      { id: "smelt", name: "Smelt", lane: "iron", machineClass: "miner", inputs: [{ item: "ore", rate: "30", byproduct: false }], outputs: [{ item: "ingot", rate: "30", byproduct: false }, { item: "slag", rate: "10", byproduct: true }], powerOutput: 0, isAlternate: false, unlockTier: 1 },
      { id: "plate", name: "Plate", lane: "iron", machineClass: "miner", inputs: [{ item: "ingot", rate: "30", byproduct: false }], outputs: [{ item: "plate", rate: "20", byproduct: false }], powerOutput: 0, isAlternate: false, unlockTier: 1 },
      { id: "reslag", name: "Reslag", lane: "iron", machineClass: "miner", inputs: [{ item: "slag", rate: "10", byproduct: false }], outputs: [{ item: "ingot", rate: "1", byproduct: false }], powerOutput: 0, isAlternate: false, unlockTier: 1 },
    ],
    pacing: {
      targetCollectionsToTier: [2, 5],
      activeHoursPerDay: 2.5,
      offlineCollectionsPerDay: 3,
      purchaseIntervalEarlySeconds: 120,
      purchaseIntervalLateSeconds: 1800,
      storageBindingCadence: 12,
    },
  };
}

describe("checkProducers (check 3)", () => {
  it("passes when every item is produced", () => {
    expect(checkProducers(bundle())).toEqual([]);
  });

  it("flags an item nothing produces", () => {
    const b = bundle();
    b.items.push({ id: "ghost", lane: "iron", tier: 0, name: "Ghost", fluid: false, terminal: true, baseStorageCap: 1, baseQuantumCap: 1 });
    const issues = checkProducers(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.check).toBe(3);
    expect(issues[0]!.message).toContain("ghost");
  });
});

describe("checkConsumers (check 4)", () => {
  it("passes: plate is terminal and also a build cost, slag is consumed", () => {
    expect(checkConsumers(bundle())).toEqual([]);
  });

  it("flags a dead-end item that is neither consumed, terminal, nor a build cost", () => {
    const b = bundle();
    b.recipes = b.recipes.filter((r) => r.id !== "reslag");
    const issues = checkConsumers(b);
    expect(issues.some((i) => i.check === 4 && i.message.includes("slag"))).toBe(true);
  });

  it("accepts an unconsumed item when it is marked terminal", () => {
    const b = bundle();
    b.recipes = b.recipes.filter((r) => r.id !== "reslag");
    b.items.find((i) => i.id === "slag")!.terminal = true;
    expect(checkConsumers(b)).toEqual([]);
  });
});

describe("checkByproductOutlets (check 5)", () => {
  it("passes when the byproduct has a consumer at or below its tier", () => {
    expect(checkByproductOutlets(bundle())).toEqual([]);
  });

  it("flags a byproduct whose only consumer unlocks later", () => {
    const b = bundle();
    b.recipes.find((r) => r.id === "reslag")!.unlockTier = 5;
    const issues = checkByproductOutlets(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.check).toBe(5);
    expect(issues[0]!.message).toContain("slag");
  });

  it("flags a byproduct with no consumer at all", () => {
    const b = bundle();
    b.recipes = b.recipes.filter((r) => r.id !== "reslag");
    expect(checkByproductOutlets(b).some((i) => i.check === 5)).toBe(true);
  });

  it("ignores non-byproduct outputs with no consumer", () => {
    const b = bundle();
    b.recipes = b.recipes.filter((r) => r.id !== "reslag");
    b.recipes.find((r) => r.id === "smelt")!.outputs[1]!.byproduct = false;
    expect(checkByproductOutlets(b)).toEqual([]);
  });

  // Guards the running-minimum in earliestConsumption: a byproduct emitted at
  // tier 3 with one consumer that unlocks earlier (tier 1) and one that
  // unlocks later (tier 10). Correct min-tracking finds the tier-1 consumer
  // and reports no issue. A bug that tracked the maximum instead of the
  // minimum would see tier 10 > 3 and wrongly flag it. A bug that tracked the
  // last-seen recipe instead of a true minimum would only sometimes flag it,
  // depending on array order — so both orderings are exercised below to make
  // sure neither one accidentally passes under that bug.
  function bundleWithMultiConsumerByproduct(order: "lateFirst" | "earlyFirst"): Bundle {
    const b = bundle();
    b.items.push({
      id: "goop",
      lane: "iron",
      tier: 1,
      name: "Goop",
      fluid: true,
      terminal: false,
      baseStorageCap: 100,
      baseQuantumCap: 400,
    });
    const source = {
      id: "byproductSource",
      name: "ByproductSource",
      lane: "iron",
      machineClass: "miner",
      inputs: [{ item: "ore", rate: "5", byproduct: false }],
      outputs: [{ item: "goop", rate: "5", byproduct: true }],
      powerOutput: 0,
      isAlternate: false,
      unlockTier: 3,
    };
    const consumerEarly = {
      id: "goopConsumerEarly",
      name: "GoopConsumerEarly",
      lane: "iron",
      machineClass: "miner",
      inputs: [{ item: "goop", rate: "5", byproduct: false }],
      outputs: [{ item: "ingot", rate: "1", byproduct: false }],
      powerOutput: 0,
      isAlternate: false,
      unlockTier: 1,
    };
    const consumerLate = {
      id: "goopConsumerLate",
      name: "GoopConsumerLate",
      lane: "iron",
      machineClass: "miner",
      inputs: [{ item: "goop", rate: "5", byproduct: false }],
      outputs: [{ item: "ingot", rate: "1", byproduct: false }],
      powerOutput: 0,
      isAlternate: false,
      unlockTier: 10,
    };
    b.recipes.push(source, ...(order === "lateFirst" ? [consumerLate, consumerEarly] : [consumerEarly, consumerLate]));
    return b;
  }

  it("multi-consumer byproduct: earliest consumer tier wins regardless of order (late consumer first)", () => {
    expect(checkByproductOutlets(bundleWithMultiConsumerByproduct("lateFirst"))).toEqual([]);
  });

  it("multi-consumer byproduct: earliest consumer tier wins regardless of order (early consumer first)", () => {
    expect(checkByproductOutlets(bundleWithMultiConsumerByproduct("earlyFirst"))).toEqual([]);
  });
});

describe("checkBuildCostsSatisfiable (check 7)", () => {
  it("passes when the build cost item is produced at or below the mark's tier", () => {
    expect(checkBuildCostsSatisfiable(bundle())).toEqual([]);
  });

  it("flags a build cost whose item is only produced at a later tier", () => {
    const b = bundle();
    b.recipes.find((r) => r.id === "plate")!.unlockTier = 4;
    const issues = checkBuildCostsSatisfiable(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.check).toBe(7);
    expect(issues[0]!.message).toContain("plate");
  });

  it("flags a build cost whose item nothing produces at all", () => {
    const b = bundle();
    b.machineClasses[0]!.marks.push({
      mark: 2,
      name: "Mk.2",
      rateMultiplier: 1.5,
      buildCostMultiplier: 1.5,
      powerDraw: 8,
      buildCost: [{ item: "vapor", amount: 5 }],
      unlockTier: 1,
    });
    const issues = checkBuildCostsSatisfiable(b);
    expect(issues.some((i) => i.check === 7 && i.message.includes("vapor"))).toBe(true);
  });

  // Guards the running-minimum in earliestProduction: an item produced by one
  // recipe at an early tier (0) and one at a late tier (5), used as a build
  // cost for a mark that unlocks between them (tier 2). Correct min-tracking
  // finds the tier-0 producer and reports no issue. A bug that tracked the
  // maximum instead of the minimum would see tier 5 > 2 and wrongly flag it.
  // A bug that tracked the last-seen recipe instead of a true minimum would
  // only sometimes flag it, depending on array order — so both orderings are
  // exercised below to make sure neither one accidentally passes under that
  // bug.
  function bundleWithMultiProducerBuildCost(order: "lateFirst" | "earlyFirst"): Bundle {
    const b = bundle();
    b.items.push({
      id: "widget",
      lane: "iron",
      tier: 0,
      name: "Widget",
      fluid: false,
      terminal: true,
      baseStorageCap: 1,
      baseQuantumCap: 1,
    });
    const early = {
      id: "widgetEarly",
      name: "WidgetEarly",
      lane: "iron",
      machineClass: "miner",
      inputs: [],
      outputs: [{ item: "widget", rate: "10", byproduct: false }],
      powerOutput: 0,
      isAlternate: false,
      unlockTier: 0,
    };
    const late = {
      id: "widgetLate",
      name: "WidgetLate",
      lane: "iron",
      machineClass: "miner",
      inputs: [],
      outputs: [{ item: "widget", rate: "10", byproduct: false }],
      powerOutput: 0,
      isAlternate: false,
      unlockTier: 5,
    };
    b.recipes.push(...(order === "lateFirst" ? [late, early] : [early, late]));
    b.machineClasses[0]!.marks.push({
      mark: 2,
      name: "Mk.2",
      rateMultiplier: 1.5,
      buildCostMultiplier: 1.5,
      powerDraw: 8,
      buildCost: [{ item: "widget", amount: 1 }],
      unlockTier: 2,
    });
    return b;
  }

  it("multi-producer build cost: earliest producer tier wins regardless of order (late recipe first)", () => {
    expect(checkBuildCostsSatisfiable(bundleWithMultiProducerBuildCost("lateFirst"))).toEqual([]);
  });

  it("multi-producer build cost: earliest producer tier wins regardless of order (early recipe first)", () => {
    expect(checkBuildCostsSatisfiable(bundleWithMultiProducerBuildCost("earlyFirst"))).toEqual([]);
  });
});
