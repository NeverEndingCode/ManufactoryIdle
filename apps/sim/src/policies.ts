// Spec E.2's four policies. Real players sit between greedy and casual; tuning only
// against optimal produces a game that is brutal for everyone else.
//
// The fourth, `bottleneck`, is the one that earns its place: it answers the only
// question that matters about the game's advice mechanism -- is the advice actually
// good? If it lands materially worse than greedy, the UI is lying to players and no
// amount of balance tuning fixes that.
import {
  apply,
  bestUnlockedMark,
  canAffordBuild,
  getMark,
  levelCostRange,
  machineCostRange,
  solve,
  type Action,
  type Dec,
  type IndexedContent,
  type ItemId,
  type Solution,
  type WorldState,
} from "@manufactory/engine";

export type PolicyName = "optimal" | "greedy" | "casual" | "bottleneck";

export const POLICY_NAMES: readonly PolicyName[] = [
  "optimal",
  "greedy",
  "casual",
  "bottleneck",
] as const;

export interface PolicyContext {
  content: IndexedContent;
  state: WorldState;
  solution: Solution;
  nowMs: number;
}

export interface Policy {
  name: PolicyName;
  /** Simulated milliseconds to advance before the next decision point. */
  intervalMs(ctx: PolicyContext): number;
  /** Actions to attempt now. The runner skips any the engine rejects. */
  decide(ctx: PolicyContext): Action[];
}

export interface Candidate {
  action: Action;
  costs: Map<ItemId, Dec>;
  /** Total cost, used to order candidates. Lower is cheaper. */
  score: number;
  label: string;
}

/**
 * A single scalar for a multi-item cost. Exact when a tier's build costs share one
 * currency, which they do in the fixture, and a stable ordering heuristic otherwise.
 */
export function costScore(costs: ReadonlyMap<ItemId, Dec>): number {
  let total = 0;
  for (const [, amount] of costs) total += amount.toNumber();
  return total;
}

/** The highest-priority unpaused item entry that something can actually produce. */
export function topTargetItem(ctx: PolicyContext): ItemId | null {
  for (const entry of ctx.state.priority) {
    if (entry.paused || entry.kind !== "item" || entry.itemId === null) continue;
    const recipeId = ctx.state.activeRecipe[entry.itemId];
    if (recipeId === undefined) continue;
    // Only a recipe with live capacity is a target anything can be steered toward.
    if (!ctx.solution.capacity.unitsByRecipe.has(recipeId)) continue;
    return entry.itemId;
  }
  return null;
}

export function affordableCandidates(ctx: PolicyContext): Candidate[] {
  const { content, state } = ctx;
  const candidates: Candidate[] = [];

  const offer = (action: Action, costs: Map<ItemId, Dec>, label: string): void => {
    if (costs.size === 0) return;
    if (!canAffordBuild(state, costs)) return;
    candidates.push({ action, costs, score: costScore(costs), label });
  };

  for (const key of content.recipesByLaneClass.keys()) {
    const [lane, machineClass] = key.split("::") as [string, string];
    const mark = bestUnlockedMark(content, machineClass, state.tier);
    if (mark === null) continue;
    const markDef = getMark(content, machineClass, mark);
    if (!markDef) continue;

    const owned = state.installed[lane]?.[machineClass]?.[mark - 1] ?? 0;
    offer(
      { type: "BUY_MACHINE", lane, machineClass, mark, count: 1 },
      machineCostRange(content, machineClass, mark, owned, 1),
      `machine:${key}`,
    );
  }

  for (const itemId of content.stockItemIds) {
    const level = state.storageLevel[itemId] ?? 0;
    if (level >= content.bundle.storage.maxLevel) continue;
    offer(
      { type: "BUY_STORAGE", itemId, levels: 1 },
      levelCostRange(content.bundle.storage, level, 1),
      `storage:${itemId}`,
    );
  }

  for (const lane of content.lanes.keys()) {
    const level = state.qsLevel[lane] ?? 0;
    if (level >= content.bundle.quantumStorage.maxLevel) continue;
    offer(
      { type: "BUY_QS", lane, levels: 1 },
      levelCostRange(content.bundle.quantumStorage, level, 1),
      `qs:${lane}`,
    );
  }

  return candidates;
}

function cheapest(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    // Ties break on the label, which is derived from ids, so the choice is stable.
    if (best === null || candidate.score < best.score) best = candidate;
    else if (candidate.score === best.score && candidate.label < best.label) best = candidate;
  }
  return best;
}

const greedy: Policy = {
  name: "greedy",
  intervalMs: (ctx) => ctx.content.bundle.pacing.purchaseIntervalEarlySeconds * 1000,
  decide: (ctx) => {
    const pick = cheapest(affordableCandidates(ctx));
    return pick === null ? [] : [pick.action];
  },
};

/**
 * Spec E.2's lower bound: checks in three times a day, buys whatever it can see, and
 * never touches the priority list. One check-in per offline window.
 */
