// The power dock's readouts (Q-12): the grid from the display solve, and the tap's stacks,
// kick and remaining time, optimistic until the flush's response lands (W-12).
import { TAP_TIMER_ID, tapMultiplier } from "@manufactory/engine";
import { localTimeOf, type Snapshot } from "../sync/snapshot.js";
import { TAP_LABEL } from "../sync/constants.js";
import type { Batch } from "../sync/outbox.js";
import type { StoreView } from "../sync/store.js";
import { isPowerTarget } from "./derive.js";

export interface DockModel {
  demandMw: number;
  supplyMw: number;
  fullDemandMw: number;
  ratio: number;
  /** The bottleneck is power: kind "power", or a recipe limiting the power entry (Q-5). */
  limited: boolean;
  stacks: number;
  maxStacks: number;
  /** The tap multiplier at the shown stacks, e.g. 1.25. */
  kick: number;
  remainingMs: number;
  injectionMw: number;
}

export function dockModel(
  s: Snapshot,
  taps: StoreView["taps"],
  clientNow: number,
  /** The store view's outbox: its TAP batches are flushed taps the snapshot hasn't counted yet. */
  pending: readonly Batch[] = [],
): DockModel {
  const { demandMw, fullDemandMw, supplyMw, ratio } = s.display.solution.power;
  const b = s.display.solution.bottleneck;
  const limited =
    b !== null &&
    (b.kind === "power" || (b.kind === "recipe" && isPowerTarget(s, b.limitingTarget)));

  const tap = s.content.bundle.tap;
  const state = s.display.state;
  // The later of the server's shared expiry and 30 s from the last local tap.
  const timer = state.timers.find((t) => t.id === TAP_TIMER_ID);
  const serverEnd = timer === undefined ? -Infinity : localTimeOf(s, timer.fireAt);
  const localEnd =
    taps.lastTapAt === null ? -Infinity : taps.lastTapAt + tap.durationSeconds * 1000;
  const end = Math.max(serverEnd, localEnd);
  const remainingMs = Number.isFinite(end) ? Math.max(0, end - clientNow) : 0;
  // Past the SERVER's expiry its stacks are gone, before the next snapshot says so; a local
  // tap since then extends the readout's time, not the expired stacks.
  const base = serverEnd > clientNow ? state.tapStacks : 0;
  let inFlight = 0;
  for (const b of pending) {
    if (b.label !== TAP_LABEL) continue;
    for (const a of b.actions) if (a.type === "TAP") inFlight += a.count;
  }
  const stacks = Math.min(tap.maxStacks, base + taps.pending + inFlight);
  return {
    demandMw,
    supplyMw,
    fullDemandMw,
    ratio,
    limited,
    stacks,
    maxStacks: tap.maxStacks,
    kick: tapMultiplier(s.content, { ...state, tapStacks: stacks }),
    remainingMs,
    injectionMw: stacks > 0 ? tap.powerInjectionMw : 0,
  };
}
