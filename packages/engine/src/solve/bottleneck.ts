// Spec 4.5, amended 2026-09-19: the solver returns the bottleneck as first-class
// output, never something the UI derives. Exactly one row per lane carries the
// treatment -- marking every row under 100% teaches players to ignore the marking.
// The reporter resolves the next milestone's unmet requirements first; only when the
// milestone is satisfied or nothing in it is blocked does it fall back to the recipe
// limiting the HIGHEST-PRIORITY limited target.
//
// machinesToClear is the count that would make some other recipe the binding
// constraint, which is what "6 more constructors clears it" means. The waterfall
// already recorded the runner-up ratio, so no second solve is needed.
import { POWER_ITEM, type ItemId, type RecipeId } from "../content/types.js";
import { isLiveRecipe, type IndexedContent } from "../graph/index-content.js";
import type { CapacityTable } from "../economy/capacity.js";
import { liquid, type ItemStateTag } from "../economy/storage.js";
import { levelCostRange } from "../economy/curves.js";
import { D, type Dec } from "../numbers/decimal.js";
import type { WorldState } from "../state/world.js";
import type { EntryAllocation } from "./waterfall.js";
import type { PowerReport } from "./power.js";

export type Bottleneck =
  | { kind: "recipe"; recipeId: RecipeId; limitingTarget: string; machinesToClear: number }
  | {
      kind: "power";
      limitingTarget: string;
      generatorRecipeId: RecipeId | null;
      machinesToClear: number;
    }
  // A cap is a constraint no machine can clear, and before this kind existed the
  // reporter fell through to the recipe it could name -- telling a player at cap,
  // with production at zero, to buy another machine. `upgrade` is null only when
  // both curves are maxed, which is the permanent wall validator check 9 exists to
  // make unreachable; saying so beats inventing a purchase that cannot be made.
  | { kind: "storage"; itemId: ItemId; limitingTarget: string; upgrade: StorageUpgrade | null }
  | null;

export type StorageUpgrade = "storage" | "quantum";

/**
 * `activeRecipe` is a Record<ItemId, RecipeId> keyed by an author-supplied content
 * id (see waterfall.ts's activeRecipeOf for the collision this guards against).
 * POWER_ITEM is a fixed engine constant ("__power__"), not author-supplied, but the
 * lookup goes through the same guarded accessor for consistency and because a
 * future content bundle authoring an item literally named "__power__" is not this
 * function's problem to reason about.
 */
function activeRecipeOf(
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
  itemId: ItemId,
): RecipeId | undefined {
  return Object.hasOwn(activeRecipe, itemId) ? activeRecipe[itemId] : undefined;
}

function machinesToClearRecipe(capacity: CapacityTable, entry: EntryAllocation): number {
  const recipeId = entry.limitedBy;
  if (recipeId === null) return 0;
  const goal = Math.min(entry.runnerUpRate, entry.requested);
  // An unbounded target with no runner-up has no natural "cleared" point, so quote
  // what a 10% lift would take rather than reporting nothing.
  const target = Number.isFinite(goal) ? goal : entry.allocated * 1.1;
  const shortfallUnits = Math.max(0, target - entry.allocated) * entry.limitingPerUnit;
  const perMachine = capacity.unitsPerMachine.get(recipeId) ?? 0;
  if (perMachine <= 0) return 1;
  return Math.max(1, Math.ceil(shortfallUnits / perMachine));
}

function levelOf(record: Readonly<Record<string, number>>, key: string): number {
  return Object.hasOwn(record, key) ? record[key]! : 0;
}

/**
 * Which container to buy when a cap is what binds. Cheaper next level wins; a curve
 * already at maxLevel is not a candidate. Only one level is ever recommended -- the
 * caller re-solves after buying, so an iterative honest answer beats quoting a
 * "levels to clear" count derived from the same 10%-lift heuristic that produced the
 * bad machine advice in the first place.
 */
