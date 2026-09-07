// Spec C.7. The only time function in the engine.
//
// The property that matters most (spec E.6) is
//     resolve(s, 2t) === resolve(resolve(s, t), t)
// because offline and online resolution cannot disagree if it holds. Four rules
// make it true:
//
//  1. Applying an event never stores a mode flag. A fill is only "the stockpile is
//     now at cap"; the next solve re-derives FULL from the state. A stored flag
//     would cross a split in one path and be re-derived in the other.
//  2. settle() is idempotent and runs at the head of EVERY iteration, including the
//     first and the one that breaks the loop. A milestone completing exactly at the
//     split instant is therefore applied once, in either arrangement.
//  3. Timers carry absolute fire times on the same clock as lastResolvedAt, and the
//     loop tracks an explicit cursor from state.lastResolvedAt.
//  4. lastResolvedAt advances by the full elapsedMs. The offline cap limits
//     simulation, not the clock.
//
// The property genuinely fails when 2t exceeds offlineCapMs, because the cap is per
// call; the property test stays well under it.
import { D, DECIMAL_ZERO, toCanonical, type Dec } from "../numbers/decimal.js";
import type { ItemId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import {
  canAffordLiquid,
  depositProduction,
  drainLiquid,
  itemStateTag,
  liquid,
  liquidCap,
  settleBound,
  spendFromLiquid,
} from "../economy/storage.js";
import type { WorldState } from "../state/world.js";
import { solve, type Solution } from "../solve/solve.js";

/** Spec C.7 and D.5: bounds the cost of one resolve, so it cannot be a DoS vector. */
export const MAX_EVENTS = 10_000;
/** Spec C.7: stops Zeno subdivision. One nanosecond. */
export const EPSILON_MS = 1e-6;
/** The fixed step the loop falls back to once MAX_EVENTS is spent. */
export const COARSE_STEP_MS = 60_000;

export type ResolveEventKind = "fill" | "drain" | "timer" | "milestone" | "guard";

export interface ResolveEvent {
  kind: ResolveEventKind;
  atMs: number;
  itemId?: ItemId;
  tier?: number;
  timerId?: string;
}

export interface ResolveSummary {
  elapsedMs: number;
  simulatedMs: number;
  skippedMs: number;
  /** Lifetime totals after the window, as canonical strings. */
  produced: Record<ItemId, string>;
  filled: { itemId: ItemId; atMs: number }[];
  /** Items sitting empty with nothing arriving. Spec C.7's "what stalled". */
  stalled: ItemId[];
  tiersUnlocked: number[];
  events: number;
  guardTripped: boolean;
}

export interface ResolveResult {
  state: WorldState;
  events: ResolveEvent[];
  summary: ResolveSummary;
}

// `stored`, `quantum`, `bound`, `lifetime` and `produced` are all
// Record<ItemId, T> keyed by an author-supplied content id, and this fixture
// bundle has a machine class named "constructor" -- so an item id colliding with an
// Object.prototype member is not implausible in principle. Plain `record[key]` on an
// object with no own such property resolves through the prototype chain instead of
// hitting undefined, and plain `record[key] = value` on an existing object goes
// through [[Set]], which for key === "__proto__" reassigns the object's prototype
// instead of creating an own property. Object.hasOwn distinguishes "own property,
// possibly falsy" from "no own property at all" for reads; Object.fromEntries
// builds every new record below via CreateDataPropertyOrThrow, which is safe for
// any key. This mirrors decOf/withItem in economy/storage.ts.
function decOf(record: Record<string, Dec>, key: string): Dec {
  return Object.hasOwn(record, key) ? record[key]! : DECIMAL_ZERO;
}

/** The next tier's delivery requirement, or null when there is no next tier. */
export function nextMilestoneCost(
  content: IndexedContent,
  state: WorldState,
): Map<ItemId, Dec> | null {
  const milestone = content.milestoneByTier.get(state.tier + 1);
  if (!milestone) return null;
  const costs = new Map<ItemId, Dec>();
  for (const requirement of milestone.requires) {
    costs.set(requirement.item, (costs.get(requirement.item) ?? DECIMAL_ZERO).plus(D(requirement.amount)));
  }
  return costs;
}

/** Floating-point residue only: every producer here already clamps at zero. */
function clampNonNegative(state: WorldState, content: IndexedContent): WorldState {
  let next = state;
  for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
    let needsClamp = false;
    for (const itemId of content.stockItemIds) {
      if (decOf(next[field], itemId).lt(0)) {
        needsClamp = true;
        break;
      }
    }
    if (!needsClamp) continue;
    const bucket: Record<ItemId, Dec> = Object.fromEntries(
      content.stockItemIds.map((itemId): [ItemId, Dec] => {
        const value = decOf(next[field], itemId);
        return [itemId, value.lt(0) ? DECIMAL_ZERO : value];
      }),
    );
    next = { ...next, [field]: bucket };
  }
  return next;
}

