// Phase 2 task 0. The `bottleneck` policy — which buys exactly what the reporter
// recommends — never reached tier 2 on the fixture. It stalled with iron_plate at
// exactly its liquid cap, production at zero, having bought no storage upgrade,
// while the report said "buy 1 more constructor". A storage cap was the binding
// constraint and `Bottleneck` had no kind that could name it, so the reporter fell
// through to the recipe it could name.
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { indexContent, isLiveRecipe } from "../graph/index-content.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";
import { liquidCap, quantumCap, storageCap } from "../economy/storage.js";
import { levelCostRange, machineCostRange } from "../economy/curves.js";
import { POWER_ITEM } from "../content/types.js";
import { D } from "../numbers/decimal.js";
import { RESERVE_ADVICE_PERCENT, SLOW_PAYER_HORIZON_COLLECTIONS, computeBottleneck } from "./bottleneck.js";
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

describe("the gridlock walk", () => {
  // Measured 2026-10-09 on the vertical slice: at tier 6 the oil lane gridlocked --
  // fuel had no consumer, residue filled, and the FULL sweep held both refineries at
  // clock 0 -- while the reporter kept naming refine_rubber. `bottleneck` bought 50
  // refineries into it. The fixture's oil lane is the same chain in miniature:
  //   extract_oil -> crude_oil -> refine_plastic -> plastic + heavy_oil_residue
  //   (byproduct) -> residual_fuel -> fuel -> burn_fuel (unlocks at tier 3)
  // The grid is raised so no setup browns out and lands in the power branch instead.
  const oilContent = (milestoneTier: number | null) =>
    indexContent({
      ...fixtureBundle,
      baseGridCapacityMw: 100_000,
      milestones:
        milestoneTier === null
          ? []
          : [
              {
                tier: milestoneTier,
                name: "Plastics",
                requires: [{ item: "plastic", amount: 100 }],
                laneMultipliers: {},
              },
            ],
    });

  interface OilMachines {
    extract_oil?: number;
    refine_plastic?: number;
    residual_fuel?: number;
    burn_fuel?: number;
  }

  function oilWorld(c: ReturnType<typeof oilContent>, tier: number, m: OilMachines): WorldState {
    const extract = m.extract_oil ?? 0;
    const refineries = (m.refine_plastic ?? 0) + (m.residual_fuel ?? 0);
    const generators = m.burn_fuel ?? 0;
    let w: WorldState = { ...initialWorld(c, 1, 0), tier };
    if (extract > 0) w = withInstalled(w, "oil", "extractor", 1, extract);
    if (refineries > 0) w = withInstalled(w, "oil", "refinery", 1, refineries);
    if (generators > 0) w = withInstalled(w, "oil", "generator", 1, generators);
    return {
      ...w,
      assignment: {
        ...w.assignment,
        extract_oil: extract,
        refine_plastic: m.refine_plastic ?? 0,
        residual_fuel: m.residual_fuel ?? 0,
        burn_fuel: generators,
      },
    };
  }

  /** Residue and fuel at cap, refineries stopped: the slice's gridlock. */
  function gridlocked(milestoneTier: number, tier: number) {
    const c = oilContent(milestoneTier);
    let w = oilWorld(c, tier, { extract_oil: 1, refine_plastic: 1, residual_fuel: 1 });
    w = atCap(atCap(w, "heavy_oil_residue"), "fuel");
    return { c, w, sol: solve(w, c, NO_FLOOR) };
  }

  it("names storage for the item nothing drains, past the byproduct it fills", () => {
    const { sol } = gridlocked(3, 2);
    // Preconditions: the gridlock is real -- residue and fuel held at cap, both
    // refinery recipes stopped -- and the waterfall blames extract_oil, a recipe
    // running at full clock (the zero-ratio tie-break), so only checking the
    // target's OWN recipe can see the jam.
    expect(sol.itemStates.get("heavy_oil_residue")).toBe("FULL");
    expect(sol.itemStates.get("fuel")).toBe("FULL");
    expect(sol.itemRates.get("heavy_oil_residue")!.net).toBe(0);
    expect(sol.clocks.get("refine_plastic")).toBe(0);
    expect(sol.clocks.get("residual_fuel")).toBe(0);
    expect(sol.entries.find((e) => e.itemId === "plastic")!.limitedBy).toBe("extract_oil");

    const b = sol.bottleneck;
    if (b === null || b.kind !== "storage") throw new Error(`expected storage, got ${JSON.stringify(b)}`);
    expect(b.itemId).toBe("fuel");
    // Still "what is stopping your plastic", not "what is wrong with fuel".
    expect(b.limitingTarget).toBe("item:plastic");
    expect(b.upgrade).not.toBeNull();
  });

  it("names the drain when it is unlocked but unbuilt", () => {
    // Tier 3 unlocks burn_fuel, and the fixture's only generator recipe is the
    // active power recipe, so it is live -- with zero machines.
    const { c, w, sol } = gridlocked(4, 3);
    expect(isLiveRecipe(c, "burn_fuel", w.tier, w.activeRecipe)).toBe(true);
    expect(sol.capacity.unitsByRecipe.get("burn_fuel") ?? 0).toBe(0);
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "burn_fuel",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("names the drain that cannot keep up", () => {
    // Eight plastic refineries emit residue faster than one residual_fuel plant
    // takes it, so residue is held at cap while fuel flows freely.
    const c = oilContent(3);
    let w = oilWorld(c, 2, { extract_oil: 3, refine_plastic: 8, residual_fuel: 1 });
    w = atCap(w, "heavy_oil_residue");
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.itemStates.get("heavy_oil_residue")).toBe("FULL");
    expect(sol.itemRates.get("heavy_oil_residue")!.net).toBe(0);
    expect(sol.itemStates.get("fuel")).not.toBe("FULL");
    expect(sol.clocks.get("residual_fuel")).toBe(1);
    expect(sol.clocks.get("refine_plastic")!).toBeLessThan(1);
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "residual_fuel",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("leaves a FULL item that is draining alone", () => {
    // One refinery each way: residue starts at cap but residual_fuel takes it far
    // faster than refine_plastic makes it, so nothing is throttled.
    const c = oilContent(3);
    let w = oilWorld(c, 2, { extract_oil: 1, refine_plastic: 1, residual_fuel: 1 });
    w = atCap(w, "heavy_oil_residue");
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.itemStates.get("heavy_oil_residue")).toBe("FULL");
    expect(sol.itemRates.get("heavy_oil_residue")!.net).toBeLessThan(0);
    expect(sol.clocks.get("refine_plastic")).toBe(1);
    // Exactly the advice this branch gave before the walk existed.
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "refine_plastic",
      limitingTarget: "item:plastic",
      machinesToClear: 3,
    });
  });

  it("names storage past an unbuilt drain whose own output is full", () => {
    // residual_fuel has no machines, but its output (fuel) is at cap: built, it would
    // be held at clock 0 at once, so the purchase that moves anything is fuel storage.
    const c = oilContent(3);
    let w = oilWorld(c, 2, { extract_oil: 1, refine_plastic: 1 });
    w = atCap(atCap(w, "heavy_oil_residue"), "fuel");
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.itemStates.get("heavy_oil_residue")).toBe("FULL");
    expect(sol.itemRates.get("heavy_oil_residue")!.net).toBe(0);
    expect(sol.itemStates.get("fuel")).toBe("FULL");
    expect(sol.capacity.unitsByRecipe.get("residual_fuel") ?? 0).toBe(0);
    expect(sol.clocks.get("refine_plastic")).toBe(0);
    expect(sol.bottleneck).toMatchObject({
      kind: "storage",
      itemId: "fuel",
      limitingTarget: "item:plastic",
    });
  });

  it("treats float noise on a held item's rate as held (tolerance)", () => {
    const { c, w, sol } = gridlocked(3, 2);
    const withResidueNet = (net: number) =>
      computeBottleneck(
        c,
        sol.capacity,
        sol.entries,
        sol.power,
        w,
        sol.itemStates,
        new Map([...sol.itemRates, ["heavy_oil_residue", { production: 0, consumption: 0, net }]]),
      );
    expect(withResidueNet(-1e-12)).toMatchObject({ kind: "storage", itemId: "fuel" });
    // Clearly draining: no walk, so the advice falls back to the waterfall's name.
    expect(withResidueNet(-0.5)).toMatchObject({ kind: "recipe", recipeId: "extract_oil" });
  });

  it("walks from the priority scan too, when no milestone is pending", () => {
    // No milestones, so the reporter falls through to the priority scan. Plastic is
    // moved to the top of the list, as a player who wants plastic would.
    const c = oilContent(null);
    let w = oilWorld(c, 2, { extract_oil: 1, refine_plastic: 1, residual_fuel: 1 });
    w = atCap(atCap(w, "heavy_oil_residue"), "fuel");
    w = {
      ...w,
      priority: [
        ...w.priority.filter((e) => e.itemId === "plastic"),
        ...w.priority.filter((e) => e.itemId !== "plastic"),
      ],
    };
    const sol = solve(w, c, NO_FLOOR);
    const first = sol.entries.find((e) => e.limitedBy !== null)!;
    expect(first.entryId).toBe("item:plastic");
    expect(first.limitedBy).toBe("extract_oil");
    expect(sol.bottleneck).toMatchObject({
      kind: "storage",
      itemId: "fuel",
      limitingTarget: "item:plastic",
    });
  });

  it("checks the recipe it is about to name, not only the target's own", () => {
    // Hand-built, because the named recipe holding a FULL output while the target's
    // own recipe does not is a tie-break artifact no fixture state produces on demand.
    // Crude is held at cap; the waterfall names extract_oil for plastic; refine_plastic
    // (plastic's own recipe) has no held output. The walk from crude names the drain.
    const c = oilContent(3);
    const w = oilWorld(c, 2, { extract_oil: 1, refine_plastic: 1 });
    const sol = solve(w, c, NO_FLOOR);
    const entries = [
      {
        entryId: "item:plastic",
        itemId: "plastic",
        requested: Number.POSITIVE_INFINITY,
        allocated: 0,
        limitedBy: "extract_oil",
        limitingPerUnit: 1,
        runnerUpRate: Number.POSITIVE_INFINITY,
      },
    ];
    const b = computeBottleneck(
      c,
      sol.capacity,
      entries,
      sol.power,
      w,
      new Map([["crude_oil", "FULL" as const]]),
      new Map([
        ["crude_oil", { production: 1, consumption: 1, net: 0 }],
        // The machine's price is growing, so this test is not about a drained payer
        // (spec 2026-10-13 would advise a reserve on it).
        ["iron_plate", { production: 1, consumption: 0, net: 1 }],
      ]),
    );
    expect(b).toEqual({
      kind: "recipe",
      recipeId: "refine_plastic",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("drains a held input through the target's own recipe, not the first consumer", () => {
    // Hand-built from the slice's rubber case: crude_oil's live consumers there are
    // refine_plastic, refine_rubber and refine_polymer_resin in bundle order, so with
    // crude held and extract_crude_oil named for `rubber`, taking the first consumer
    // drained through refine_plastic -- off the target's path. The extra recipe is
    // listed first in the bundle, so it is first in consumersOf; it makes iron_plate,
    // which it then owns as the first producer (isLiveRecipe wants the active recipe),
    // and plays no part in the plastic requirement.
    const base = oilContent(3).bundle;
    const extra = {
      ...base.recipes.find((r) => r.id === "refine_plastic")!,
      id: "refine_scrap",
      name: "Scrap Refinery",
      outputs: [{ item: "iron_plate", rate: "20", byproduct: false }],
    };
    const c = indexContent({
      ...base,
      recipes: [extra, ...base.recipes],
    });
    expect(c.consumersOf.get("crude_oil")![0]).toBe("refine_scrap");
    const w = oilWorld(c, 2, { extract_oil: 1, refine_plastic: 1 });
    expect(w.activeRecipe.plastic).toBe("refine_plastic");
    expect(isLiveRecipe(c, "refine_plastic", w.tier, w.activeRecipe)).toBe(true);
    expect(isLiveRecipe(c, "refine_scrap", w.tier, w.activeRecipe)).toBe(true);
    const sol = solve(w, c, NO_FLOOR);
    const b = computeBottleneck(
      c,
      sol.capacity,
      [
        {
          entryId: "item:plastic",
          itemId: "plastic",
          requested: Number.POSITIVE_INFINITY,
          allocated: 0,
          limitedBy: "extract_oil",
          limitingPerUnit: 1,
          runnerUpRate: Number.POSITIVE_INFINITY,
        },
      ],
      sol.power,
      w,
      new Map([["crude_oil", "FULL" as const]]),
      new Map([
        ["crude_oil", { production: 1, consumption: 1, net: 0 }],
        // The machine's price is growing, so this test is not about a drained payer
        // (spec 2026-10-13 would advise a reserve on it).
        ["iron_plate", { production: 1, consumption: 0, net: 1 }],
      ]),
    );
    expect(b).toEqual({
      kind: "recipe",
      recipeId: "refine_plastic",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("walks from a starved generator's supplier when that supplier is jammed", () => {
    // Hand-built: neither bundle has a fuel maker with a byproduct, so this shape
    // cannot arise on shipped content yet. The grid browns out with a generator
    // installed, the waterfall blames refine_plastic for the power shortfall, and
    // refine_plastic's residue is held at cap. Naming refine_plastic would buy into
    // a jam; the walk names residual_fuel, which drains residue and is running.
    const c = oilContent(null);
    const w = oilWorld(c, 3, { extract_oil: 1, refine_plastic: 1, residual_fuel: 1, burn_fuel: 1 });
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.capacity.unitsByRecipe.get("burn_fuel") ?? 0).toBeGreaterThan(0);
    const b = computeBottleneck(
      c,
      sol.capacity,
      [
        {
          entryId: "power",
          itemId: POWER_ITEM,
          requested: 400,
          allocated: 0,
          limitedBy: "refine_plastic",
          limitingPerUnit: 1,
          runnerUpRate: Number.POSITIVE_INFINITY,
        },
      ],
      { demandMw: 200, fullDemandMw: 400, supplyMw: 200, ratio: 0.5, passes: 1 },
      w,
      new Map([["heavy_oil_residue", "FULL" as const]]),
      new Map([
        ["heavy_oil_residue", { production: 1, consumption: 1, net: 0 }],
        // The machine's price is growing, so this test is not about a drained payer
        // (spec 2026-10-13 would advise a reserve on it).
        ["iron_plate", { production: 1, consumption: 0, net: 1 }],
      ]),
    );
    expect(b).toEqual({
      kind: "recipe",
      recipeId: "residual_fuel",
      limitingTarget: "power",
      machinesToClear: 1,
    });
  });
});

describe("payable advice", () => {
  // Measured 2026-10-10 on the vertical slice: `bottleneck` stalled at tier 7 told to
  // buy a Quantum Storage level costing 4,473 iron_plate while iron_plate could hold
  // 4,000. Builds spend bound, then quantum, then stored, and bound was empty, so only
  // the liquid cap bounded what could be held and that advice could never be followed. One iron_plate storage level, 90, was the way out.
  //
  // Fixture numbers these tests stand on: iron_plate's liquid cap is 1,500 at storage
  // and QS level 0; storage levels cost 50 * 1.5^L iron_plate, Quantum Storage levels
  // 500 * 1.55^L. The grid is raised so no setup reaches the power branch by accident.
  const variant = (over: Partial<typeof fixtureBundle>) =>
    indexContent({
      ...fixtureBundle,
      baseGridCapacityMw: 100_000,
      milestones: [
        {
          tier: 3,
          name: "Plastics",
          requires: [{ item: "plastic", amount: 100_000 }],
          laneMultipliers: {},
        },
      ],
      ...over,
    });

  /** One extractor and one refinery on refine_plastic, so plastic's recipe has capacity
   *  and a FULL plastic reaches the storage branch rather than the zero-machines one. */
  function oilWorld(c: ReturnType<typeof variant>, refineries = 1): WorldState {
    let w: WorldState = { ...initialWorld(c, 1, 0), tier: 2 };
    w = withInstalled(w, "oil", "extractor", 1, 2 * refineries);
    w = withInstalled(w, "oil", "refinery", 1, refineries);
    return {
      ...w,
      assignment: { ...w.assignment, extract_oil: 2 * refineries, refine_plastic: refineries },
    };
  }

  const withLevels = (
    w: WorldState,
    storage: Record<string, number>,
    qs: Record<string, number>,
  ): WorldState => ({
    ...w,
    storageLevel: { ...w.storageLevel, ...storage },
    qsLevel: { ...w.qsLevel, ...qs },
  });

  const cost = (m: Map<string, { toNumber(): number }>, item: string) => m.get(item)!.toNumber();

  it("names storage for the payer when the advised level costs more than it can hold", () => {
    const c = variant({});
    let w = withLevels(oilWorld(c), { plastic: 9 }, { oil: 3 });
    w = atCap(w, "plastic");
    // Preconditions: both of plastic's next levels overflow iron_plate's cap.
    const ironCap = liquidCap(c, w, "iron_plate").toNumber();
    expect(ironCap).toBe(1500);
    expect(cost(levelCostRange(c.bundle.storage, 9, 1), "iron_plate")).toBeGreaterThan(ironCap);
    expect(cost(levelCostRange(c.bundle.quantumStorage, 3, 1), "iron_plate")).toBeGreaterThan(ironCap);

    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      // Still "what is stopping your plastic".
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });
  });

  it("gives storage advice, not a reserve, when the price exceeds the payer's cap", () => {
    // Spec 2026-10-13: the cap check runs before the drained-payer check. iron_plate is
    // empty and not growing here, which would be a reserve if the level fit.
    const c = variant({});
    let w = withLevels(oilWorld(c), { plastic: 9 }, { oil: 3 });
    w = atCap(w, "plastic");
    const advice = solve(w, c, NO_FLOOR).bottleneck;
    expect(advice).toMatchObject({ kind: "storage", itemId: "iron_plate" });
    expect(advice?.kind).not.toBe("reserve");
  });

  it("counts bound stock the player already holds", () => {
    // Builds spend bound first, and bound is uncapped (dismantle and upgrade refunds),
    // so 1,500 liquid + 1,000 bound covers a level the liquid cap alone could not.
    const c = variant({});
    let w = withLevels(oilWorld(c), { plastic: 9 }, { oil: 3 });
    w = atCap(w, "plastic");
    w = { ...w, bound: { ...w.bound, iron_plate: D(1000) } };
    const ironCap = liquidCap(c, w, "iron_plate").toNumber();
    const qs = cost(levelCostRange(c.bundle.quantumStorage, 3, 1), "iron_plate");
    expect(ironCap).toBe(1500);
    expect(qs).toBeGreaterThan(ironCap);
    expect(qs).toBeLessThanOrEqual(ironCap + 1000);

    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "plastic",
      limitingTarget: "item:plastic",
      upgrade: "quantum",
    });
  });

  it("picks the dearer upgrade when the cheaper one can never be paid for", () => {
    // Quantum Storage paid in heavy_oil_residue, which can hold 500: its 600 level is
    // cheaper than storage's 854 iron_plate, and can never be bought.
    const c = variant({
      quantumStorage: { ...fixtureBundle.quantumStorage, baseCostItem: "heavy_oil_residue", baseCostAmount: 600 },
    });
    let w = withLevels(oilWorld(c), { plastic: 7 }, {});
    w = atCap(w, "plastic");
    expect(liquidCap(c, w, "heavy_oil_residue").toNumber()).toBe(500);
    expect(cost(levelCostRange(c.bundle.quantumStorage, 0, 1), "heavy_oil_residue")).toBe(600);
    expect(cost(levelCostRange(c.bundle.storage, 7, 1), "iron_plate")).toBeLessThanOrEqual(1500);

    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "plastic",
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });
  });

  it("names payer storage for a machine it can never pay for", () => {
    // Refinery #31 costs 3,595 iron_plate against a cap of 1,500 -- the refinery-#51
    // shape the gridlock spec set aside.
    const c = variant({ milestones: [{ tier: 3, name: "Plastics", requires: [{ item: "plastic", amount: 100 }], laneMultipliers: {} }] });
    const w = oilWorld(c, 30);
    expect(cost(machineCostRange(c, "refinery", 1, 30, 1), "iron_plate")).toBeGreaterThan(
      liquidCap(c, w, "iron_plate").toNumber(),
    );
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });
  });

  it("names payer storage for a generator it can never pay for", () => {
    // Hand-built brownout at tier 3, where burn_fuel is the active generator: 25
    // installed, so generator #26 costs 1,725 iron_plate against 1,500.
    const c = variant({ milestones: [] });
    let w: WorldState = { ...initialWorld(c, 1, 0), tier: 3 };
    w = withInstalled(w, "oil", "generator", 1, 25);
    w = { ...w, assignment: { ...w.assignment, burn_fuel: 25 } };
    const sol = solve(w, c, NO_FLOOR);
    const ironCap = liquidCap(c, w, "iron_plate").toNumber();
    expect(sol.capacity.unitsByRecipe.get("burn_fuel") ?? 0).toBeGreaterThan(0);
    expect(cost(machineCostRange(c, "generator", 1, 25, 1), "iron_plate")).toBeGreaterThan(ironCap);
    const b = computeBottleneck(
      c,
      sol.capacity,
      [
        {
          entryId: "power",
          itemId: POWER_ITEM,
          requested: 400,
          allocated: 0,
          // The generator itself, so the branch gives generator advice, not supplier advice.
          limitedBy: "burn_fuel",
          limitingPerUnit: 1,
          runnerUpRate: Number.POSITIVE_INFINITY,
        },
      ],
      { demandMw: 200, fullDemandMw: 400, supplyMw: 200, ratio: 0.5, passes: 1 },
      w,
      sol.itemStates,
      sol.itemRates,
    );
    expect(b).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "power",
      upgrade: "storage",
    });
  });

  it("ends at no upgrade when nothing anywhere fits", () => {
    // Cost curves that outgrow capacity (costGrowth 3): plastic's next levels overflow
    // iron_plate's cap, and so do iron_plate's own.
    const c = variant({
      storage: { ...fixtureBundle.storage, costGrowth: 3 },
      quantumStorage: { ...fixtureBundle.quantumStorage, costGrowth: 3 },
    });
    let w = withLevels(oilWorld(c), { plastic: 6, iron_plate: 6 }, { oil: 3, iron: 3 });
    w = atCap(w, "plastic");
    const ironCap = liquidCap(c, w, "iron_plate").toNumber();
    expect(cost(levelCostRange(c.bundle.storage, 6, 1), "iron_plate")).toBeGreaterThan(ironCap);
    expect(cost(levelCostRange(c.bundle.quantumStorage, 3, 1), "iron_plate")).toBeGreaterThan(ironCap);

    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "item:plastic",
      upgrade: null,
    });
  });

  it("leaves advice the player can afford later alone", () => {
    // Next storage level 380 iron_plate, within the 1,500 cap, with NO iron_plate in
    // stock: waiting for income is the right advice, so it is unchanged.
    const c = variant({});
    let w = withLevels(oilWorld(c), { plastic: 5 }, {});
    w = atCap(w, "plastic");
    w = { ...w, stored: { ...w.stored, iron_plate: D(0) }, quantum: { ...w.quantum, iron_plate: D(0) } };
    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "plastic",
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });

    // Boundary: a cost EXACTLY equal to the cap fits -- a player holding it can pay. A
    // variant storage curve makes plastic's level-5 cost exactly 1,500 against
    // iron_plate's 1,500 cap, and QS(oil) level 3 (1,862) overflows, so storage is the
    // only upgrade that can fit. With `>=` it would not, and the advice would move to
    // iron_plate.
    const tight = variant({ storage: { ...fixtureBundle.storage, baseCostAmount: 1500 / 7.59375 /* 1.5^5 */ } });
    let t = withLevels(oilWorld(tight), { plastic: 5 }, { oil: 3 });
    t = atCap(t, "plastic");
    expect(liquidCap(tight, t, "iron_plate").toNumber()).toBe(1500);
    expect(cost(levelCostRange(tight.bundle.storage, 5, 1), "iron_plate")).toBe(1500);
    expect(cost(levelCostRange(tight.bundle.quantumStorage, 3, 1), "iron_plate")).toBeGreaterThan(1500);
    expect(solve(t, tight, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "plastic",
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });
  });
});

