import { add, fromBigInt, makeRational, negate, type Rational } from "./rational.js";

/** Thrown by `parseRational` when the input string doesn't match any supported format. */
export class RationalParseError extends Error {
  constructor(input: string, reason?: string) {
    super(
      `Invalid rational string: "${input}"` + (reason ? ` (${reason})` : ""),
    );
    this.name = "RationalParseError";
  }
}

// Mixed number: "2 1/3", "-2 1/3" (sign belongs to the whole expression, not
// just the whole-number part).
const MIXED_NUMBER = /^([+-]?)(\d+)\s+(\d+)\/(\d+)$/;

// Simple fraction: "12/5", "-9/5", "12/-5".
const FRACTION = /^([+-]?\d+)\/([+-]?\d+)$/;

// Decimal: "0.125", "-0.125", ".125", "5.", "-5." — at least one digit must
// appear on one side of the point.
const DECIMAL = /^([+-]?)(\d*)\.(\d*)$/;

// Plain integer: "5", "-3", "+5".
const INTEGER = /^([+-]?\d+)$/;

/**
 * Parses a string into an exact `Rational`. Supports every numeric format
 * the game data and UI need:
 *   - Plain integers: "5", "-3"
 *   - Simple fractions: "12/5", "-9/5"
 *   - Decimals: "0.125", ".125"
 *   - Mixed numbers: "2 1/3", "-2 1/3"
 *
 * Throws `RationalParseError` on anything else (including malformed input
 * and division by zero).
 */
export function parseRational(input: string): Rational {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new RationalParseError(input, "empty string");
  }

  const mixedMatch = MIXED_NUMBER.exec(trimmed);
  if (mixedMatch) {
    const [, sign, wholeStr, numStr, denStr] = mixedMatch as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const denominator = BigInt(denStr);
    if (denominator === 0n) {
      throw new RationalParseError(input, "zero denominator");
    }
    const whole = fromBigInt(BigInt(wholeStr));
    const fraction = makeRational(BigInt(numStr), denominator);
    let result = add(whole, fraction);
    if (sign === "-") {
      result = negate(result);
    }
    return result;
  }

  const fractionMatch = FRACTION.exec(trimmed);
  if (fractionMatch) {
    const [, numStr, denStr] = fractionMatch as unknown as [string, string, string];
    const denominator = BigInt(denStr);
    if (denominator === 0n) {
      throw new RationalParseError(input, "zero denominator");
    }
    return makeRational(BigInt(numStr), denominator);
  }

  const decimalMatch = DECIMAL.exec(trimmed);
  if (decimalMatch) {
    const [, sign, intPart, fracPart] = decimalMatch as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (intPart === "" && fracPart === "") {
      throw new RationalParseError(input, "no digits");
    }
    const digits = fracPart.length;
    const combinedDigits = `${intPart}${fracPart}` || "0";
    const numerator = BigInt(combinedDigits);
    const denominator = 10n ** BigInt(digits);
    let result = makeRational(numerator, denominator);
    if (sign === "-") {
      result = negate(result);
    }
    return result;
  }

  const integerMatch = INTEGER.exec(trimmed);
  if (integerMatch) {
    return makeRational(BigInt(integerMatch[1] as string), 1n);
  }

  throw new RationalParseError(input);
}
