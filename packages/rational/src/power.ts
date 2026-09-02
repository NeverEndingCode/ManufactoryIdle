import type { Rational } from "./rational.js";

/**
 * The ONE deliberate floating-point boundary in this codebase.
 *
 * The game data's `OverclockPowerExponent` (canonically `1321929/1000000`,
 * i.e. ~1.321929) is used as a real-valued exponent:
 *
 *     power = base * clock ^ exponent
 *
 * Raising a value to a fractional power is irrational for virtually every
 * input, so there is no exact-rational equivalent — floating point is
 * unavoidable here. Every other computation in this codebase should go
 * through `Rational` arithmetic (see `rational.ts`); this module is the only
 * place permitted to convert a `Rational` to a `number`, so that exactness
 * being deliberately given up stays a one-line, easy-to-audit boundary
 * instead of `Number(...)` calls scattered through the codebase.
 */

/**
 * Converts a `Rational` to its nearest `number` approximation. Precision may
 * be lost once the numerator/denominator exceed `Number.MAX_SAFE_INTEGER`.
 *
 * Use ONLY at the float boundary (this module) — never in an exact-
 * arithmetic code path.
 */
export function toApproximateNumber(value: Rational): number {
  return Number(value.numerator) / Number(value.denominator);
}

/**
 * `power = base * clock ^ exponent`, per the game's `OverclockPowerExponent`
 * formula. `base` and `clock` are supplied as exact `Rational`s and are
 * converted to floating point right here, at the point of use — this is the
 * only function in the package that returns `number` instead of `Rational`.
 *
 * `exponent` is typically obtained by parsing the game data's
 * `OverclockPowerExponent` field with `parseRational` and converting it with
 * `toApproximateNumber`.
 */
export function powerAtClock(
  baseRational: Rational,
  clockRational: Rational,
  exponent: number,
): number {
  const base = toApproximateNumber(baseRational);
  const clock = toApproximateNumber(clockRational);
  return base * Math.pow(clock, exponent);
}