// Spec 2026-10-13 (reserves protect stock): a purchase priced in an item whose stock is
// short and not growing can never be paid while consumers take every unit made. The
// advice becomes a reserve on that item.
describe("computeBottleneck — a drained payer gets a reserve", () => {
  const start = initialWorld(content, 1, 0);
  const sol = solve(start, content, NO_FLOOR);
  const advise = (state: WorldState, net: number, production = 1) => {
    const rates = new Map(sol.itemRates);
    for (const [itemId] of priceItems) rates.set(itemId, { production, consumption: production - net, net });
    return computeBottleneck(content, sol.capacity, sol.entries, sol.power, state, sol.itemStates, rates);
  };
  // What the fresh fixture's advice costs: its machine's build cost items.
  const firstAdvice = computeBottleneck(content, sol.capacity, sol.entries, sol.power, start, sol.itemStates, sol.itemRates);
  const priceItems: [string, unknown][] = (() => {
    if (firstAdvice?.kind !== "recipe") return [];
    const recipe = content.recipes.get(firstAdvice.recipeId)!;
    return [...machineCostRange(content, recipe.machineClass, 1, 0, 1)];
  })();

  it("names a reserve on the payer when it is short and not growing", () => {
    // Preconditions: the fresh fixture advises a machine, priced in something it holds
    // too little of.
    expect(firstAdvice?.kind).toBe("recipe");
    expect(priceItems.length).toBeGreaterThan(0);
    expect(advise(start, 0)).toMatchObject({
      kind: "reserve",
      itemId: priceItems[0]![0],
      percent: RESERVE_ADVICE_PERCENT,
      limitingTarget: firstAdvice!.limitingTarget,
    });
  });

  it("names no reserve on a payer nothing produces", () => {
    // A reserve banks a share of production; with production 0 there is nothing to bank.
    expect(advise(start, 0, 0)).toMatchObject({ kind: "recipe" });
  });

  it("leaves the advice alone when the payer is growing", () => {
    expect(advise(start, 0.5)).toMatchObject({ kind: "recipe" });
  });

  it("does not advise a reserve again when the reserve is not helping", () => {
    const reserved: WorldState = {
      ...start,
      reserve: Object.fromEntries(priceItems.map(([itemId]) => [itemId, 0.25])),
    };
    expect(advise(reserved, 0)).toMatchObject({ kind: "recipe" });
  });

  it("keeps advising the reserve while the payer is still short and growing", () => {
    const reserved: WorldState = {
      ...start,
      reserve: Object.fromEntries(priceItems.map(([itemId]) => [itemId, 0.25])),
    };
    expect(advise(reserved, 0.5)).toMatchObject({
      kind: "reserve",
      itemId: priceItems[0]![0],
      percent: RESERVE_ADVICE_PERCENT,
    });
  });
});