function cheaperUpgrade(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): StorageUpgrade | null {
  const item = content.items.get(itemId);
  if (!item) return null;

  const storageLevel = levelOf(state.storageLevel, itemId);
  const qsLevel = levelOf(state.qsLevel, item.lane);
  const storageOpen = storageLevel < content.bundle.storage.maxLevel;
  const qsOpen = qsLevel < content.bundle.quantumStorage.maxLevel;
  if (!storageOpen && !qsOpen) return null;
  if (!qsOpen) return "storage";
  if (!storageOpen) return "quantum";

  // Both open: compare what one more level costs. Each curve names a single cost
  // item, and they need not be the same one, so compare the amounts that are there.
  const storageCost = levelCostRange(content.bundle.storage, storageLevel, 1);
  const qsCost = levelCostRange(content.bundle.quantumStorage, qsLevel, 1);
  const total = (costs: Map<ItemId, Dec>): Dec =>
    [...costs.values()].reduce((sum, amount) => sum.plus(amount), D(0));
  return total(qsCost).lt(total(storageCost)) ? "quantum" : "storage";
}

/**
 * What is stopping `itemId`, or null if nothing is.
 *
 * `visited` is shared across one call's whole sweep rather than reset per
 * requirement: an item that returned null once returns null again, so sharing is
 * exact and saves re-walking an item two requirements have in common. The walk no
 * longer recurses into recipe inputs -- see the comment at the bottom of this
 * function for why -- so the guard is currently dormant, not load-bearing. It is
 * kept anyway, at no cost, because ruling R6 keeping the live subgraph acyclic today
 * is a property of content, not a guarantee, should recursion return.
 */
function resolveBlocker(
  content: IndexedContent,
  capacity: CapacityTable,
  entries: readonly EntryAllocation[],
  state: WorldState,
  itemStates: ReadonlyMap<ItemId, ItemStateTag>,
  itemId: ItemId,
  /**
   * The milestone requirement this walk started from. Every blocker reports it as
   * `limitingTarget`, NOT the item the walk happens to have reached: the advice has
   * to read "this is what is stopping the thing you need", not name an intermediate
   * the player never asked for. The blocker's own identity travels in `recipeId` or
   * `itemId`, so both halves are still recoverable.
   */
  targetId: ItemId,
  visited: Set<ItemId>,
): Bottleneck {
  if (visited.has(itemId)) return null;
  visited.add(itemId);

  const recipeId = activeRecipeOf(state.activeRecipe, itemId);
  if (recipeId === undefined) return null;
  // A locked recipe is not advice. The player cannot buy a machine for a recipe that
  // has not unlocked, and `unitsByRecipe` only carries live recipes, so without this
  // guard every locked recipe downstream would read as a zero-capacity blocker.
  if (!isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) return null;

  // Zero machines is not "limited" -- nothing is constraining it, it has no capacity
  // at all, and its waterfall entry reports `limitedBy: null`. That is exactly why
  // the priority scan could never name it.
  if ((capacity.unitsByRecipe.get(recipeId) ?? 0) <= 0) {
    return {
      kind: "recipe",
      recipeId,
      limitingTarget: `item:${targetId}`,
      // One, deliberately, and not from `machinesToClearRecipe`. That function
      // answers "how many machines of `entry.limitedBy`", and for a zero-capacity
      // target `limitedBy` need not name this recipe at all: measured on the fixture
      // at tier 2, `plastic` comes back limited by `extract_oil` rather than
      // `refine_plastic`, because both oil recipes sit at ratio 0 with no machines
      // and the tie breaks on `content.recipeIds` order. Quoting its count would
      // attach a number to the wrong recipe. One machine is the honest minimum and
      // the caller re-solves after buying -- the same argument the storage branch
      // makes for only ever recommending one level.
      machinesToClear: 1,
    };
  }

  // A cap is a constraint no machine can clear. Ordered ahead of the limited branch
  // for the same reason the priority scan orders it that way: a FULL item's producer
  // is limited by backpressure, and naming the recipe would advise a purchase that
  // cannot help.
  if (itemStates.get(itemId) === "FULL") {
    return {
      kind: "storage",
      itemId,
      limitingTarget: `item:${targetId}`,
      upgrade: cheaperUpgrade(content, state, itemId),
    };
  }

  const entry = entries.find((candidate) => candidate.itemId === itemId);
  if (entry !== undefined && entry.limitedBy !== null) {
    return {
      kind: "recipe",
      recipeId: entry.limitedBy,
      limitingTarget: `item:${targetId}`,
      machinesToClear: machinesToClearRecipe(capacity, entry),
    };
  }

  // Producing, uncapped, and getting everything it asked for: this requirement is
  // not blocked, it is merely not banked yet. This branch used to recurse into the
  // recipe's inputs in case one of THEM was stopped, but measurement found that
  // branch dead: running `bottleneck` on the vertical-slice content at tier 2 --
  // the tier the policy could never pass before this task, so the tier where this
  // walk does the most work -- for 5 simulated days hit a counter placed at the top
  // of that loop zero times. The waterfall's `limitedBy` already names the deepest
  // limiting recipe by the time this function runs, so there was nothing left for
  // the recursion to find. Deleted rather than shipped on faith; `visited` stays
  // because it still guards this function's entry point.
  return null;
}

