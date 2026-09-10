import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBundleDir } from "../load.js";
import { validateBundle } from "./index.js";

// The B.5 vertical slice — the content the game actually runs on, and the
// content Task 3 calibrates. It was authored with no test and no script
// covering it: `content:check` was pinned to `bundles/fixture`, so nothing in
// CI would have noticed it breaking. These assertions track B.5's *load-bearing
// properties* rather than its exact size, so authoring more content is free but
// losing one of the shapes the solver is meant to exercise is not.
const sliceDir = fileURLToPath(new URL("../../bundles/vertical-slice", import.meta.url));

const bundle = () => loadBundleDir(sliceDir);
const recipe = (id: string) => {
  const found = bundle().recipes.find((r) => r.id === id);
  if (!found) throw new Error(`slice is missing recipe ${id}`);
  return found;
};
const inputIds = (id: string) => recipe(id).inputs.map((i) => i.item);
const outputIds = (id: string) => recipe(id).outputs.map((o) => o.item);

describe("the vertical slice", () => {
  it("loads and reports no errors", () => {
    const issues = validateBundle(bundle());
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("warns about exactly the one deliberate cycle", () => {
    // B.5 authors Recycled Plastic <-> Recycled Rubber as a genuine SCC so the
    // cycle detector has something real to catch. If this assertion changes,
    // the v1 SCC decision changed with it — that is the point of pinning it.
    const warnings = validateBundle(bundle()).filter((i) => i.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.check).toBe(6);
    expect(warnings[0]?.message).toContain("alt_recycled_plastic");
    expect(warnings[0]?.message).toContain("alt_recycled_rubber");
  });

  it("covers the five B.5 lanes", () => {
    expect(bundle().lanes.map((l) => l.id).sort()).toEqual([
      "coal",
      "copper",
      "iron",
      "oil",
      "power",
    ]);
  });

  it("is the full slice, not a truncated one", () => {
    const b = bundle();
    expect(b.items.length).toBeGreaterThanOrEqual(31);
    expect(b.recipes.length).toBeGreaterThanOrEqual(44);
  });

  it("exercises cross-lane contention", () => {
    // Steel Ingot draws iron ore and coal, so the Iron and Coal lanes compete
    // for the same solver capacity — the reason the slice has four lanes.
    expect(inputIds("make_steel_ingot").sort()).toEqual(["coal", "iron_ore"]);
    expect(inputIds("make_encased_industrial_beam").sort()).toEqual(["concrete", "steel_beam"]);
  });

  it("closes the byproduct triangle", () => {
    // Two emitters, and two consume corners so the triangle has an outlet even
    // when one is unbuilt (spec section 3.4).
    for (const id of ["refine_plastic", "refine_rubber", "refine_polymer_resin"]) {
      const hor = recipe(id).outputs.find((o) => o.item === "heavy_oil_residue");
      expect(hor?.byproduct).toBe(true);
    }
    expect(inputIds("refine_residual_fuel")).toContain("heavy_oil_residue");
    expect(inputIds("alt_coated_cable")).toContain("heavy_oil_residue");
  });

  it("exercises fluids and packaging", () => {
    expect(bundle().items.filter((i) => i.fluid).length).toBeGreaterThanOrEqual(4);
    // Packaged Fuel exists so the "fluids cannot be sunk directly" rule has a
    // path around it.
    expect(inputIds("package_fuel").sort()).toEqual(["empty_canister", "fuel"]);
    expect(outputIds("package_fuel")).toEqual(["packaged_fuel"]);
  });

  it("has generation at three power tiers", () => {
    const generators = bundle().recipes.filter((r) => r.powerOutput > 0);
    expect(generators.map((r) => r.id).sort()).toEqual(["burn_biomass", "burn_coal", "burn_fuel"]);
    // Coal generation is water-gated, which is what makes power contend with
    // the Oil lane's extractors.
    expect(inputIds("burn_coal")).toContain("water");
  });

  it("carries alternate recipes and machine marks", () => {
    expect(bundle().recipes.filter((r) => r.isAlternate).length).toBeGreaterThanOrEqual(7);
    expect(bundle().machineClasses.some((m) => m.marks.length > 1)).toBe(true);
  });
});
