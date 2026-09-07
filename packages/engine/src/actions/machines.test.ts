import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { ladderInput, machineCostRange } from "../economy/curves.js";
import { liquid } from "../economy/storage.js";
import { initialWorld, installedAt, withInstalled, type WorldState } from "../state/world.js";
import {
  applyAssignMachines,
  applyBuyMachine,
  applyDismantle,
  applySelectRecipe,
  applyUpgradeMark,
} from "./machines.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

// The fixture funds all three iron-lane currencies generously: constructor mk1
// costs iron_ingot, miner mk1 and smelter mk1 cost iron_ore, and miner mk2 and up
// cost iron_plate. A single `amount` keeps every currency affordable regardless of
// which one a given test's purchase happens to spend.
function rich(amount = 100_000): WorldState {
  const w = initialWorld(content, 1, 0);
  return {
    ...w,
    stored: {
      ...w.stored,
      iron_plate: D(amount),
      iron_ingot: D(amount),
      iron_ore: D(amount),
    },
  };
}

function expectAccepted(result: ReturnType<typeof applyBuyMachine>): WorldState {
  if (result.rejected) throw new Error(`unexpectedly rejected: ${result.reason}`);
  return result.state;
}

describe("BUY_MACHINE", () => {
  it("charges the geometric run from the current count", () => {
    // Constructor mk1 costs 20 iron_ingot at r = 1.09, and one is already installed.
    // Buying two: 20 * (1.09 + 1.09^2) = 20 * 2.2781 = 45.562
    const start = rich(100);
    const next = expectAccepted(
      applyBuyMachine(start, content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 2,
      }),
    );
    expect(installedAt(next, "iron", "constructor", 1)).toBe(3);
    expect(liquid(next, "iron_ingot").toNumber()).toBeCloseTo(100 - 45.562, 6);
  });

  it("auto-assigns the new machines to the busiest recipe in the lane-class (R5)", () => {
    const next = expectAccepted(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 4,
      }),
    );
    // make_plate had 1 of 1; it now has 5 of 5, so no machine sits idle.
    expect(next.assignment.make_plate).toBe(5);
  });

  it("rejects a purchase it cannot afford and changes nothing", () => {
    const poor = initialWorld(content, 1, 0);
    const result = applyBuyMachine(poor, content, {
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 1,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/afford/i);
  });

  it("rejects a mark that has not unlocked yet", () => {
    // Miner mk2 unlocks at tier 1; the world starts at tier 0.
    const result = applyBuyMachine(rich(), content, {
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "miner",
      mark: 2,
      count: 1,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/unlock/i);
  });

  it("rejects a non-positive, non-integer, or oversized count", () => {
    for (const count of [0, -1, 2.5, 100_000]) {
      const result = applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count,
      });
      expect(result.rejected).toBe(true);
    }
  });

  it("rejects an unknown lane or class", () => {
    expect(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "ghost",
        machineClass: "constructor",
        mark: 1,
        count: 1,
      }).rejected,
    ).toBe(true);
    expect(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "ghost",
        mark: 1,
        count: 1,
      }).rejected,
    ).toBe(true);
  });

  it("can be paid for entirely out of bound stock (spec C.5)", () => {
    // stored and quantum start at zero here, so this purchase can only succeed by
    // drawing from bound.
    const w = initialWorld(content, 1, 0);
    const bounded: WorldState = { ...w, bound: { ...w.bound, iron_ingot: D(1_000) } };
    const next = expectAccepted(
      applyBuyMachine(bounded, content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 1,
      }),
    );
    // One constructor is already installed, so this purchase is n = 1: 20 * 1.09 = 21.8.
    // spendForBuild's settleBound pass (Task 7) immediately migrates any leftover
    // bound into Quantum Storage when there is room, so the 978.2 remainder lands in
    // `quantum`, not `bound` -- summing the three tiers is what is actually
    // conserved, not any single tier's resting place.
    const remaining = next.bound.iron_ingot!.plus(next.quantum.iron_ingot!).plus(
      next.stored.iron_ingot!,
    );
    expect(remaining.toNumber()).toBeCloseTo(1000 - 21.8, 6);
  });
});

