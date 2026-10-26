import { describe, expect, it } from "vitest";
import { D, FLOW_TOLERANCE, apply, computeCapacity, indexContent, solve, type WorldState } from "@manufactory/engine";
import { SLICE_BUNDLE_DIR, loadContent, newWorld } from "./bootstrap.js";
import {
  POLICY_NAMES,
  affordableCandidates,
  idleReassignments,
  milestoneFirstReorder,
  costScore,
  getPolicy,
  tierProgress,
  topTargetItem,
  type PolicyContext,
} from "./policies.js";

const content = loadContent();

function context(over: Partial<WorldState> = {}): PolicyContext {
  const state: WorldState = { ...newWorld(content, 1), ...over };
  return { content, state, solution: solve(state, content), nowMs: 0 };
}

// The brief's `rich()` funded only iron_plate, but fixture mk1 build costs are
// iron_ore (miner, smelter) and iron_ingot (constructor) -- mk2+ is iron_plate.
// Funding only plate left every BUY_MACHINE candidate unaffordable. Funding all
// three keeps this helper's purpose (a player who can afford anything) intact.
function rich(): PolicyContext {
  const base = newWorld(content, 1);
  return context({
    stored: {
      ...base.stored,
      iron_ore: D(100_000),
      iron_ingot: D(100_000),
      iron_plate: D(100_000),
    },
  });
}

describe("costScore", () => {
  it("sums the amounts so candidates can be ordered", () => {
    expect(costScore(new Map([["a", D(10)], ["b", D(5)]]))).toBe(15);
    expect(costScore(new Map())).toBe(0);
  });
});

