import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { POWER_ITEM } from "../content/types.js";
import { indexContent } from "../graph/index-content.js";
import {
  POWER_ENTRY_ID,
  WORLD_SCHEMA_VERSION,
  assignedTotal,
  initialWorld,
  installedAt,
  installedMachines,
  withInstalled,
} from "./world.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

// The content schema places no restriction on ids (`z.string().min(1)`), so
// "__proto__" is exactly as legal a lane or item id as "constructor" is a legal
// machine class id (the fixture bundle's iron lane already exercises that one, via
// ownOrUndefined). Built here rather than added to the shared fixture: it is
// pathological enough to belong in a targeted test, not in content every other
// task loads.
function poisonedContent() {
  const bundle = loadBundleDir(fixtureDir);
  return indexContent({
    ...bundle,
    lanes: [...bundle.lanes, { id: "__proto__", name: "Proto Lane", order: 99, unlockTier: 0 }],
    items: [
      ...bundle.items,
      {
        id: "__proto__",
        lane: "iron",
        tier: 0,
        name: "Proto Trap",
        fluid: false,
        terminal: false,
        baseStorageCap: 500,
        baseQuantumCap: 2000,
      },
    ],
  });
}

describe("initialWorld", () => {
  it("stamps the schema and content version and the clock it was given", () => {
    const w = initialWorld(content, 42, 1_000);
    expect(w.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(w.contentVersion).toBe("fixture.v1");
    expect(w.lastResolvedAt).toBe(1_000);
    expect(w.tier).toBe(0);
  });

  it("installs the authored starting machines and assignments", () => {
    const w = initialWorld(content, 42, 0);
    expect(installedAt(w, "iron", "miner", 1)).toBe(2);
    expect(installedAt(w, "iron", "constructor", 1)).toBe(1);
    expect(installedMachines(w, "iron", "smelter")).toBe(2);
    expect(w.assignment.mine_iron).toBe(2);
    expect(w.assignment.make_plate).toBe(1);
    expect(assignedTotal(content, w, "iron", "miner")).toBe(2);
  });

  it("pins power to position 1 of the priority list (spec C.4)", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.priority[0]!.id).toBe(POWER_ENTRY_ID);
    expect(w.priority[0]!.kind).toBe("power");
    expect(w.priority[0]!.itemId).toBe(POWER_ITEM);
    expect(w.priority[0]!.mode).toBe("guaranteed");
    expect(w.priority[0]!.targetRate).toBeNull();
  });

  it("builds the rest of the priority list from the authored start block", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.priority.slice(1).map((e) => e.itemId)).toEqual([
      "iron_plate",
      "iron_ingot",
      "iron_ore",
      "plastic",
      "fuel",
      "heavy_oil_residue",
      "crude_oil",
    ]);
    expect(w.priority.every((e) => e.mode === "guaranteed" && !e.paused)).toBe(true);
  });

  it("covers every item, because there is no add-or-remove action (spec D.1)", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.priority).toHaveLength(content.stockItemIds.length + 1);
    const listed = new Set(w.priority.slice(1).map((e) => e.itemId));
    for (const itemId of content.stockItemIds) expect(listed.has(itemId)).toBe(true);
  });

  it("zeroes every stockpile, level, and reserve", () => {
    const w = initialWorld(content, 42, 0);
    for (const id of content.stockItemIds) {
      expect(w.stored[id]!.toNumber()).toBe(0);
      expect(w.quantum[id]!.toNumber()).toBe(0);
      expect(w.bound[id]!.toNumber()).toBe(0);
      expect(w.lifetime[id]!.toNumber()).toBe(0);
      expect(w.storageLevel[id]).toBe(0);
      expect(w.reserve[id]).toBe(0);
    }
    expect(w.powerBank.toNumber()).toBe(0);
    expect(w.tapStacks).toBe(0);
    expect(w.timers).toEqual([]);
    for (const lane of content.lanes.keys()) expect(w.qsLevel[lane]).toBe(0);
  });

  it("does not give the power item a stockpile", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.stored[POWER_ITEM]).toBeUndefined();
  });

  it("selects the default recipe for every item", () => {
    const w = initialWorld(content, 42, 0);
    expect(w.activeRecipe.iron_plate).toBe("make_plate");
    expect(w.activeRecipe[POWER_ITEM]).toBe("burn_fuel");
  });

  it("seeds the PRNG from the seed argument", () => {
    expect(initialWorld(content, 7, 0).seed).toEqual(initialWorld(content, 7, 0).seed);
    expect(initialWorld(content, 7, 0).seed).not.toEqual(initialWorld(content, 8, 0).seed);
  });
});

describe("withInstalled", () => {
  it("returns a new state and leaves the original untouched", () => {
    const w = initialWorld(content, 1, 0);
    const next = withInstalled(w, "iron", "miner", 2, 5);
    expect(installedAt(next, "iron", "miner", 2)).toBe(5);
    expect(installedAt(w, "iron", "miner", 2)).toBe(0);
    expect(installedAt(next, "iron", "miner", 1)).toBe(2);
    expect(installedMachines(next, "iron", "miner")).toBe(7);
  });

  it("creates the lane and class buckets on demand", () => {
    const w = initialWorld(content, 1, 0);
    const next = withInstalled(w, "oil", "refinery", 1, 3);
    expect(installedAt(next, "oil", "refinery", 1)).toBe(3);
  });
});

describe("prototype-pollution safety", () => {
  it("stores an item id of \"__proto__\" as a real own entry, in every per-item record", () => {
    const w = initialWorld(poisonedContent(), 1, 0);
    for (const record of [
      w.stored,
      w.quantum,
      w.bound,
      w.lifetime,
      w.storageLevel,
      w.reserve,
    ] as Record<string, unknown>[]) {
      expect(Object.hasOwn(record, "__proto__")).toBe(true);
      // The record's actual prototype must still be Object.prototype -- if the
      // write went through plain bracket assignment instead of Object.fromEntries,
      // this would instead equal whatever value was "assigned" to "__proto__".
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    }
    expect(w.stored["__proto__"]!.toNumber()).toBe(0);
    expect(w.storageLevel["__proto__"]).toBe(0);
  });

  it("stores a lane id of \"__proto__\" as a real own entry in qsLevel", () => {
    const w = initialWorld(poisonedContent(), 1, 0);
    expect(Object.hasOwn(w.qsLevel, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(w.qsLevel)).toBe(Object.prototype);
    expect(w.qsLevel["__proto__"]).toBe(0);
  });

  it("installs a machine class id of \"__proto__\" as a real own entry, not the lane bucket's prototype", () => {
    const w = initialWorld(content, 1, 0);
    const next = withInstalled(w, "iron", "__proto__", 1, 5);
    expect(installedAt(next, "iron", "__proto__", 1)).toBe(5);
    const laneBucket = next.installed.iron as unknown as Record<string, unknown>;
    expect(Object.hasOwn(laneBucket, "__proto__")).toBe(true);
    // If the write reassigned the prototype instead of creating an own property,
    // the lane bucket's prototype would now be the marks array, not Object.prototype.
    expect(Object.getPrototypeOf(laneBucket)).toBe(Object.prototype);
    // Every other machine class on the lane must still be readable -- a reassigned
    // prototype would silently break every OTHER lookup on this object too.
    expect(installedAt(next, "iron", "miner", 1)).toBe(2);
  });
});