describe("DISMANTLE", () => {
  it("refunds exactly what the same machines cost (spec D4, LIFO)", () => {
    const bought = expectAccepted(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 5,
      }),
    );
    // One constructor was already installed, so the purchase covered n = 1..5 and
    // the dismantle refunds exactly that same range. Constructor mk1 costs iron_ingot.
    const paid = machineCostRange(content, "constructor", 1, 1, 5).get("iron_ingot")!;
    const refundResult = applyDismantle(bought, content, {
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 5,
    });
    if (refundResult.rejected) throw new Error(refundResult.reason);
    const refunded = refundResult.effects.find((e) => e.kind === "refunded");
    expect(refunded).toBeDefined();
    if (refunded?.kind !== "refunded") throw new Error("unreachable");
    // Bitwise equal, because both directions evaluate the same closed form.
    expect(refunded.items.iron_ingot).toBe(paid.toString());
    expect(installedAt(refundResult.state, "iron", "constructor", 1)).toBe(1);
  });

  it("returns the stock to Quantum Storage, not to storage (spec C.5)", () => {
    const bought = expectAccepted(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 2,
      }),
    );
    const before = bought.quantum.iron_ingot!.toNumber();
    const result = applyDismantle(bought, content, {
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 2,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.quantum.iron_ingot!.toNumber()).toBeGreaterThan(before);
  });

  it("clamps assignments down when the pool shrinks", () => {
    const bought = expectAccepted(
      applyBuyMachine(rich(), content, {
        type: "BUY_MACHINE",
        lane: "iron",
        machineClass: "constructor",
        mark: 1,
        count: 4,
      }),
    );
    expect(bought.assignment.make_plate).toBe(5);
    const result = applyDismantle(bought, content, {
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 3,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.assignment.make_plate).toBe(2);
  });

  it("rejects dismantling more than are installed", () => {
    const result = applyDismantle(rich(), content, {
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 9,
    });
    expect(result.rejected).toBe(true);
  });
});

