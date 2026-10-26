// Ruling PL-1 (spec 2026-10-25, Problem 1): the mark the bottleneck advice names.
//
// The best unlocked mark is not always one the player can pay for. On the vertical slice,
// Constructor Mk3 unlocks at tier 5 with make_steel_pipe and is priced only in steel pipe:
// advice to buy a steel-pipe machine at Mk3 can never be paid, and a player who follows
// the advice deadlocks there. Mk2 (iron plate) is the way out. The reporter keeps naming
// the recipe; only the mark it names steps down.
//
// In its own file, not capacity.ts, because it reads the solver's FLOW_TOLERANCE, and
// solve/ already imports capacity.ts.
import type { ItemId, LaneId, MachineClassId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import { D } from "../numbers/decimal.js";
import { installedAt, type WorldState } from "../state/world.js";
import { FLOW_TOLERANCE, type ItemFlow } from "../solve/fixpoint.js";
import { bestUnlockedMark } from "./capacity.js";
import { machineCostRange } from "./curves.js";
import { liquid } from "./storage.js";

/**
 * True when one more machine of `mark` is priced in a dead payer: an item that is short
 * (liquid plus bound below the price; a build spends bound first) and not made at all
 * (production at or under FLOW_TOLERANCE). Waiting pays a short item that is being made;
 * nothing pays a dead one. An item missing from `itemRates` reads as unmade.
 */
function hasDeadPayer(
  content: IndexedContent,
  state: WorldState,
  itemRates: ReadonlyMap<ItemId, ItemFlow>,
  machineClass: MachineClassId,
  lane: LaneId,
  mark: number,
): boolean {
  const owned = installedAt(state, lane, machineClass, mark);
  for (const [itemId, amount] of machineCostRange(content, machineClass, mark, owned, 1)) {
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    if (liquid(state, itemId).plus(bound).gte(amount)) continue;
    if ((itemRates.get(itemId)?.production ?? 0) <= FLOW_TOLERANCE) return true;
  }
  return false;
}

/**
 * The mark to advise for one more `machineClass` machine in `lane`: the best unlocked mark,
 * unless its one-machine price has a dead payer; then the best lower unlocked mark with no
 * dead payer; and if there is none, the best mark after all, so a single-mark class is
 * unchanged. Null only when no mark of the class is unlocked, as for `bestUnlockedMark`.
 */
export function adviceMark(
  content: IndexedContent,
  state: WorldState,
  itemRates: ReadonlyMap<ItemId, ItemFlow>,
  machineClass: MachineClassId,
  lane: LaneId,
): number | null {
  const best = bestUnlockedMark(content, machineClass, state.tier);
  if (best === null) return null;
  if (!hasDeadPayer(content, state, itemRates, machineClass, lane, best)) return best;
  const lower = content.machineClasses
    .get(machineClass)!
    .marks.filter((m) => m.mark < best && m.unlockTier <= state.tier)
    .map((m) => m.mark)
    .sort((a, b) => b - a);
  for (const mark of lower) {
    if (!hasDeadPayer(content, state, itemRates, machineClass, lane, mark)) return mark;
  }
  return best;
}
