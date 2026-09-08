// Phase 2 task 0. The `bottleneck` policy — which buys exactly what the reporter
// recommends — never reached tier 2 on the fixture. It stalled with iron_plate at
// exactly its liquid cap, production at zero, having bought no storage upgrade,
// while the report said "buy 1 more constructor". A storage cap was the binding
// constraint and `Bottleneck` had no kind that could name it, so the reporter fell
// through to the recipe it could name.
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, type WorldState } from "../state/world.js";
import { quantumCap, storageCap } from "../economy/storage.js";
import { solve } from "./solve.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const NO_FLOOR = { reserveFloor: 0 };

/** Fills `itemId` to exactly its liquid cap, which is what spec C.2 calls FULL. */
function atCap(state: WorldState, itemId: string): WorldState {
  return {
    ...state,
    stored: { ...state.stored, [itemId]: storageCap(content, state, itemId) },
    quantum: { ...state.quantum, [itemId]: quantumCap(content, state, itemId) },
  };
}

describe("the storage bottleneck kind", () => {
  it("names the cap, not a recipe, when the limited item is at cap", () => {
    const sol = solve(atCap(initialWorld(content, 1, 0), "iron_plate"), content, NO_FLOOR);
    // Precondition: the state really is the one the policy stalled in.
    expect(sol.itemStates.get("iron_plate")).toBe("FULL");
    expect(sol.bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "item:iron_plate",
      // Storage level 0 -> 1 costs 50 iron_plate; QS level 0 -> 1 costs 500.
      upgrade: "storage",
    });
  });

  it("still names the recipe one unit below the cap", () => {
    // The bite-check for the boundary above: FULL is `liquid >= liquidCap`, so a
    // single unit of headroom must put the report back on the recipe branch.
    let w = atCap(initialWorld(content, 1, 0), "iron_plate");
    w = { ...w, quantum: { ...w.quantum, iron_plate: quantumCap(content, w, "iron_plate").minus(1) } };
    const sol = solve(w, content, NO_FLOOR);
    expect(sol.itemStates.get("iron_plate")).not.toBe("FULL");
    expect(sol.bottleneck).toMatchObject({ kind: "recipe", recipeId: "make_plate" });
  });

  it("recommends quantum storage once per-item storage is maxed", () => {
    let w = initialWorld(content, 1, 0);
    w = { ...w, storageLevel: { ...w.storageLevel, iron_plate: content.bundle.storage.maxLevel } };
    const sol = solve(atCap(w, "iron_plate"), content, NO_FLOOR);
    expect(sol.bottleneck).toMatchObject({ kind: "storage", upgrade: "quantum" });
  });

  it("reports no upgrade at all when both curves are maxed — a genuine permanent wall", () => {
    let w = initialWorld(content, 1, 0);
    w = {
      ...w,
      storageLevel: { ...w.storageLevel, iron_plate: content.bundle.storage.maxLevel },
      qsLevel: { ...w.qsLevel, iron: content.bundle.quantumStorage.maxLevel },
    };
    const sol = solve(atCap(w, "iron_plate"), content, NO_FLOOR);
    // Honest emptiness beats a manufactured recommendation: this is the state
    // validator check 9 exists to make unreachable, and the report should say so
    // rather than inventing a purchase that cannot be made.
    expect(sol.bottleneck).toMatchObject({ kind: "storage", upgrade: null });
  });

  it("leaves the healthy case on the recipe branch", () => {
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.bottleneck).toMatchObject({ kind: "recipe", recipeId: "make_plate" });
  });
});