export function computeBottleneck(
  content: IndexedContent,
  capacity: CapacityTable,
  entries: readonly EntryAllocation[],
  power: PowerReport,
  state: WorldState,
  itemStates: ReadonlyMap<ItemId, ItemStateTag>,
): Bottleneck {
  const tier = state.tier;
  const activeRecipe = state.activeRecipe;
  const firstLimited = entries.find((entry) => entry.limitedBy !== null) ?? null;

  // Spec 4.5: when the grid is what binds, the bottleneck surfaces on the power bar
  // with a generator purchase instead of a recipe.
  if (power.ratio < 1 - 1e-9) {
    const generatorId = activeRecipeOf(activeRecipe, POWER_ITEM);
    const live =
      generatorId !== undefined && isLiveRecipe(content, generatorId, tier, activeRecipe)
        ? generatorId
        : null;

    let machines = 0;
    if (live !== null) {
      const perUnitMw = content.recipes.get(live)!.outputPerSecond.get(POWER_ITEM) ?? 0;
      const perMachineMw = (capacity.unitsPerMachine.get(live) ?? 0) * perUnitMw;
      const deficit = Math.max(0, power.fullDemandMw - power.supplyMw);
      machines = perMachineMw > 0 ? Math.max(1, Math.ceil(deficit / perMachineMw)) : 0;
    }
    return {
      kind: "power",
      limitingTarget: firstLimited?.entryId ?? (entries[0]?.entryId ?? ""),
      generatorRecipeId: live,
      machinesToClear: machines,
    };
  }

  // Spec §4.5 as amended 2026-09-19: what blocks the next milestone outranks what
  // limits the top priority item. Falls through when the milestone is satisfied,
  // when nothing in it is blocked, or at the last tier.
  const nextMilestone = content.milestoneByTier.get(tier + 1);
  if (nextMilestone !== undefined) {
    const visited = new Set<ItemId>();
    for (const requirement of nextMilestone.requires) {
      // Ruling R7 pays deliveries from liquid stock, so liquid is the right measure.
      if (liquid(state, requirement.item).gte(requirement.amount)) continue;
      const blocker = resolveBlocker(
        content, capacity, entries, state, itemStates,
        requirement.item, requirement.item, visited,
      );
      if (blocker !== null) return blocker;
    }
  }

  if (firstLimited === null || firstLimited.limitedBy === null) return null;

  // A FULL item is throttled by backpressure, not by capacity: its producing recipe
  // is limited because there is nowhere to put the output. Adding machines cannot
  // move it, so the cap must be named before the recipe branch gets the chance.
  if (itemStates.get(firstLimited.itemId) === "FULL") {
    return {
      kind: "storage",
      itemId: firstLimited.itemId,
      limitingTarget: firstLimited.entryId,
      upgrade: cheaperUpgrade(content, state, firstLimited.itemId),
    };
  }

  return {
    kind: "recipe",
    recipeId: firstLimited.limitedBy,
    limitingTarget: firstLimited.entryId,
    machinesToClear: machinesToClearRecipe(capacity, firstLimited),
  };
}
