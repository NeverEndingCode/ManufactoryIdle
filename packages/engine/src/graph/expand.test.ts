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

  it("is exact on a non-binary-representable fraction — 1/500 composed through two divisions", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // 1.5 is exactly representable in binary floating point (3 * 2^-1), so the test
    // above cannot tell genuine exactness from a premature float conversion that
    // happens to round-trip. 1/500 = 1/(2^2*5^3) has a factor of 5 in its reduced
    // denominator, so its binary expansion is non-terminating (0.000000010000011...
    // repeating), making this a strictly stronger assertion than 1.5 or 0.75, which
    // any implementation lands on regardless of method. It is reached by composing
    // burn_fuel's fuel requirement (1/3 fuel/s per MW / 250 MW per unit = 1/750
    // fuel/s per MW) with residual_fuel's own unit cost (1.5 units per fuel/s):
    // (1/750) * (3/2) = 1/500 exactly, carried as a Rational the whole way and
    // converted to float64 exactly once, at the return boundary.
    //
    // What this does NOT prove: verified empirically (a scratch replay of the same
    // operations in plain `number`, plus several re-associations) that naive float64
    // composition does not actually diverge on this value in this fixture — every
    // authored rate here is a small integer over a two-or-three-recipe chain, so
    // double-rounding has nowhere to accumulate visible drift. So this assertion
    // does not currently catch a premature-conversion bug; it only confirms the
    // implementation lands on the mathematically exact value, which floats also do
    // here by luck of the numbers involved. A genuinely drift-sensitive assertion
    // needs content with awkward rates — Satisfactory's real values like 11.25/min
    // and 4.5/min — which is a Phase 2 carry-forward once the calibrated vertical
    // slice content lands; add that test then. (The exact-rational composition
    // itself is independently verified correct against a synthetic deep chain with
    // repeating binary fractions — see the task-3 review — this fixture just isn't
    // built to expose the failure mode.)
    expect(e.perUnit.get(POWER_ITEM)!.get("residual_fuel")).toBe(0.002);
  });

  it("charges the full input cost of a multi-output craft to the primary output, not the byproduct", () => {
    const c = indexContent(fixture());
    const e = computeExpansion(c, 9, c.defaultActiveRecipe);
    // refine_plastic: 20 plastic/min + 10 heavy_oil_residue/min (byproduct) per 30
    // crude_oil/min. plastic is the primary output, so 1 plastic/s books the full
    // 3 refine_plastic units and the crude_oil they pull (1.5 crude_oil/s -> 0.75
    // extract_oil units, since extract_oil makes 2 crude_oil/s per unit). The
    // byproduct heavy_oil_residue is never itself expanded here and costs nothing.
    const v = e.perUnit.get("plastic")!;
    expect(v.get("refine_plastic")).toBe(3);
    expect(v.get("extract_oil")).toBe(0.75);
    expect(v.size).toBe(2);
    expect(e.rawCost.get("plastic")!.get("crude_oil")).toBe(1.5);
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
