// Spec D.1, actions one through five.
//
// Ruling R5 pools machines per (lane, machineClass), so a purchase adds to the pool
// and an assignment distributes it. Making the player assign after every purchase
// would be exactly the management surface pillar 3 rules out, so BUY_MACHINE
// auto-assigns by the player's priority list (see autoAssignTarget) and DISMANTLE
// clamps back down from the largest assignment first.
//
// Spec D4 makes refunds LIFO: dismantling the nth machine returns cost(n), so
// rebuilding costs exactly what was refunded. Both directions call
// machineCostRange with the same arguments, which makes the two Decimals bitwise
// equal rather than merely close.
import type { ItemId, LaneId, MachineClassId, RecipeId } from "../content/types.js";
import {
  getMark,
  isLiveRecipe,
  laneClassKey,
  type IndexedContent,
} from "../graph/index-content.js";
import { machineCostRange } from "../economy/curves.js";
import { depositRefund, spendForBuild } from "../economy/storage.js";
import {
  assignedTotal,
  installedAt,
  installedMachines,
  withInstalled,
  type WorldState,
} from "../state/world.js";
import { MAX_ACTION_COUNT, accept, costEffect, reject, type Action, type ApplyResult } from "./types.js";

function validCount(count: number): boolean {
  return Number.isInteger(count) && count > 0 && count <= MAX_ACTION_COUNT;
}

function recipesIn(
  content: IndexedContent,
  lane: LaneId,
  machineClass: MachineClassId,
): RecipeId[] {
  return content.recipesByLaneClass.get(laneClassKey(lane, machineClass)) ?? [];
}

// `state.assignment` is a Record<RecipeId, number> keyed by an author-supplied
// content id, and a recipe id can legitimately collide with a property already on
// Object.prototype (e.g. "constructor", "toString"). Plain `state.assignment[id] ??
// 0` on an object with no own such property resolves through the prototype chain
// instead of hitting the `?? 0` fallback. Object.hasOwn distinguishes "own
// property, possibly zero" from "no own property at all" -- this mirrors
// assignmentOf in economy/capacity.ts, kept module-local here since that one isn't
// exported.
function assignmentOf(state: WorldState, recipeId: RecipeId): number {
  return Object.hasOwn(state.assignment, recipeId) ? state.assignment[recipeId]! : 0;
}

/**
 * Keeps the assignments of a lane-class within its pool, shrinking the largest
 * first so the shape of the player's split survives. Ties break by authored recipe
 * order (spec A.5).
 */
export function clampAssignments(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): WorldState {
  const pool = installedMachines(state, lane, machineClass);
  const recipeIds = recipesIn(content, lane, machineClass);
  let total = 0;
  for (const recipeId of recipeIds) total += assignmentOf(state, recipeId);
  if (total <= pool) return state;

  const working = new Map<RecipeId, number>(recipeIds.map((id) => [id, assignmentOf(state, id)]));
  let excess = total - pool;
  while (excess > 0) {
    let biggest: RecipeId | null = null;
    for (const recipeId of recipeIds) {
      const count = working.get(recipeId) ?? 0;
      if (count <= 0) continue;
      if (biggest === null || count > (working.get(biggest) ?? 0)) biggest = recipeId;
    }
    if (biggest === null) break;
    const take = Math.min(excess, working.get(biggest) ?? 0);
    working.set(biggest, (working.get(biggest) ?? 0) - take);
    excess -= take;
  }

  // Merge the updated lane-class counts back into the full assignment record via
  // Object.fromEntries, not a bracket write into a spread copy: a recipe id of
  // "__proto__" would otherwise reassign the copy's prototype instead of landing as
  // an own property (the same hazard withInstalled in state/world.ts guards
  // against with Object.defineProperty).
  const merged = new Map<RecipeId, number>(Object.entries(state.assignment));
  for (const [recipeId, count] of working) merged.set(recipeId, count);
  return { ...state, assignment: Object.fromEntries(merged) };
}

/**
 * Where a newly bought machine goes. Pillar 3 says there is no management surface,
 * so the engine assigns rather than asking — but it must assign somewhere the player
 * actually wants.
 *
 * The rule is the priority list (spec 4.1), which is exactly where the player states
 * what they want most. A machine goes to the live recipe in this lane-class whose
 * output sits highest in that list, skipping paused entries because pausing IS the
 * remove verb.
 *
 * It used to go to whichever recipe already had the most machines. That is
 * indistinguishable from this rule while a lane-class has ONE live recipe, which is
 * true everywhere in the fixture's iron lane and false as soon as real content
 * arrives: on the vertical slice it sent every iron constructor to `make_iron_plate`
 * forever, so `make_iron_rod` never got a machine and a tier requiring 300 iron rods
 * was unreachable. Existing assignment survives only as a tie-break, which keeps the
 * old single-recipe behaviour byte-identical.
 */
