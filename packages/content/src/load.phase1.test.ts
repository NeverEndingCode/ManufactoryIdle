import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkReferences, loadBundleDir } from "./load.js";
import { validateBundle } from "./validate/index.js";

const fixtureDir = fileURLToPath(new URL("../bundles/fixture", import.meta.url));

describe("checkReferences over the Phase 1 blocks", () => {
  it("passes on the fixture", () => {
    expect(checkReferences(loadBundleDir(fixtureDir))).toEqual([]);
  });

  it("flags a milestone requiring a missing item", () => {
    const b = loadBundleDir(fixtureDir);
    b.milestones[0]!.requires[0]!.item = "ghost";
    expect(checkReferences(b).some((i) => i.check === 2 && i.message.includes("ghost"))).toBe(true);
  });

  it("flags a milestone lane multiplier on a missing lane", () => {
    const b = loadBundleDir(fixtureDir);
    b.milestones[0]!.laneMultipliers = { ghost: 1.5 };
    expect(checkReferences(b).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("flags a storage curve cost item that does not exist", () => {
    const b = loadBundleDir(fixtureDir);
    b.storage.baseCostItem = "ghost";
    expect(checkReferences(b).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("accepts a null storage cost item", () => {
    const b = loadBundleDir(fixtureDir);
    b.storage.baseCostItem = null;
    expect(checkReferences(b)).toEqual([]);
  });

  it("flags a start machine in a missing lane and a start assignment to a missing recipe", () => {
    const b = loadBundleDir(fixtureDir);
    b.start.machines[0]!.lane = "ghost";
    b.start.assignments = { ...b.start.assignments, phantom_recipe: 1 };
    const issues = checkReferences(b);
    expect(issues.some((i) => i.message.includes("ghost"))).toBe(true);
    expect(issues.some((i) => i.message.includes("phantom_recipe"))).toBe(true);
  });

  it("flags a start machine mark the class does not define", () => {
    const b = loadBundleDir(fixtureDir);
    b.start.machines[0]!.mark = 9;
    expect(checkReferences(b).some((i) => i.message.includes("mk9"))).toBe(true);
  });

  it("flags a start priority entry naming a missing item", () => {
    const b = loadBundleDir(fixtureDir);
    b.start.priority = ["ghost"];
    expect(checkReferences(b).some((i) => i.message.includes("ghost"))).toBe(true);
  });
});

describe("the extended fixture", () => {
  it("passes every implemented validator check", () => {
    expect(validateBundle(loadBundleDir(fixtureDir))).toEqual([]);
  });

  it("carries the values the engine needs", () => {
    const b = loadBundleDir(fixtureDir);
    expect(b.baseGridCapacityMw).toBeGreaterThan(0);
    expect(b.milestones.length).toBeGreaterThanOrEqual(3);
    expect(b.start.machines.length).toBeGreaterThan(0);
    expect(b.storage.baseCostItem).not.toBeNull();
    expect(b.machineClasses.every((c) => c.costRatio > 1)).toBe(true);
  });
});
