// Spec B.6 checks 8, 9 and 10. Deferred out of Phase 0 for needing the economy
// machinery that arrives with Phase 2's calibration.
import { describe, expect, it } from "vitest";
import {
  checkGeneratorCapacity,
  checkRunawayGrowth,
  checkStorageLadderClimbable,
  maxAttainableCap,
  checkStorageReachesCosts,
} from "./economy.js";
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
    storage: { capGrowth: 1.6, costGrowth: 2, baseCostItem: null, baseCostAmount: 50, maxLevel: 20, capPerTier: 1 },
    quantumStorage: { capGrowth: 1.6, costGrowth: 2.5, baseCostItem: null, baseCostAmount: 500, maxLevel: 15, capPerTier: 1 },
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

// Phase 2, Task 3. Found by the calibration script, which could not lengthen any tier
// past the second: every stalled run parked at exactly 500*1.6^12 + 2000*1.6^7 =
// 194424.579555328 iron_plate while the next storage level cost 409,600.
describe("checkStorageLadderClimbable (check 12)", () => {
  function withCostItem(b: Bundle): Bundle {
    b.storage = { ...b.storage, baseCostItem: "plate", baseCostAmount: 50 };
    b.quantumStorage = { ...b.quantumStorage, baseCostItem: "plate", baseCostAmount: 500 };
    return b;
  }

  it("flags a curve whose level cost outruns the capacity that level buys", () => {
    // costGrowth 2 against capGrowth 1.6: cost doubles while capacity grows 1.6x, so
    // past a crossover level the next level costs more than the player can hold and
    // the ladder permanently ends. This is the slice's authored shape.
    const issues = checkStorageLadderClimbable(withCostItem(bundle()));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.check).toBe(12);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toMatch(/storage/);
  });

  it("names the level the ladder stops at, which is what the author has to move", () => {
    const issues = checkStorageLadderClimbable(withCostItem(bundle()));
    expect(issues[0]!.message).toMatch(/level \d+/);
  });

  it("passes when cost growth does not exceed capacity growth", () => {
    const b = withCostItem(bundle());
    b.storage = { ...b.storage, costGrowth: 1.5 };
    b.quantumStorage = { ...b.quantumStorage, costGrowth: 1.55 };
    expect(checkStorageLadderClimbable(b)).toEqual([]);
  });

  // The very first level has to be affordable too, and that is a different sum: no
  // amount of favourable growth rescues a base cost above the base cap.
  it("flags a first level nobody could ever afford", () => {
    const b = withCostItem(bundle());
    b.storage = { ...b.storage, costGrowth: 1.5, baseCostAmount: 1e9 };
    b.quantumStorage = { ...b.quantumStorage, costGrowth: 1.55 };
    const issues = checkStorageLadderClimbable(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/level 0/);
  });

  // A curve with no cost item is the schema's "levels are free" case. Free levels
  // cannot be unaffordable, and the fixture relies on that.
  it("says nothing about a curve whose levels are free", () => {
    expect(checkStorageLadderClimbable(bundle())).toEqual([]);
  });
});

// Phase 2, Task 3, corrected. `capPerTier` amends B.4's cap formula, and it is keyed on
// the PLAYER's tier rather than the item's -- see the note on `capAtLevel`. Both checks
// below read caps, and both have to ask "at which tier?" rather than assume tier 0.
describe("capPerTier and the cap-reading checks", () => {
  function withTierGrowth(b: Bundle, capPerTier: number): Bundle {
    b.storage = { ...b.storage, capPerTier };
    b.quantumStorage = { ...b.quantumStorage, capPerTier };
    return b;
  }

  it("raises maxAttainableCap by capPerTier to the player's tier", () => {
    const plain = bundle();
    const ore = plain.items.find((i) => i.id === "ore")!;
    expect(ore.tier).toBe(0);
    const before = maxAttainableCap(plain, ore, 0);
    // A tier-0 item still benefits, which is the whole point of the correction.
    expect(maxAttainableCap(withTierGrowth(bundle(), 3), ore, 2)).toBeCloseTo(before * 9, 6);
  });

  it("is inert at tier 0, however steep the growth", () => {
    const ore = bundle().items.find((i) => i.id === "ore")!;
    expect(maxAttainableCap(withTierGrowth(bundle(), 3), ore, 0)).toBeCloseTo(
      maxAttainableCap(bundle(), ore, 0),
      6,
    );
  });

  // A milestone is banked while the player is on the tier BELOW it -- they cannot be on
  // tier k before unlocking tier k -- so that is the cap check 9 must measure against.
  it("check 9 measures a milestone against the cap on the tier below it", () => {
    const b = bundle();
    const plate = b.items.find((i) => i.id === "plate")!;
    const atTierOne = maxAttainableCap(withTierGrowth(bundle(), 3), plate, 1);
    const amount = Math.floor(atTierOne * 0.9);
    b.milestones = [
      { tier: 2, name: "M", requires: [{ item: "plate", amount }], laneMultipliers: {} },
    ];
    // Without the tier factor this is far beyond reach; with it, tier 2 is banked at
    // tier 1's caps and it fits.
    expect(checkStorageReachesCosts(b)).toHaveLength(1);
    expect(checkStorageReachesCosts(withTierGrowth(b, 3))).toEqual([]);
  });

  // Check 12 asks whether the ladder can EVER be climbed, and caps only grow with
  // progression, so the deepest tier is the fairest place to ask.
  function steepLadder(capPerTier: number): Bundle {
    const b = withTierGrowth(bundle(), capPerTier);
    b.storage = { ...b.storage, baseCostItem: "plate", costGrowth: 2 };
    b.quantumStorage = { ...b.quantumStorage, baseCostItem: "plate", costGrowth: 1.55 };
    b.milestones = [
      { tier: 1, name: "A", requires: [{ item: "plate", amount: 1 }], laneMultipliers: {} },
      { tier: 2, name: "B", requires: [{ item: "plate", amount: 1 }], laneMultipliers: {} },
    ];
    return b;
  }

  function stoppingLevel(b: Bundle): number {
    const issues = checkStorageLadderClimbable(b);
    const match = /stops at level (\d+)/.exec(issues[0]?.message ?? "");
    return match === null ? Number.POSITIVE_INFINITY : Number(match[1]);
  }

  // A constant multiplier does NOT repeal costGrowth > capGrowth: that is cost
  // outgrowing capacity per level, a difference in growth rate, and a constant cannot
  // beat a rate. It only moves the crossover level.
  it("check 12 lets the tier factor push the ladder further before it stops", () => {
    const before = stoppingLevel(steepLadder(1));
    expect(Number.isFinite(before)).toBe(true);
    expect(stoppingLevel(steepLadder(4))).toBeGreaterThan(before);
  });

  // And the ladder is finite, so a large enough factor moves the crossover past
  // maxLevel entirely. That is a legitimate pass, not a hole: a ladder climbable to its
  // own top has no wall in it, which is all check 12 claims.
  it("check 12 passes once the crossover is pushed past maxLevel", () => {
    expect(stoppingLevel(steepLadder(1000))).toBe(Number.POSITIVE_INFINITY);
    expect(checkStorageLadderClimbable(steepLadder(1000))).toEqual([]);
  });
});