describe("affordableCandidates", () => {
  it("offers nothing when nothing can be paid for", () => {
    expect(affordableCandidates(context())).toEqual([]);
  });

  it("offers a machine in every unlocked lane-class, plus storage and QS levels", () => {
    const candidates = affordableCandidates(rich());
    const kinds = new Set(candidates.map((c) => c.action.type));
    expect(kinds.has("BUY_MACHINE")).toBe(true);
    expect(kinds.has("BUY_STORAGE")).toBe(true);
    expect(kinds.has("BUY_QS")).toBe(true);
    // At tier 0 only the iron lane's three classes have unlocked.
    const machines = candidates.filter((c) => c.action.type === "BUY_MACHINE");
    expect(machines).toHaveLength(3);
  });

  it("offers no locked machine class", () => {
    const candidates = affordableCandidates(rich());
    for (const candidate of candidates) {
      if (candidate.action.type !== "BUY_MACHINE") continue;
      expect(["miner", "smelter", "constructor"]).toContain(candidate.action.machineClass);
    }
  });

  // Phase 2, Task 8. A mark can unlock long before any recipe that uses it does:
  // on the slice, miner mk1 is tier 0 while `mine_copper_ore` is tier 2, so at
  // tier 0 `copper/miner` passed bestUnlockedMark and was offered. greedy bought
  // it -- and 790 of its first 1,639 purchases went into copper, coal and oil
  // lane-classes with nothing live to assign to. Those machines produce nothing
  // and the money is gone, which is not a player's behaviour and is not a pace
  // the calibrator should be solving against.
  it("offers no machine for a lane-class with no live recipe", () => {
    const slice = loadContent(SLICE_BUNDLE_DIR);
    const base = newWorld(slice, 1);
    const state: WorldState = {
      ...base,
      stored: Object.fromEntries(slice.stockItemIds.map((id) => [id, D(100_000)])),
    };
    const candidates = affordableCandidates({
      content: slice,
      state,
      solution: solve(state, slice),
      nowMs: 0,
    });
    const lanes = new Set(
      candidates
        .filter((c) => c.action.type === "BUY_MACHINE")
        .map((c) => (c.action as { lane: string }).lane),
    );
    // Only iron and power unlock at tier 0; copper is tier 2, coal 3, oil 6.
    expect([...lanes].sort()).toEqual(["iron", "power"]);
  });

  // Measured on main b1e0d26 (seed 42): greedy bought 98 and casual 108 storage
  // levels (about 18-20% of their storage purchases) for items no live recipe
  // produces. Same shape as the machine guard above.
  describe("storage offers", () => {
    const slice = loadContent(SLICE_BUNDLE_DIR);
    function richSlice(tier: number): PolicyContext {
      const base = newWorld(slice, 1);
      const state: WorldState = {
        ...base,
        tier,
        stored: Object.fromEntries(slice.stockItemIds.map((id) => [id, D(100_000)])),
      };
      return { content: slice, state, solution: solve(state, slice), nowMs: 0 };
    }
    const storageItems = (ctx: PolicyContext): Set<string> =>
      new Set(
        affordableCandidates(ctx)
          .filter((c) => c.action.type === "BUY_STORAGE")
          .map((c) => (c.action as { itemId: string }).itemId),
      );

    it("offers no storage for an item only a not-yet-live recipe produces", () => {
      const items = storageItems(richSlice(0));
      // Precondition: a live-produced item is offered, so storage was affordable.
      expect(items.has("iron_ore")).toBe(true);
      // copper_ore is mined only by mine_copper_ore, unlockTier 2.
      expect(slice.stockItemIds).toContain("copper_ore");
      expect(items.has("copper_ore")).toBe(false);
    });

    it("offers storage for an item produced only as a live recipe's byproduct", () => {
      const ctx = richSlice(6);
      expect(ctx.state.activeRecipe["plastic"]).toBe("refine_plastic");
      // No live recipe has heavy_oil_residue as its primary output.
      expect(
        [...slice.recipes.values()].some((r) => r.primaryOutput === "heavy_oil_residue"),
      ).toBe(false);
      expect(storageItems(ctx).has("heavy_oil_residue")).toBe(true);
      // Before refine_plastic unlocks, nothing live produces it.
      expect(storageItems(richSlice(5)).has("heavy_oil_residue")).toBe(false);
    });
  });

  it("every candidate it returns is actually applicable", () => {
    const ctx = rich();
    for (const candidate of affordableCandidates(ctx)) {
      const result = apply(ctx.state, ctx.content, candidate.action, ctx.state.seed);
      expect(result.rejected).toBe(false);
    }
  });

  it("scores each candidate by its total cost", () => {
    const candidates = affordableCandidates(rich());
    for (const candidate of candidates) {
      expect(candidate.score).toBe(costScore(candidate.costs));
      expect(candidate.score).toBeGreaterThan(0);
    }
  });
});

describe("topTargetItem", () => {
  it("is the highest-priority item entry with a live recipe", () => {
    expect(topTargetItem(context())).toBe("iron_plate");
  });

  it("skips paused entries", () => {
    const base = newWorld(content, 1);
    const ctx = context({
      priority: base.priority.map((e) => (e.itemId === "iron_plate" ? { ...e, paused: true } : e)),
    });
    expect(topTargetItem(ctx)).toBe("iron_ingot");
  });
});