function autoAssignTarget(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): RecipeId | null {
  const recipeIds = recipesIn(content, lane, machineClass).filter((recipeId) =>
    isLiveRecipe(content, recipeId, state.tier, state.activeRecipe),
  );
  if (recipeIds.length === 0) return null;
  if (recipeIds.length === 1) return recipeIds[0]!;

  // A Map, not a Record: priority entries are keyed by author-supplied item ids,
  // which can collide with Object.prototype members.
  const rankByItem = new Map<ItemId, number>();
  state.priority.forEach((entry, index) => {
    if (entry.paused || entry.itemId === null) return;
    if (!rankByItem.has(entry.itemId)) rankByItem.set(entry.itemId, index);
  });

  // `primaryOutput` is already "the output this recipe is selected for" -- the first
  // non-byproduct output, or POWER_ITEM for a generator. A byproduct is never what a
  // machine is bought for, so ranking on it would be wrong.
  const rankOf = (recipeId: RecipeId): number => {
    const recipe = content.recipes.get(recipeId);
    if (!recipe) return Number.POSITIVE_INFINITY;
    return rankByItem.get(recipe.primaryOutput) ?? Number.POSITIVE_INFINITY;
  };

  let best = recipeIds[0]!;
  let bestRank = rankOf(best);
  for (const recipeId of recipeIds) {
    const rank = rankOf(recipeId);
    if (rank < bestRank) {
      best = recipeId;
      bestRank = rank;
      continue;
    }
    // Equal priority (or both unranked) falls back to the busiest recipe, so a
    // lane-class the player has expressed no opinion about still concentrates
    // rather than spreading thin.
    if (rank === bestRank && assignmentOf(state, recipeId) > assignmentOf(state, best)) {
      best = recipeId;
    }
  }
  return best;
}

export function applyBuyMachine(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "BUY_MACHINE" }>,
): ApplyResult {
  const { lane, machineClass, mark, count } = action;
  if (!content.lanes.has(lane)) return reject(`unknown lane "${lane}"`);
  if (!content.machineClasses.has(machineClass)) {
    return reject(`unknown machine class "${machineClass}"`);
  }
  const markDef = getMark(content, machineClass, mark);
  if (!markDef) return reject(`"${machineClass}" has no mk${mark}`);
  if (markDef.unlockTier > state.tier) {
    return reject(`"${machineClass}" mk${mark} unlocks at tier ${markDef.unlockTier}`);
  }
  if (!validCount(count)) return reject(`count must be an integer in 1..${MAX_ACTION_COUNT}`);

  const owned = installedAt(state, lane, machineClass, mark);
  const costs = machineCostRange(content, machineClass, mark, owned, count);
  const paid = spendForBuild(content, state, costs);
  if (paid === null) return reject("cannot afford this purchase");

  let next = withInstalled(paid, lane, machineClass, mark, owned + count);

  const target = autoAssignTarget(content, next, lane, machineClass);
  const effects = [
    costEffect("spent", costs),
    { kind: "installed" as const, lane, machineClass, mark, count },
  ];
  if (target !== null) {
    const assigned = assignmentOf(next, target) + count;
    next = { ...next, assignment: { ...next.assignment, [target]: assigned } };
    effects.push({ kind: "assigned" as const, recipeId: target, count: assigned });
  }
  return accept(next, effects);
}

export function applyDismantle(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "DISMANTLE" }>,
): ApplyResult {
  const { lane, machineClass, mark, count } = action;
  if (!getMark(content, machineClass, mark)) return reject(`"${machineClass}" has no mk${mark}`);
  if (!validCount(count)) return reject(`count must be an integer in 1..${MAX_ACTION_COUNT}`);

  const owned = installedAt(state, lane, machineClass, mark);
  if (count > owned) return reject(`only ${owned} installed`);

  // LIFO: the last `count` machines bought are the ones refunded.
  const refund = machineCostRange(content, machineClass, mark, owned - count, count);
  let next = state;
  for (const [itemId, amount] of refund) next = depositRefund(content, next, itemId, amount);
  next = withInstalled(next, lane, machineClass, mark, owned - count);
  next = clampAssignments(content, next, lane, machineClass);

  return accept(next, [
    costEffect("refunded", refund),
    { kind: "removed", lane, machineClass, mark, count },
  ]);
}

