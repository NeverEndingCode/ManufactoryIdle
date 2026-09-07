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

  it("greedy and bottleneck check in at the authored early purchase interval", () => {
    const ctx = rich();
    const expected = content.bundle.pacing.purchaseIntervalEarlySeconds * 1000;
    expect(getPolicy("greedy").intervalMs(ctx)).toBe(expected);
    expect(getPolicy("bottleneck").intervalMs(ctx)).toBe(expected);
  });

  it("bottleneck buys exactly what the reporter recommends (spec 4.5, E.2)", () => {
    const ctx = rich();
    expect(ctx.solution.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "make_plate",
      limitingTarget: "item:iron_plate",
      machinesToClear: 1,
    });
    const actions = getPolicy("bottleneck").decide(ctx);
    expect(actions).toEqual([
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
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