describe("getPolicy", () => {
  it("knows all four of spec E.2's policies", () => {
    expect([...POLICY_NAMES].sort()).toEqual(["bottleneck", "casual", "greedy", "optimal"]);
    for (const name of POLICY_NAMES) expect(getPolicy(name).name).toBe(name);
  });

  it("greedy buys the single cheapest affordable thing", () => {
    const ctx = rich();
    const actions = getPolicy("greedy").decide(ctx);
    expect(actions).toHaveLength(1);
    const cheapest = affordableCandidates(ctx).reduce((a, b) => (b.score < a.score ? b : a));
    expect(actions[0]).toEqual(cheapest.action);
  });

  it("casual checks in three times a day and buys what it can", () => {
    const ctx = rich();
    // Three collections a day is spec E.2's lower bound: one 8h window per check-in.
    expect(getPolicy("casual").intervalMs(ctx)).toBe(content.offlineCapMs);
    expect(getPolicy("casual").decide(ctx).length).toBeGreaterThan(0);
  });

  it("casual never reorders priorities or changes modes (spec E.2)", () => {
    const actions = getPolicy("casual").decide(rich());
    for (const action of actions) {
      expect(["REORDER_PRIORITY", "SET_PRIORITY_MODE", "SET_RESERVE"]).not.toContain(action.type);
    }
  });

  // Spec B.7 authors both a tier-start and a tier-end interval. Until this ramp
  // existed `purchaseIntervalLateSeconds` was authored, schema'd and typed but read
  // by nothing, so every policy checked in at the tier-start rate forever.
  describe("the spec B.7 purchase-interval ramp", () => {
    const early = content.bundle.pacing.purchaseIntervalEarlySeconds * 1000;
    const late = content.bundle.pacing.purchaseIntervalLateSeconds * 1000;

    it("starts a tier at the early interval", () => {
      // Fixture tier 1 wants 200 iron_plate; a fresh world has none.
      const ctx = context();
      expect(getPolicy("greedy").intervalMs(ctx)).toBe(early);
      expect(getPolicy("bottleneck").intervalMs(ctx)).toBe(early);
    });

    it("reaches the late interval once the requirement is met", () => {
      const base = newWorld(content, 1);
      const ctx = context({ stored: { ...base.stored, iron_plate: D(200) } });
      expect(getPolicy("greedy").intervalMs(ctx)).toBe(late);
    });

    it("interpolates in between", () => {
      const base = newWorld(content, 1);
      const ctx = context({ stored: { ...base.stored, iron_plate: D(100) } });
      expect(getPolicy("greedy").intervalMs(ctx)).toBeCloseTo(early + (late - early) * 0.5, 6);
    });

    it("tracks the LEAST-satisfied requirement, not the average", () => {
      // Fixture tier 3 wants 20000 iron_plate AND 500 plastic. Banking all the plate
      // and none of the plastic is 0% progress, not 50%: the tier is not nearly over.
      const base = newWorld(content, 1);
      const ctx = context({
        tier: 2,
        stored: { ...base.stored, iron_plate: D(20_000) },
      });
      expect(getPolicy("greedy").intervalMs(ctx)).toBe(early);
    });

    // Phase 2, Task 3. The ramp read "pinned at a cap I have to raise" as "96% done"
    // and slowed the player to one decision every 29 minutes exactly when they had to
    // go and buy storage. Measured on the slice: raising tier 1 from 2,500 iron_plate
    // (the base liquid cap) to 2,600 -- four per cent -- took the tier from 0.26
    // collections to 4.05, a fifteenfold jump, and the curve was non-monotone either
    // side of it. That made a whole band of tier times unreachable at any requirement,
    // so calibration had no solution to find rather than a hard one.
    //
    // A requirement above what the player can physically hold is not progress at any
    // fill level; it is a wall that only a purchase moves. B.7's ramp models "fewer,
    // bigger decisions as a tier genuinely nears its end", which this is not.
    it("stays at the early interval when the requirement exceeds the liquid cap", () => {
      // Fixture tier 2 wants 2000 iron_plate; the base liquid cap is 300 + 1200.
      const base = newWorld(content, 1);
      const ctx = context({ tier: 1, stored: { ...base.stored, iron_plate: D(1500) } });
      expect(tierProgress(ctx)).toBe(0);
      expect(getPolicy("greedy").intervalMs(ctx)).toBe(early);
    });

    it("ramps again once storage levels lift the cap past the requirement", () => {
      const base = newWorld(content, 1);
      // capGrowth 1.6^4 = 6.5536, so level 4 puts iron_plate's cap at 9830 > 2000.
      const ctx = context({
        tier: 1,
        stored: { ...base.stored, iron_plate: D(1000) },
        storageLevel: { ...base.storageLevel, iron_plate: 4 },
      });
      expect(tierProgress(ctx)).toBeCloseTo(0.5, 6);
      expect(getPolicy("greedy").intervalMs(ctx)).toBeCloseTo(early + (late - early) * 0.5, 6);
    });

    it("holds at the late interval past the last authored milestone", () => {
      const ctx = context({ tier: 99 });
      expect(getPolicy("greedy").intervalMs(ctx)).toBe(late);
    });
  });

  // `rich()` funds every item past its cap, so the binding constraint there is
  // storage, not capacity. Buying a machine into a full warehouse is exactly the
  // stall that kept this policy off tier 2, so the machine path needs a state that
  // can afford a constructor without being at cap.
  function funded(): PolicyContext {
    const base = newWorld(content, 1);
    // Caps are ore 3000, ingot 2000, plate 1500. A constructor mk1 costs 20 ingot.
    return context({
      stored: { ...base.stored, iron_ore: D(1000), iron_ingot: D(1000) },
    });
  }

  it("bottleneck buys the machine the reporter names (spec 4.5, E.2)", () => {
    const ctx = funded();
    expect(ctx.solution.itemStates.get("iron_plate")).not.toBe("FULL");
    expect(ctx.solution.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "make_plate",
      limitingTarget: "item:iron_plate",
      machinesToClear: 1,
      mark: 1,
    });
    expect(getPolicy("bottleneck").decide(ctx)).toEqual([
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1, recipeId: "make_plate" },
    ]);
  });

  it("bottleneck buys the reporter's advised mark, not the best unlocked one (PL-1)", () => {
    // Tier 1 unlocks miner Mk2. When the reporter steps down to Mk1, the policy buys Mk1.
    const ctx = rich();
    const advised: PolicyContext = {
      ...ctx,
      state: { ...ctx.state, tier: 1 },
      solution: {
        ...ctx.solution,
        bottleneck: { kind: "recipe", recipeId: "mine_iron", limitingTarget: "item:iron_ore", machinesToClear: 1, mark: 1 },
      },
    };
    const buys = getPolicy("bottleneck").decide(advised).filter((a) => a.type === "BUY_MACHINE");
    expect(buys).toEqual([{ type: "BUY_MACHINE", lane: "iron", machineClass: "miner", mark: 1, count: 1, recipeId: "mine_iron" }]);
  });

  it("bottleneck buys for the advised recipe only while that recipe is live (spec 2026-10-14)", () => {
    // A not-live recipe would make the purchase reject and abort the decision's batch,
    // so the policy omits the recipe and lets auto-assignment place the machine.
    const ctx = funded();
    const { iron_plate: _dropped, ...activeRecipe } = ctx.state.activeRecipe;
    const stale: PolicyContext = { ...ctx, state: { ...ctx.state, activeRecipe } };
    const buys = getPolicy("bottleneck").decide(stale).filter((a) => a.type === "BUY_MACHINE");
    expect(buys).toEqual([{ type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 }]);
  });

  it("bottleneck buys storage when a cap is what binds, not another machine", () => {
    const ctx = rich();
    expect(ctx.solution.itemStates.get("iron_plate")).toBe("FULL");
    expect(ctx.solution.bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "item:iron_plate",
      upgrade: "storage",
    });
    expect(getPolicy("bottleneck").decide(ctx)).toEqual([
      { type: "BUY_STORAGE", itemId: "iron_plate", levels: 1 },
    ]);
  });

  it("bottleneck does nothing when there is no bottleneck to clear", () => {
    const base = newWorld(content, 1);
    // Pausing every item entry leaves the solver with nothing to be limited by.
    const ctx = context({
      stored: { ...base.stored, iron_plate: D(100_000) },
      priority: base.priority.map((e) => (e.kind === "item" ? { ...e, paused: true } : e)),
    });
    expect(ctx.solution.bottleneck).toBeNull();
    expect(getPolicy("bottleneck").decide(ctx)).toEqual([]);
  });

  it("optimal picks a candidate that does not lower the top target's rate", () => {
    const ctx = rich();
    const actions = getPolicy("optimal").decide(ctx);
    expect(actions).toHaveLength(1);
    const applied = apply(ctx.state, ctx.content, actions[0]!, ctx.state.seed);
    if (applied.rejected) throw new Error(applied.reason);
    const before = ctx.solution.itemRates.get("iron_plate")!.production;
    const after = solve(applied.state, content).itemRates.get("iron_plate")!.production;
    expect(after).toBeGreaterThanOrEqual(before - 1e-9);
  });

  it("every policy returns an empty list rather than throwing when broke", () => {
    const ctx = context();
    for (const name of POLICY_NAMES) expect(getPolicy(name).decide(ctx)).toEqual([]);
  });

  it("capacity is what a purchase actually moves", () => {
    const ctx = rich();
    const before = computeCapacity(content, ctx.state).unitsByRecipe.get("make_plate")!;
    const applied = apply(
      ctx.state,
      content,
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
      ctx.state.seed,
    );
    if (applied.rejected) throw new Error(applied.reason);
    expect(computeCapacity(content, applied.state).unitsByRecipe.get("make_plate")!).toBeGreaterThan(
      before,
    );
  });
});

