// Spec D3's four levers, and the determinism rules spec E.4 imposes on them.
//
// Math.pow, exp and log are libm-dependent and vary by platform and Node version.
// A game built on r^n walks straight into that, so every exponent here is an
// integer and every power is evaluated by squaring, which is `*` only. Softcaps are
// piecewise-linear rather than T*(M/T)^p for the same reason. The formatter in
// numbers/format.ts uses Math.pow; it is display-only and exempt. Nothing in this
// file may follow its example.
import { D, DECIMAL_ZERO, type Dec } from "../numbers/decimal.js";
import type {
  ItemId,
  LaneId,
  MachineClassId,
  SoftcapDef,
  StorageCurveDef,
} from "../content/types.js";
import { getMark, type IndexedContent } from "../graph/index-content.js";
import { installedAt, type WorldState } from "../state/world.js";

function assertExponent(exponent: number): void {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new Error(`exponent must be a non-negative integer, got ${exponent}`);
  }
}

/** base^exponent by squaring, in float64. Exact and platform-stable. */
export function powIntNumber(base: number, exponent: number): number {
  assertExponent(exponent);
  let result = 1;
  let factor = base;
  let n = exponent;
  while (n > 0) {
    if ((n & 1) === 1) result *= factor;
    factor *= factor;
    n >>>= 1;
  }
  return result;
}

/** base^exponent by squaring, in Decimal. Costs reach 1e600 and beyond. */
export function powIntDecimal(base: number, exponent: number): Dec {
  assertExponent(exponent);
  let result = D(1);
  let factor = D(base);
  let n = exponent;
  while (n > 0) {
    if ((n & 1) === 1) result = result.times(factor);
    factor = factor.times(factor);
    n >>>= 1;
  }
  return result;
}

/**
 * Spec D3: applied per multiplier category and again on the product, so neither one
 * system nor the four stacking can drive r_eff below 1. Piecewise-linear, so it is
 * monotonic (it never hard-caps, which spec 16.6 forbids) and deterministic.
 */
export function softcap(value: number, cap: SoftcapDef): number {
  if (value <= cap.threshold) return value;
  return cap.threshold + (value - cap.threshold) * cap.slope;
}

/**
 * Spec B.2: the ladder counts mark-weighted equivalents, not raw machines. Spec C.0
 * derives why: counting raw machines would collapse the ladder on consolidation and
 * nobody would ever buy a mark upgrade.
 */
export function ladderInput(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return 0;
  let total = 0;
  for (const mark of cls.marks) {
    total += installedAt(state, lane, machineClass, mark.mark) * mark.rateMultiplier;
  }
  return total;
}

/**
 * Spec B.3: stepped, not continuous. `step^floor(n / interval)` keeps a visible
 * threshold to grind toward and keeps the exponent an integer.
 */
export function ladderMultiplier(
  content: IndexedContent,
  state: WorldState,
  lane: LaneId,
  machineClass: MachineClassId,
): number {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return 1;
  const steps = Math.floor(ladderInput(content, state, lane, machineClass) / cls.ladder.interval);
  const raw = powIntNumber(cls.ladder.step, Math.max(0, steps));
  return softcap(raw, content.bundle.softcaps.ladder);
}

/** Spec D3 lever 3: discrete lane-wide grants, compounded over unlocked milestones. */
export function laneMultiplier(content: IndexedContent, tier: number, lane: LaneId): number {
  let product = 1;
  for (const milestone of content.bundle.milestones) {
    if (milestone.tier > tier) continue;
    product *= milestone.laneMultipliers[lane] ?? 1;
  }
  return softcap(product, content.bundle.softcaps.lane);
}

/**
 * Spec C.6: a step function, not a decaying curve. Continuously varying rates would
 * break the piecewise-constant assumption the whole event model rests on.
 */
export function tapMultiplier(content: IndexedContent, state: WorldState): number {
  const tap = content.bundle.tap;
  const stacks = Math.max(0, Math.min(state.tapStacks, tap.maxStacks));
  return softcap(1 + stacks * tap.kickPerStack, content.bundle.softcaps.tap);
}

/** The product softcap from spec D3, applied on top of the per-category ones. */
export function combinedMultiplier(content: IndexedContent, parts: readonly number[]): number {
  let product = 1;
  for (const part of parts) product *= part;
  return softcap(product, content.bundle.softcaps.product);
}

/**
 * cost(n) = base * r^n, summed over [fromCount, fromCount + count).
 *
 * Evaluated as the closed-form geometric sum base * r^from * (r^count - 1)/(r - 1),
 * which matters for more than speed: buying `count` machines starting at n and
 * refunding those same `count` machines both call this with identical arguments, so
 * the two results are bitwise equal and spec D4's LIFO symmetry is exact rather
 * than approximate.
 *
 * `mark.buildCost` is the absolute cost at n = 0 for that mark, so the curve resets
 * on a new mark, which is the staircase in spec D3. `mark.buildCostMultiplier` is
 * metadata for spec C.0's pace analysis and is deliberately not read here.
 */
export function machineCostRange(
  content: IndexedContent,
  machineClass: MachineClassId,
  mark: number,
  fromCount: number,
  count: number,
): Map<ItemId, Dec> {
  const out = new Map<ItemId, Dec>();
  if (count <= 0) return out;

  const cls = content.machineClasses.get(machineClass);
  if (!cls) throw new Error(`unknown machine class "${machineClass}"`);
  const markDef = getMark(content, machineClass, mark);
  if (!markDef) throw new Error(`machine class "${machineClass}" has no mk${mark}`);

  const r = cls.costRatio;
  const runs = powIntDecimal(r, count).minus(1).div(r - 1);
  const offset = powIntDecimal(r, fromCount);
  const factor = offset.times(runs);

  for (const entry of markDef.buildCost) {
    const amount = D(entry.amount).times(factor);
    out.set(entry.item, (out.get(entry.item) ?? DECIMAL_ZERO).plus(amount));
  }
  return out;
}

/** The same geometric sum for storage and Quantum Storage levels (spec B.4). */
export function levelCostRange(
  curve: StorageCurveDef,
  fromLevel: number,
  levels: number,
): Map<ItemId, Dec> {
  const out = new Map<ItemId, Dec>();
  if (levels <= 0 || curve.baseCostItem === null) return out;
  const runs = powIntDecimal(curve.costGrowth, levels).minus(1).div(curve.costGrowth - 1);
  const factor = powIntDecimal(curve.costGrowth, fromLevel).times(runs);
  out.set(curve.baseCostItem, D(curve.baseCostAmount).times(factor));
  return out;
}

/** cap = base * capGrowth^level (spec 3.3, B.4). */
export function capAtLevel(base: number, curve: StorageCurveDef, level: number): Dec {
  return D(base).times(powIntDecimal(curve.capGrowth, level));
}
