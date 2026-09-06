// Spec C.5 and D4. Three tiers, four orders, and they are deliberately not
// symmetric:
//
//   production overflow -> stored -> quantum -> BACKPRESSURE   (never creates bound)
//   dismantle refund    -> quantum (to cap) -> bound (uncapped)
//   spend on builds     -> bound -> quantum -> stored          (liquid preserved)
//   spend on delivery,  -> stored -> quantum                   (bound untouchable)
//     contracts, sink
//
// The asymmetry is the whole mechanism. Dismantling ignores the QS cap so materials
// are never destroyed, but the bulge above the cap stays bound as machine matter --
// re-instantiable, never decoherable back into spendable stock. Without that rule a
// player buys 200 machines under the cap, dismantles them all, banks 4.1B plate in
// Quantum Storage, and delivers it: storage caps stop gating milestones, contracts
// and the sink entirely. A full-stack refund is the geometric sum base*(r^n-1)/(r-1),
// roughly 10x the marginal cost of the next machine at r = 1.09.
import { DECIMAL_ZERO, type Dec } from "../numbers/decimal.js";
import type { ItemId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import type { WorldState } from "../state/world.js";
import { capAtLevel } from "./curves.js";

/** Spec C.2's three item states. */
export type ItemStateTag = "EMPTY" | "FLOWING" | "FULL";

// `stored`, `quantum`, `bound`, `storageLevel` and `qsLevel` are all
// Record<ItemId | LaneId, T> keyed by an author-supplied content id, and this
// fixture bundle has a machine class named "constructor" -- so an item or lane
// named similarly is not implausible in principle, and other content bundles are
// free to author one. Plain `record[key] ?? fallback` on an object with no own
// such property resolves through the prototype chain (e.g. to
// Object.prototype.constructor) instead of hitting the fallback, silently turning
// a missing entry into NaN arithmetic downstream. Object.hasOwn distinguishes "own
// property, possibly falsy/zero" from "no own property at all", mirroring
// ownOrUndefined in state/world.ts and assignmentOf in economy/capacity.ts.
function decOf(record: Record<string, Dec>, key: string): Dec {
  return Object.hasOwn(record, key) ? record[key]! : DECIMAL_ZERO;
}

function numOf(record: Record<string, number>, key: string): number {
  return Object.hasOwn(record, key) ? record[key]! : 0;
}

export function storageCap(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): Dec {
  const item = content.items.get(itemId);
  if (!item) return DECIMAL_ZERO;
  return capAtLevel(item.baseStorageCap, content.bundle.storage, numOf(state.storageLevel, itemId));
}

/** Spec B.4: Quantum Storage is purchased per lane, so one level lifts every item. */
export function quantumCap(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): Dec {
  const item = content.items.get(itemId);
  if (!item) return DECIMAL_ZERO;
  return capAtLevel(
    item.baseQuantumCap,
    content.bundle.quantumStorage,
    numOf(state.qsLevel, item.lane),
  );
}

/** Spendable-on-anything stock. `bound` is deliberately excluded. */
export function liquid(state: WorldState, itemId: ItemId): Dec {
  return decOf(state.stored, itemId).plus(decOf(state.quantum, itemId));
}

export function liquidCap(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): Dec {
  return storageCap(content, state, itemId).plus(quantumCap(content, state, itemId));
}

/**
 * Spec C.2. FULL means storage AND Quantum Storage are both at cap; because the fill
 * order always tops up `stored` before `quantum` takes anything, `liquid >= liquidCap`
 * expresses exactly that.
 */
export function itemStateTag(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): ItemStateTag {
  const have = liquid(state, itemId);
  if (have.lte(0)) return "EMPTY";
  if (have.gte(liquidCap(content, state, itemId))) return "FULL";
  return "FLOWING";
}

function withItem(
  state: WorldState,
  field: "stored" | "quantum" | "bound",
  itemId: ItemId,
  value: Dec,
): WorldState {
  return { ...state, [field]: { ...state[field], [itemId]: value } };
}

/** Spec C.5: stored -> quantum -> backpressure. `overflow` is what did not fit. */
export function depositProduction(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
  amount: Dec,
): { state: WorldState; overflow: Dec } {
  if (amount.lte(0)) return { state, overflow: DECIMAL_ZERO };
  let remaining = amount;
  let next = state;

  const storedRoom = storageCap(content, next, itemId).minus(decOf(next.stored, itemId));
  if (storedRoom.gt(0)) {
    const take = remaining.lt(storedRoom) ? remaining : storedRoom;
    next = withItem(next, "stored", itemId, decOf(next.stored, itemId).plus(take));
    remaining = remaining.minus(take);
  }

  const quantumRoom = quantumCap(content, next, itemId).minus(decOf(next.quantum, itemId));
  if (remaining.gt(0) && quantumRoom.gt(0)) {
    const take = remaining.lt(quantumRoom) ? remaining : quantumRoom;
    next = withItem(next, "quantum", itemId, decOf(next.quantum, itemId).plus(take));
    remaining = remaining.minus(take);
  }

  // Anything left is backpressure. It is never turned into bound: bound exists only
  // as the residue of a dismantle (spec D4).
  return { state: next, overflow: remaining.gt(0) ? remaining : DECIMAL_ZERO };
}

/** Ordinary consumption: stored -> quantum, mirroring the deposit order. */
export function drainLiquid(
  state: WorldState,
  itemId: ItemId,
  amount: Dec,
): { state: WorldState; shortfall: Dec } {
  if (amount.lte(0)) return { state, shortfall: DECIMAL_ZERO };
  let remaining = amount;
  let next = state;

  for (const field of ["stored", "quantum"] as const) {
    const have = decOf(next[field], itemId);
    if (have.lte(0)) continue;
    const take = remaining.lt(have) ? remaining : have;
    next = withItem(next, field, itemId, have.minus(take));
    remaining = remaining.minus(take);
    if (remaining.lte(0)) break;
  }
  return { state: next, shortfall: remaining.gt(0) ? remaining : DECIMAL_ZERO };
}

/** Spec C.5 and D4: a refund fills Quantum Storage to its cap, then binds the rest. */
export function depositRefund(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
  amount: Dec,
): WorldState {
  if (amount.lte(0)) return state;
  let remaining = amount;
  let next = state;

  const room = quantumCap(content, next, itemId).minus(decOf(next.quantum, itemId));
  if (room.gt(0)) {
    const take = remaining.lt(room) ? remaining : room;
    next = withItem(next, "quantum", itemId, decOf(next.quantum, itemId).plus(take));
    remaining = remaining.minus(take);
  }
  if (remaining.gt(0)) {
    next = withItem(next, "bound", itemId, decOf(next.bound, itemId).plus(remaining));
  }
  return next;
}

/**
 * Spec D4: "whenever quantum < cap && bound > 0, bound flows down automatically".
 * Idempotent by construction, which resolve's split-invariance in Task 11 depends on.
 */
export function settleBound(content: IndexedContent, state: WorldState): WorldState {
  let next = state;
  for (const itemId of content.stockItemIds) {
    const bound = decOf(next.bound, itemId);
    if (bound.lte(0)) continue;
    const room = quantumCap(content, next, itemId).minus(decOf(next.quantum, itemId));
    if (room.lte(0)) continue;
    const move = bound.lt(room) ? bound : room;
    next = withItem(next, "quantum", itemId, decOf(next.quantum, itemId).plus(move));
    next = withItem(next, "bound", itemId, bound.minus(move));
  }
  return next;
}

function totalFor(state: WorldState, itemId: ItemId, includeBound: boolean): Dec {
  const base = liquid(state, itemId);
  return includeBound ? base.plus(decOf(state.bound, itemId)) : base;
}

export function canAffordBuild(state: WorldState, costs: ReadonlyMap<ItemId, Dec>): boolean {
  for (const [itemId, amount] of costs) {
    if (totalFor(state, itemId, true).lt(amount)) return false;
  }
  return true;
}

export function canAffordLiquid(state: WorldState, costs: ReadonlyMap<ItemId, Dec>): boolean {
  for (const [itemId, amount] of costs) {
    if (totalFor(state, itemId, false).lt(amount)) return false;
  }
  return true;
}

/**
 * break_infinity's Decimal keeps ~14-15 significant mantissa digits and
 * renormalizes on every op (spec A.4 zone 3's price for 1e600-scale numbers).
 * canAffordLiquid/canAffordBuild sum a whole item's stock with one `.plus()`
 * and compare once; spendInOrder instead walks stored -> quantum -> bound,
 * subtracting from each field in turn. The two routes can renormalize
 * differently: an item whose combined `stored + quantum` displays as exactly
 * the cost -- so canAffordLiquid says yes -- can still, when the fields are
 * drained one at a time, fall a few ULPs short of that same cost. That is
 * exactly what happened at the milestone knife-edge (spec E.6): the two
 * resolve() split points integrated `quantum` via different intermediate
 * anchors, one landing on a clean 771.2, the other on 771.199999999995. Left
 * unhandled, spendInOrder's own affordability re-derivation (below) disagreed
 * with the caller's, and one path silently declined a spend the other made --
 * a discrete fork, not float noise. Anything within this fraction of the
 * requested amount is that renormalization gap; anything past it is a real
 * bug and still fails loudly.
 */
export const SPEND_RESIDUAL_TOLERANCE = 1e-9;

function spendInOrder(
  content: IndexedContent,
  state: WorldState,
  costs: ReadonlyMap<ItemId, Dec>,
  order: readonly ("stored" | "quantum" | "bound")[],
  affordable: boolean,
): WorldState | null {
  if (!affordable) return null;
  let next = state;
  for (const [itemId, amount] of costs) {
    let remaining = amount;
    for (const field of order) {
      if (remaining.lte(0)) break;
      const have = decOf(next[field], itemId);
      if (have.lte(0)) continue;
      const take = remaining.lt(have) ? remaining : have;
      next = withItem(next, field, itemId, have.minus(take));
      remaining = remaining.minus(take);
    }
    // Guarded by the affordability check above. A residue here is normally
    // impossible -- unless it's SPEND_RESIDUAL_TOLERANCE's renormalization gap
    // (see that constant's comment), which every field in `order` has already
    // been drained toward zero trying to close. Anything bigger is a genuine
    // bug in the Decimal comparison, so still fail loudly rather than
    // silently giving the cost away.
    if (remaining.gt(amount.abs().times(SPEND_RESIDUAL_TOLERANCE))) return null;
  }
  return settleBound(content, next);
}

/** Spec C.5: builds spend the restricted resource first, preserving liquid stock. */
export function spendForBuild(
  content: IndexedContent,
  state: WorldState,
  costs: ReadonlyMap<ItemId, Dec>,
): WorldState | null {
  return spendInOrder(content, state, costs, ["bound", "quantum", "stored"], canAffordBuild(state, costs));
}

/**
 * Spec C.5: deliveries, contracts and the sink spend liquid only. Ruling R7's
 * milestone delivery calls this, and Spec 2's contracts will call the same function.
 */
export function spendFromLiquid(
  content: IndexedContent,
  state: WorldState,
  costs: ReadonlyMap<ItemId, Dec>,
): WorldState | null {
  return spendInOrder(content, state, costs, ["stored", "quantum"], canAffordLiquid(state, costs));
}
