import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBundleDir } from "../load.js";
import { validateBundle } from "./index.js";
import { maxAttainableCap } from "./economy.js";

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

  // Check 9 rejects a requirement ABOVE the cap, which leaves the far more common
  // failure silent: one that fits by a hair. Tier 9's polymer_resin sat at 99.6% of its
  // ceiling -- legal, and one bisection step from a wall the calibrator could not see
  // past. The amounts search then reported a miss rather than an error, so a terminated
  // ladder looked like content that merely paced badly.
  //
  // Only tiers the run actually FITTED are held to this. Where a target is out of reach
  // the amounts search saturates against whatever ceiling exists, by construction and at
  // any ladder depth -- tier 10 asks 93.5% of its cap at maxLevel 22 and would ask the
  // same share at 30, because the deep end answers the requirement logarithmically and
  // the search keeps climbing for a target it can never hit. Asserting headroom there
  // would report an unreachable target as a storage defect and invite deepening the
  // ladder until the content asks for ten billion units. The miss is already the finding.
  it("leaves every fitted milestone real headroom under its storage ceiling", () => {
    const b = bundle();
    const run = b.derived?.run;
    expect(run, "the slice must ship a calibration run to check headroom against").toBeDefined();
    const fitted = (tier: number): boolean => {
      const target = run!.targetCollectionsToTier[tier - 1];
      const observed = run!.observedCollectionsToTier?.[tier - 1];
      if (target === undefined || observed === undefined || observed === null) return false;
      return Math.abs(observed - target) / target <= 0.05;
    };

    const items = new Map(b.items.map((i) => [i.id, i]));
    const tight = b.milestones
      .filter((m) => fitted(m.tier))
      .flatMap((m) =>
        m.requires.map((r) => {
          const cap = maxAttainableCap(b, items.get(r.item)!, Math.max(0, m.tier - 1));
          return `tier ${m.tier} ${r.item} ${((r.amount / cap) * 100).toFixed(1)}%`;
        }),
      )
      .filter((line) => Number(line.split(" ").at(-1)!.replace("%", "")) > 60);
    expect(tight).toEqual([]);
  });

  it("carries alternate recipes and machine marks", () => {
    expect(bundle().recipes.filter((r) => r.isAlternate).length).toBeGreaterThanOrEqual(7);
    expect(bundle().machineClasses.some((m) => m.marks.length > 1)).toBe(true);
  });
});
