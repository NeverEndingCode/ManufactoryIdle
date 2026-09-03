import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { beforeEach, describe, expect, it } from "vitest";
import { POWER_ITEM, type ContentBundle } from "../content/types.js";
import { clearExpansionCache, computeExpansion, expansionKey } from "./expand.js";
import { indexContent } from "./index-content.js";

const fixtureDir = fileURLToPath(
  new URL("../../../content/bundles/fixture", import.meta.url),
);
function fixture(): ContentBundle {
  return loadBundleDir(fixtureDir);
}

beforeEach(() => clearExpansionCache());

describe("computeExpansion", () => {
  it("computes machine-units per item per second", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // mine_iron makes 1 ore/s per unit -> 1 unit per ore/s.
    expect(e.unitsPerItem.get("iron_ore")).toBeCloseTo(1, 12);
    // smelt_iron makes 0.5 ingot/s per unit -> 2 units per ingot/s.
    expect(e.unitsPerItem.get("iron_ingot")).toBeCloseTo(2, 12);
    // make_plate makes 1/3 plate/s per unit -> 3 units per plate/s.
    expect(e.unitsPerItem.get("iron_plate")).toBeCloseTo(3, 12);
  });

  it("computes direct input requirements per unit of output", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // One plate needs 30 ingot/min per 20 plate/min = 1.5 ingot.
    expect(e.directInputs.get("iron_plate")!.get("iron_ingot")).toBeCloseTo(1.5, 12);
    // One ingot needs 30 ore/min per 30 ingot/min = 1 ore.
    expect(e.directInputs.get("iron_ingot")!.get("iron_ore")).toBeCloseTo(1, 12);
    expect(e.directInputs.get("iron_ore")!.size).toBe(0);
  });

  it("composes the full per-unit recipe vector across the chain", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    const v = e.perUnit.get("iron_plate")!;
    // 1 plate/s needs 3 make_plate units; those pull 1.5 ingot/s, needing 3
    // smelt_iron units; those pull 1.5 ore/s, needing 1.5 mine_iron units.
    expect(v.get("make_plate")).toBeCloseTo(3, 12);
    expect(v.get("smelt_iron")).toBeCloseTo(3, 12);
    expect(v.get("mine_iron")).toBeCloseTo(1.5, 12);
    expect(v.size).toBe(3);
  });

  it("traces raw extraction cost per unit", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // 1 plate = 1.5 ingot = 1.5 ore.
    expect(e.rawCost.get("iron_plate")!.get("iron_ore")).toBeCloseTo(1.5, 12);
    expect(e.rawCost.get("iron_ore")!.get("iron_ore")).toBeCloseTo(1, 12);
  });

  it("expands power back through the fuel chain", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // burn_fuel: 250 MW per unit -> 1/250 units per MW. It pulls 20 fuel/min =
    // 1/3 fuel/s per unit, so 1 MW pulls 1/750 fuel/s.
    expect(e.unitsPerItem.get(POWER_ITEM)).toBeCloseTo(1 / 250, 12);
    expect(e.perUnit.get(POWER_ITEM)!.get("burn_fuel")).toBeCloseTo(1 / 250, 12);
    // residual_fuel makes 40 fuel/min = 2/3 fuel/s per unit -> 1.5 units per fuel/s.
    // 1 MW needs 1/750 fuel/s -> 1.5/750 = 0.002 residual_fuel units.
    expect(e.perUnit.get(POWER_ITEM)!.get("residual_fuel")).toBeCloseTo(0.002, 12);
  });

  it("is exact where floats would drift — 1/3 composed three deep", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // 1 plate/s pulls 1.5 ore/s exactly; a float chain through 20/60 and 30/60
    // would leave a last-digit residue. Exact rationals mean this is dead on.
    expect(e.rawCost.get("iron_plate")!.get("iron_ore")).toBe(1.5);
  });

  it("stops at items whose recipe is locked at the given tier", () => {
    const c = indexContent(fixture());
    const early = computeExpansion(c, 0, c.defaultActiveRecipe);
    expect(early.unitsPerItem.has("plastic")).toBe(false);
    expect(early.perUnit.has("plastic")).toBe(false);
    const late = computeExpansion(c, 3, c.defaultActiveRecipe);
    expect(late.unitsPerItem.has("plastic")).toBe(true);
  });

  it("keys the cache on content version, tier, and the active recipe set", () => {
    const c = indexContent(fixture());
    const a = expansionKey(c, 2, c.defaultActiveRecipe);
    expect(a).toContain("fixture.v1");
    expect(expansionKey(c, 3, c.defaultActiveRecipe)).not.toBe(a);
    expect(expansionKey(c, 2, { ...c.defaultActiveRecipe, iron_plate: "other" })).not.toBe(a);
  });

  it("returns the identical object for a repeated call", () => {
    const c = indexContent(fixture());
    expect(computeExpansion(c, 9, c.defaultActiveRecipe)).toBe(
      computeExpansion(c, 9, c.defaultActiveRecipe),
    );
  });

  it("excludes cyclic recipes entirely (ruling R6)", () => {
    const b = fixture();
    b.recipes.push({
      id: "recycle_plastic",
      name: "Recycled Plastic",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      outputs: [{ item: "plastic", rate: "20", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 2,
    });
    b.recipes.push({
      id: "recycle_residue",
      name: "Recycled Residue",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "plastic", rate: "20", byproduct: false }],
      outputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 2,
    });
    const c = indexContent(b);
    const e = computeExpansion(c, 9, {
      ...c.defaultActiveRecipe,
      plastic: "recycle_plastic",
      heavy_oil_residue: "recycle_residue",
    });
    // Both are cyclic, so neither is live and neither item expands.
    expect(e.perUnit.has("plastic")).toBe(false);
    expect(e.perUnit.has("heavy_oil_residue")).toBe(false);
    // The acyclic rest of the graph is unaffected.
    expect(e.perUnit.get("iron_plate")!.get("mine_iron")).toBeCloseTo(1.5, 12);
  });
});
