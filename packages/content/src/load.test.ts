import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReferences, loadBundleDir } from "./load.js";
import type { Bundle } from "./schema.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function writeBundle(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "bundle-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const LANES = `version: test.v1\nlanes:\n  - { id: iron, name: Iron, order: 0, unlockTier: 0 }\n`;
const ITEMS = `items:\n  - { id: iron_ore, lane: iron, tier: 0, name: Iron Ore, baseStorageCap: 600, baseQuantumCap: 2400 }\n`;
const MACHINES = `machineClasses:\n  - id: miner\n    name: Miner\n    ladder: { step: 1.5, interval: 10 }\n    marks:\n      - mark: 1\n        name: Miner Mk.1\n        rateMultiplier: 1\n        buildCostMultiplier: 1\n        powerDraw: 5\n        buildCost: [{ item: iron_ore, amount: 10 }]\n        unlockTier: 0\n`;
const RECIPES = `recipes:\n  - id: mine_iron\n    name: Iron Ore\n    lane: iron\n    machineClass: miner\n    inputs: []\n    outputs: [{ item: iron_ore, rate: "60" }]\n    unlockTier: 0\n`;
const PACING = `pacing:\n  targetCollectionsToTier: [2, 5]\n  activeHoursPerDay: 2.5\n  offlineCollectionsPerDay: 3\n  purchaseIntervalEarlySeconds: 120\n  purchaseIntervalLateSeconds: 1800\n  storageBindingCadence: 12\n`;

const ALL = { "a.yaml": LANES, "b.yaml": ITEMS, "c.yaml": MACHINES, "d.yaml": RECIPES, "e.yaml": PACING };

describe("loadBundleDir", () => {
  it("merges every yaml file in the directory into one bundle", () => {
    const bundle = loadBundleDir(writeBundle(ALL));
    expect(bundle.version).toBe("test.v1");
    expect(bundle.lanes).toHaveLength(1);
    expect(bundle.items).toHaveLength(1);
    expect(bundle.recipes).toHaveLength(1);
  });

  it("concatenates arrays that appear in more than one file", () => {
    const extra = `items:\n  - { id: iron_ingot, lane: iron, tier: 0, name: Iron Ingot, baseStorageCap: 400, baseQuantumCap: 1600 }\n`;
    const bundle = loadBundleDir(writeBundle({ ...ALL, "f.yaml": extra }));
    expect(bundle.items.map((i) => i.id).sort()).toEqual(["iron_ingot", "iron_ore"]);
  });

  it("throws on a schema violation (check 1)", () => {
    const broken = `items:\n  - { id: bad, lane: iron, tier: 0, name: Bad, baseStorageCap: -5, baseQuantumCap: 1 }\n`;
    expect(() => loadBundleDir(writeBundle({ ...ALL, "f.yaml": broken }))).toThrow();
  });

  it("throws on a file whose top level is a bare list, naming the file", () => {
    const bareList = `- a\n- b\n`;
    expect(() => loadBundleDir(writeBundle({ ...ALL, "f.yaml": bareList }))).toThrow(/f\.yaml/);
  });

  it("throws on a file whose top level is a bare scalar", () => {
    const bareScalar = `just a string\n`;
    expect(() => loadBundleDir(writeBundle({ ...ALL, "f.yaml": bareScalar }))).toThrow();
  });

  it("skips an empty file without error, still loading the rest of the bundle", () => {
    const bundle = loadBundleDir(writeBundle({ ...ALL, "f.yaml": "" }));
    expect(bundle.lanes).toHaveLength(1);
    expect(bundle.items).toHaveLength(1);
  });
});