/**
 * Idempotent state normalization: bound flows down as room opens (spec D4), values
 * are clamped, and every milestone whose requirement is met is delivered out of
 * liquid stock (ruling R7). Called at the head of every loop iteration, which is
 * what makes a split at a milestone instant safe.
 */
export function settle(
  content: IndexedContent,
  state: WorldState,
  nowMs: number,
  events: ResolveEvent[],
): WorldState {
  let next = clampNonNegative(settleBound(content, state), content);

  for (;;) {
    const costs = nextMilestoneCost(content, next);
    if (costs === null) break;
    if (!canAffordLiquid(next, costs)) break;
    const spent = spendFromLiquid(content, next, costs);
    if (spent === null) break;
    next = { ...spent, tier: next.tier + 1 };
    events.push({ kind: "milestone", atMs: nowMs, tier: next.tier });
  }
  return next;
}

function fireDueTimers(
  state: WorldState,
  cursorMs: number,
  events: ResolveEvent[],
): WorldState {
  const due = state.timers.filter((timer) => timer.fireAt <= cursorMs);
  if (due.length === 0) return state;

  // Spec A.5's canonical event ordering: by time, ties broken by a stable id.
  const ordered = [...due].sort((a, b) =>
    a.fireAt === b.fireAt ? (a.id < b.id ? -1 : 1) : a.fireAt - b.fireAt,
  );

  let next = state;
  for (const timer of ordered) {
    if (timer.kind === "tapExpiry") next = { ...next, tapStacks: 0 };
    events.push({ kind: "timer", atMs: timer.fireAt, timerId: timer.id });
  }
  return { ...next, timers: next.timers.filter((timer) => timer.fireAt > cursorMs) };
}

// "unpin" is internal only -- it never reaches ResolveEvent/events[]. Spec C.3's
// requirement walk recurses through an input only while that input is pinned EMPTY
// (liquid <= 0); the instant an EMPTY item's liquid goes positive it stops being
// EMPTY, and solve()'s output can jump (e.g. a recipe that was contested through a
// pinned downstream item becomes uncontested, dropping the reserve-floor tax).
// That is a real discontinuity in solve()'s rate function even though spec C.7's
// illustrative list only names "hits zero", so it must be caught the same way a
// fill or drain is -- otherwise a solve() snapshot taken while an item is pinned
// gets integrated straight through the instant that pin stops being true, and
// resolve(s, 2t) silently disagrees with resolve(resolve(s, t), t) whenever t lands
// after that instant. Scheduled at EPSILON_MS (as close to "now" as the guard
// allows) rather than 0 so it never wins a tie against a same-instant fill/drain/
// timer/milestone by sorting first for free.
type InternalEventKind = ResolveEventKind | "unpin";

interface NextEvent {
  dtMs: number;
  kind: InternalEventKind | null;
  itemId?: ItemId;
}

function nextDiscontinuity(
  content: IndexedContent,
  state: WorldState,
  solution: Solution,
  cursorMs: number,
): NextEvent {
  let best: NextEvent = { dtMs: Number.POSITIVE_INFINITY, kind: null };
  const consider = (dtMs: number, kind: InternalEventKind, itemId?: ItemId): void => {
    if (dtMs > 0 && dtMs < best.dtMs) best = { dtMs, kind, itemId };
  };

  for (const itemId of content.stockItemIds) {
    const net = solution.itemRates.get(itemId)?.net ?? 0;
    if (!Number.isFinite(net) || net === 0) continue;
    const have = liquid(state, itemId);
    if (net > 0) {
      if (have.lte(0)) {
        // Leaves EMPTY at essentially this instant: re-solve before integrating any
        // further so the next segment sees the correct (unpinned) rate.
        consider(EPSILON_MS, "unpin", itemId);
        continue;
      }
      const room = liquidCap(content, state, itemId).minus(have);
      if (room.gt(0)) consider(room.div(net).toNumber() * 1000, "fill", itemId);
    } else if (have.gt(0)) {
      consider(have.div(-net).toNumber() * 1000, "drain", itemId);
    }
  }

  for (const timer of state.timers) consider(timer.fireAt - cursorMs, "timer");

  // Ruling R7: the milestone completes when every required item has been banked, so
  // its time is the max over requirements, and it never arrives if any is falling.
  const costs = nextMilestoneCost(content, state);
  if (costs !== null) {
    let worst = 0;
    let reachable = true;
    for (const [itemId, needed] of costs) {
      const have = liquid(state, itemId);
      if (have.gte(needed)) continue;
      const net = solution.itemRates.get(itemId)?.net ?? 0;
      if (net <= 0) {
        reachable = false;
        break;
      }
      worst = Math.max(worst, needed.minus(have).div(net).toNumber() * 1000);
    }
    if (reachable && worst > 0) consider(worst, "milestone");
  }

  return best;
}

