import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { POWER_ITEM } from "../content/types.js";
import { indexContent } from "../graph/index-content.js";
import {
  initialWorld,
  installedMachines,
  withInstalled,
  type WorldState,
} from "../state/world.js";
import {
  bestUnlockedMark,
  computeCapacity,
  installedUnits,
  powerDemandMw,
  powerSupplyMw,
  unconstrainedRate,
} from "./capacity.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

/** 8 Mk1 miners (rate x1) plus 4 Mk2 (rate x3): 12 machines, 20 mark-weighted units. */
function pooled(): WorldState {
  let w = initialWorld(content, 1, 0);
  w = withInstalled(w, "iron", "miner", 1, 8);
  w = withInstalled(w, "iron", "miner", 2, 4);
  return { ...w, assignment: { ...w.assignment, mine_iron: 9 } };
}

describe("installedUnits", () => {
  it("weights each mark by its rate multiplier (ruling R5)", () => {
    expect(installedUnits(content, pooled(), "iron", "miner")).toBe(20);
  });

  it("is zero for an empty lane-class", () => {
    expect(installedUnits(content, initialWorld(content, 1, 0), "oil", "refinery")).toBe(0);
  });
});

describe("computeCapacity", () => {
  it("distributes the pooled units by assigned fraction (ruling R5)", () => {
    const cap = computeCapacity(content, pooled());
    // 9 of 12 machines assigned -> 0.75 of 20 units = 15, times the ladder x2.25
    // (ladderInput 20, interval 10, step 1.5) = 33.75.
    expect(cap.machinesByRecipe.get("mine_iron")).toBe(9);
    expect(cap.multiplierByRecipe.get("mine_iron")).toBeCloseTo(2.25, 12);
    expect(cap.unitsByRecipe.get("mine_iron")).toBeCloseTo(33.75, 9);
  });

  it("reports units per additional machine, for bottleneck arithmetic", () => {
    const cap = computeCapacity(content, pooled());
    // One more machine at the best unlocked mark. At tier 0 only Mk1 is unlocked,
    // so rateMultiplier 1 x the 2.25 ladder = 2.25 units per machine.
    expect(cap.unitsPerMachine.get("mine_iron")).toBeCloseTo(2.25, 12);
  });

  it("averages power draw over the pool, per machine (ruling R5)", () => {
    const cap = computeCapacity(content, pooled());
    // (8 x 5 MW + 4 x 15 MW) / 12 machines = 100/12 MW per machine.
    expect(cap.drawPerMachine.get("iron::miner")).toBeCloseTo(100 / 12, 12);
  });

  it("gives an unassigned recipe zero capacity", () => {
    const w = { ...pooled(), assignment: { mine_iron: 0 } };
    expect(computeCapacity(content, w).unitsByRecipe.get("mine_iron")).toBe(0);
  });

  it("gives a locked recipe no capacity even when machines are assigned", () => {
    let w = initialWorld(content, 1, 0);
    w = withInstalled(w, "oil", "refinery", 1, 4);
    w = { ...w, assignment: { ...w.assignment, refine_plastic: 4 } };
    // refine_plastic unlocks at tier 2; the world is at tier 0.
    expect(computeCapacity(content, w).unitsByRecipe.has("refine_plastic")).toBe(false);
    // At tier 2 the oil lane has picked up that tier's x1.5 milestone grant, so the
    // four machines are 6 machine-units.
    expect(
      computeCapacity(content, { ...w, tier: 2 }).unitsByRecipe.get("refine_plastic"),
    ).toBeCloseTo(6, 9);
  });

  it("gives a deselected recipe no capacity (spec 4.4)", () => {
    const w = pooled();
    const deselected = { ...w, activeRecipe: { ...w.activeRecipe, iron_ore: "nothing" } };
    expect(computeCapacity(content, deselected).unitsByRecipe.has("mine_iron")).toBe(false);
  });

  it("scales with the lane multiplier once milestones land", () => {
    const cap = computeCapacity(content, { ...pooled(), tier: 1 });
    // ladder 2.25 x lane 1.5 = 3.375; 15 base units -> 50.625.
    expect(cap.multiplierByRecipe.get("mine_iron")).toBeCloseTo(3.375, 12);
    expect(cap.unitsByRecipe.get("mine_iron")).toBeCloseTo(50.625, 9);
  });

  it("scales with the tap kick", () => {
    const cap = computeCapacity(content, { ...pooled(), tapStacks: 10 });
    // ladder 2.25 x tap 1.5 = 3.375.
    expect(cap.multiplierByRecipe.get("mine_iron")).toBeCloseTo(3.375, 12);
  });
});

describe("bestUnlockedMark", () => {
  it("returns the highest mark unlocked at the tier", () => {
    expect(bestUnlockedMark(content, "miner", 0)).toBe(1);
    expect(bestUnlockedMark(content, "miner", 1)).toBe(2);
    expect(bestUnlockedMark(content, "miner", 5)).toBe(2);
  });

  it("returns null when nothing is unlocked yet", () => {
    expect(bestUnlockedMark(content, "generator", 0)).toBeNull();
    expect(bestUnlockedMark(content, "generator", 3)).toBe(1);
  });
});

