import { describe, expect, it } from "vitest";
import { D, apply, computeCapacity, solve, type WorldState } from "@manufactory/engine";
import { loadContent, newWorld } from "./bootstrap.js";
import {
  POLICY_NAMES,
  affordableCandidates,
  costScore,
  getPolicy,
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
    });
    expect(getPolicy("bottleneck").decide(ctx)).toEqual([
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
    ]);
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
