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
import { serializeWorld } from "../state/serialize.js";
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
  /** How many times the solver actually ran. Spec C.7's cost, next to `events`. */
  solves: number;
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
  solution: StepAnswer,
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

/** What the client needs to draw stock as straight lines until the next rate change (D.2). */
export interface Schedule {
  /**
   * World time (ms) the schedule describes: state.lastResolvedAt, or a few EPSILON_MS
   * later when schedule() stepped past an internal unpin.
   */
  atMs: number;
  /** Per stock item: liquid stock now (canonical decimal string) and net rate per second. */
  items: Record<ItemId, { stock: string; netPerSecond: number }>;
  /** World time of the next rate change (fill, drain, timer, milestone; never the internal unpin), or null if none. */
  nextBoundaryAtMs: number | null;
}

/**
 * Pure. Does what `resolve` does at the start of a window: while the next discontinuity
 * is the internal unpin (an item leaving EMPTY), it steps past it with
 * `resolve(state, content, EPSILON_MS)`, because the pinned solve's rates are not the
 * rates the world actually runs at (on the vertical slice a fresh world's iron_ore is
 * 0.98/s pinned and 1.0/s unpinned, and the pinned boundary is ~2x too late). The
 * rates, stock and boundary are then all taken from that advanced state, and `atMs`
 * is its `lastResolvedAt` (at most a few nanoseconds after the input's). Each step
 * clears at least one pin, so the loop runs at most once per stock item.
 *
 * The boundary search is `resolve`'s own, so on the advanced state the reported
 * boundary is the first fill/drain/timer/milestone `resolve` would fire, up to
 * floating-point rounding.
 *
 * Delegates to `scheduleDetail`, which also returns the advanced state and its solve.
 */
export function schedule(state: WorldState, content: IndexedContent): Schedule {
  return scheduleDetail(state, content).schedule;
}

/** `schedule` plus the state it advanced to and the solve its rates came from (W-8). */
export interface ScheduleDetail {
  schedule: Schedule;
  /** The state schedule() advanced past internal unpins; its lastResolvedAt === schedule.atMs. */
  state: WorldState;
  /** solve(state, content) of that advanced state: the rates schedule.items came from. */
  solution: Solution;
}

export function scheduleDetail(state: WorldState, content: IndexedContent): ScheduleDetail {
  let current = state;
  let solution = solve(current, content);
  let next = nextDiscontinuity(content, current, solution, current.lastResolvedAt);
  for (let i = 0; next.kind === "unpin" && i < content.stockItemIds.length; i += 1) {
    current = resolve(current, content, EPSILON_MS).state;
    solution = solve(current, content);
    next = nextDiscontinuity(content, current, solution, current.lastResolvedAt);
  }
  const items: Record<ItemId, { stock: string; netPerSecond: number }> = Object.fromEntries(
    content.stockItemIds.map((itemId) => [
      itemId,
      {
        stock: toCanonical(liquid(current, itemId)),
        netPerSecond: solution.itemRates.get(itemId)?.net ?? 0,
      },
    ]),
  );
  const atMs = current.lastResolvedAt;
  return {
    schedule: {
      atMs,
      items,
      nextBoundaryAtMs: Number.isFinite(next.dtMs) ? atMs + next.dtMs : null,
    },
    state: current,
    solution,
  };
}

