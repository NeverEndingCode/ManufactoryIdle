import { describe, expect, it } from "vitest";
import { BundleSchema, ItemSchema, MarkSchema, RecipeSchema } from "./schema.js";

const minimalBundle = {
  version: "fixture.v1",
  lanes: [{ id: "iron", name: "Iron", order: 0, unlockTier: 0 }],
  items: [
    { id: "iron_ore", lane: "iron", tier: 0, name: "Iron Ore", baseStorageCap: 600, baseQuantumCap: 2400 },
  ],
  machineClasses: [
    {
      id: "miner",
      name: "Miner",
      ladder: { step: 1.5, interval: 10 },
      marks: [
        {
          mark: 1,
          name: "Miner Mk.1",
          rateMultiplier: 1,
          buildCostMultiplier: 1,
          powerDraw: 5,
          buildCost: [{ item: "iron_ore", amount: 10 }],
          unlockTier: 0,
        },
      ],
    },
  ],
  recipes: [
    {
      id: "mine_iron",
      name: "Iron Ore",
      lane: "iron",
      machineClass: "miner",
      inputs: [],
      outputs: [{ item: "iron_ore", rate: "60" }],
      unlockTier: 0,
    },
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

describe("BundleSchema", () => {
  it("accepts a minimal valid bundle", () => {
    expect(() => BundleSchema.parse(minimalBundle)).not.toThrow();
  });

  it("applies defaults for optional flags", () => {
    const parsed = BundleSchema.parse(minimalBundle);
    expect(parsed.items[0]!.fluid).toBe(false);
    expect(parsed.items[0]!.terminal).toBe(false);
    expect(parsed.recipes[0]!.isAlternate).toBe(false);
    expect(parsed.recipes[0]!.powerOutput).toBe(0);
    expect(parsed.recipes[0]!.outputs[0]!.byproduct).toBe(false);
  });

  it("rejects a bundle with no lanes", () => {
    expect(() => BundleSchema.parse({ ...minimalBundle, lanes: [] })).toThrow();
  });
});

describe("RecipeSchema", () => {
  it("accepts exact rational rates as decimals and fractions", () => {
    const base = minimalBundle.recipes[0]!;
    expect(() => RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "11.25" }] })).not.toThrow();
    expect(() => RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "45/4" }] })).not.toThrow();
    expect(() => RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "60" }] })).not.toThrow();
    expect(() => RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "0.5" }] })).not.toThrow();
  });

  it("rejects a rate that is not a number or fraction", () => {
    const base = minimalBundle.recipes[0]!;
    expect(() => RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "fast" }] })).toThrow();
  });

  it("rejects a hybrid rate with both decimal and fraction", () => {
    const base = minimalBundle.recipes[0]!;
    expect(() => RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "11.25/4" }] })).toThrow();
  });

  it("rejects a rate with a zero denominator", () => {
    // Fix 3: the regex alone accepts "5/0"; a division by zero would
    // otherwise first surface deep inside Phase 1's expansion-vector code.
    const base = minimalBundle.recipes[0]!;
    expect(() => RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "5/0" }] })).toThrow();
  });

  it("rejects a zero rate", () => {
    const base = minimalBundle.recipes[0]!;
    expect(() => RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "0" }] })).toThrow();
  });

  it("allows empty outputs array for generators", () => {
    const base = minimalBundle.recipes[0]!;
    expect(() => RecipeSchema.parse({ ...base, outputs: [] })).not.toThrow();
  });

  it("rejects an unknown key on a recipe part (authoring typo guard)", () => {
    // e.g. "byprodcut: true" instead of "byproduct: true" — with a non-strict
    // schema this is silently stripped, check 5 quietly never fires, and
    // because the checksum is computed over the stripped bundle, the typo
    // doesn't even change the version stamp.
    const base = minimalBundle.recipes[0]!;
    expect(() =>
      RecipeSchema.parse({ ...base, outputs: [{ item: "a", rate: "60", byprodcut: true }] }),
    ).toThrow();
  });
});

describe("MarkSchema", () => {
  it("requires at least one build cost entry", () => {
    const base = minimalBundle.machineClasses[0]!.marks[0]!;
    expect(() => MarkSchema.parse({ ...base, buildCost: [] })).toThrow();
  });

  it("rejects a non-positive rate multiplier", () => {
    const base = minimalBundle.machineClasses[0]!.marks[0]!;
    expect(() => MarkSchema.parse({ ...base, rateMultiplier: 0 })).toThrow();
  });

  it("rejects a non-positive build cost multiplier", () => {
    const base = minimalBundle.machineClasses[0]!.marks[0]!;
    expect(() => MarkSchema.parse({ ...base, buildCostMultiplier: 0 })).toThrow();
  });
});

describe("ItemSchema", () => {
  it("rejects a negative storage cap", () => {
    expect(() =>
      ItemSchema.parse({ id: "x", lane: "iron", tier: 0, name: "X", baseStorageCap: -1, baseQuantumCap: 1 }),
    ).toThrow();
  });
});
