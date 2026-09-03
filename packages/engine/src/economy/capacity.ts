// Ruling R5: machine capacity is pooled per (lane, machineClass) and distributed
// proportionally by assignment.
//
// Original spec section 4.2 computes capacity[R] = machineCount[R] * baseRate[R] as
// though machines are owned per-recipe, while spec B.2 scopes the cost counter and
// the ladder to (lane, class, mark). Both cannot hold. Pooling resolves it: the
// player buys machines into a lane-class and assigns integer counts of them to
// recipes, marks are fungible so a mark upgrade lifts every recipe in the
// lane-class at once, and pillar 3's "no management surface" survives.
//
// The solver's unit of capacity is the machine-unit: one Mk1 machine at clock 1 with
// no multipliers. Output in items/second is
//   unitsByRecipe[R] * outputPerSecond[R][item] * clock[R].
import type { ItemId, LaneId, MachineClassId, RecipeId } from "../content/types.js";
import { POWER_ITEM } from "../content/types.js";
import { isLiveRecipe, laneClassKey, type IndexedContent } from "../graph/index-content.js";
import { installedAt, installedMachines, type WorldState } from "../state/world.js";
import { combinedMultiplier, ladderMultiplier, laneMultiplier, tapMultiplier } from "./curves.js";

export interface CapacityTable {
  /** Machine-units available to each live recipe, multipliers already applied. */
  unitsByRecipe: Map<RecipeId, number>;
  /** Physical machines assigned to each live recipe. Drives power draw. */
  machinesByRecipe: Map<RecipeId, number>;
  /** Mean MW per machine for each `lane::class`, over the whole installed pool. */
  drawPerMachine: Map<string, number>;
  /** The combined multiplier stack applied to each live recipe. */
  multiplierByRecipe: Map<RecipeId, number>;
  /** Machine-units one additional machine would add. Bottleneck arithmetic. */
  unitsPerMachine: Map<RecipeId, number>;
}

// `state.assignment` is a Record<RecipeId, number> keyed by an author-supplied
// content id, and a recipe id can legitimately collide with a property already on
// Object.prototype (e.g. "constructor", "__proto__", "toString"). Plain
// `state.assignment[recipeId] ?? 0` on an object with no own such property resolves
// through the prototype chain instead of hitting the `?? 0` fallback, silently
// turning a missing assignment into NaN arithmetic downstream. Object.hasOwn
// distinguishes "own property, possibly zero" from "no own property at all",
// mirroring ownOrUndefined in state/world.ts.
function assignmentOf(state: WorldState, recipeId: RecipeId): number {
  return Object.hasOwn(state.assignment, recipeId) ? state.assignment[recipeId]! : 0;
}

export function installedUnits(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return 0;
  let total = 0;
  for (const mark of cls.marks) {
    total += installedAt(state, lane, machineClass, mark.mark) * mark.rateMultiplier;
  }
  return total;
}

/** Highest mark of a class the player has unlocked at `tier`, or null if none. */
export function bestUnlockedMark(
  content: IndexedContent,
  machineClass: MachineClassId,
  tier: number,
): number | null {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return null;
  let best: number | null = null;
  for (const mark of cls.marks) {
    if (mark.unlockTier <= tier && (best === null || mark.mark > best)) best = mark.mark;
  }
  return best;
}