const casual: Policy = {
  name: "casual",
  intervalMs: (ctx) => ctx.content.offlineCapMs,
  decide: (ctx) => {
    const actions: Action[] = [];
    let state = ctx.state;
    // Buy repeatedly until nothing is affordable, because a casual player who has
    // been away eight hours spends the whole backlog in one sitting.
    for (let i = 0; i < 50; i += 1) {
      const pick = cheapest(affordableCandidates({ ...ctx, state }));
      if (pick === null) break;
      const result = apply(state, ctx.content, pick.action, state.seed);
      if (result.rejected) break;
      state = result.state;
      actions.push(pick.action);
    }
    return actions;
  },
};

const bottleneck: Policy = {
  name: "bottleneck",
  intervalMs: (ctx) => ctx.content.bundle.pacing.purchaseIntervalEarlySeconds * 1000,
  decide: (ctx) => {
    const report = ctx.solution.bottleneck;
    if (report === null) return [];

    // A cap binds where no machine helps. Before the reporter could say so, this
    // policy bought constructors into a full warehouse and never reached tier 2.
    if (report.kind === "storage") {
      if (report.upgrade === null) return [];
      const item = ctx.content.items.get(report.itemId);
      if (!item) return [];

      const buyingStorage = report.upgrade === "storage";
      const curve = buyingStorage ? ctx.content.bundle.storage : ctx.content.bundle.quantumStorage;
      const levels = buyingStorage ? ctx.state.storageLevel : ctx.state.qsLevel;
      const key = buyingStorage ? report.itemId : item.lane;
      const level = Object.hasOwn(levels, key) ? levels[key]! : 0;

      const costs = levelCostRange(curve, level, 1);
      if (!canAffordBuild(ctx.state, costs)) return [];
      return [
        buyingStorage
          ? { type: "BUY_STORAGE", itemId: report.itemId, levels: 1 }
          : { type: "BUY_QS", lane: item.lane, levels: 1 },
      ];
    }

    const recipeId = report.kind === "recipe" ? report.recipeId : report.generatorRecipeId;
    if (recipeId === null) return [];
    const recipe = ctx.content.recipes.get(recipeId);
    if (!recipe) return [];

    const mark = bestUnlockedMark(ctx.content, recipe.machineClass, ctx.state.tier);
    if (mark === null) return [];

    const owned =
      ctx.state.installed[recipe.lane]?.[recipe.machineClass]?.[mark - 1] ?? 0;

    // Buy what the reporter says, then fall back to what is affordable, so the
    // policy still makes progress rather than stalling on an expensive quote.
    for (let count = Math.max(1, report.machinesToClear); count >= 1; count -= 1) {
      const costs = machineCostRange(ctx.content, recipe.machineClass, mark, owned, count);
      if (canAffordBuild(ctx.state, costs)) {
        return [
          {
            type: "BUY_MACHINE",
            lane: recipe.lane,
            machineClass: recipe.machineClass,
            mark,
            count,
          },
        ];
      }
    }
    return [];
  },
};

/**
 * Greedy with one-step lookahead, and named `optimal` because spec E.2 calls the
 * upper-bound policy that. It is a proxy, not a true optimum: a real optimum would
 * search the whole purchase sequence. It is still strictly better informed than
 * greedy, which is the comparison the policy exists to provide.
 */
const optimal: Policy = {
  name: "optimal",
  intervalMs: (ctx) => ctx.content.bundle.pacing.purchaseIntervalEarlySeconds * 1000,
  decide: (ctx) => {
    const target = topTargetItem(ctx);
    const candidates = affordableCandidates(ctx);
    if (candidates.length === 0) return [];
    if (target === null) {
      const pick = cheapest(candidates);
      return pick === null ? [] : [pick.action];
    }

    const before = ctx.solution.itemRates.get(target)?.production ?? 0;
    let best: { action: Action; value: number; label: string } | null = null;

    for (const candidate of candidates) {
      const applied = apply(ctx.state, ctx.content, candidate.action, ctx.state.seed);
      if (applied.rejected) continue;
      const after = solve(applied.state, ctx.content).itemRates.get(target)?.production ?? 0;
      const value = (after - before) / Math.max(1, candidate.score);
      if (
        best === null ||
        value > best.value ||
        (value === best.value && candidate.label < best.label)
      ) {
        best = { action: candidate.action, value, label: candidate.label };
      }
    }

    if (best === null) return [];
    // Nothing helped the top target, so fall back to the cheapest capacity there is:
    // a purchase that does nothing today may unblock a tier tomorrow.
    if (best.value <= 0) {
      const pick = cheapest(candidates);
      return pick === null ? [] : [pick.action];
    }
    return [best.action];
  },
};

const POLICIES: Record<PolicyName, Policy> = { optimal, greedy, casual, bottleneck };

export function getPolicy(name: PolicyName): Policy {
  return POLICIES[name];
}