function integrate(
  content: IndexedContent,
  state: WorldState,
  solution: StepAnswer,
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

/**
 * What one step of `resolve` reads from the solver: only `itemRates`. Narrowed on purpose:
 * the cache in `resolve` is exact for rates, but not for, e.g., `bottleneck`, which reads
 * exact stock -- so a step must not be able to see it.
 */
export type StepAnswer = Pick<Solution, "itemRates">;
export type StepSolve = (world: WorldState) => StepAnswer;

/**
 * PL-2. A resolve's first MAX_EVENTS fine steps, kept so a later resolve from the same start
 * can resume after them. Treat it as opaque: only `resolve` reads one.
 *
 * Why resuming is exact: up to the guard, the loop reads the window only through
 * `min(remaining, dt)`. A prefix is kept only if none of its steps was clipped by `remaining`
 * (a clipped step leaves `remaining` at exactly 0, ending the loop before the guard). A later
 * window resumes only after `stepSizes` is replayed against it and every step still fits,
 * which is exactly the condition for each `min` to pick the same `dt`, so the loop would have
 * taken the same steps to the same state. `remaining` is re-derived by that same sequence of
 * subtractions, so the coarse phase that follows starts from the bits a cold resolve has.
 */
export interface ResolvePrefix {
  /** `serializeWorld` of the start state: the caller's key only finds an entry; this proves it. */
  readonly start: string;
  /** The cursor the fine steps started from: lastResolvedAt plus the time skipped past the cap. */
  readonly startCursor: number;
  readonly content: IndexedContent;
  /** The state, cursor and output after step MAX_EVENTS, before the next iteration's settle. */
  readonly current: WorldState;
  readonly cursor: number;
  readonly stepSizes: Float64Array;
  readonly events: readonly Readonly<ResolveEvent>[];
  readonly filled: readonly Readonly<{ itemId: ItemId; atMs: number }>[];
  /** `resolve`'s per-call solve cache and miss count at that point, so `summary.solves` matches. */
  readonly answers: ReadonlyMap<string, StepAnswer>;
  readonly solves: number;
}

/** Where `resolve` keeps prefixes. The caller owns it, its keys and its bound (e.g. an LRU). */
export interface PrefixCache {
  get(key: string): ResolvePrefix | undefined;
  set(key: string, prefix: ResolvePrefix): void;
}

export interface ResolveOptions {
  prefixCache?: PrefixCache;
  /**
   * Names the start state, e.g. world id, state version and content checksum. Both this and
   * `prefixCache` are needed for the cache to be used. A wrong key costs only a miss: an entry
   * is resumed only if its start state, start cursor and content are this call's.
   */
  cacheKey?: string;
}

/** What `resolveWith` needs to resume from or keep a prefix; `resolve` supplies it. */
interface PrefixHooks {
  candidate: ResolvePrefix | undefined;
  /** Restores the step solver's own state from the prefix being resumed. */
  resumed(prefix: ResolvePrefix): void;
  /** Hands over a prefix the loop has just completed; the hook adds the solver's state. */
  reached(prefix: Omit<ResolvePrefix, "answers" | "solves">): void;
}

/**
 * Spec C.7. Within one call nothing can be bought, so machines, assignments, priorities,
 * storage levels and active recipes are fixed; what changes is stock, tier (a milestone)
 * and tap stacks (a timer). `solve` reads stock only as `liquid <= 0` and the FULL test,
 * both of which are an item's state tag -- so tier, tap stacks and every stock item's tag
 * decide its answer exactly, and each distinct combination is solved once. That is what
 * keeps a pin/unpin cycle cheap: measured 2026-10-12, the vertical slice's screw cycle
 * cost ~10,000 solves per 120 s resolve, ~20 s, and now costs a handful. If `solve` ever
 * reads anything else that can change mid-resolve, it belongs in this key. `state.reserve`
 * is constant within one resolve (only actions change it), which the key relies on.
 */
export function resolve(
  state: WorldState,
  content: IndexedContent,
  elapsedMs: number,
  opts: ResolveOptions = {},
): ResolveResult {
  let cache = new Map<string, StepAnswer>();
  let solves = 0;
  const { prefixCache, cacheKey } = opts;
  const prefix: PrefixHooks | undefined =
    prefixCache === undefined || cacheKey === undefined
      ? undefined
      : {
          candidate: prefixCache.get(cacheKey),
          resumed(p) {
            cache = new Map(p.answers);
            solves = p.solves;
          },
          reached(p) {
            prefixCache.set(cacheKey, { ...p, answers: new Map(cache), solves });
          },
        };
  const out = resolveWith(
    state,
    content,
    elapsedMs,
    (world) => {
      let key = `${world.tier}|${world.tapStacks}|`;
      for (const itemId of content.stockItemIds) key += `${itemStateTag(content, world, itemId)},`;
      let answer = cache.get(key);
      if (answer === undefined) {
        answer = solve(world, content);
        cache.set(key, answer);
        solves += 1;
      }
      return answer;
    },
    prefix,
  );
  // resolveWith counts every step as a solve; here most of them were cache hits.
  return { ...out, summary: { ...out.summary, solves: solves + 1 } };
}

/**
 * Replays a kept prefix's step sizes against a window of `simulatedMs`: the `remaining` a
 * cold resolve would hold after them, or null if any step would not have been taken whole
 * (the loop would have stopped, or `min(remaining, dt)` would have picked `remaining`).
 */
function replayStepSizes(stepSizes: Float64Array, simulatedMs: number): number | null {
  let remaining = simulatedMs;
  for (const dtMs of stepSizes) {
    if (!(remaining > 0) || remaining < dtMs) return null;
    remaining -= dtMs;
  }
  return remaining;
}

/**
 * `resolve`, with the per-step solver supplied: it runs once per step, uncached.
 * @internal Exported for tests, which compare `resolve` against it. Game code calls `resolve`.
 */
export function resolveWith(
  state: WorldState,
  content: IndexedContent,
  elapsedMs: number,
  solveStep: StepSolve,
  prefix?: PrefixHooks,
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

  // PL-2: resume after a kept prefix when it provably is this call's own, or record one.
  const startCursor = cursor;
  let start: string | null = null;
  let stepSizes: Float64Array | null = null;
  if (prefix !== undefined) {
    start = serializeWorld(state);
    const p = prefix.candidate;
    const resumed =
      p !== undefined && p.content === content && p.startCursor === startCursor && p.start === start
        ? replayStepSizes(p.stepSizes, remaining)
        : null;
    if (p !== undefined && resumed !== null) {
      prefix.resumed(p);
      current = p.current;
      cursor = p.cursor;
      remaining = resumed;
      steps = MAX_EVENTS;
      // Copies, so no caller can reach the kept prefix through what it is handed back.
      events.length = 0;
      for (const event of p.events) events.push({ ...event });
      for (const fill of p.filled) filled.push({ ...fill });
    } else {
      stepSizes = new Float64Array(MAX_EVENTS);
    }
  }

  for (;;) {
    current = settle(content, current, cursor, events);
    if (remaining <= 0 || steps >= hardStop) break;

    const coarse = steps >= MAX_EVENTS;
    if (coarse && !guardTripped) {
      guardTripped = true;
      events.push({ kind: "guard", atMs: cursor });
    }
    steps += 1;

    const solution = solveStep(current);
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

    if (stepSizes !== null) {
      stepSizes[steps - 1] = dtMs;
      // Every step so far was unclipped: a clipped one leaves remaining at exactly 0.
      if (steps === MAX_EVENTS && remaining > 0) {
        prefix!.reached({
          start: start!,
          startCursor,
          content,
          current,
          cursor,
          stepSizes,
          events: events.map((event) => ({ ...event })),
          filled: filled.map((fill) => ({ ...fill })),
        });
        stepSizes = null;
      }
    }
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
      // Every step, plus the final solve below the loop.
      solves: steps + 1,
    },
  };
}
