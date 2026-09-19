import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { BundleSchema, DerivedSchema } from "./schema.js";
import { serialiseDerived } from "./derived.js";

const derived = {
  run: {
    calibratedAt: "2026-09-11T00:00:00.000Z",
    policy: "greedy",
    seed: 42,
    targetCollectionsToTier: [2, 5],
    observedCollectionsToTier: [1.98, null],
  },
  machineClasses: [{ id: "miner", costRatio: 1.0903245 }],
  milestones: [{ tier: 1, requires: [{ item: "iron_plate", amount: 14500 }] }],
};

describe("serialiseDerived", () => {
  it("round-trips through the schema it was parsed from", () => {
    expect(DerivedSchema.parse(parseYaml(serialiseDerived(derived)).derived)).toEqual(derived);
  });

  // The file sits next to hand-authored ones in the same directory and is merged by
  // the same loader. Anyone opening it has to be able to tell at a glance that
  // editing it is pointless, or spec B.1's authored/derived split is a convention
  // rather than a structure.
  it("says in the file that it is generated and how to regenerate it", () => {
    const text = serialiseDerived(derived);
    expect(text).toMatch(/GENERATED/);
    expect(text).toMatch(/sim calibrate/);
  });

  it("is a legal bundle file on its own", () => {
    expect(() => parseYaml(serialiseDerived(derived))).not.toThrow();
    expect(parseYaml(serialiseDerived(derived))).toHaveProperty("derived");
  });

  // Re-running calibration on unchanged content should produce an unchanged file
  // apart from the timestamp, so a diff shows what actually moved.
  it("orders its keys stably so a re-run diffs cleanly", () => {
    const shuffled = {
      ...derived,
      machineClasses: [...derived.machineClasses].reverse(),
      milestones: [...derived.milestones].reverse(),
    };
    expect(serialiseDerived(shuffled)).toBe(serialiseDerived(derived));
  });
});

describe("a bundle carrying a serialised derived block", () => {
  it("parses back out of BundleSchema", () => {
    const parsed = parseYaml(serialiseDerived(derived)) as { derived: unknown };
    const bundle = BundleSchema.parse({
      version: "t.v1",
      lanes: [{ id: "iron", name: "Iron", order: 0, unlockTier: 0 }],
      items: [
        { id: "iron_plate", lane: "iron", tier: 0, name: "P", baseStorageCap: 1, baseQuantumCap: 1 },
      ],
      machineClasses: [
        {
          id: "miner",
          name: "M",
          ladder: { step: 1.5, interval: 10 },
          marks: [
            {
              mark: 1,
              name: "M1",
              rateMultiplier: 1,
              buildCostMultiplier: 1,
              powerDraw: 1,
              buildCost: [{ item: "iron_plate", amount: 1 }],
              unlockTier: 0,
            },
          ],
        },
      ],
      recipes: [
        {
          id: "r",
          name: "R",
          lane: "iron",
          machineClass: "miner",
          inputs: [],
          outputs: [{ item: "iron_plate", rate: "60" }],
          unlockTier: 0,
        },
      ],
      pacing: {
        targetCollectionsToTier: [2],
        activeHoursPerDay: 2.5,
        offlineCollectionsPerDay: 3,
        purchaseIntervalEarlySeconds: 120,
        purchaseIntervalLateSeconds: 1800,
        storageBindingCadence: 12,
      },
      derived: parsed.derived,
    });
    expect(bundle.derived!.machineClasses![0]!.costRatio).toBeCloseTo(1.0903245, 7);
  });
});