// Spec 2026-10-14 (slow-payer advice): a purchase whose payer would take longer than
// half an offline window to afford becomes one more machine for that payer's recipe.
// Measured cause: bottleneck stopped at tier 9 told to buy a rig ~22.6 h of beam
// production away.
describe("computeBottleneck — a slow payer gets production advice", () => {
  const start = initialWorld(content, 1, 0);
  const sol = solve(start, content, NO_FLOOR);
  const firstAdvice = computeBottleneck(content, sol.capacity, sol.entries, sol.power, start, sol.itemStates, sol.itemRates);
  const payer = (() => {
    if (firstAdvice?.kind !== "recipe") return undefined;
    const recipe = content.recipes.get(firstAdvice.recipeId)!;
    return [...machineCostRange(content, recipe.machineClass, 1, 0, 1)][0]?.[0];
  })();
  // The one-step redirect assumes the payer's recipe is not starved. The fresh fixture
  // has iron_ore EMPTY (the walk test below uses it so), so these tests mark it FLOWING.
  const fed = (states: ReadonlyMap<string, "EMPTY" | "FLOWING" | "FULL">) => {
    const copy = new Map(states);
    copy.set("iron_ore", "FLOWING");
    return copy;
  };
  // The payer grows at `net`/s and is otherwise as the fresh fixture has it.
  const advise = (state: WorldState, net: number, c = content, s = sol, itemStates = fed(s.itemStates)) => {
    const rates = new Map(s.itemRates);
    rates.set(payer!, { production: net + 1, consumption: 1, net });
    return computeBottleneck(c, s.capacity, s.entries, s.power, state, itemStates, rates);
  };

  it("redirects to the slow payer's recipe", () => {
    // Preconditions: the fresh fixture advises a machine priced in an item it is short of.
    expect(firstAdvice).toMatchObject({ kind: "recipe", recipeId: "make_plate", limitingTarget: "item:iron_plate" });
    expect(payer).toBe("iron_ingot");
    // 1e-6/s is far slower than half an offline window allows.
    expect(advise(start, 1e-6)).toEqual({
      kind: "recipe",
      recipeId: start.activeRecipe[payer!],
      limitingTarget: firstAdvice!.limitingTarget,
      machinesToClear: 1,
    });
  });

  it("walks the redirect on to the recipe that limits an EMPTY input", () => {
    // Precondition: the fixture itself marks iron_ore (smelt_iron's input) EMPTY.
    expect(sol.itemStates.get("iron_ore")).toBe("EMPTY");
    expect(advise(start, 1e-6, content, sol, sol.itemStates)).toEqual({
      kind: "recipe",
      recipeId: start.activeRecipe.iron_ore,
      limitingTarget: firstAdvice!.limitingTarget,
      machinesToClear: 1,
    });
    expect(start.activeRecipe.iron_ore).toBe("mine_iron");
  });

  it("leaves the advice alone when the payer affords it within the horizon", () => {
    expect(SLOW_PAYER_HORIZON_COLLECTIONS).toBe(0.5);
    expect(advise(start, 1e9)).toMatchObject({ kind: "recipe", recipeId: "make_plate", limitingTarget: "item:iron_plate" });
  });

  it("leaves the advice alone when the slow payer has no active recipe", () => {
    const { [payer!]: _dropped, ...activeRecipe } = start.activeRecipe;
    expect(advise({ ...start, activeRecipe }, 1e-6)).toMatchObject({ kind: "recipe", recipeId: "make_plate", limitingTarget: "item:iron_plate" });
  });

  it("sends a redirect whose own price overflows on to storage advice", () => {
    // A variant where the payer's producing machine costs far more than anything can hold.
    const recipeId = start.activeRecipe[payer!]!;
    const machineClass = content.recipes.get(recipeId)!.machineClass;
    const bundle = content.bundle;
    const pricey = indexContent({
      ...bundle,
      machineClasses: bundle.machineClasses.map((cls) =>
        cls.id !== machineClass
          ? cls
          : { ...cls, marks: cls.marks.map((m) => ({ ...m, buildCost: m.buildCost.map((b) => ({ ...b, amount: 1e12 })) })) },
      ),
    } as never);
    const s = solve(start, pricey, NO_FLOOR);
    // Precondition: the variant still advises the same first purchase.
    expect(computeBottleneck(pricey, s.capacity, s.entries, s.power, start, s.itemStates, s.itemRates)).toMatchObject({
      kind: "recipe",
      recipeId: (firstAdvice as { recipeId: string }).recipeId,
    });
    expect(advise(start, 1e-6, pricey, s)).toMatchObject({ kind: "storage" });
  });
});

