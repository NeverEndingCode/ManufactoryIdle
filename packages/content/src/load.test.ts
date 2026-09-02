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
