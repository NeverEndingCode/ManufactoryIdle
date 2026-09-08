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

  // The regression that matters most for check 7. This bundle WAS an unbootstrappable
  // deadlock in Phase 0 and validated clean, because the check compared tiers rather
  // than proving reachability. Taking the starting machines away restores exactly that
  // state, on real content rather than a synthetic bundle.
  it("fails loudly once the starting machines that bootstrap it are removed", () => {
    const bundle = loadBundleDir(fixtureDir);
    bundle.start.machines = [];
    const issues = validateBundle(bundle);
    const bootstrap = issues.filter((i) => i.check === 7);
    expect(bootstrap.length).toBeGreaterThan(0);
    expect(bootstrap.every((i) => i.message.includes("unreachable"))).toBe(true);
  });

  it("has an r_eff above the runaway floor for every machine class", () => {
    const bundle = loadBundleDir(fixtureDir);
    expect(validateBundle(bundle).filter((i) => i.check === 8)).toEqual([]);
  });
});
