import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";
import { solve } from "./solve.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const NO_FLOOR = { reserveFloor: 0 };

/** 60 Mk1 miners: 300 MW of draw against the fixture's 200 MW HUB allowance. */
function brownout(tier: number): WorldState {
  let w = initialWorld(content, 1, 0);
  w = { ...w, tier };
  w = withInstalled(w, "iron", "miner", 1, 60);
  return { ...w, assignment: { ...w.assignment, mine_iron: 60 } };
}

describe("solve — the healthy case", () => {
  it("runs everything at full clock when the grid has headroom", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.power.ratio).toBe(1);
    // 2 miners x 5 + 2 smelters x 4 + 1 constructor x 4 = 22 MW.
    expect(sol.power.demandMw).toBeCloseTo(22, 9);
    expect(sol.power.supplyMw).toBeCloseTo(200, 9);
    expect(sol.clocks.get("make_plate")).toBeCloseTo(1, 12);
    expect(sol.clocks.get("smelt_iron")).toBeCloseTo(1, 12);
    expect(sol.clocks.get("mine_iron")).toBeCloseTo(1, 12);
  });

  it("reports item rates and states", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.itemRates.get("iron_plate")!.net).toBeCloseTo(1 / 3, 9);
    expect(sol.itemRates.get("iron_ingot")!.net).toBeCloseTo(0.5, 9);
    expect(sol.itemRates.get("iron_ore")!.net).toBeCloseTo(1, 9);
    expect(sol.itemStates.get("iron_ore")).toBe("EMPTY");
  });

  it("names the binding recipe and the machines that would clear it (spec 4.5)", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "make_plate",
      limitingTarget: "item:iron_plate",
      // Runner-up is smelt_iron at 2/3 plate/s against 1/3 achieved. Closing that
      // needs (2/3 - 1/3) x 3 = 1 more constructor unit, and one machine is one unit.
      machinesToClear: 1,
    });
  });

  it("quotes more machines when the runner-up is further away", () => {
    let w = initialWorld(content, 1, 0);
    // 8 smelters keeps ladderInput under the interval of 10, so the ladder stays x1.
    w = withInstalled(w, "iron", "smelter", 1, 8);
    w = { ...w, assignment: { ...w.assignment, smelt_iron: 8 } };
    // Only the plate entry, so nothing else competes for miner or smelter capacity.
    w = { ...w, priority: w.priority.filter((e) => e.itemId !== "iron_ingot" && e.itemId !== "iron_ore") };
    const sol = solve(w, content, NO_FLOOR);
    // Ratios: make_plate 1/3, smelt_iron 8/3, mine_iron 2/1.5 = 4/3. Runner-up is
    // mine_iron at 4/3. (4/3 - 1/3) x 3 = 3 constructor units, one per machine.
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "make_plate",
      limitingTarget: "item:iron_plate",
      machinesToClear: 3,
    });
  });
});