export function computeCapacity(content: IndexedContent, state: WorldState): CapacityTable {
  const unitsByRecipe = new Map<RecipeId, number>();
  const machinesByRecipe = new Map<RecipeId, number>();
  const drawPerMachine = new Map<string, number>();
  const multiplierByRecipe = new Map<RecipeId, number>();
  const unitsPerMachine = new Map<RecipeId, number>();

  for (const recipeId of content.recipeIds) {
    if (!isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) continue;
    const recipe = content.recipes.get(recipeId)!;
    const { lane, machineClass } = recipe;
    const key = laneClassKey(lane, machineClass);

    const machines = installedMachines(state, lane, machineClass);
    const units = installedUnits(content, state, lane, machineClass);

    if (!drawPerMachine.has(key)) {
      const cls = content.machineClasses.get(machineClass)!;
      let totalDraw = 0;
      for (const mark of cls.marks) {
        totalDraw += installedAt(state, lane, machineClass, mark.mark) * mark.powerDraw;
      }
      drawPerMachine.set(key, machines > 0 ? totalDraw / machines : 0);
    }

    const multiplier = combinedMultiplier(content, [
      ladderMultiplier(content, state, lane, machineClass),
      laneMultiplier(content, state.tier, lane),
      tapMultiplier(content, state),
    ]);
    multiplierByRecipe.set(recipeId, multiplier);

    const assigned = assignmentOf(state, recipeId);
    machinesByRecipe.set(recipeId, assigned);

    // Unassigned machines are idle: no capacity, no draw.
    const fraction = machines > 0 ? assigned / machines : 0;
    unitsByRecipe.set(recipeId, fraction * units * multiplier);

    const bestMark = bestUnlockedMark(content, machineClass, state.tier);
    const perMachineRate =
      bestMark === null
        ? 0
        : (content.machineClasses.get(machineClass)!.marks.find((m) => m.mark === bestMark)
            ?.rateMultiplier ?? 0);
    unitsPerMachine.set(recipeId, perMachineRate * multiplier);
  }

  return { unitsByRecipe, machinesByRecipe, drawPerMachine, multiplierByRecipe, unitsPerMachine };
}

/** Production of `itemId` in items/second if every live producer ran at clock 1. */
export function unconstrainedRate(
  content: IndexedContent,
  capacity: CapacityTable,
  itemId: ItemId,
): number {
  let total = 0;
  for (const recipeId of content.producersOf.get(itemId) ?? []) {
    const units = capacity.unitsByRecipe.get(recipeId);
    if (units === undefined) continue;
    total += units * (content.recipes.get(recipeId)!.outputPerSecond.get(itemId) ?? 0);
  }
  return total;
}

/** Spec 6.1: grid demand = sum of draw x clock over every assigned machine. */
export function powerDemandMw(
  content: IndexedContent,
  capacity: CapacityTable,
  _state: WorldState,
  clocks: ReadonlyMap<RecipeId, number>,
): number {
  let demand = 0;
  for (const [recipeId, machines] of capacity.machinesByRecipe) {
    if (machines <= 0) continue;
    const recipe = content.recipes.get(recipeId)!;
    // A generator's own draw is zero in content, but excluding power producers here
    // as well makes the death-spiral exemption in solve/power.ts symmetric.
    if (recipe.def.powerOutput > 0) continue;
    const perMachine =
      capacity.drawPerMachine.get(laneClassKey(recipe.lane, recipe.machineClass)) ?? 0;
    demand += machines * perMachine * (clocks.get(recipeId) ?? 0);
  }
  return demand;
}

/**
 * Spec 6.1 and 6.3: grid capacity = generator output plus the HUB allowance, so a
 * fresh world is not stalled at ratio 0 before the first generator unlocks. The tap
 * injection from spec section 7 is added by the power loop in solve/power.ts, which
 * has the tap state in scope.
 */
export function powerSupplyMw(
  content: IndexedContent,
  capacity: CapacityTable,
  clocks: ReadonlyMap<RecipeId, number>,
): number {
  let supply = content.bundle.baseGridCapacityMw;
  for (const recipeId of content.producersOf.get(POWER_ITEM) ?? []) {
    const units = capacity.unitsByRecipe.get(recipeId);
    if (units === undefined) continue;
    const perUnit = content.recipes.get(recipeId)!.outputPerSecond.get(POWER_ITEM) ?? 0;
    supply += units * perUnit * (clocks.get(recipeId) ?? 0);
  }
  return supply;
}
