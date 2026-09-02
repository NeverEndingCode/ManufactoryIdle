import { describe, expect, it } from "vitest";
import { bundleChecksum } from "./checksum.js";
import type { Bundle } from "./schema.js";

const base = (): Bundle =>
  ({
    version: "t.v1",
    lanes: [{ id: "iron", name: "Iron", order: 0, unlockTier: 0 }],
    items: [],
    machineClasses: [],
    recipes: [],
    pacing: {
      targetCollectionsToTier: [2],
      activeHoursPerDay: 2.5,
      offlineCollectionsPerDay: 3,
      purchaseIntervalEarlySeconds: 120,
      purchaseIntervalLateSeconds: 1800,
      storageBindingCadence: 12,
    },
  }) as unknown as Bundle;

describe("bundleChecksum", () => {
  it("is a 64-character hex sha256", () => {
    expect(bundleChecksum(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across repeated calls", () => {
    expect(bundleChecksum(base())).toBe(bundleChecksum(base()));
  });

  it("ignores key insertion order", () => {
    const a = base();
    const b = { pacing: a.pacing, recipes: [], machineClasses: [], items: [], lanes: a.lanes, version: a.version } as unknown as Bundle;
    expect(bundleChecksum(b)).toBe(bundleChecksum(a));
  });

  it("changes when any value changes", () => {
    const changed = base();
    changed.version = "t.v2";
    expect(bundleChecksum(changed)).not.toBe(bundleChecksum(base()));
  });

  it("does not ignore array order, which is meaningful", () => {
    const a = base();
    a.lanes = [
      { id: "iron", name: "Iron", order: 0, unlockTier: 0 },
      { id: "oil", name: "Oil", order: 1, unlockTier: 2 },
    ];
    const b = base();
    b.lanes = [...a.lanes].reverse();
    expect(bundleChecksum(a)).not.toBe(bundleChecksum(b));
  });
});
