import type { Rational } from "./rational.js";

/**
 * How to round a `Rational` down to a fixed number of decimal digits when a
 * decimal display can't represent it exactly (e.g. 1/3 at 2 digits).
 *   - "round"    — round half away from zero (the usual "round" behavior).
 *   - "floor"    — round toward negative infinity.
 *   - "ceil"     — round toward positive infinity.
 *   - "truncate" — round toward zero (drop the remainder).
 */
export type RoundingMode = "round" | "floor" | "ceil" | "truncate";

export interface DecimalFormatOptions {
  /** Number of digits after the decimal point. Defaults to 6. */
  digits?: number;
  /** Defaults to "round". */
  rounding?: RoundingMode;
  /** Strip trailing zeros (and a bare trailing ".") after rounding. Defaults to true. */
  trimTrailingZeros?: boolean;
}

export type FormatStyle = "fraction" | "mixed" | "decimal";

export interface FormatOptions extends DecimalFormatOptions {
  /** Defaults to "fraction". `digits`/`rounding`/`trimTrailingZeros` only apply to "decimal". */
  style?: FormatStyle;
}

/**
 * Canonical `n/d` fraction string — the lossless storage format (matches
 * `game_data.json` and the Postgres `limit_exact`/`clock_exact` columns).
 * Whole numbers are rendered without a denominator (`"5"`, not `"5/1"`),
 * matching `game_data.json`'s own style.
 */
export function toFractionString(value: Rational): string {
  return value.denominator === 1n
    ? value.numerator.toString()
    : `${value.numerator}/${value.denominator}`;
}

/**
 * Mixed-number display string, e.g. `7/3` -> `"2 1/3"`, `-7/3` -> `"-2 1/3"`.
 * Proper fractions (magnitude < 1) render as a plain fraction (`"1/3"`),
 * and integers render with no fraction part (`"5"`).
 */
export function toMixedNumberString(value: Rational): string {
  // bigint division truncates toward zero, which is exactly the "whole part"
  // we want given the numerator carries the sign and the denominator is
  // always positive in canonical form.
  const whole = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;

  if (remainder === 0n) {
    return whole.toString();
  }

  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (whole === 0n) {
    // Proper fraction: keep the sign on the numerator, e.g. "-1/3".
    return `${remainder < 0n ? "-" : ""}${absRemainder}/${value.denominator}`;
  }

  const sign = whole < 0n ? "-" : "";
  const absWhole = whole < 0n ? -whole : whole;
  return `${sign}${absWhole} ${absRemainder}/${value.denominator}`;
}

/**
 * Fixed-digit decimal string, e.g. `1/8` at 3 digits -> `"0.125"`.
 * Uses exact `bigint` arithmetic throughout (long division by scaling),
 * never `number` — the rounding here is a deliberate, explicit display-time
 * operation, not silent float error.
 */
export function toDecimalString(value: Rational, options: DecimalFormatOptions = {}): string {
  const digits = options.digits ?? 6;
  const rounding = options.rounding ?? "round";
  const trim = options.trimTrailingZeros ?? true;

  if (!Number.isInteger(digits) || digits < 0) {
    throw new Error(`toDecimalString: digits must be a non-negative integer, got ${digits}`);
  }

  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const denominator = value.denominator;

  const scale = 10n ** BigInt(digits);
  const scaled = numerator * scale;
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;

  if (remainder !== 0n) {
    switch (rounding) {
      case "truncate":
        break;
      case "round":
        if (remainder * 2n >= denominator) quotient += 1n;
        break;
      case "ceil":
        // Toward +infinity: only bumps magnitude up for non-negative values.
        if (!negative) quotient += 1n;
        break;
      case "floor":
        // Toward -infinity: only bumps magnitude up for negative values.
        if (negative) quotient += 1n;
        break;
    }
  }

  const digitsStr = quotient.toString().padStart(digits + 1, "0");
  const intPart = digits > 0 ? digitsStr.slice(0, digitsStr.length - digits) : digitsStr;
  let fracPart = digits > 0 ? digitsStr.slice(digitsStr.length - digits) : "";

  if (trim && fracPart.length > 0) {
    fracPart = fracPart.replace(/0+$/, "");
  }

  const isZeroResult = intPart === "0" && fracPart === "";
  const sign = negative && !isZeroResult ? "-" : "";

  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

/**
 * General-purpose formatter dispatching to `toFractionString` (default),
 * `toMixedNumberString`, or `toDecimalString` based on `options.style`.
 */
export function formatRational(value: Rational, options: FormatOptions = {}): string {
  const style = options.style ?? "fraction";
  switch (style) {
    case "fraction":
      return toFractionString(value);
    case "mixed":
      return toMixedNumberString(value);
    case "decimal":
      return toDecimalString(value, options);
  }
}
