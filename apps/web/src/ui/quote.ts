// What a spend costs and refunds, exactly as the five spend reducers compute it (Q-3), and
// whether the shown stock covers it (W-13). Pure; affordability is the one function the 4 Hz
// text tick re-reads.
import {
  DECIMAL_ZERO,
  getMark,
  installedAt,
  isLiveRecipe,
  levelCostRange,
  liquid,
  liquidCap,
  machineCostRange,
  MAX_ACTION_COUNT,
  SPEND_RESIDUAL_TOLERANCE,
  type Action,
  type Dec,
  type IndexedContent,
  type ItemId,
  type LaneId,
  type MachineClassId,
  type WorldState,
} from "@manufactory/engine";
import { shownStock } from "../sync/interpolate.js";
import { plateauAtMs, type Snapshot } from "../sync/snapshot.js";

export type SpendAction = Extract<
  Action,
  { type: "BUY_MACHINE" | "UPGRADE_MARK" | "DISMANTLE" | "BUY_STORAGE" | "BUY_QS" }
>;

export interface Quote {
  cost: Map<ItemId, Dec>;
  refund: Map<ItemId, Dec>;
}

const SPEND_TYPES: ReadonlySet<Action["type"]> = new Set([
  "BUY_MACHINE",
  "UPGRADE_MARK",
  "DISMANTLE",
  "BUY_STORAGE",
  "BUY_QS",
]);

