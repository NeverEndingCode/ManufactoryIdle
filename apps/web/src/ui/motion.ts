// S-14 / W-18: motion by formula. The production sweep's period, the conveyor's density and
// speed, and the number tween (W-7), all as named constants here, so retuning is one file.
import { D, DECIMAL_ZERO, type Dec } from "@manufactory/engine";

/** W-7 / W-18: a snapshot correction tweens over this long, in log space. */
export const TWEEN_MS = 300;
/** A correction smaller than this fraction of the old value snaps instead. */
export const TWEEN_MIN_CHANGE = 0.01;

const SWEEP_MIN_S = 0.8;
const SWEEP_MAX_S = 6;
const SWEEP_PER_DECADE_S = 1.2;

const CONVEYOR_MAX_BLOCKS = 12;
const CONVEYOR_BLOCKS_PER_DECADE = 2;
const CONVEYOR_MIN_S = 4;
const CONVEYOR_MAX_S = 20;
const CONVEYOR_PER_DECADE_S = 4;

function clamp(lo: number, x: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function decades(perSecond: number): number {
  return Math.log10(1 + Math.max(0, perSecond));
}

/** W-18: clamp(0.8, 6 − 1.2·log10(1 + p), 6) seconds; a fast line sweeps fast. */
export function sweepPeriodS(productionPerSecond: number): number {
  return clamp(
    SWEEP_MIN_S,
    SWEEP_MAX_S - SWEEP_PER_DECADE_S * decades(productionPerSecond),
    SWEEP_MAX_S,
  );
}

/** S-14: the lane strip's blocks (none for a still lane, at most 12) and its loop period. */
export function conveyor(laneProductionPerSecond: number): { blocks: number; periodS: number } {
  const d = decades(laneProductionPerSecond);
  const blocks =
    laneProductionPerSecond > 0
      ? clamp(1, 1 + Math.floor(CONVEYOR_BLOCKS_PER_DECADE * d), CONVEYOR_MAX_BLOCKS)
      : 0;
  const periodS = clamp(CONVEYOR_MIN_S, CONVEYOR_MAX_S - CONVEYOR_PER_DECADE_S * d, CONVEYOR_MAX_S);
  return { blocks, periodS };
}

/** The tween's ease-out: fast at first, settling into the new value. */
export function easeOut(f: number): number {
  const t = clamp(0, f, 1);
  return 1 - (1 - t) * (1 - t);
}

function log1p10(x: Dec): number {
  return (x.lt(DECIMAL_ZERO) ? DECIMAL_ZERO : x).plus(1).log10();
}

/** log10(1 + x) space, f in [0, 1]; exact at both ends. A jump from 1e12 to 1e14 passes
 * through 1e13 at the half (§13.6), not the linear 5.05e13. */
export function tweenDec(from: Dec, to: Dec, f: number): Dec {
  if (f <= 0) return from;
  if (f >= 1) return to;
  const a = log1p10(from);
  const b = log1p10(to);
  const v = D(10)
    .pow(a + (b - a) * f)
    .minus(1);
  return v.lt(DECIMAL_ZERO) ? DECIMAL_ZERO : v;
}

/** |to/from − 1| > TWEEN_MIN_CHANGE; 0→0 never tweens, 0→x always does. */
export function shouldTween(from: Dec, to: Dec): boolean {
  if (from.eq(DECIMAL_ZERO)) return !to.eq(DECIMAL_ZERO);
  return to.div(from).minus(1).abs().gt(TWEEN_MIN_CHANGE);
}