describe("UPGRADE_MARK", () => {
  function fortyFiveMiners(): WorldState {
    let w = rich();
    w = { ...w, tier: 1 };
    w = withInstalled(w, "iron", "miner", 1, 45);
    return { ...w, assignment: { ...w.assignment, mine_iron: 45 } };
  }

  it("consolidates to the mark-equivalent count", () => {
    // rateMultiplier: mk1 = 1, mk2 = 3. floor(45 * 1 / 3) = 15.
    const result = applyUpgradeMark(fortyFiveMiners(), content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(installedAt(result.state, "iron", "miner", 1)).toBe(0);
    expect(installedAt(result.state, "iron", "miner", 2)).toBe(15);
  });

  it("leaves the mark-weighted ladder input untouched (spec B.2, C.0)", () => {
    const before = fortyFiveMiners();
    expect(ladderInput(content, before, "iron", "miner")).toBe(45);
    const result = applyUpgradeMark(before, content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(ladderInput(content, result.state, "iron", "miner")).toBe(45);
  });

  it("refunds the old stack and charges the new one", () => {
    const result = applyUpgradeMark(fortyFiveMiners(), content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    const refunded = result.effects.find((e) => e.kind === "refunded");
    const spent = result.effects.find((e) => e.kind === "spent");
    expect(refunded?.kind).toBe("refunded");
    expect(spent?.kind).toBe("spent");
    if (refunded?.kind !== "refunded" || spent?.kind !== "spent") throw new Error("unreachable");
    // Miner mk1 costs iron_ore; mk2 costs iron_plate.
    expect(refunded.items.iron_ore).toBe(
      machineCostRange(content, "miner", 1, 0, 45).get("iron_ore")!.toString(),
    );
    expect(spent.items.iron_plate).toBe(
      machineCostRange(content, "miner", 2, 0, 15).get("iron_plate")!.toString(),
    );
  });

  it("rescales the assignment to the new pool", () => {
    const result = applyUpgradeMark(fortyFiveMiners(), content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.assignment.mine_iron).toBe(15);
  });

  it("rejects when the next mark has not unlocked", () => {
    let w = rich();
    w = withInstalled(w, "iron", "miner", 1, 45);
    const result = applyUpgradeMark(w, content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects when there is no next mark at all", () => {
    let w = rich();
    w = withInstalled(w, "iron", "smelter", 1, 10);
    const result = applyUpgradeMark(w, content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "smelter",
      fromMark: 1,
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects when too few machines to make even one of the higher mark", () => {
    let w = rich();
    w = { ...w, tier: 1 };
    w = withInstalled(w, "iron", "miner", 1, 2);
    const result = applyUpgradeMark(w, content, {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "miner",
      fromMark: 1,
    });
    expect(result.rejected).toBe(true);
  });
});

describe("ASSIGN_MACHINES", () => {
  it("sets the count and leaves the rest idle", () => {
    const result = applyAssignMachines(rich(), content, {
      type: "ASSIGN_MACHINES",
      recipeId: "make_plate",
      count: 0,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.assignment.make_plate).toBe(0);
  });

  it("rejects assigning more than the lane-class pool holds (ruling R5)", () => {
    const result = applyAssignMachines(rich(), content, {
      type: "ASSIGN_MACHINES",
      recipeId: "make_plate",
      count: 2,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/installed/i);
  });

  it("counts every recipe in the lane-class against the same pool", () => {
    let w = rich();
    w = withInstalled(w, "oil", "refinery", 1, 4);
    w = { ...w, tier: 2, assignment: { ...w.assignment, refine_plastic: 3 } };
    expect(
      applyAssignMachines(w, content, {
        type: "ASSIGN_MACHINES",
        recipeId: "residual_fuel",
        count: 1,
      }).rejected,
    ).toBe(false);
    expect(
      applyAssignMachines(w, content, {
        type: "ASSIGN_MACHINES",
        recipeId: "residual_fuel",
        count: 2,
      }).rejected,
    ).toBe(true);
  });

  it("rejects a locked recipe and a negative or fractional count", () => {
    expect(
      applyAssignMachines(rich(), content, {
        type: "ASSIGN_MACHINES",
        recipeId: "refine_plastic",
        count: 0,
      }).rejected,
    ).toBe(true);
    for (const count of [-1, 1.5]) {
      expect(
        applyAssignMachines(rich(), content, {
          type: "ASSIGN_MACHINES",
          recipeId: "make_plate",
          count,
        }).rejected,
      ).toBe(true);
    }
  });
});

describe("SELECT_RECIPE", () => {
  it("switches the active recipe for an item", () => {
    const result = applySelectRecipe(rich(), content, {
      type: "SELECT_RECIPE",
      itemId: "iron_plate",
      recipeId: "make_plate",
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.activeRecipe.iron_plate).toBe("make_plate");
  });

  it("rejects a recipe that does not produce that item as its primary output", () => {
    const result = applySelectRecipe(rich(), content, {
      type: "SELECT_RECIPE",
      itemId: "iron_plate",
      recipeId: "smelt_iron",
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects a recipe that has not unlocked", () => {
    const result = applySelectRecipe(rich(), content, {
      type: "SELECT_RECIPE",
      itemId: "plastic",
      recipeId: "refine_plastic",
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects a recipe inside a cycle by name (ruling R6)", () => {
    const bundle = loadBundleDir(fixtureDir);
    bundle.recipes.push({
      id: "recycle_plastic",
      name: "Recycled Plastic",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      outputs: [{ item: "plastic", rate: "20", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 0,
    });
    bundle.recipes.push({
      id: "recycle_residue",
      name: "Recycled Residue",
      lane: "oil",
      machineClass: "refinery",
      inputs: [{ item: "plastic", rate: "20", byproduct: false }],
      outputs: [{ item: "heavy_oil_residue", rate: "30", byproduct: false }],
      powerOutput: 0,
      isAlternate: true,
      unlockTier: 0,
    });
    const cyclic = indexContent(bundle);
    const w = initialWorld(cyclic, 1, 0);
    const result = applySelectRecipe(w, cyclic, {
      type: "SELECT_RECIPE",
      itemId: "plastic",
      recipeId: "recycle_plastic",
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/cycle/i);
  });
});