function integrate(
  content: IndexedContent,
  state: WorldState,
  solution: Solution,
  dtMs: number,
): WorldState {
  const seconds = dtMs / 1000;
  let next = state;
  const lifetime: Record<ItemId, Dec> = Object.fromEntries(
    content.stockItemIds.map((itemId): [ItemId, Dec] => {
      const flow = solution.itemRates.get(itemId);
      const bump = flow && flow.production > 0 ? D(flow.production * seconds) : DECIMAL_ZERO;
      return [itemId, decOf(next.lifetime, itemId).plus(bump)];
    }),
  );

  for (const itemId of content.stockItemIds) {
    const flow = solution.itemRates.get(itemId);
    if (!flow) continue;

    if (flow.net > 0) {
      // Overflow should be zero: the solver already throttled producers of a FULL
      // item. Anything left is backpressure and is deliberately not banked.
      next = depositProduction(content, next, itemId, D(flow.net * seconds)).state;
    } else if (flow.net < 0) {
      next = drainLiquid(next, itemId, D(-flow.net * seconds)).state;
    }
  }
  return { ...next, lifetime };
}

export function resolve(
  state: WorldState,
  content: IndexedContent,
  elapsedMs: number,
): ResolveResult {
  const events: ResolveEvent[] = [];
  const elapsed = Math.max(0, elapsedMs);
  const simulated = Math.min(elapsed, content.offlineCapMs);
  const skipped = elapsed - simulated;

  // Time past the cap is not simulated, but it did pass: start the cursor after it
  // and retire anything that expired in the gap.
  let cursor = state.lastResolvedAt + skipped;
  let current = fireDueTimers(state, cursor, events);

  const startingTier = current.tier;
  const startingLifetime = current.lifetime;
  const filled: { itemId: ItemId; atMs: number }[] = [];

  let remaining = simulated;
  let steps = 0;
  let guardTripped = false;
  const hardStop = MAX_EVENTS + Math.ceil(content.offlineCapMs / COARSE_STEP_MS) + 2;

  for (;;) {
    current = settle(content, current, cursor, events);
    if (remaining <= 0 || steps >= hardStop) break;

    const coarse = steps >= MAX_EVENTS;
    if (coarse && !guardTripped) {
      guardTripped = true;
      events.push({ kind: "guard", atMs: cursor });
    }
    steps += 1;

    const solution = solve(current, content);
    let dtMs: number;
    let fired: NextEvent | null = null;
    if (coarse) {
      dtMs = Math.min(remaining, COARSE_STEP_MS);
    } else {
      fired = nextDiscontinuity(content, current, solution, cursor);
      dtMs = Math.min(remaining, fired.dtMs);
      if (!(dtMs > EPSILON_MS)) dtMs = EPSILON_MS;
      dtMs = Math.min(dtMs, remaining);
    }

    current = integrate(content, current, solution, dtMs);
    cursor += dtMs;
    remaining -= dtMs;

    if (fired !== null && fired.kind !== null && fired.dtMs <= dtMs + EPSILON_MS) {
      if (fired.kind === "fill" && fired.itemId !== undefined) {
        events.push({ kind: "fill", atMs: cursor, itemId: fired.itemId });
        filled.push({ itemId: fired.itemId, atMs: cursor });
      } else if (fired.kind === "drain" && fired.itemId !== undefined) {
        events.push({ kind: "drain", atMs: cursor, itemId: fired.itemId });
      }
    }

    current = fireDueTimers(current, cursor, events);
  }

  // What was produced during THIS window, which is what the "while you were away"
  // report means -- not the lifetime total.
  const produced: Record<ItemId, string> = Object.fromEntries(
    content.stockItemIds.map((itemId): [ItemId, string] => {
      const before = decOf(startingLifetime, itemId);
      const after = decOf(current.lifetime, itemId);
      return [itemId, toCanonical(after.minus(before))];
    }),
  );

  const finalSolution = solve(current, content);
  const stalled: ItemId[] = [];
  for (const itemId of content.stockItemIds) {
    if (itemStateTag(content, current, itemId) !== "EMPTY") continue;
    if ((content.consumersOf.get(itemId) ?? []).length === 0) continue;
    if ((finalSolution.itemRates.get(itemId)?.production ?? 0) > 0) continue;
    stalled.push(itemId);
  }

  const tiersUnlocked: number[] = [];
  for (let tier = startingTier + 1; tier <= current.tier; tier += 1) tiersUnlocked.push(tier);

  return {
    state: { ...current, lastResolvedAt: state.lastResolvedAt + elapsed },
    events,
    summary: {
      elapsedMs: elapsed,
      simulatedMs: simulated,
      skippedMs: skipped,
      produced,
      filled,
      stalled,
      tiersUnlocked,
      events: events.length,
      guardTripped,
    },
  };
}