// Phase 2, Task 3. Calibration stalled at tier 4 on the slice with 81 assemblers
// sitting idle on a reinforced-iron-plate warehouse pinned at its maximum cap, while
// `make_rotor` -- which tier 4 needs -- had zero machines and produced nothing. Moving
// 40 of the idle 81 produced 143 rotor/s immediately.
//
// The engine already routes a NEW machine correctly (it went to rotor when bought).
// The gap is that nothing ever revisits an assignment, and greedy had stopped buying
// assemblers because they were never the cheapest thing on offer. So the machines
// existed, the verb to move them existed, and no policy used it.
//
// This is deliberately NOT the strategy question that SET_RESERVE and REORDER_PRIORITY
// raise. Leaving owned machines idle while a sibling recipe starves is not a strategy,
// it models no player, and spec E.2 does not describe greedy as doing it.
describe("idleReassignments", () => {
  function refineryWorld(machines: number, plastic: number): PolicyContext {
    const base = newWorld(content, 1);
    const state: WorldState = {
      ...base,
      tier: 3,
      installed: { ...base.installed, oil: { ...base.installed.oil, refinery: [machines] } },
      assignment: { ...base.assignment, refine_plastic: machines },
      stored: { ...base.stored, plastic: D(plastic), crude_oil: D(5000) },
    };
    return { content, state, solution: solve(state, content), nowMs: 0 };
  }

  it("moves idle machines to a live sibling that has none", () => {
    // plastic's liquid cap is 200 + 800, so this pins refine_plastic at clock 0.
    const actions = idleReassignments(refineryWorld(10, 1000));
    const assigns = actions.filter((a) => a.type === "ASSIGN_MACHINES");
    expect(assigns).toHaveLength(2);
    const byRecipe = new Map(
      assigns.map((a) => [(a as { recipeId: string }).recipeId, (a as { count: number }).count]),
    );
    expect(byRecipe.get("residual_fuel")).toBeGreaterThan(0);
    // The donor keeps the rest, and the two still sum to the pool.
    expect(byRecipe.get("refine_plastic")! + byRecipe.get("residual_fuel")!).toBe(10);
  });

  it("leaves a busy lane-class alone", () => {
    // plastic well under cap, so refine_plastic is running and its machines are not idle.
    expect(idleReassignments(refineryWorld(10, 0))).toEqual([]);
  });

  it("does nothing once the sibling has machines of its own", () => {
    const ctx = refineryWorld(10, 1000);
    const state: WorldState = {
      ...ctx.state,
      assignment: { ...ctx.state.assignment, refine_plastic: 6, residual_fuel: 4 },
    };
    expect(idleReassignments({ ...ctx, state, solution: solve(state, content) })).toEqual([]);
  });

  it("leaves a lane-class with a single live recipe alone", () => {
    const base = newWorld(content, 1);
    const state: WorldState = { ...base, stored: { ...base.stored, iron_plate: D(1e9) } };
    const actions = idleReassignments({ content, state, solution: solve(state, content), nowMs: 0 });
    for (const action of actions) {
      expect(["make_plate", "mine_iron", "smelt_iron"]).not.toContain(
        (action as { recipeId?: string }).recipeId,
      );
    }
  });

  it("every action it emits is accepted by the engine", () => {
    const ctx = refineryWorld(10, 1000);
    let state = ctx.state;
    for (const action of idleReassignments(ctx)) {
      const result = apply(state, content, action, state.seed);
      expect(result.rejected).toBe(false);
      if (!result.rejected) state = result.state;
    }
  });
});