export function applyUpgradeMark(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "UPGRADE_MARK" }>,
): ApplyResult {
  const { lane, machineClass, fromMark } = action;
  const from = getMark(content, machineClass, fromMark);
  if (!from) return reject(`"${machineClass}" has no mk${fromMark}`);
  const to = getMark(content, machineClass, fromMark + 1);
  if (!to) return reject(`"${machineClass}" has no mk${fromMark + 1}`);
  if (to.unlockTier > state.tier) {
    return reject(`"${machineClass}" mk${to.mark} unlocks at tier ${to.unlockTier}`);
  }

  const owned = installedAt(state, lane, machineClass, fromMark);
  if (owned <= 0) return reject(`no mk${fromMark} ${machineClass} installed in ${lane}`);

  // Spec C.0: a Mk2 at rate xA needs only n/A machines for the same output. Keeping
  // the mark-weighted ladder input intact is what stops the upgrade costing the
  // player their multiplier (spec B.2).
  const equivalent = Math.floor((owned * from.rateMultiplier) / to.rateMultiplier);
  if (equivalent < 1) {
    return reject(`need at least ${Math.ceil(to.rateMultiplier / from.rateMultiplier)} to upgrade`);
  }

  const refund = machineCostRange(content, machineClass, fromMark, 0, owned);
  const ownedHigher = installedAt(state, lane, machineClass, to.mark);
  const cost = machineCostRange(content, machineClass, to.mark, ownedHigher, equivalent);

  let next = state;
  for (const [itemId, amount] of refund) next = depositRefund(content, next, itemId, amount);
  const paid = spendForBuild(content, next, cost);
  if (paid === null) return reject("cannot afford the upgrade");
  next = paid;

  next = withInstalled(next, lane, machineClass, fromMark, 0);
  next = withInstalled(next, lane, machineClass, to.mark, ownedHigher + equivalent);
  next = clampAssignments(content, next, lane, machineClass);

  return accept(next, [
    costEffect("refunded", refund),
    costEffect("spent", cost),
    { kind: "removed", lane, machineClass, mark: fromMark, count: owned },
    { kind: "installed", lane, machineClass, mark: to.mark, count: equivalent },
  ]);
}

export function applyAssignMachines(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "ASSIGN_MACHINES" }>,
): ApplyResult {
  const { recipeId, count } = action;
  const recipe = content.recipes.get(recipeId);
  if (!recipe) return reject(`unknown recipe "${recipeId}"`);
  // Ruling R6: cyclic recipes are unselectable in this version.
  if (recipe.inCycle) return reject(`recipe "${recipeId}" is inside a recipe cycle`);
  if (recipe.def.unlockTier > state.tier) {
    return reject(`recipe "${recipeId}" unlocks at tier ${recipe.def.unlockTier}`);
  }
  if (!Number.isInteger(count) || count < 0 || count > MAX_ACTION_COUNT) {
    return reject(`count must be an integer in 0..${MAX_ACTION_COUNT}`);
  }

  const { lane, machineClass } = recipe;
  const pool = installedMachines(state, lane, machineClass);
  const others = assignedTotal(content, state, lane, machineClass) - assignmentOf(state, recipeId);
  if (others + count > pool) {
    return reject(`only ${pool} ${machineClass} installed in ${lane}, ${others} already assigned`);
  }

  return accept({ ...state, assignment: { ...state.assignment, [recipeId]: count } }, [
    { kind: "assigned", recipeId, count },
  ]);
}

export function applySelectRecipe(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "SELECT_RECIPE" }>,
): ApplyResult {
  const { itemId, recipeId } = action;
  const recipe = content.recipes.get(recipeId);
  if (!recipe) return reject(`unknown recipe "${recipeId}"`);
  if (recipe.primaryOutput !== itemId) {
    return reject(`recipe "${recipeId}" does not produce "${itemId}" as its primary output`);
  }
  // Ruling R6: detected here rather than silently accepted, so the player is told.
  if (recipe.inCycle) return reject(`recipe "${recipeId}" is inside a recipe cycle`);
  if (recipe.def.unlockTier > state.tier) {
    return reject(`recipe "${recipeId}" unlocks at tier ${recipe.def.unlockTier}`);
  }

  return accept({ ...state, activeRecipe: { ...state.activeRecipe, [itemId]: recipeId } }, [
    { kind: "recipeSelected", itemId, recipeId },
  ]);
}
