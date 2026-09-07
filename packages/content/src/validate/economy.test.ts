// Spec B.6 checks 8, 9 and 10. Deferred out of Phase 0 for needing the economy
// machinery that arrives with Phase 2's calibration.
import { describe, expect, it } from "vitest";
import { checkGeneratorCapacity, checkRunawayGrowth, checkStorageReachesCosts } from "./economy.js";
import type { Bundle } from "../schema.js";

function bundle(): Bundle {
  return {
    version: "t.v1",
    lanes: [{ id: "iron", name: "Iron", order: 0, unlockTier: 0 }],
    items: [
      { id: "ore", lane: "iron", tier: 0, name: "Ore", fluid: false, terminal: false, baseStorageCap: 600, baseQuantumCap: 2400 },
      { id: "plate", lane: "iron", tier: 1, name: "Plate", fluid: false, terminal: true, baseStorageCap: 300, baseQuantumCap: 1200 },
    ],
    machineClasses: [
      {
        id: "miner",
        name: "Miner",
        // m = 1.5^(1/10) = 1.04138, so r_eff = 1.09 / 1.04138 = 1.0467.
        ladder: { step: 1.5, interval: 10 },
        costRatio: 1.09,
        marks: [
          { mark: 1, name: "Mk.1", rateMultiplier: 1, buildCostMultiplier: 1, powerDraw: 5, buildCost: [{ item: "ore", amount: 10 }], unlockTier: 0 },
        ],
      },
    ],
    recipes: [
      { id: "mine", name: "Mine", lane: "iron", machineClass: "miner", inputs: [], outputs: [{ item: "ore", rate: "60", byproduct: false }], powerOutput: 0, isAlternate: false, unlockTier: 0 },
      { id: "plate", name: "Plate", lane: "iron", machineClass: "miner", inputs: [{ item: "ore", rate: "30", byproduct: false }], outputs: [{ item: "plate", rate: "20", byproduct: false }], powerOutput: 0, isAlternate: false, unlockTier: 0 },
    ],
    storage: { capGrowth: 1.6, costGrowth: 2, baseCostItem: null, baseCostAmount: 50, maxLevel: 20 },
    quantumStorage: { capGrowth: 1.6, costGrowth: 2.5, baseCostItem: null, baseCostAmount: 500, maxLevel: 15 },
    softcaps: {
      ladder: { threshold: 1000, slope: 0.25 },
      lane: { threshold: 50, slope: 0.25 },
      tap: { threshold: 2, slope: 0.25 },
      product: { threshold: 5000, slope: 0.2 },
    },
    tap: { kickPerStack: 0.05, durationSeconds: 30, maxStacks: 10, powerInjectionMw: 25 },
    milestones: [],
    start: { tier: 0, machines: [{ lane: "iron", machineClass: "miner", mark: 1, count: 1 }], assignments: {}, priority: [] },
    baseGridCapacityMw: 200,
    offlineCapHours: 8,
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

describe("checkRunawayGrowth (check 8)", () => {
  it("passes the authored r_eff of 1.0467", () => {
    expect(checkRunawayGrowth(bundle())).toEqual([]);
  });

  it("flags r_eff below 1 — super-exponential production, game over in an afternoon", () => {
    const b = bundle();
    // Ladder growth now outruns the cost ratio: m = 3^(1/10) = 1.1161, so
    // r_eff = 1.09 / 1.1161 = 0.977 -- under 1, which spec D3 calls runaway.
    b.machineClasses[0]!.ladder = { step: 3, interval: 10 };
    const issues = checkRunawayGrowth(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.check).toBe(8);
    expect(issues[0]!.message).toContain("miner");
  });

  it("flags the knife edge, where r_eff is exactly 1", () => {
    const b = bundle();
    // step^(1/interval) === costRatio makes r_eff exactly 1: machine count linear in
    // t, production exponential. Spec D3 calls this the knife edge, and `> 1 + eps`
    // is what excludes it.
    b.machineClasses[0]!.ladder = { step: Math.pow(1.09, 10), interval: 10 };
    expect(checkRunawayGrowth(b)).toHaveLength(1);
  });
});

describe("checkStorageReachesCosts (check 9)", () => {
  it("passes when every cost fits inside the maximum attainable cap", () => {
    expect(checkStorageReachesCosts(bundle())).toEqual([]);
  });

  it("flags a build cost no amount of storage upgrading could ever bank", () => {
    const b = bundle();
    // Max attainable ore cap is 600 * 1.6^20 + 2400 * 1.6^15, about 10.0M.
    b.machineClasses[0]!.marks[0]!.buildCost = [{ item: "ore", amount: 1e12 }];
    const issues = checkStorageReachesCosts(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.check).toBe(9);
    expect(issues[0]!.message).toContain("ore");
  });

  // The extension beyond spec B.6's wording. B.6 scopes check 9 to build costs, but a
  // milestone requirement is the same permanent-wall failure on the axis the check
  // does not look at: a delivery you could never bank enough for.
  it("flags a milestone requirement no amount of storage upgrading could ever bank", () => {
    const b = bundle();
    b.milestones = [
      {
        tier: 1,
        name: "Impossible",
        requires: [{ item: "plate", amount: 1e12 }],
        laneMultipliers: {},
      },
    ];
    const issues = checkStorageReachesCosts(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.check).toBe(9);
    expect(issues[0]!.message).toContain("plate");
  });

  it("accepts a milestone that merely exceeds the BASE cap, since upgrades are real", () => {
    const b = bundle();
    // Base liquid cap for plate is 300 + 1200 = 1500. Requiring 2000 leaves the
    // player temporarily capped, not permanently walled -- they can buy levels. That
    // distinction is why this check uses the maximum attainable cap.
    b.milestones = [
      { tier: 1, name: "Reachable", requires: [{ item: "plate", amount: 2000 }], laneMultipliers: {} },
    ];
    expect(checkStorageReachesCosts(b)).toEqual([]);
  });
});

describe("checkGeneratorCapacity (check 10)", () => {
  it("passes when the HUB allowance covers everything unlocked before any generator", () => {
    expect(checkGeneratorCapacity(bundle())).toEqual([]);
  });

  it("flags a tier that browns out on arrival with no generator to build", () => {
    const b = bundle();
    b.machineClasses[0]!.marks[0]!.powerDraw = 250; // against a 200 MW HUB allowance
    const issues = checkGeneratorCapacity(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.check).toBe(10);
    expect(issues[0]!.message).toContain("tier 0");
  });

  it("accepts an over-allowance draw once a generator is unlocked to cover it", () => {
    const b = bundle();
    b.machineClasses[0]!.marks[0]!.powerDraw = 250;
    b.machineClasses.push({
      id: "generator",
      name: "Generator",
      ladder: { step: 1.5, interval: 10 },
      costRatio: 1.09,
      marks: [
        { mark: 1, name: "Mk.1", rateMultiplier: 1, buildCostMultiplier: 1, powerDraw: 0, buildCost: [{ item: "ore", amount: 10 }], unlockTier: 0 },
      ],
    });
    b.recipes.push({
      id: "burn",
      name: "Burn",
      lane: "iron",
      machineClass: "generator",
      inputs: [{ item: "ore", rate: "10", byproduct: false }],
      outputs: [],
      powerOutput: 250,
      isAlternate: false,
      unlockTier: 0,
    });
    expect(checkGeneratorCapacity(b)).toEqual([]);
  });
});