export function isSpend(a: Action): a is SpendAction {
  return SPEND_TYPES.has(a.type);
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The reducers' validCount (actions/machines.ts). */
function validCount(count: number): boolean {
  return Number.isInteger(count) && count > 0 && count <= MAX_ACTION_COUNT;
}

const none = (): Quote => ({ cost: new Map(), refund: new Map() });

function levelQuote(
  curve: IndexedContent["bundle"]["storage"],
  level: number,
  levels: number,
): Quote {
  if (!Number.isInteger(levels) || levels <= 0 || level + levels > curve.maxLevel) return none();
  return { cost: levelCostRange(curve, level, levels), refund: new Map() };
}

/** Exactly the reducer's spent/refunded amounts; empty maps for settings and TAP (Q-3). Never
 * throws: an action the reducer would reject (unknown mark, count 0) gets empty maps. */
export function quote(content: IndexedContent, state: WorldState, action: Action): Quote {
  switch (action.type) {
    case "BUY_MACHINE": {
      const { lane, machineClass, mark, count } = action;
      const def = getMark(content, machineClass, mark);
      if (!def || !content.lanes.has(lane) || !validCount(count)) return none();
      if (def.unlockTier > state.tier) return none();
      if (action.recipeId !== undefined) {
        const recipe = content.recipes.get(action.recipeId);
        if (
          !recipe ||
          recipe.lane !== lane ||
          recipe.machineClass !== machineClass ||
          !isLiveRecipe(content, action.recipeId, state.tier, state.activeRecipe)
        ) {
          return none();
        }
      }
      const owned = installedAt(state, lane, machineClass, mark);
      return { cost: machineCostRange(content, machineClass, mark, owned, count), refund: new Map() };
    }
    case "DISMANTLE": {
      const { lane, machineClass, mark, count } = action;
      if (!getMark(content, machineClass, mark) || !validCount(count)) return none();
      const owned = installedAt(state, lane, machineClass, mark);
      if (count > owned) return none();
      return {
        cost: new Map(),
        refund: machineCostRange(content, machineClass, mark, owned - count, count),
      };
    }
    case "UPGRADE_MARK": {
      const { lane, machineClass, fromMark } = action;
      const from = getMark(content, machineClass, fromMark);
      const to = getMark(content, machineClass, fromMark + 1);
      if (!from || !to || to.unlockTier > state.tier) return none();
      const owned = installedAt(state, lane, machineClass, fromMark);
      if (owned <= 0) return none();
      const equivalent = Math.floor((owned * from.rateMultiplier) / to.rateMultiplier);
      if (equivalent < 1) return none();
      const ownedHigher = installedAt(state, lane, machineClass, to.mark);
      return {
        cost: machineCostRange(content, machineClass, to.mark, ownedHigher, equivalent),
        refund: machineCostRange(content, machineClass, fromMark, 0, owned),
      };
    }
    case "BUY_STORAGE":
      if (!content.items.has(action.itemId)) return none();
      return levelQuote(
        content.bundle.storage,
        own(state.storageLevel, action.itemId) ?? 0,
        action.levels,
      );
    case "BUY_QS":
      if (!content.lanes.has(action.lane)) return none();
      return levelQuote(
        content.bundle.quantumStorage,
        own(state.qsLevel, action.lane) ?? 0,
        action.levels,
      );
    default:
      return none();
  }
}

/** Q-1: per cost item, max(0, cost − liquid − bound − refund). Only positive credits appear.
 * This is the shortfall the UI reports; creditedState is what the preview applies. */
export function creditFor(state: WorldState, q: Quote): Map<ItemId, Dec> {
  const out = new Map<ItemId, Dec>();
  for (const [itemId, cost] of q.cost) {
    const bound = own(state.bound, itemId) ?? DECIMAL_ZERO;
    const refund = q.refund.get(itemId) ?? DECIMAL_ZERO;
    const have = liquid(state, itemId).plus(bound).plus(refund);
    // The reducer's own gate is an exact compare. cost − have can round to 0 when have is a
    // hair under cost (Decimal keeps ~15 digits), and that item is still short, by 0.
    if (cost.gt(have)) out.set(itemId, cost.minus(have));
  }
  return out;
}

function setField(
  state: WorldState,
  field: "stored" | "quantum" | "bound",
  itemId: ItemId,
  value: Dec,
): WorldState {
  return {
    ...state,
    [field]: Object.fromEntries([...Object.entries(state[field]), [itemId, value]]),
  };
}

/**
 * The state the preview applies (Q-1): the purchase at the moment it becomes affordable,
 * which drains each short item to exactly zero. A short item with no refund in that item
 * gets stored = quantum = 0 and bound = cost, so the reducer's gate sums to exactly the
 * cost and its spend leaves exactly 0 (EMPTY, as the real buy would). Adding the shortfall
 * to bound instead rounds: Decimal keeps ~15 digits, so liquid + (bound + short) can land a
 * few ULPs under the cost, and any bump past it leaves a residue that reads FLOWING.
 *
 * A short item that the action also refunds (UPGRADE_MARK) can't be zeroed, because the
 * refund lands first. It falls back to adding the shortfall to bound, raised by the smallest
 * doubling relative step that covers the cost. It throws if no step within
 * SPEND_RESIDUAL_TOLERANCE does.
 */
export function creditedState(state: WorldState, q: Quote): WorldState {
  let next = state;
  for (const [itemId, short] of creditFor(state, q)) {
    const cost = q.cost.get(itemId)!;
    const refund = q.refund.get(itemId) ?? DECIMAL_ZERO;
    if (refund.lte(DECIMAL_ZERO)) {
      next = setField(next, "stored", itemId, DECIMAL_ZERO);
      next = setField(next, "quantum", itemId, DECIMAL_ZERO);
      next = setField(next, "bound", itemId, cost);
      continue;
    }
    const bound = own(state.bound, itemId) ?? DECIMAL_ZERO;
    const covers = (credit: Dec) =>
      liquid(state, itemId).plus(bound.plus(credit)).plus(refund).gte(cost);
    let credit = short;
    for (let step = 1e-15; !covers(credit); step *= 2) {
      if (step > SPEND_RESIDUAL_TOLERANCE) {
        throw new Error(`creditedState: no credit covers the cost of "${itemId}"`);
      }
      credit = short.plus(cost.times(step));
    }
    next = setField(next, "bound", itemId, bound.plus(credit));
  }
  return next;
}

export type Affordability =
  | { affordable: true }
  /** inMs null: not reachable on current rates. */
  | { affordable: false; inMs: number | null };

/** display.state with stored = shownStock at serverMs and quantum = 0: what affordability reads
 * (S-18), so its verdict and its countdown are creditFor's own. */
export function stockAt(s: Snapshot, serverMs: number): WorldState {
  const base = s.display.state;
  const stored: Record<ItemId, Dec> = { ...base.stored };
  const quantum: Record<ItemId, Dec> = { ...base.quantum };
  for (const itemId of s.content.stockItemIds) {
    stored[itemId] = shownStock(s, itemId, serverMs);
    quantum[itemId] = DECIMAL_ZERO;
  }
  return { ...base, stored, quantum };
}

/** 4a's affordability, widened to any Action: creditFor over the shown stock at serverMs (the
 * 4 Hz tick) says what is short; the line stops at the cap and at the plateau (W-13, P-3,
 * P-4). */
export function affordability(s: Snapshot, action: Action, serverMs: number): Affordability {
  const q = quote(s.content, s.state, action);
  const credit = creditFor(stockAt(s, serverMs), q);
  if (credit.size === 0) return { affordable: true };
  let inMs: number | null = 0;
  for (const [itemId, short] of credit) {
    const net = s.schedule.items[itemId]?.netPerSecond ?? 0;
    const extra = (own(s.state.bound, itemId) ?? DECIMAL_ZERO).plus(
      q.refund.get(itemId) ?? DECIMAL_ZERO,
    );
    // Past the cap or the plateau the wait never ends.
    if (net <= 0 || q.cost.get(itemId)!.minus(extra).gt(liquidCap(s.content, s.state, itemId))) {
      inMs = null;
      break;
    }
    inMs = Math.max(inMs, (short.toNumber() / net) * 1000);
  }
  if (inMs !== null && serverMs + inMs > plateauAtMs(s)) inMs = null;
  return { affordable: false, inMs };
}

/** The largest count in 0..MAX_ACTION_COUNT affordable at serverMs (a binary search; the
 * cost rises with the count). 0 for an unknown mark. */
export function maxAffordableCount(
  s: Snapshot,
  lane: LaneId,
  machineClass: MachineClassId,
  mark: number,
  serverMs: number,
): number {
  if (!getMark(s.content, machineClass, mark)) return 0;
  const owned = installedAt(s.state, lane, machineClass, mark);
  const fits = (count: number): boolean => {
    for (const [itemId, need] of machineCostRange(s.content, machineClass, mark, owned, count)) {
      const bound = own(s.state.bound, itemId) ?? DECIMAL_ZERO;
      if (shownStock(s, itemId, serverMs).plus(bound).lt(need)) return false;
    }
    return true;
  };
  let lo = 0; // fits
  let hi = MAX_ACTION_COUNT + 1; // does not fit
  if (fits(MAX_ACTION_COUNT)) return MAX_ACTION_COUNT;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
