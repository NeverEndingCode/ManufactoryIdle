import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { POWER_ITEM, type ContentBundle } from "../content/types.js";
import { getMark, indexContent, isLiveRecipe, laneClassKey } from "./index-content.js";

const fixtureDir = fileURLToPath(
  new URL("../../../content/bundles/fixture", import.meta.url),
);

function fixture(): ContentBundle {
  return loadBundleDir(fixtureDir);
}

describe("indexContent", () => {
  it("indexes every lane, item, class and recipe by id", () => {
    const c = indexContent(fixture());
    expect(c.lanes.get("iron")!.name).toBe("Iron");
    expect(c.items.get("iron_plate")!.tier).toBe(1);
    expect(c.machineClasses.get("constructor")!.costRatio).toBe(1.09);
    expect(c.recipes.get("make_plate")!.def.name).toBe("Iron Plate");
  });

  it("converts authored per-minute rates to per-second floats", () => {
    const c = indexContent(fixture());
    // mine_iron: 60/min -> 1/s.  make_plate: 30/min in, 20/min out -> 0.5/s, 1/3/s.
    expect(c.recipes.get("mine_iron")!.outputPerSecond.get("iron_ore")).toBe(1);
    expect(c.recipes.get("make_plate")!.inputPerSecond.get("iron_ingot")).toBe(0.5);
    expect(c.recipes.get("make_plate")!.outputPerSecond.get("iron_plate")).toBeCloseTo(1 / 3, 12);
  });

  it("gives a generator the synthetic power item as its primary output", () => {
    const c = indexContent(fixture());
    const burn = c.recipes.get("burn_fuel")!;
    expect(burn.primaryOutput).toBe(POWER_ITEM);
    // 250 MW is a standing output, not a per-minute rate, so it is not divided by 60.
    expect(burn.outputPerSecond.get(POWER_ITEM)).toBe(250);
    expect(burn.inputPerSecond.get("fuel")).toBeCloseTo(20 / 60, 12);
  });

  it("puts the power item in itemIds but not in stockItemIds", () => {
    const c = indexContent(fixture());
    expect(c.itemIds).toContain(POWER_ITEM);
    expect(c.stockItemIds).not.toContain(POWER_ITEM);
    expect(c.stockItemIds).toHaveLength(c.bundle.items.length);
  });

  it("maps producers and consumers, counting byproducts as production", () => {
    const c = indexContent(fixture());
    expect(c.producersOf.get("heavy_oil_residue")).toEqual(["refine_plastic"]);
    expect(c.consumersOf.get("heavy_oil_residue")).toEqual(["residual_fuel"]);
    expect(c.producersOf.get(POWER_ITEM)).toEqual(["burn_fuel"]);
  });

  it("groups recipes by lane and class", () => {
    const c = indexContent(fixture());
    expect(c.recipesByLaneClass.get(laneClassKey("oil", "refinery"))!.sort()).toEqual([
      "refine_plastic",
      "residual_fuel",
    ]);
  });

  it("orders items so producers come before consumers", () => {
    const c = indexContent(fixture());
    const at = (id: string) => c.topologicalItems.indexOf(id);
    expect(at("iron_ore")).toBeLessThan(at("iron_ingot"));
    expect(at("iron_ingot")).toBeLessThan(at("iron_plate"));
    expect(at("crude_oil")).toBeLessThan(at("heavy_oil_residue"));
    expect(at("heavy_oil_residue")).toBeLessThan(at("fuel"));
    expect(at("fuel")).toBeLessThan(at(POWER_ITEM));
    expect(c.topologicalItems).toHaveLength(c.itemIds.length);
  });

  it("finds no cycles in the acyclic fixture", () => {
    expect(indexContent(fixture()).cyclicRecipes.size).toBe(0);
  });

  it("marks every recipe of a genuine cycle as cyclic and never live (ruling R6)", () => {
    const b = fixture();
    // Recycled Plastic / Recycled Rubber in miniature: plastic <-> residue.
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
    expect(c.cyclicRecipes.has("recycle_plastic")).toBe(true);
    expect(c.cyclicRecipes.has("recycle_residue")).toBe(true);
    expect(c.cyclicRecipes.has("make_plate")).toBe(false);
    expect(isLiveRecipe(c, "recycle_plastic", 9, { plastic: "recycle_plastic" })).toBe(false);
  });

  it("picks the earliest-declared non-alternate recipe as each item's default", () => {
    const c = indexContent(fixture());
    expect(c.defaultActiveRecipe.iron_plate).toBe("make_plate");
    expect(c.defaultActiveRecipe[POWER_ITEM]).toBe("burn_fuel");
  });

  it("reports a recipe live only when unlocked, acyclic, and selected", () => {
    const c = indexContent(fixture());
    const active = { ...c.defaultActiveRecipe };
    expect(isLiveRecipe(c, "make_plate", 0, active)).toBe(true);
    expect(isLiveRecipe(c, "refine_plastic", 1, active)).toBe(false); // unlockTier 2
    expect(isLiveRecipe(c, "refine_plastic", 2, active)).toBe(true);
    expect(isLiveRecipe(c, "make_plate", 0, { ...active, iron_plate: "other" })).toBe(false);
  });

  it("indexes milestones and derives maxTier and the offline cap", () => {
    const c = indexContent(fixture());
    expect(c.milestoneByTier.get(2)!.name).toBe("Oil Access");
    expect(c.maxTier).toBe(3);
    expect(c.offlineCapMs).toBe(8 * 60 * 60 * 1000);
  });

  it("looks up a machine class mark by number", () => {
    const c = indexContent(fixture());
    expect(getMark(c, "constructor", 1)!.name).toBe("Constructor");
    expect(getMark(c, "constructor", 99)).toBeUndefined();
    expect(getMark(c, "ghost_class", 1)).toBeUndefined();
  });

  it("rejects a recipe whose machine class does not exist", () => {
    const b = fixture();
    b.recipes[0]!.machineClass = "ghost";
    expect(() => indexContent(b)).toThrow(/ghost/);
  });
});