describe("policies move idle machines before buying more", () => {
  function stuck(): PolicyContext {
    const base = newWorld(content, 1);
    const state: WorldState = {
      ...base,
      tier: 3,
      installed: { ...base.installed, oil: { ...base.installed.oil, refinery: [10] } },
      assignment: { ...base.assignment, refine_plastic: 10 },
      stored: { ...base.stored, plastic: D(1000), crude_oil: D(5000), iron_ore: D(1e6), iron_ingot: D(1e6), iron_plate: D(1e6) },
    };
    return { content, state, solution: solve(state, content), nowMs: 0 };
  }

  for (const name of ["greedy", "optimal", "bottleneck", "casual"] as const) {
    it(`${name} reassigns rather than leaving a live recipe at zero machines`, () => {
      const actions = getPolicy(name).decide(stuck());
      const moved = actions.filter((a) => a.type === "ASSIGN_MACHINES");
      expect(moved.length).toBeGreaterThan(0);
      expect(
        moved.some((a) => (a as { recipeId: string }).recipeId === "residual_fuel"),
      ).toBe(true);
    });
  }
});

// Spec 2026-10-12 (milestone-first policies). The fixture's start priority is
// iron_plate, iron_ingot, iron_ore, plastic, fuel, heavy_oil_residue, crude_oil, and
// its tier-3 milestone needs iron_plate then plastic.
describe("milestoneFirstReorder", () => {
  const AUTHORED = [
    "item:iron_plate",
    "item:iron_ingot",
    "item:iron_ore",
    "item:plastic",
    "item:fuel",
    "item:heavy_oil_residue",
    "item:crude_oil",
  ];
  const TIER3_FIRST = [
    "item:iron_plate",
    "item:plastic",
    "item:iron_ingot",
    "item:iron_ore",
    "item:fuel",
    "item:heavy_oil_residue",
    "item:crude_oil",
  ];
  /** The fixture world's priority, reordered to `ids` (power wherever `powerAt` says). */
  function ordered(ids: string[], powerAt = 0): WorldState["priority"] {
    const base = newWorld(content, 1).priority;
    const byId = new Map(base.map((e) => [e.id, e]));
    const items = ids.map((id) => byId.get(id)!);
    const power = base.find((e) => e.kind === "power")!;
    return [...items.slice(0, powerAt), power, ...items.slice(powerAt)];
  }
  const idsOf = (actions: ReturnType<typeof milestoneFirstReorder>) =>
    actions.length === 0 ? null : (actions[0] as { entries: string[] }).entries;

  it("puts power first, then the next milestone's items, then the rest as authored", () => {
    // Precondition: at tier 2 the list is still authored, and plastic sits fourth.
    const ctx = context({ tier: 2 });
    expect(ctx.state.priority.map((e) => e.id)).toEqual(["power", ...AUTHORED]);
    expect(idsOf(milestoneFirstReorder(ctx))).toEqual(["power", ...TIER3_FIRST]);
  });

  it("keeps power first even where the player moved it", () => {
    const ctx = context({ tier: 2, priority: ordered(TIER3_FIRST, 3) });
    expect(idsOf(milestoneFirstReorder(ctx))).toEqual(["power", ...TIER3_FIRST]);
  });

  it("emits nothing when the list is already in that order", () => {
    expect(milestoneFirstReorder(context({ tier: 2, priority: ordered(TIER3_FIRST) }))).toEqual([]);
  });

  it("puts an item back where it was authored once its milestone is no longer next", () => {
    // Tier 1's next milestone (tier 2) needs only iron_plate, so plastic goes home.
    const ctx = context({ tier: 1, priority: ordered(TIER3_FIRST) });
    expect(idsOf(milestoneFirstReorder(ctx))).toEqual(["power", ...AUTHORED]);
  });

  it("reverts to the authored order when there is no next milestone", () => {
    const ctx = context({ tier: 3, priority: ordered(TIER3_FIRST) });
    expect(idsOf(milestoneFirstReorder(ctx))).toEqual(["power", ...AUTHORED]);
  });

  it("is used by greedy and optimal, never by casual or bottleneck", () => {
    const base = rich();
    const ctx: PolicyContext = { ...base, state: { ...base.state, tier: 2 } };
    ctx.solution = solve(ctx.state, content);
    for (const name of ["greedy", "optimal"] as const) {
      const first = getPolicy(name).decide(ctx)[0]!;
      expect(first.type).toBe("REORDER_PRIORITY");
      // The engine accepts it: it is a permutation of the existing entries.
      expect(apply(ctx.state, content, first, ctx.state.seed).rejected).toBe(false);
    }
    for (const name of ["casual", "bottleneck"] as const) {
      expect(getPolicy(name).decide(ctx).some((a) => a.type === "REORDER_PRIORITY")).toBe(false);
    }
  });

  it("dedupes a milestone that lists the same item twice, so the reorder stays a permutation", () => {
    const bundle = content.bundle;
    const milestones = bundle.milestones.map((m) =>
      m.tier === 3 ? { ...m, requires: [...m.requires, ...m.requires] } : m,
    );
    const dup = indexContent({ ...bundle, milestones });
    const state: WorldState = { ...newWorld(dup, 1), tier: 2 };
    const ctx: PolicyContext = { content: dup, state, solution: solve(state, dup), nowMs: 0 };
    const entries = idsOf(milestoneFirstReorder(ctx))!;
    expect(new Set(entries).size).toBe(entries.length);
    expect(entries).toHaveLength(state.priority.length);
    expect(apply(state, dup, milestoneFirstReorder(ctx)[0]!, state.seed).rejected).toBe(false);
  });

  it("optimal's reorder moves its lookahead target to the milestone item", () => {
    // decide's output alone cannot tell the two states apart on this fixture (the
    // smelter binds either way), so the lookahead target is asserted directly.
    const base = rich();
    const handedPriority = ordered(
      ["item:iron_ore", ...AUTHORED.filter((id) => id !== "item:iron_ore")],
    );
    const handedState: WorldState = { ...base.state, tier: 2, priority: handedPriority };
    const ctx: PolicyContext = { ...base, state: handedState, solution: solve(handedState, content) };
    const [reorder, ...rest] = getPolicy("optimal").decide(ctx);
    const applied = apply(ctx.state, content, reorder!, ctx.state.seed);
    if (applied.rejected) throw new Error(applied.reason);
    const reordered: PolicyContext = { ...ctx, state: applied.state, solution: solve(applied.state, content) };
    expect(topTargetItem(ctx)).toBe("iron_ore");
    expect(topTargetItem(reordered)).toBe("iron_plate");
    expect(rest).toEqual(getPolicy("optimal").decide(reordered));
  });
});

