// Ruling PL-1: the bottleneck advice names a machine mark the player can actually pay for.
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, type WorldState } from "../state/world.js";
import type { ItemFlow } from "../solve/fixpoint.js";
import { D } from "../numbers/decimal.js";
import { adviceMark } from "./advice-mark.js";
import { bestUnlockedMark } from "./capacity.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

/** Tier 1 with no stock at all: miner Mk2 (30 iron_plate) and Mk1 (10 iron_ore) are both unlocked. */
function emptyTier1(): WorldState {
  const w = initialWorld(content, 1, 0);
  return { ...w, tier: 1, stored: {}, quantum: {}, bound: {} };
}

function rates(made: Record<string, number>): Map<string, ItemFlow> {
  return new Map(Object.entries(made).map(([item, production]) => [item, { production, consumption: 0, net: production }]));
}

describe("adviceMark (PL-1)", () => {
  it("steps down from a best mark priced in an item that is short and not made at all", () => {
    const state = emptyTier1();
    // Precondition: Mk2 is the best unlocked miner, and it costs iron_plate.
    expect(bestUnlockedMark(content, "miner", state.tier)).toBe(2);
    // iron_plate is short and unmade; iron_ore, Mk1's payer, is made.
    const r = rates({ iron_plate: 0, iron_ore: 1 });
    expect(adviceMark(content, state, r, "miner", "iron")).toBe(1);
  });

  it("keeps a best mark whose short payer is being made", () => {
    // Short is not dead: waiting pays it.
    const r = rates({ iron_plate: 0.5, iron_ore: 1 });
    expect(adviceMark(content, emptyTier1(), r, "miner", "iron")).toBe(2);
  });

  it("keeps a best mark whose payer is held, even if nothing makes it", () => {
    // 20 liquid plus 10 bound is exactly the 30 iron_plate price: bound counts, as it does for a build.
    const state: WorldState = { ...emptyTier1(), stored: { iron_plate: D(20) }, bound: { iron_plate: D(10) } };
    expect(adviceMark(content, state, rates({ iron_plate: 0 }), "miner", "iron")).toBe(2);
    // One unit short of it, and the mark is dead again.
    const short: WorldState = { ...state, bound: { iron_plate: D(9) } };
    expect(adviceMark(content, short, rates({ iron_plate: 0, iron_ore: 1 }), "miner", "iron")).toBe(1);
  });

  it("keeps the best mark when every lower mark is dead too", () => {
    // iron_ore is short and unmade as well, so Mk1 is no way out: say the best.
    const r = rates({ iron_plate: 0, iron_ore: 0 });
    expect(adviceMark(content, emptyTier1(), r, "miner", "iron")).toBe(2);
  });

  it("leaves a single-mark class unchanged", () => {
    // The smelter's only mark costs iron_ore; dead or not, it is the answer.
    const r = rates({ iron_ore: 0 });
    expect(adviceMark(content, emptyTier1(), r, "smelter", "iron")).toBe(1);
  });

  it("is null when no mark of the class is unlocked", () => {
    expect(adviceMark(content, emptyTier1(), rates({}), "generator", "power")).toBeNull();
  });
});