// Spec 2026-10-15 (buy for a recipe, Part 2): a payer short of the price and not made at
// all, because its own recipe has a FULL output, gets storage advice for that output.
// Measured cause: bottleneck stalled at tier 7 told to buy a packager priced in rubber
// while every oil refinery sat at clock 0 behind a FULL heavy_oil_residue.
describe("computeBottleneck — a payer blocked by its own output gets storage", () => {
  // smelt_iron also emits heavy_oil_residue, so the ingot recipe can back up on it.
  const bundle = content.bundle;
  const blockable = indexContent({
    ...bundle,
    recipes: bundle.recipes.map((r) =>
      r.id !== "smelt_iron" ? r : { ...r, outputs: [...r.outputs, { item: "heavy_oil_residue", rate: "10", byproduct: true }] },
    ),
  } as never);
  const start = initialWorld(blockable, 1, 0);
  const sol = solve(start, blockable, NO_FLOOR);
  const firstAdvice = computeBottleneck(blockable, sol.capacity, sol.entries, sol.power, start, sol.itemStates, sol.itemRates);
  // `production` is the payer's production; `residue` is the byproduct's tag.
  const advise = (production: number, residue: "EMPTY" | "FLOWING" | "FULL", c = blockable, s = sol, net = 0) => {
    const rates = new Map(s.itemRates);
    rates.set("iron_ingot", { production, consumption: production - net, net });
    const states = new Map(s.itemStates);
    states.set("heavy_oil_residue", residue);
    return computeBottleneck(c, s.capacity, s.entries, s.power, start, states, rates);
  };

  it("advises storage for the FULL output that stops the payer's recipe", () => {
    // Preconditions: the variant advises make_plate, priced in iron_ingot, which is short.
    expect(firstAdvice).toMatchObject({ kind: "recipe", recipeId: "make_plate", limitingTarget: "item:iron_plate" });
    expect(advise(0, "FULL")).toMatchObject({
      kind: "storage",
      itemId: "heavy_oil_residue",
      limitingTarget: "item:iron_plate",
    });
  });

  it("leaves the advice alone when the output is not FULL", () => {
    expect(advise(0, "FLOWING")).toMatchObject({ kind: "recipe", recipeId: "make_plate" });
  });

  it("does not treat a payer that is made as blocked, even when its output is FULL", () => {
    // Made and growing slowly (not drained): the slow-payer path, a recipe answer.
    const slow = advise(5, "FULL", blockable, sol, 1e-6);
    expect(slow).not.toMatchObject({ kind: "storage", itemId: "heavy_oil_residue" });
    expect(slow).toMatchObject({ kind: "recipe" });
    // Made and not growing is drainedPayer's case: reserve advice. Pins the check order.
    expect(advise(5, "FULL")).toMatchObject({ kind: "reserve", itemId: "iron_ingot" });
  });

  it("prices the storage it advises through the same loop", () => {
    // A variant whose storage levels cost far more than anything can hold: the residue
    // storage overflows its own payer and steps on to storage for that payer instead.
    const pricey = indexContent({
      ...blockable.bundle,
      storage: { ...blockable.bundle.storage, baseCostAmount: 1e12 },
      quantumStorage: { ...blockable.bundle.quantumStorage, baseCostAmount: 1e12 },
    } as never);
    const s = solve(start, pricey, NO_FLOOR);
    const advice = advise(0, "FULL", pricey, s);
    expect(advice).toMatchObject({ kind: "storage" });
    expect(advice).not.toMatchObject({ itemId: "heavy_oil_residue" });
  });
});
