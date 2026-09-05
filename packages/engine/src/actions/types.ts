// Spec D.1's action set. Exactly eleven, and this union is the whole of it: the
// engine's reducers are the game logic, and spec A.2 makes the API almost pure
// transport around them. That is what buys spec 16.3's "full action parity in
// sim play" structurally rather than as ongoing maintenance.
import type { Dec } from "../numbers/decimal.js";
import type { ItemId, LaneId, MachineClassId, RecipeId } from "../content/types.js";
import type { PriorityMode, WorldState } from "../state/world.js";

/** Ceiling on any single action's count, so one action cannot be a DoS vector. */
export const MAX_ACTION_COUNT = 1000;

export type Action =
  | { type: "BUY_MACHINE"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number }
  | { type: "DISMANTLE"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number }
  | { type: "UPGRADE_MARK"; lane: LaneId; machineClass: MachineClassId; fromMark: number }
  | { type: "ASSIGN_MACHINES"; recipeId: RecipeId; count: number }
  | { type: "SELECT_RECIPE"; itemId: ItemId; recipeId: RecipeId }
  | { type: "REORDER_PRIORITY"; entries: string[] }
  | {
      type: "SET_PRIORITY_MODE";
      entryId: string;
      mode: PriorityMode;
      share?: number;
      targetRate?: number | null;
      paused?: boolean;
    }
  | { type: "SET_RESERVE"; itemId: ItemId; percent: number }
  | { type: "BUY_STORAGE"; itemId: ItemId; levels: number }
  | { type: "BUY_QS"; lane: LaneId; levels: number }
  | { type: "TAP"; count: number; clientElapsedMs: number };

export type Effect =
  | { kind: "spent"; items: Record<ItemId, string> }
  | { kind: "refunded"; items: Record<ItemId, string> }
  | { kind: "installed"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number }
  | { kind: "removed"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number }
  | { kind: "assigned"; recipeId: RecipeId; count: number }
  | { kind: "recipeSelected"; itemId: ItemId; recipeId: RecipeId }
  | { kind: "priorityChanged"; order: string[] }
  | {
      kind: "entryModeChanged";
      entryId: string;
      mode: PriorityMode;
      share: number;
      targetRate: number | null;
      paused: boolean;
    }
  | { kind: "reserveChanged"; itemId: ItemId; percent: number }
  | { kind: "levelChanged"; scope: "storage" | "quantum"; id: string; level: number }
  | { kind: "tapped"; stacks: number; discarded: number };

export type ApplyResult =
  | { rejected: false; state: WorldState; effects: Effect[] }
  | { rejected: true; reason: string };

export function reject(reason: string): ApplyResult {
  return { rejected: true, reason };
}

export function accept(state: WorldState, effects: Effect[]): ApplyResult {
  return { rejected: false, state, effects };
}

/**
 * Costs travel as canonical Decimal strings so an effect log is replayable.
 *
 * Built via Object.fromEntries rather than `items[itemId] = ...`: itemId is an
 * author-supplied content id, and a plain bracket *assignment* of the literal
 * string "__proto__" on an ordinary object reassigns its prototype instead of
 * creating an own property (Annex B.3.1) -- it would silently vanish from the
 * record. Object.fromEntries builds the object via CreateDataPropertyOrThrow,
 * which has no such special case.
 */
export function costEffect(kind: "spent" | "refunded", costs: ReadonlyMap<ItemId, Dec>): Effect {
  const items = Object.fromEntries(
    [...costs].map(([itemId, amount]) => [itemId, amount.toString()] as const),
  ) as Record<ItemId, string>;
  return kind === "spent" ? { kind: "spent", items } : { kind: "refunded", items };
}
