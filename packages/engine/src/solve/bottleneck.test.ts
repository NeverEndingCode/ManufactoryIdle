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
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";
import { quantumCap, storageCap } from "../economy/storage.js";
import { D } from "../numbers/decimal.js";
import { solve } from "./solve.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const fixtureBundle = content.bundle;
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

// Phase 2, 2026-09-19. `bottleneck` stalled at tier 1 of the vertical slice for 120
// simulated days holding 2,307,820 iron_plate and 430,367 screw, owning zero
// assemblers, needing 200 reinforced_iron_plate -- and was told to buy three iron ore
// miners. Two causes: the scan ranked by authored priority, and a target with no
// machines reports `limitedBy: null`, so it was invisible to a scan looking for
// limited entries.
describe("the milestone branch", () => {
  // refine_plastic unlocks at tier 2 and the fixture's start machines are all iron,
  // so at tier 2 this recipe is LIVE and has exactly zero machines -- the shape of
  // the stall, reproduced on a bundle that solves instantly.
  const plasticMilestone = indexContent({
    ...fixtureBundle,
    milestones: [
      { tier: 3, name: "Plastics", requires: [{ item: "plastic", amount: 100 }], laneMultipliers: {} },
    ],
  });

  it("names the recipe of a milestone item that nothing is making", () => {
    const state = { ...initialWorld(plasticMilestone, 1, 0), tier: 2 };
    const sol = solve(state, plasticMilestone, NO_FLOOR);
    // Precondition: the recipe really is live-with-no-machines, not merely locked.
    expect(sol.capacity.unitsByRecipe.get("refine_plastic") ?? 0).toBe(0);
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "refine_plastic",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("falls back to the priority scan when every requirement is met", () => {
    const base = initialWorld(plasticMilestone, 1, 0);
    // 150 plastic against a requirement of 100, and under the 200 storage cap so the
    // item is not FULL either. The milestone branch must decline entirely.
    const state = {
      ...base,
      tier: 2,
      stored: { ...base.stored, plastic: D(150) },
    };
    const sol = solve(state, plasticMilestone, NO_FLOOR);
    // The authored priority list starts at iron_plate, so a working fallback names
    // that. Without the fallback this would still be talking about plastic.
    expect(sol.bottleneck?.limitingTarget).toBe("item:iron_plate");
  });

  it("names the cap when the milestone item is at its cap", () => {
    // Tier 2 of the fixture needs 2000 iron_plate; the liquid cap at level 0 is
    // 300 + 1200 = 1500, so the requirement is unmet AND the item is FULL.
    //
    // iron_plate is moved to the end of the priority list here: it is also
    // priority[0] in the fixture, so leaving it there lets the OLD priority-scan
    // path name the same object and the test would pass without the milestone
    // branch doing any work. Moving it to the end means only the milestone branch
    // can produce this result.
    const state = {
      ...atCap(initialWorld(content, 1, 0), "iron_plate"),
      tier: 1,
      priority: [
        ...initialWorld(content, 1, 0).priority.filter((e) => e.itemId !== "iron_plate"),
        ...initialWorld(content, 1, 0).priority.filter((e) => e.itemId === "iron_plate"),
      ],
    };
    const sol = solve(state, content, NO_FLOOR);
    expect(sol.itemStates.get("iron_plate")).toBe("FULL");
    expect(sol.bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "item:iron_plate",
      upgrade: "storage",
    });
  });

  it("names the limiting recipe when the milestone item is merely constrained", () => {
    // Tier 1 of the fixture needs 200 iron_plate. Production is live and below cap,
    // so the walk must reach the limited branch rather than returning null.
    //
    // iron_plate is moved to the end of the priority list here too: it is also the
    // priority scan's first limited entry in the fixture's default state, so
    // leaving it in place lets the OLD priority-scan fallback produce the exact
    // same { kind: "recipe", limitingTarget: "item:iron_plate" } and the test would
    // pass whether or not the milestone branch's limited case does anything at all.
    const base = initialWorld(content, 1, 0);
    const state = {
      ...base,
      priority: [
        ...base.priority.filter((e) => e.itemId !== "iron_plate"),
        ...base.priority.filter((e) => e.itemId === "iron_plate"),
      ],
    };
    const sol = solve(state, content, NO_FLOOR);
    expect(sol.bottleneck?.kind).toBe("recipe");
    expect(sol.bottleneck?.limitingTarget).toBe("item:iron_plate");
  });

  it("declines an unmet requirement that is merely accumulating, not blocked (step 5)", () => {
    // Design doc acceptance criterion 1, the branch called out as "easy to get
    // wrong": the item is live, has machines, is under cap, and its entry is
    // getting everything it asked for (limitedBy: null) -- so the walk must
    // return null and let the priority scan run, rather than inventing a blocker.
    //
    // A finite, modest targetRate is the key: with the default unbounded demand
    // (targetRate: null) an entry's allocated rate can never reach `requested`
    // (Infinity), so limitedBy is never null. Giving `plastic` both a small
    // achievable targetRate and enough machines to clear it puts the entry in the
    // one state step 4 does not catch.
    const base = initialWorld(plasticMilestone, 1, 0);
    let state: WorldState = {
      ...base,
      tier: 2,
      // Recipe rates are authored per MINUTE (spec A.4's exactRatePerSecond divides
      // by 60), so one refine_plastic machine's ceiling is 20/60 = 0.333 plastic/s.
      // 0.1/s sits comfortably under that with the reserve floor and crude_oil's own
      // draw both accounted for.
      priority: base.priority.map((entry) =>
        entry.itemId === "plastic" ? { ...entry, targetRate: 0.1 } : entry,
      ),
    };
    state = withInstalled(state, "oil", "extractor", 1, 1);
    state = withInstalled(state, "oil", "refinery", 1, 1);
    state = { ...state, assignment: { ...state.assignment, extract_oil: 1, refine_plastic: 1 } };

    const sol = solve(state, plasticMilestone, NO_FLOOR);
    // Preconditions: the requirement really is unmet, the item really is live with
    // machines and under cap, and it really is getting everything it asked for.
    expect(sol.capacity.unitsByRecipe.get("refine_plastic") ?? 0).toBeGreaterThan(0);
    expect(sol.itemStates.get("plastic")).not.toBe("FULL");
    const plasticEntry = sol.entries.find((e) => e.itemId === "plastic");
    expect(plasticEntry?.limitedBy).toBeNull();
    // The milestone branch must decline entirely: nothing about plastic should
    // surface, and the fallback (iron_plate, first on the priority list) should.
    expect(sol.bottleneck?.limitingTarget).toBe("item:iron_plate");
  });
});

describe("the milestone walk on real content", () => {
  // This is the only test coverage of the milestone branch against real content at all
  // ten tiers. The fixture tests above demonstrate the walk's behavior on individual
  // cases, but only on the 7-recipe fixture; this assertion exercises the actual
  // 44-recipe bundle that ships with the engine.
  //
  // The slice deliberately ships a recipe cycle (alt_recycled_plastic ->
  // alt_recycled_rubber, the documented check 6 validator warning). Ruling R6
  // prevents in-cycle recipes from ever being live, so the walk should never reach
  // them. This test confirms that guard holds across all tiers. The walk currently
  // has no recursive call site, so this is a safeguard against future content changes
  // rather than a live hazard today.
  //
  // `not.toThrow()` cannot itself detect a looping walk: a walk that failed to
  // terminate would hang rather than throw. Termination here is actually enforced
  // by vitest's per-test timeout, which fails the test if the loop below does not
  // return. The assertion below is a real (if weaker) check on top of that: it
  // confirms `solve` completes without an exception at every tier.
  const sliceDir = fileURLToPath(new URL("../../../content/bundles/vertical-slice", import.meta.url));
  const slice = indexContent(loadBundleDir(sliceDir));

  it("terminates at every tier of the vertical slice", () => {
    for (let tier = 0; tier <= slice.maxTier; tier += 1) {
      const state = { ...initialWorld(slice, 1, 0), tier };
      expect(() => solve(state, slice, NO_FLOOR), `tier ${tier}`).not.toThrow();
    }
  });
});
