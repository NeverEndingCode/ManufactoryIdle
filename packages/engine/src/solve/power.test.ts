import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { indexContent } from "../graph/index-content.js";
import { computeCapacity } from "../economy/capacity.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";
import { absoluteClocks, isGenerator, scaleCapacityByRatio } from "./power.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

/**
 * Spec C.4's death-spiral fix, isolated at the unit level. The integration test in
 * solve.test.ts ("exempts generators from the ratio") happens not to distinguish an
 * exempted implementation from a non-exempted one on the fixture's specific
 * scenarios: mutation there converges to ratio 1 (a no-op scaling either way) or to
 * zero installed generator capacity (0 x anything is still 0) either way. These
 * tests exercise `scaleCapacityByRatio` and `absoluteClocks` directly against a real
 * generator recipe (`burn_fuel`) with genuine nonzero capacity at a ratio strictly
 * between 0 and 1, where the exemption actually changes the number.
 */
function tier3WithGenerator(): WorldState {
  let w = initialWorld(content, 1, 0);
  w = { ...w, tier: 3 };
  w = withInstalled(w, "oil", "generator", 1, 2);
  return { ...w, assignment: { ...w.assignment, burn_fuel: 2 } };
}

describe("scaleCapacityByRatio — spec C.4's generator exemption", () => {
  it("confirms burn_fuel is classified as a generator and mine_iron is not", () => {
    expect(isGenerator(content, "burn_fuel")).toBe(true);
    expect(isGenerator(content, "mine_iron")).toBe(false);
  });

  it("leaves a live generator's capacity untouched at a partial ratio", () => {
    const state = tier3WithGenerator();
    const capacity = computeCapacity(content, state);
    const before = capacity.unitsByRecipe.get("burn_fuel")!;
    expect(before).toBeGreaterThan(0);

    const scaled = scaleCapacityByRatio(content, capacity, 0.5);
    expect(scaled.unitsByRecipe.get("burn_fuel")).toBe(before);
  });

  it("scales a consuming recipe's capacity by the ratio", () => {
    const state = tier3WithGenerator();
    const capacity = computeCapacity(content, state);
    const before = capacity.unitsByRecipe.get("mine_iron")!;
    expect(before).toBeGreaterThan(0);

    const scaled = scaleCapacityByRatio(content, capacity, 0.5);
    expect(scaled.unitsByRecipe.get("mine_iron")).toBeCloseTo(before * 0.5, 12);
  });
});

describe("absoluteClocks — spec C.4's generator exemption", () => {
  it("reports a generator's clock as-is, not scaled down by the grid ratio", () => {
    const scaledClocks = new Map([
      ["burn_fuel", 0.8],
      ["mine_iron", 0.8],
    ]);
    const absolute = absoluteClocks(content, scaledClocks, 0.5);
    expect(absolute.get("burn_fuel")).toBe(0.8);
    expect(absolute.get("mine_iron")).toBeCloseTo(0.4, 12);
  });
});