describe("solve — power equilibrium (spec C.4)", () => {
  it("settles at capacity over full-power demand, not at a square root", () => {
    const sol = solve(brownout(0), content, NO_FLOOR);
    // Full-power demand: 60 x 5 + 2 x 4 + 1 x 4 = 312 MW against 200 MW of supply.
    expect(sol.power.fullDemandMw).toBeCloseTo(312, 6);
    expect(sol.power.supplyMw).toBeCloseTo(200, 9);
    expect(sol.power.ratio).toBeCloseTo(200 / 312, 9);
    // At equilibrium the grid draws exactly what it can supply.
    expect(sol.power.demandMw).toBeCloseTo(200, 6);
  });

  it("converges within the 2 to 3 passes spec C.4 predicts", () => {
    expect(solve(brownout(0), content, NO_FLOOR).power.passes).toBeLessThanOrEqual(3);
  });

  it("reports absolute clocks, scaled by the ratio", () => {
    const sol = solve(brownout(0), content, NO_FLOOR);
    expect(sol.clocks.get("mine_iron")).toBeCloseTo(200 / 312, 9);
    expect(sol.clocks.get("smelt_iron")).toBeCloseTo(200 / 312, 9);
  });

  it("surfaces a power-shaped bottleneck and a generator purchase (spec 4.5)", () => {
    const sol = solve(brownout(3), content, NO_FLOOR);
    const bottleneck = sol.bottleneck;
    if (bottleneck === null || bottleneck.kind !== "power") throw new Error("unreachable");
    // burn_fuel makes 250 MW per unit; at tier 3 the oil lane carries a x1.5 x x1.5
    // milestone multiplier, so one generator machine is 2.25 units = 562.5 MW.
    // The deficit is 312 - 200 = 112 MW, so one machine covers it.
    expect(bottleneck.generatorRecipeId).toBe("burn_fuel");
    expect(bottleneck.machinesToClear).toBe(1);
  });

  it("reports no generator to buy when none is unlocked", () => {
    const sol = solve(brownout(0), content, NO_FLOOR);
    const bottleneck = sol.bottleneck;
    if (bottleneck === null || bottleneck.kind !== "power") {
      throw new Error("expected a power bottleneck");
    }
    expect(bottleneck.generatorRecipeId).toBeNull();
    expect(bottleneck.machinesToClear).toBe(0);
  });

  it("exempts generators from the ratio, so a brownout cannot spiral (spec C.4)", () => {
    let w = brownout(3);
    w = withInstalled(w, "oil", "generator", 1, 1);
    w = { ...w, assignment: { ...w.assignment, burn_fuel: 1 } };
    // A stocked fuel buffer at its cap, so the generator draws from stock rather
    // than needing the whole oil chain built.
    w = {
      ...w,
      stored: { ...w.stored, fuel: D(200) },
      quantum: { ...w.quantum, fuel: D(800) },
    };
    const sol = solve(w, content, NO_FLOOR);
    // One generator machine is 2.25 units x 250 MW = 562.5 MW of headroom, so the
    // grid recovers: supply 200 + 312 = 512 against 312 of demand.
    expect(sol.power.ratio).toBe(1);
    expect(sol.clocks.get("mine_iron")).toBeCloseTo(1, 9);
    // The generator throttles itself to the demand it is asked for: 312 / 562.5.
    expect(sol.clocks.get("burn_fuel")).toBeCloseTo(312 / 562.5, 6);
    expect(sol.power.supplyMw).toBeCloseTo(512, 6);
  });
});

describe("solve — options and shape", () => {
  it("seeds the pin set by default and reports the pass count", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.pinnedEmpty.has("iron_ore")).toBe(true);
    expect(sol.passes).toBe(1);
  });

  it("honours seedPins: false", () => {
    const sol = solve(initialWorld(content, 1, 0), content, { ...NO_FLOOR, seedPins: false });
    expect(sol.passes).toBeLessThanOrEqual(content.itemIds.length);
  });

  it("applies the 2% reserve floor by default", () => {
    const sol = solve(initialWorld(content, 1, 0), content);
    // mine_iron and smelt_iron are contested, so 2% of each sits idle.
    expect(sol.clocks.get("mine_iron")).toBeCloseTo(0.98, 9);
    expect(sol.clocks.get("make_plate")).toBeCloseTo(1, 9);
  });

  it("exposes the capacity table it solved against", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.capacity.unitsByRecipe.get("mine_iron")).toBeCloseTo(2, 12);
  });

  it("is a pure function — solving twice gives identical numbers", () => {
    const w = brownout(3);
    const a = solve(w, content, NO_FLOOR);
    const b = solve(w, content, NO_FLOOR);
    expect(a.power.ratio).toBe(b.power.ratio);
    for (const [recipeId, clock] of a.clocks) expect(b.clocks.get(recipeId)).toBe(clock);
  });
});

