// Spec 4.5: the solver returns the bottleneck as first-class output, never something
// the UI derives. Exactly one row per lane carries the treatment, so what is
// returned is the recipe limiting the HIGHEST-PRIORITY limited target -- marking
// every row under 100% teaches players to ignore the marking.
//
// machinesToClear is the count that would make some other recipe the binding
// constraint, which is what "6 more constructors clears it" means. The waterfall
// already recorded the runner-up ratio, so no second solve is needed.
import { POWER_ITEM, type ItemId, type RecipeId } from "../content/types.js";
import { isLiveRecipe, type IndexedContent } from "../graph/index-content.js";
import type { CapacityTable } from "../economy/capacity.js";
import type { ItemStateTag } from "../economy/storage.js";
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
