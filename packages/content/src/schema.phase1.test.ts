import { describe, expect, it } from "vitest";
import {
  BundleSchema,
  MilestoneSchema,
  SoftcapSchema,
  SoftcapsSchema,
  StartSchema,
  StorageCurveSchema,
  TapSchema,
} from "./schema.js";

const minimal = {
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

describe("Phase 1 bundle fields", () => {
  it("still accepts a Phase 0 bundle and fills every new field", () => {
    const parsed = BundleSchema.parse(minimal);
    expect(parsed.machineClasses[0]!.costRatio).toBe(1.09);
    expect(parsed.storage.capGrowth).toBe(1.6);
    expect(parsed.storage.baseCostItem).toBeNull();
    expect(parsed.quantumStorage.maxLevel).toBe(15);
    expect(parsed.softcaps.product.slope).toBe(0.2);
    expect(parsed.tap.maxStacks).toBe(10);
    expect(parsed.milestones).toEqual([]);
    expect(parsed.start).toEqual({ tier: 0, machines: [], assignments: {}, priority: [] });
    expect(parsed.baseGridCapacityMw).toBe(0);
    expect(parsed.offlineCapHours).toBe(8);
  });

  it("accepts authored values for every new field", () => {
    const parsed = BundleSchema.parse({
      ...minimal,
      machineClasses: [{ ...minimal.machineClasses[0]!, costRatio: 1.12 }],
      storage: {
        capGrowth: 1.5,
        costGrowth: 2,
        baseCostItem: "iron_ore",
        baseCostAmount: 50,
        maxLevel: 20,
      },
      milestones: [
        { tier: 1, name: "First", requires: [{ item: "iron_ore", amount: 200 }], laneMultipliers: { iron: 1.5 } },
      ],
      start: {
        tier: 0,
        machines: [{ lane: "iron", machineClass: "miner", mark: 1, count: 1 }],
        assignments: { mine_iron: 1 },
        priority: ["iron_ore"],
      },
      baseGridCapacityMw: 200,
      offlineCapHours: 8,
    });
    expect(parsed.machineClasses[0]!.costRatio).toBe(1.12);
    expect(parsed.milestones[0]!.laneMultipliers.iron).toBe(1.5);
    expect(parsed.start.machines[0]!.count).toBe(1);
    expect(parsed.baseGridCapacityMw).toBe(200);
  });

  it("rejects a cost ratio at or below 1 — r must exceed 1 or costs never inflate", () => {
    expect(() =>
      BundleSchema.parse({ ...minimal, machineClasses: [{ ...minimal.machineClasses[0]!, costRatio: 1 }] }),
    ).toThrow();
  });

  it("rejects a softcap slope outside (0, 1] — a softcap must slow growth, not stop or amplify it", () => {
    expect(() =>
      BundleSchema.parse({
        ...minimal,
        softcaps: {
          ladder: { threshold: 1000, slope: 0 },
          lane: { threshold: 50, slope: 0.25 },
          tap: { threshold: 2, slope: 0.25 },
          product: { threshold: 5000, slope: 0.2 },
        },
      }),
    ).toThrow();
  });

  it("rejects a milestone tier below 1 — tier 0 is the starting state, never delivered", () => {
    expect(() =>
      BundleSchema.parse({
        ...minimal,
        milestones: [{ tier: 0, name: "Bad", requires: [{ item: "iron_ore", amount: 1 }], laneMultipliers: {} }],
      }),
    ).toThrow();
  });
});

// Authoring-typo guards, one per Phase 1 object schema (spec of the same class as
// the "byprodcut" guard in schema.test.ts): with a non-strict schema, an unknown
// key is silently stripped — no error, no validation issue, and no checksum
// change, so the typo is invisible. Every Phase 1 schema must reject it instead.
describe("Phase 1 schemas reject unknown keys (authoring typo guard)", () => {
  const validStorageCurve = {
    capGrowth: 1.6,
    costGrowth: 2,
    baseCostItem: null,
    baseCostAmount: 50,
    maxLevel: 20,
  };

  it("StorageCurveSchema rejects an unrecognized key", () => {
    expect(() => StorageCurveSchema.parse({ ...validStorageCurve, basecostItem: "ghost" })).toThrow();
  });

  const validSoftcap = { threshold: 1000, slope: 0.25 };

  it("SoftcapSchema rejects an unrecognized key", () => {
    expect(() => SoftcapSchema.parse({ ...validSoftcap, thresold: 1000 })).toThrow();
  });

  it("SoftcapsSchema rejects an unrecognized key", () => {
    expect(() =>
      SoftcapsSchema.parse({
        ladder: validSoftcap,
        lane: validSoftcap,
        tap: validSoftcap,
        product: validSoftcap,
        extra: validSoftcap,
      }),
    ).toThrow();
  });

  it("TapSchema rejects an unrecognized key", () => {
    expect(() =>
      TapSchema.parse({
        kickPerStack: 0.05,
        durationSeconds: 30,
        maxStacks: 10,
        powerInjectionMw: 25,
        poweInjectionMw: 25,
      }),
    ).toThrow();
  });

  it("MilestoneSchema rejects an unrecognized key", () => {
    expect(() =>
      MilestoneSchema.parse({
        tier: 1,
        name: "First",
        requires: [{ item: "iron_ore", amount: 200 }],
        laneMultipliers: {},
        laneMultiplyers: { iron: 1.5 },
      }),
    ).toThrow();
  });

  it("StartSchema rejects an unrecognized top-level key", () => {
    expect(() =>
      StartSchema.parse({
        tier: 0,
        machines: [],
        assignments: {},
        priority: [],
        priorty: [],
      }),
    ).toThrow();
  });

  it("StartSchema rejects an unrecognized key on a nested machines entry", () => {
    expect(() =>
      StartSchema.parse({
        tier: 0,
        machines: [{ lane: "iron", machineClass: "miner", mark: 1, count: 1, cout: 1 }],
        assignments: {},
        priority: [],
      }),
    ).toThrow();
  });
});