/**
 * Ruling R30 (task 10, fix round 1). fuel's raw cost stops at heavy_oil_residue
 * (spec F.1's deliberate, unchanged byproduct cutoff), but the EMPTY invariant is a
 * separate, unconditional runtime rule (spec C.2, spec 3.4): consumption must never
 * exceed production for a zero-stock item, byproduct-sourced or not.
 *
 * 2 extractors, 3 refineries split 1 refine_plastic / 2 residual_fuel: refine_plastic
 * (pulled only by plastic's own priority demand) produces heavy_oil_residue far
 * slower than residual_fuel's own installed capacity could consume it. Before this
 * fix, requirementVector's walk for the `fuel` entry could not reach
 * heavy_oil_residue (it has no active recipe of its own -- it is never anyone's
 * primary output) and treated it as a free leaf, so residual_fuel ran unthrottled at
 * its own capacity: heavy_oil_residue net came out at -2.75 item/s against zero
 * stock. fixpoint.ts's EMPTY clamp now enforces this directly on itemStates rather
 * than through the requirement walk.
 */
function byproductStarvation(tier: number): WorldState {
  let w = initialWorld(content, 1, 0);
  w = { ...w, tier };
  w = withInstalled(w, "oil", "extractor", 1, 2);
  w = withInstalled(w, "oil", "refinery", 1, 3);
  return {
    ...w,
    assignment: {
      ...w.assignment,
      extract_oil: 2,
      refine_plastic: 1,
      residual_fuel: 2,
    },
  };
}

describe("solve — the EMPTY invariant holds through a byproduct (ruling R30)", () => {
  it("clamps residual_fuel to what heavy_oil_residue actually supplies, not to its own capacity", () => {
    const sol = solve(byproductStarvation(2), content, NO_FLOOR);

    // refine_plastic is unthrottled (nothing pulls back on it): 1 unit x 1.5 (tier-2
    // oil lane multiplier) = 1.5 machine-units at clock 1, producing heavy_oil_residue
    // at 1.5 x 10/60 = 0.25 item/s.
    expect(sol.clocks.get("refine_plastic")).toBeCloseTo(1, 9);
    const residue = sol.itemRates.get("heavy_oil_residue")!;
    expect(residue.production).toBeCloseTo(0.25, 9);

    // Before ruling R30, residual_fuel ran flat out on its own 2-unit x 1.5 = 3
    // machine-units of capacity, consuming heavy_oil_residue at 3 item/s -- 12x what
    // refine_plastic actually makes, against zero stock. The clamp now throttles
    // residual_fuel to 0.25/1 = 0.25 achieved machine-units, i.e. clock 0.25/3.
    expect(sol.clocks.get("residual_fuel")).toBeCloseTo(0.25 / 3, 9);

    // The invariant itself: an EMPTY item's consumption must not exceed its
    // production.
    expect(residue.consumption).toBeCloseTo(residue.production, 9);
    expect(residue.net).toBeGreaterThanOrEqual(-1e-9);
    expect(sol.itemStates.get("heavy_oil_residue")).toBe("EMPTY");

    // fuel's achievable rate now actually reflects what the starved byproduct can
    // sustain (0.25 residual_fuel-units x 40/60 fuel/unit), not residual_fuel's own
    // unconstrained capacity.
    const fuel = sol.itemRates.get("fuel")!;
    expect(fuel.production).toBeCloseTo((0.25 / 3) * 3 * (40 / 60), 9);
    expect(fuel.production).toBeCloseTo(1 / 6, 9);
  });

  it("holds the EMPTY invariant everywhere on the fixture, not just this one item", () => {
    const scenarios = [
      initialWorld(content, 1, 0),
      brownout(0),
      brownout(3),
      byproductStarvation(2),
      byproductStarvation(3),
    ];
    for (const state of scenarios) {
      const sol = solve(state, content, NO_FLOOR);
      for (const [itemId, tag] of sol.itemStates) {
        if (tag !== "EMPTY") continue;
        const flow = sol.itemRates.get(itemId);
        if (!flow) continue;
        expect(flow.consumption).toBeLessThanOrEqual(flow.production + 1e-9);
      }
    }
  });
});
