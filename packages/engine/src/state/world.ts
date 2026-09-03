// Spec C.1's state shape, plus two fields C.1 does not list and the reason for each:
//   tier       -- ruling R7 records milestone progress here.
//   tapStacks  -- spec C.6's step function needs a stack count; its expiry is a
//                 timer, so the two together are the whole tap state.
// powerBank is listed in C.1 and carried here, but stays zero in Phase 1: spec 6.2's
// Power Storage is a purchasable and spec D.1's action set has no way to buy one, so
// it lands with Spec 2.
import { D, DECIMAL_ZERO, type Dec } from "../numbers/decimal.js";
import {
  POWER_ITEM,
  type ItemId,
  type LaneId,
  type MachineClassId,
  type RecipeId,
} from "../content/types.js";
import { laneClassKey, type IndexedContent } from "../graph/index-content.js";
import { makePrng, type PrngState } from "./prng.js";

export const WORLD_SCHEMA_VERSION = 1;
export const POWER_ENTRY_ID = "power";

export type PriorityKind = "power" | "item";
export type PriorityMode = "guaranteed" | "share";

export interface PriorityEntry {
  id: string;
  kind: PriorityKind;
  itemId: ItemId | null;
  mode: PriorityMode;
  /** Weight within the share group. Ignored while mode is "guaranteed". */
  share: number;
  /** Items per second ceiling; null means unbounded. */
  targetRate: number | null;
  paused: boolean;
}

export type TimerKind = "tapExpiry";

export interface Timer {
  id: string;
  kind: TimerKind;
  /** Absolute world time in ms, on the same clock as lastResolvedAt. */
  fireAt: number;
}

export interface WorldState {
  schemaVersion: number;
  contentVersion: string;
  seed: PrngState;
  tier: number;
  /** installed[lane][class][mark - 1]. Spec B.2's single counter. */
  installed: Record<LaneId, Record<MachineClassId, number[]>>;
  assignment: Record<RecipeId, number>;
  activeRecipe: Record<ItemId, RecipeId>;
  stored: Record<ItemId, Dec>;
  quantum: Record<ItemId, Dec>;
  /** Above the QS cap. Spendable on builds only (spec D4). */
  bound: Record<ItemId, Dec>;
  storageLevel: Record<ItemId, number>;
  qsLevel: Record<LaneId, number>;
  reserve: Record<ItemId, number>;
  priority: PriorityEntry[];
  powerBank: Dec;
  tapStacks: number;
  /** Sorted by fireAt, ties broken by id (spec A.5's canonical event ordering). */
  timers: Timer[];
  lifetime: Record<ItemId, Dec>;
  lastResolvedAt: number;
}

// A machine class id can legitimately be "constructor" (this fixture bundle has
// one), and every other property name on Object.prototype is fair game too. Plain
// `record[key] ?? fallback` is wrong for a content-driven key: an absent
// "constructor" property still resolves through the prototype chain to
// Object.prototype.constructor, which is truthy and not iterable, not the intended
// "not present" case. Object.hasOwn distinguishes "own property, possibly falsy"
// from "no own property at all", so every lookup below goes through it.
function ownOrUndefined<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record) return undefined;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function installedAt(
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
  mark: number,
): number {
  const laneBucket = ownOrUndefined(state.installed, lane);
  const marks = ownOrUndefined(laneBucket, machineClass);
  return marks?.[mark - 1] ?? 0;
}

export function installedMachines(
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  const laneBucket = ownOrUndefined(state.installed, lane);
  const marks = ownOrUndefined(laneBucket, machineClass);
  if (!marks) return 0;
  let total = 0;
  for (const count of marks) total += count ?? 0;
  return total;
}

export function withInstalled(
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
  mark: number,
  count: number,
): WorldState {
  const laneBucket = { ...ownOrUndefined(state.installed, lane) };
  const existingMarks = ownOrUndefined(laneBucket, machineClass);
  const marks = existingMarks ? [...existingMarks] : [];
  while (marks.length < mark) marks.push(0);
  marks[mark - 1] = count;
  // Plain `laneBucket[machineClass] = marks` goes through [[Set]], which for
  // machineClass === "__proto__" reassigns the object's prototype instead of
  // creating an own property (unlike the object-literal spreads above and below,
  // which use CreateDataProperty and are proto-safe even for that key).
  // Object.defineProperty always creates a genuine own data property.
  Object.defineProperty(laneBucket, machineClass, {
    value: marks,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return { ...state, installed: { ...state.installed, [lane]: laneBucket } };
}

export function assignedTotal(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  let total = 0;
  for (const recipeId of content.recipesByLaneClass.get(laneClassKey(lane, machineClass)) ?? []) {
    total += ownOrUndefined(state.assignment, recipeId) ?? 0;
  }
  return total;
}

export function initialWorld(content: IndexedContent, seed: number, nowMs: number): WorldState {
  // Object.fromEntries builds properties via CreateDataPropertyOrThrow, so an item
  // id of "__proto__" lands as a genuine own property here -- unlike a loop that
  // assigns into `{}` via bracket notation, which would silently reassign the
  // record's prototype instead of storing the item (see withInstalled above).
  const zeroDec = (id: ItemId): [ItemId, Dec] => [id, DECIMAL_ZERO];
  const zeroNum = (id: ItemId): [ItemId, number] => [id, 0];
  const stored: Record<ItemId, Dec> = Object.fromEntries(content.stockItemIds.map(zeroDec));
  const quantum: Record<ItemId, Dec> = Object.fromEntries(content.stockItemIds.map(zeroDec));
  const bound: Record<ItemId, Dec> = Object.fromEntries(content.stockItemIds.map(zeroDec));
  const lifetime: Record<ItemId, Dec> = Object.fromEntries(content.stockItemIds.map(zeroDec));
  const storageLevel: Record<ItemId, number> = Object.fromEntries(
    content.stockItemIds.map(zeroNum),
  );
  const reserve: Record<ItemId, number> = Object.fromEntries(content.stockItemIds.map(zeroNum));

  const qsLevel: Record<LaneId, number> = Object.fromEntries(
    [...content.lanes.keys()].map((laneId): [LaneId, number] => [laneId, 0]),
  );

  let state: WorldState = {
    schemaVersion: WORLD_SCHEMA_VERSION,
    contentVersion: content.bundle.version,
    seed: makePrng(seed),
    tier: content.bundle.start.tier,
    installed: {},
    assignment: { ...content.bundle.start.assignments },
    activeRecipe: { ...content.defaultActiveRecipe },
    stored,
    quantum,
    bound,
    storageLevel,
    qsLevel,
    reserve,
    // Spec C.4: power sits at position 1 by default. It is an ordinary entry the
    // player may move, so nothing downstream assumes index 0.
    priority: [
      {
        id: POWER_ENTRY_ID,
        kind: "power",
        itemId: POWER_ITEM,
        mode: "guaranteed",
        share: 1,
        targetRate: null,
        paused: false,
      },
      ...content.bundle.start.priority.map((itemId) => ({
        id: `item:${itemId}`,
        kind: "item" as const,
        itemId,
        mode: "guaranteed" as const,
        share: 1,
        targetRate: null,
        paused: false,
      })),
    ],
    powerBank: D(0),
    tapStacks: 0,
    timers: [],
    lifetime,
    lastResolvedAt: nowMs,
  };

  for (const machine of content.bundle.start.machines) {
    state = withInstalled(
      state,
      machine.lane,
      machine.machineClass,
      machine.mark,
      installedAt(state, machine.lane, machine.machineClass, machine.mark) + machine.count,
    );
  }
  return state;
}
