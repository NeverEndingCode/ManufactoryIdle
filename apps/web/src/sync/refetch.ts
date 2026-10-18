// When to GET /api/world next (W-9, P-4, P-6). Pure: the store owns the timer.
import {
  BOUNDARY_SLACK_MS,
  REPOLL_STEPS_MS,
  SHORT_BOUNDARY_MS,
  SHORT_STREAK,
} from "./constants.js";
import { isPlateaued } from "./interpolate.js";
import { localTimeOf, plateauAtMs, type Snapshot } from "./snapshot.js";

export interface RepollState {
  /** Consecutive adopted snapshots whose boundary was under SHORT_BOUNDARY_MS ahead. */
  streak: number;
}

/** The repoll state after adopting `s`. A POST (an action) or a long or null boundary resets it. */
export function nextRepoll(prev: RepollState, s: Snapshot, cause: "get" | "post"): RepollState {
  if (cause === "post") return { streak: 0 };
  const boundary = s.schedule.nextBoundaryAtMs;
  const short = boundary !== null && boundary - s.schedule.atMs < SHORT_BOUNDARY_MS;
  return { streak: short ? prev.streak + 1 : 0 };
}

export function minGapMs(r: RepollState): number {
  const last = REPOLL_STEPS_MS.length - 1;
  const step = Math.min(last, Math.max(0, r.streak - SHORT_STREAK + 1));
  return REPOLL_STEPS_MS[step]!;
}

/** Local (ClientClock) time to GET next, or null for no timer. */
export function nextFetchAt(s: Snapshot, r: RepollState): number | null {
  if (isPlateaued(s)) return null;
  const target = Math.min(s.schedule.nextBoundaryAtMs ?? Infinity, plateauAtMs(s));
  if (!Number.isFinite(target)) return null;
  return Math.max(localTimeOf(s, target + BOUNDARY_SLACK_MS), s.receivedAt + minGapMs(r));
}