describe("checkReferences", () => {
  const base = (): Bundle => loadBundleDir(writeBundle(ALL));

  it("passes a self-consistent bundle", () => {
    expect(checkReferences(base())).toEqual([]);
  });

  it("flags an item pointing at a missing lane", () => {
    const bundle = base();
    bundle.items[0]!.lane = "ghost";
    const issues = checkReferences(bundle);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.check).toBe(2);
    expect(issues[0]!.message).toContain("ghost");
  });

  it("flags a recipe pointing at a missing machine class", () => {
    const bundle = base();
    bundle.recipes[0]!.machineClass = "ghost";
    expect(checkReferences(bundle).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("flags a recipe output pointing at a missing item", () => {
    const bundle = base();
    bundle.recipes[0]!.outputs[0]!.item = "ghost";
    expect(checkReferences(bundle).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("flags a recipe input pointing at a missing item", () => {
    const bundle = base();
    bundle.recipes[0]!.inputs.push({ item: "ghost", rate: "1", byproduct: false });
    expect(checkReferences(bundle).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("flags a build cost pointing at a missing item", () => {
    const bundle = base();
    bundle.machineClasses[0]!.marks[0]!.buildCost[0]!.item = "ghost";
    expect(checkReferences(bundle).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  it("flags duplicate ids", () => {
    const bundle = base();
    bundle.items.push({ ...bundle.items[0]! });
    expect(checkReferences(bundle).some((i) => i.message.includes("duplicate"))).toBe(true);
  });
});

// Spec B.1: "Cost numbers are never hand-authored. Intent is authored and a script
// solves for the numbers... it needs to be structural, not aspirational." Phase 2's
// calibrator emits its solution as a `derived` block, which the loader lays over the
// authored values. Keeping it a separate, generated file is what makes the split
// structural: you can tell by looking which numbers a human chose.
describe("the derived block", () => {
  const CURVES = `storage: { capGrowth: 1.6, costGrowth: 2.0, baseCostItem: iron_ore, baseCostAmount: 50, maxLevel: 20 }\n`;
  const MILESTONE = `milestones:\n  - { tier: 1, name: First, requires: [{ item: iron_ore, amount: 100 }] }\n`;

  it("overrides a machine class cost ratio", () => {
    const derived = `derived:\n  machineClasses:\n    - { id: miner, costRatio: 1.234 }\n`;
    const bundle = loadBundleDir(writeBundle({ ...ALL, "z-derived.yaml": derived }));
    expect(bundle.machineClasses[0]!.costRatio).toBe(1.234);
  });

  // The calibrator solves r_eff and derives costRatio from it. Both are emitted: the
  // costRatio is what the engine runs on, and the r_eff beside it is what a reader has
  // to see to know what pacing decision produced it. Spec D3 as amended in Phase 2.
  it("overrides a machine class r_eff alongside its cost ratio", () => {
    const derived =
      `derived:\n  machineClasses:\n    - { id: miner, costRatio: 1.234, rEff: 1.185 }\n`;
    const bundle = loadBundleDir(writeBundle({ ...ALL, "z-derived.yaml": derived }));
    expect(bundle.machineClasses[0]!.costRatio).toBe(1.234);
    expect(bundle.machineClasses[0]!.rEff).toBe(1.185);
  });

  it("overrides a milestone requirement amount", () => {
    const derived = `derived:\n  milestones:\n    - { tier: 1, requires: [{ item: iron_ore, amount: 9999 }] }\n`;
    const bundle = loadBundleDir(
      writeBundle({ ...ALL, "f.yaml": MILESTONE, "z-derived.yaml": derived }),
    );
    expect(bundle.milestones[0]!.requires[0]!.amount).toBe(9999);
  });

  it("overrides only the storage fields it names", () => {
    const derived = `derived:\n  storage: { capGrowth: 1.85 }\n`;
    const bundle = loadBundleDir(
      writeBundle({ ...ALL, "f.yaml": CURVES, "z-derived.yaml": derived }),
    );
    expect(bundle.storage.capGrowth).toBe(1.85);
    expect(bundle.storage.costGrowth).toBe(2);
    expect(bundle.storage.baseCostItem).toBe("iron_ore");
  });

  it("leaves the bundle exactly as authored when there is no derived block", () => {
    const bundle = loadBundleDir(writeBundle(ALL));
    expect(bundle.machineClasses[0]!.costRatio).toBe(1.09);
    expect(bundle.derived).toBeUndefined();
  });

  // A derived block naming something that is not there is a stale calibration run
  // against content that has since been re-authored. Silently ignoring it would
  // leave the bundle half-calibrated with nothing to say so.
  it("rejects a derived entry for a machine class that does not exist", () => {
    const derived = `derived:\n  machineClasses:\n    - { id: nope, costRatio: 1.2 }\n`;
    expect(() => loadBundleDir(writeBundle({ ...ALL, "z-derived.yaml": derived }))).toThrow(
      /nope/,
    );
  });

  it("rejects a derived requirement for an item the milestone does not require", () => {
    const derived = `derived:\n  milestones:\n    - { tier: 1, requires: [{ item: nope, amount: 5 }] }\n`;
    expect(() =>
      loadBundleDir(writeBundle({ ...ALL, "f.yaml": MILESTONE, "z-derived.yaml": derived })),
    ).toThrow(/nope/);
  });
});

// Spec B.1 runs one way: intent is authored, numbers are solved. A calibration that
// starts from the PREVIOUS calibration's output breaks that -- its amounts search scales
// from whatever the last run emitted, so factors compound and two runs of the same
// script on the same content give different answers.
//
// It also makes the slice unusable as a test fixture: every test that loads it starts
// seeing calibrated numbers the moment derived.yaml lands.
describe("loading without the derived overlay", () => {
  const DERIVED = `derived:\n  machineClasses:\n    - { id: miner, costRatio: 1.9 }\n`;

  it("ignores derived.yaml when asked for the authored bundle", () => {
    const dir = writeBundle({ ...ALL, "z-derived.yaml": DERIVED });
    expect(loadBundleDir(dir).machineClasses[0]!.costRatio).toBe(1.9);
    expect(loadBundleDir(dir, { applyDerived: false }).machineClasses[0]!.costRatio).toBe(1.09);
  });

  it("still parses and returns the block, so a caller can read the provenance", () => {
    const dir = writeBundle({ ...ALL, "z-derived.yaml": DERIVED });
    expect(loadBundleDir(dir, { applyDerived: false }).derived).toBeDefined();
  });

  it("applies the overlay by default, because the game must run on solved numbers", () => {
    const dir = writeBundle({ ...ALL, "z-derived.yaml": DERIVED });
    expect(loadBundleDir(dir).machineClasses[0]!.costRatio).toBe(1.9);
  });
});