describe("unconstrainedRate", () => {
  it("is total production at clock 1 across every live producer", () => {
    const cap = computeCapacity(content, pooled());
    // 33.75 units x 1 ore/s per unit = 33.75 ore/s.
    expect(unconstrainedRate(content, cap, "iron_ore")).toBeCloseTo(33.75, 9);
  });
});

describe("power", () => {
  it("charges draw against assigned machines, weighted by clock", () => {
    const w = pooled();
    const cap = computeCapacity(content, w);
    const clocks = new Map([["mine_iron", 1]]);
    // 9 machines x 100/12 MW = 75 MW at clock 1.
    expect(powerDemandMw(content, cap, w, clocks)).toBeCloseTo(75, 9);
    expect(powerDemandMw(content, cap, w, new Map([["mine_iron", 0.5]]))).toBeCloseTo(37.5, 9);
  });

  it("charges nothing for idle machines", () => {
    let w = initialWorld(content, 1, 0);
    w = withInstalled(w, "iron", "miner", 1, 10);
    w = { ...w, assignment: { mine_iron: 0 } };
    const cap = computeCapacity(content, w);
    expect(powerDemandMw(content, cap, w, new Map([["mine_iron", 1]]))).toBe(0);
  });

  it("sums generator output on top of the HUB allowance", () => {
    let w = initialWorld(content, 1, 0);
    // burn_fuel unlocks at tier 3, so the world has to be there for it to be live.
    w = { ...w, tier: 3 };
    w = withInstalled(w, "oil", "generator", 1, 2);
    w = { ...w, assignment: { ...w.assignment, burn_fuel: 2 } };
    const cap = computeCapacity(content, w);
    // At tier 3 the oil lane carries the tier-2 and tier-3 milestone grants, x1.5
    // each, so the lane multiplier is 2.25 and 2 machines are 4.5 machine-units.
    expect(cap.unitsByRecipe.get("burn_fuel")).toBeCloseTo(4.5, 9);
    // 4.5 units x 250 MW at clock 1 = 1125, plus the fixture's 200 MW HUB allowance.
    expect(powerSupplyMw(content, cap, new Map([["burn_fuel", 1]]))).toBeCloseTo(1325, 6);
    // At clock 0.4: 1125 * 0.4 = 450, plus 200.
    expect(powerSupplyMw(content, cap, new Map([["burn_fuel", 0.4]]))).toBeCloseTo(650, 6);
  });

  it("counts the power item as a generator output, not a stockpile", () => {
    expect(content.stockItemIds).not.toContain(POWER_ITEM);
  });
});

// Three boundaries called out explicitly in the task brief: zero installed machines
// in a lane-class (division by zero in assignedFraction), assignment exactly equal
// to installedMachines, and a mark upgrade that consolidates machine count downward
// while holding installedUnits constant (ruling R5's mark-weighting).
describe("R5 boundaries", () => {
  it("does not divide by zero when a lane-class has no installed machines", () => {
    // refine_plastic is live at tier 2, but no refinery has ever been installed --
    // assignedFraction's denominator (installedMachines) is 0, even though (through
    // a bug elsewhere) machines are assigned to the recipe.
    let w = initialWorld(content, 1, 0);
    w = { ...w, tier: 2, assignment: { ...w.assignment, refine_plastic: 3 } };
    expect(installedMachines(w, "oil", "refinery")).toBe(0);
    const cap = computeCapacity(content, w);
    expect(cap.unitsByRecipe.get("refine_plastic")).toBe(0);
    expect(cap.drawPerMachine.get("oil::refinery")).toBe(0);
  });

  it("gives the full pool when assignment exactly equals installedMachines", () => {
    let w = initialWorld(content, 1, 0);
    w = withInstalled(w, "iron", "miner", 1, 5);
    w = { ...w, assignment: { ...w.assignment, mine_iron: 5 } };
    const cap = computeCapacity(content, w);
    // fraction = 5/5 = 1, so unitsByRecipe equals installedUnits x multiplier exactly.
    const units = installedUnits(content, w, "iron", "miner");
    const multiplier = cap.multiplierByRecipe.get("mine_iron")!;
    expect(cap.unitsByRecipe.get("mine_iron")).toBeCloseTo(units * multiplier, 9);
  });

  it("keeps installedUnits constant when a mark upgrade consolidates machine count", () => {
    // The fixture's start.yaml installs 2 starting Mk1 miners; clear that slot in
    // both worlds so the comparison isolates the mark-weighting.
    let low = initialWorld(content, 1, 0);
    low = withInstalled(low, "iron", "miner", 1, 9);
    let high = initialWorld(content, 1, 0);
    high = withInstalled(high, "iron", "miner", 1, 0);
    high = withInstalled(high, "iron", "miner", 2, 3);
    // 9 Mk1 (rate x1) and 3 Mk2 (rate x3) are both 9 machine-units, even though the
    // raw machine count drops from 9 to 3 -- the mark-weighting the whole ladder
    // mechanic depends on (ruling R5). Counting raw machines instead would collapse
    // the ladder on consolidation and nobody would ever upgrade.
    expect(installedMachines(low, "iron", "miner")).toBe(9);
    expect(installedMachines(high, "iron", "miner")).toBe(3);
    expect(installedUnits(content, low, "iron", "miner")).toBe(9);
    expect(installedUnits(content, high, "iron", "miner")).toBe(9);
  });
});
