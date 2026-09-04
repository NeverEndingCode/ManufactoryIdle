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
  | null;

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

export function computeBottleneck(
  content: IndexedContent,
  capacity: CapacityTable,
  entries: readonly EntryAllocation[],
  power: PowerReport,
  tier: number,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
): Bottleneck {
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
  return {
    kind: "recipe",
    recipeId: firstLimited.limitedBy,
    limitingTarget: firstLimited.entryId,
    machinesToClear: machinesToClearRecipe(capacity, firstLimited),
  };
}
