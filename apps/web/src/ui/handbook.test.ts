// S-13: the handbook's model over the slice, on the tier-8 fixture and a fresh world.
import {
  bestUnlockedMark,
  computeExpansion,
  D,
  getMark,
  initialWorld,
  type WorldState,
} from "@manufactory/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { chainOf, handbookEntry, searchItems } from "./handbook.js";
import { fmt } from "./notation.js";
import { fixtureState, loadSlice, type Slice } from "./test-fixtures.js";

let slice: Slice;
let tier8: WorldState;
beforeAll(() => {
  slice = loadSlice();
  tier8 = fixtureState("slice-tier-8.world.json");
});

const entry = (state: WorldState, id: string) => {
  const e = handbookEntry(slice.content, state, id);
  expect(e).not.toBeNull();
  return e!;
};

describe("handbookEntry (S-13)", () => {
  it("1. screw on tier 8: made from, alternates, traces back to, the chain, used in", () => {
    const e = entry(tier8, "screw");
    const made = e.madeFrom!;
    expect(made.recipeId).toBe("make_screw");
    expect(made.machine).toBe("Constructor");
    expect(made.inputs).toEqual([{ itemId: "iron_rod", name: "Iron Rod", perMin: fmt(D(10)) }]);
    expect(made.outputs).toEqual([
      { itemId: "screw", name: "Screw", perMin: fmt(D(40)), byproduct: false },
    ]);
    const n = bestUnlockedMark(slice.content, "constructor", tier8.tier);
    expect(n).toBe(3);
    const mark = getMark(slice.content, "constructor", 3)!;
    expect(made.power).toEqual({ kind: "draw", mw: mark.powerDraw, mark: mark.name });

    const alt = e.alternates.find((a) => a.recipeId === "alt_cast_screw");
    expect(alt).toMatchObject({ locked: true, unlockTier: 9 });

    expect(e.tracesBack).toEqual([
      { itemId: "iron_ore", name: "Iron Ore", amountText: fmt(D(0.25)) },
    ]);
    expect(e.chain).toEqual(["Iron Ore", "Iron Ingot", "Iron Rod", "Screw"]);
    expect(e.tracedAt).toBeNull();

    expect(e.usedIn).toHaveLength(4);
    expect(e.usedIn.find((u) => u.recipeId === "alt_bolted_frame")).toMatchObject({
      locked: true,
      outputItemId: "modular_frame",
    });
  });

  it("1b. modular frame traces to 24 Iron Ore through a 5-name chain", () => {
    const e = entry(tier8, "modular_frame");
    expect(e.tracesBack).toEqual([
      { itemId: "iron_ore", name: "Iron Ore", amountText: fmt(D(24)) },
    ]);
    expect(e.chain).toEqual([
      "Iron Ore",
      "Iron Ingot",
      "Iron Plate",
      "Reinforced Iron Plate",
      "Modular Frame",
    ]);
  });

  it("1c. the chain steps to the largest raw total, not the first input; ties keep authored order", () => {
    // Every slice recipe's first input is also its largest, so the rule is pinned on modular
    // frame's real recipes with the raw totals turned around: Iron Rod outweighs the plate.
    const { content } = slice;
    const raw = new Map(computeExpansion(content, tier8.tier, tier8.activeRecipe).rawCost);
    raw.set("iron_rod", new Map([["iron_ore", 100]]));
    const names = (ids: string[]) => ids.map((id) => content.items.get(id)!.name);
    expect(names(chainOf(content, tier8.activeRecipe, raw, "modular_frame"))).toEqual([
      "Iron Ore",
      "Iron Ingot",
      "Iron Rod",
      "Modular Frame",
    ]);
    raw.set("iron_rod", raw.get("reinforced_iron_plate")!);
    expect(chainOf(content, tier8.activeRecipe, raw, "modular_frame")[2]).toBe("iron_plate");
  });

  it("2. a locked item is traced at its own tier; a byproduct names its makers; no consumers; unknown", () => {
    const fresh = initialWorld(slice.content, 1, 0);
    expect(fresh.tier).toBe(0);
    const screw = entry(fresh, "screw");
    expect(screw.locked).toBe(true);
    expect(screw.tracesBack.length).toBeGreaterThan(0);
    expect(screw.tracedAt).toEqual({ tier: slice.content.items.get("screw")!.tier });
    expect(screw.chain).toEqual(["Iron Ore", "Iron Ingot", "Iron Rod", "Screw"]);

    const residue = entry(tier8, "heavy_oil_residue");
    expect(residue.madeFrom).toBeNull();
    expect(residue.byproductOf.map((b) => b.recipeId).sort()).toEqual(
      ["refine_plastic", "refine_polymer_resin", "refine_rubber"].sort(),
    );
    expect(residue.tracesBack).toEqual([]);

    expect(entry(tier8, "cable").usedIn).toEqual([]);
    expect(handbookEntry(slice.content, tier8, "nope")).toBeNull();
  });

  it("3. the chain follows the player's recipes", () => {
    const state: WorldState = {
      ...tier8,
      tier: 9,
      activeRecipe: { ...tier8.activeRecipe, screw: "alt_cast_screw" },
    };
    const e = entry(state, "screw");
    expect(e.madeFrom!.recipeId).toBe("alt_cast_screw");
    expect(e.chain).toEqual(["Iron Ore", "Iron Ingot", "Screw"]);
    const raw = computeExpansion(slice.content, 9, state.activeRecipe).rawCost.get("screw")!;
    expect(e.tracesBack).toEqual(
      [...raw].map(([id, v]) => ({
        itemId: id,
        name: slice.content.items.get(id)!.name,
        amountText: fmt(D(v)),
      })),
    );
    // make_screw is now the alternate, and unlocked.
    expect(e.alternates.map((a) => [a.recipeId, a.locked])).toEqual([["make_screw", false]]);
  });
});

describe("searchItems (S-13)", () => {
  it("4. all 32 in lane order; a case-insensitive substring on name and id; locked by tier", () => {
    const { content } = slice;
    const all = searchItems(content, tier8, "");
    expect(all).toHaveLength(32);
    const order = all.map((r) => content.lanes.get(content.items.get(r.itemId)!.lane)!.order);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const iron = searchItems(content, tier8, "iron");
    expect(iron.length).toBeGreaterThan(0);
    for (const r of iron)
      expect(r.name.toLowerCase().includes("iron") || r.itemId.includes("iron")).toBe(true);
    const missed = content.bundle.items.filter(
      (i) => i.name.toLowerCase().includes("iron") || i.id.includes("iron"),
    );
    expect(iron).toHaveLength(missed.length);
    expect(searchItems(content, tier8, "IRON")).toEqual(iron);

    for (const r of all) expect(r.locked).toBe(content.items.get(r.itemId)!.tier > tier8.tier);
    expect(all.find((r) => r.itemId === "heavy_modular_frame")!.locked).toBe(true);
    const fresh = initialWorld(content, 1, 0);
    expect(searchItems(content, fresh, "screw")[0]!.locked).toBe(true);
  });
});