describe("bottleneck and reserve advice (spec 2026-10-13)", () => {
  const advice = { kind: "reserve", itemId: "iron_ingot", percent: 0.25, limitingTarget: "item:iron_plate" } as const;

  it("sets the reserve it is advised to", () => {
    const base = rich();
    const ctx: PolicyContext = { ...base, solution: { ...base.solution, bottleneck: advice } };
    expect(getPolicy("bottleneck").decide(ctx)).toContainEqual({ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0.25 });
  });

  it("clears a reserve whose item has stopped growing", () => {
    const base = rich();
    const state: WorldState = { ...base.state, reserve: { ...base.state.reserve, iron_ingot: 0.25 } };
    const solved = solve(state, content);
    // Precondition: the advice is not a reserve on iron_ingot.
    expect(solved.bottleneck).not.toMatchObject({ kind: "reserve", itemId: "iron_ingot" });
    // Under the keep rule a growing reserve is kept, so the item must not be growing.
    const itemRates = new Map(solved.itemRates);
    const production = solved.itemRates.get("iron_ingot")?.production ?? 0;
    itemRates.set("iron_ingot", { production, consumption: production, net: 0 });
    const solution = { ...solved, itemRates };
    expect(getPolicy("bottleneck").decide({ ...base, state, solution })).toContainEqual({
      type: "SET_RESERVE",
      itemId: "iron_ingot",
      percent: 0,
    });
  });

  // Spec 2026-10-16 (reserves that last): a reserve is kept while it is working, so it is
  // not dropped the moment the advice moves. Measured cause: every reserve lasted one
  // decision, and two payers alternated four times.
  const reservedWith = (items: Record<string, number>, rates: Record<string, number>, states: Record<string, "EMPTY" | "FLOWING" | "FULL"> = {}) => {
    const base = rich();
    const state: WorldState = { ...base.state, reserve: { ...base.state.reserve, ...items } };
    const solved = solve(state, content);
    const itemRates = new Map(solved.itemRates);
    for (const [itemId, net] of Object.entries(rates)) itemRates.set(itemId, { production: net + 1, consumption: 1, net });
    const itemStates = new Map(solved.itemStates);
    for (const [itemId, tag] of Object.entries(states)) itemStates.set(itemId, tag);
    const ctx: PolicyContext = { ...base, state, solution: { ...solved, itemRates, itemStates } };
    // Precondition: the advice is not a reserve on any of these items.
    for (const itemId of Object.keys(items)) expect(ctx.solution.bottleneck).not.toMatchObject({ kind: "reserve", itemId });
    return getPolicy("bottleneck").decide(ctx);
  };

  it("keeps a reserve whose item is still growing after the advice moved", () => {
    const actions = reservedWith({ iron_ingot: 0.25 }, { iron_ingot: 2 }, { iron_ingot: "FLOWING" });
    expect(actions).not.toContainEqual({ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0 });
  });

  it("clears a reserve whose item is FULL", () => {
    const actions = reservedWith({ iron_ingot: 0.25 }, { iron_ingot: 2 }, { iron_ingot: "FULL" });
    expect(actions).toContainEqual({ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0 });
  });

  it("clears a reserve whose net is exactly FLOW_TOLERANCE (growing is net > FLOW_TOLERANCE)", () => {
    const actions = reservedWith({ iron_ingot: 0.25 }, { iron_ingot: FLOW_TOLERANCE }, { iron_ingot: "FLOWING" });
    expect(actions).toContainEqual({ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0 });
  });

  it("keeps two reserves at once while both are growing", () => {
    const actions = reservedWith({ iron_ingot: 0.25, iron_ore: 0.25 }, { iron_ingot: 2, iron_ore: 3 }, { iron_ingot: "FLOWING", iron_ore: "FLOWING" });
    expect(actions.filter((a) => a.type === "SET_RESERVE" && a.percent === 0)).toEqual([]);
  });

  it("is the only policy that ever reserves", () => {
    const base = rich();
    const ctx: PolicyContext = { ...base, solution: { ...base.solution, bottleneck: advice } };
    for (const name of ["greedy", "casual", "optimal"] as const) {
      expect(getPolicy(name).decide(ctx).some((a) => a.type === "SET_RESERVE")).toBe(false);
    }
  });
});
