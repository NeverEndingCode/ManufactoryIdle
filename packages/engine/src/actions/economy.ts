// Spec D.1, actions six through eleven.
import type { IndexedContent } from "../graph/index-content.js";
import { levelCostRange } from "../economy/curves.js";
import { spendForBuild } from "../economy/storage.js";
import type { PriorityEntry, Timer, WorldState } from "../state/world.js";
import { accept, costEffect, reject, type Action, type ApplyResult } from "./types.js";

/**
 * Ruling R8: a reserve becomes a synthetic near-top-of-list priority entry, so an
 * uncapped one could starve the whole list. Rejected rather than silently clamped,
 * so the player is told what happened.
 */
export const MAX_RESERVE_PERCENT = 0.5;

/** Spec D.5: maxTaps = elapsedSinceLastFlush / 50ms, clamped server-side. */
export const TAP_MIN_INTERVAL_MS = 50;

/** Spec C.6: every stack shares one expiry, which keeps rates piecewise-constant. */
export const TAP_TIMER_ID = "tap-expiry";

export function applyReorderPriority(
  state: WorldState,
  _content: IndexedContent,
  action: Extract<Action, { type: "REORDER_PRIORITY" }>,
): ApplyResult {
  const requested = action.entries;
  if (requested.length !== state.priority.length) {
    return reject(`expected ${state.priority.length} entries, got ${requested.length}`);
  }

  const byId = new Map(state.priority.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const id of requested) {
    if (!byId.has(id)) return reject(`unknown priority entry "${id}"`);
    if (seen.has(id)) return reject(`duplicate priority entry "${id}"`);
    seen.add(id);
  }

  // Spec F.1: power is movable, with a warning in the UI. The engine allows it, and
  // spec C.4's bottleneck report is what tells the player the consequence.
  const priority = requested.map((id) => byId.get(id)!);
  return accept({ ...state, priority }, [{ kind: "priorityChanged", order: [...requested] }]);
}

export function applySetPriorityMode(
  state: WorldState,
  _content: IndexedContent,
  action: Extract<Action, { type: "SET_PRIORITY_MODE" }>,
): ApplyResult {
  const index = state.priority.findIndex((entry) => entry.id === action.entryId);
  if (index < 0) return reject(`unknown priority entry "${action.entryId}"`);

  const existing = state.priority[index]!;
  const share = action.share ?? existing.share;
  if (action.mode === "share" && !(share > 0)) return reject("share weight must be positive");

  const targetRate = action.targetRate === undefined ? existing.targetRate : action.targetRate;
  if (targetRate !== null && !(Number.isFinite(targetRate) && targetRate >= 0)) {
    return reject("target rate must be a non-negative number or null");
  }

  const updated: PriorityEntry = {
    ...existing,
    mode: action.mode,
    share,
    targetRate,
    paused: action.paused ?? existing.paused,
  };
  const priority = [...state.priority];
  priority[index] = updated;

  return accept({ ...state, priority }, [
    {
      kind: "entryModeChanged",
      entryId: updated.id,
      mode: updated.mode,
      share: updated.share,
      targetRate: updated.targetRate,
      paused: updated.paused,
    },
  ]);
}

export function applySetReserve(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "SET_RESERVE" }>,
): ApplyResult {
  const { itemId, percent } = action;
  if (!content.items.has(itemId)) return reject(`unknown item "${itemId}"`);
  if (!Number.isFinite(percent) || percent < 0) return reject("reserve must be at least 0");
  if (percent > MAX_RESERVE_PERCENT) {
    return reject(`reserve cannot exceed 50% (${MAX_RESERVE_PERCENT})`);
  }
  return accept({ ...state, reserve: { ...state.reserve, [itemId]: percent } }, [
    { kind: "reserveChanged", itemId, percent },
  ]);
}

