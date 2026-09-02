import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBundleDir } from "../load.js";
import { validateBundle } from "./index.js";

const fixtureDir = fileURLToPath(new URL("../../bundles/fixture", import.meta.url));

describe("the fixture bundle", () => {
  it("loads and passes every implemented check", () => {
    const bundle = loadBundleDir(fixtureDir);
    expect(validateBundle(bundle)).toEqual([]);
  });

  it("covers the shapes the engine needs to exercise", () => {
    const bundle = loadBundleDir(fixtureDir);
    expect(bundle.lanes.length).toBeGreaterThanOrEqual(2);
    expect(bundle.items.some((i) => i.fluid)).toBe(true);
    expect(bundle.recipes.some((r) => r.inputs.length === 0)).toBe(true);
    expect(bundle.recipes.some((r) => r.outputs.some((o) => o.byproduct))).toBe(true);
    expect(bundle.recipes.some((r) => r.powerOutput > 0)).toBe(true);
    expect(bundle.machineClasses.some((m) => m.marks.length > 1)).toBe(true);
  });

  it("fails loudly once a byproduct outlet is removed", () => {
    const bundle = loadBundleDir(fixtureDir);
    bundle.recipes = bundle.recipes.filter((r) => r.id !== "residual_fuel");
    const issues = validateBundle(bundle);
    expect(issues.some((i) => i.check === 5)).toBe(true);
  });
});