// `storageLevel` and `qsLevel` are Record<string, number> keyed by an
// author-supplied content id (an item id or a lane id), and either can
// legitimately collide with a property already on Object.prototype (this fixture
// has a machine class literally named "constructor", so a similarly named item or
// lane is not implausible). Plain `record[id] ?? 0` on an object with no own such
// property resolves through the prototype chain instead of hitting the `?? 0`
// fallback. Object.hasOwn distinguishes "own property, possibly zero" from "no own
// property at all" -- mirrors numOf/decOf in economy/storage.ts.
function levelOf(record: Record<string, number>, id: string): number {
  return Object.hasOwn(record, id) ? record[id]! : 0;
}

function buyLevels(
  state: WorldState,
  content: IndexedContent,
  scope: "storage" | "quantum",
  id: string,
  levels: number,
): ApplyResult {
  if (!Number.isInteger(levels) || levels <= 0) return reject("levels must be a positive integer");

  const curve = scope === "storage" ? content.bundle.storage : content.bundle.quantumStorage;
  const currentLevel =
    scope === "storage" ? levelOf(state.storageLevel, id) : levelOf(state.qsLevel, id);
  if (currentLevel + levels > curve.maxLevel) {
    return reject(`level ${currentLevel + levels} exceeds the maximum of ${curve.maxLevel}`);
  }

  // Spec C.5: a container is a build, so it draws bound stock first. Deliveries
  // remain the only thing bound cannot pay for (spec D4).
  const costs = levelCostRange(curve, currentLevel, levels);
  const paid = spendForBuild(content, state, costs);
  if (paid === null) return reject("cannot afford these levels");

  const next: WorldState =
    scope === "storage"
      ? { ...paid, storageLevel: { ...paid.storageLevel, [id]: currentLevel + levels } }
      : { ...paid, qsLevel: { ...paid.qsLevel, [id]: currentLevel + levels } };

  return accept(next, [
    costEffect("spent", costs),
    { kind: "levelChanged", scope, id, level: currentLevel + levels },
  ]);
}

export function applyBuyStorage(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "BUY_STORAGE" }>,
): ApplyResult {
  if (!content.items.has(action.itemId)) return reject(`unknown item "${action.itemId}"`);
  return buyLevels(state, content, "storage", action.itemId, action.levels);
}

export function applyBuyQs(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "BUY_QS" }>,
): ApplyResult {
  if (!content.lanes.has(action.lane)) return reject(`unknown lane "${action.lane}"`);
  return buyLevels(state, content, "quantum", action.lane, action.levels);
}

export function applyTap(
  state: WorldState,
  content: IndexedContent,
  action: Extract<Action, { type: "TAP" }>,
): ApplyResult {
  const { count, clientElapsedMs } = action;
  if (!Number.isFinite(count) || count < 0) return reject("tap count must be non-negative");
  if (!Number.isFinite(clientElapsedMs) || clientElapsedMs < 0) {
    return reject("clientElapsedMs must be non-negative");
  }

  // Spec D.5: clientElapsedMs is the only client-supplied number the engine reads,
  // and this ceiling is the only thing it is trusted for. Surplus is discarded
  // silently rather than rejected, so a laggy client is not punished.
  const allowed = Math.floor(clientElapsedMs / TAP_MIN_INTERVAL_MS);
  const applied = Math.min(Math.floor(count), allowed);
  const discarded = Math.floor(count) - applied;

  const tap = content.bundle.tap;
  const stacks = Math.min(tap.maxStacks, state.tapStacks + applied);

  // Spec C.6: one shared expiry, refreshed by each tap. lastResolvedAt is "now",
  // because spec D.2's request lifecycle resolves before it applies.
  const timers: Timer[] = state.timers.filter((timer) => timer.id !== TAP_TIMER_ID);
  if (stacks > 0) {
    timers.push({
      id: TAP_TIMER_ID,
      kind: "tapExpiry",
      fireAt: state.lastResolvedAt + tap.durationSeconds * 1000,
    });
  }
  // Spec A.5's canonical ordering: by time, ties broken by a stable id.
  timers.sort((a, b) => (a.fireAt === b.fireAt ? (a.id < b.id ? -1 : 1) : a.fireAt - b.fireAt));

  return accept({ ...state, tapStacks: stacks, timers }, [{ kind: "tapped", stacks, discarded }]);
}
