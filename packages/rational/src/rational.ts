/**
 * BigInt-backed exact rational number.
 *
 * Invariant (canonical form), guaranteed by every function in this module:
 *   - `denominator` is always strictly positive.
 *   - `numerator` and `denominator` are always fully reduced (coprime).
 *   - Zero is always represented as `{ numerator: 0n, denominator: 1n }`.
 *
 * Values are never mutated in place; every operation returns a new
 * `Rational`. Do not hand-construct a `Rational` object literal outside this
 * module — always go through `makeRational`/`of`/`fromBigInt` (or the
 * arithmetic functions, which preserve canonical form) so the invariant
 * above actually holds.
 */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Euclidean algorithm, `bigint`-safe (handles negative inputs). */
function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

/**
 * Builds a `Rational` in canonical form from a raw numerator/denominator
 * pair: reduces by the gcd and normalizes the sign onto the numerator so
 * the denominator is always positive.
 *
 * Throws if `denominator` is zero.
 */
export function makeRational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new Error("Rational: denominator cannot be zero");
  }

  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  if (n === 0n) {
    return { numerator: 0n, denominator: 1n };
  }

  const divisor = gcd(n, d);
  return { numerator: n / divisor, denominator: d / divisor };
}

/**
 * Convenience constructor accepting `number` or `bigint` operands (e.g.
 * `of(1, 2)` for one half). `number` inputs must be safe integers — this is
 * for literal-value ergonomics, not a general float-to-rational conversion.
 */
export function of(numerator: bigint | number, denominator: bigint | number = 1): Rational {
  if (typeof numerator === "number" && !Number.isSafeInteger(numerator)) {
    throw new Error(`Rational.of: numerator ${numerator} is not a safe integer`);
  }
  if (typeof denominator === "number" && !Number.isSafeInteger(denominator)) {
    throw new Error(`Rational.of: denominator ${denominator} is not a safe integer`);
  }
  return makeRational(BigInt(numerator), BigInt(denominator));
}

/** Builds an integer-valued `Rational` from a `bigint`. */
export function fromBigInt(value: bigint): Rational {
  return { numerator: value, denominator: 1n };
}

export const ZERO: Rational = { numerator: 0n, denominator: 1n };
export const ONE: Rational = { numerator: 1n, denominator: 1n };

export function add(a: Rational, b: Rational): Rational {
  return makeRational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function subtract(a: Rational, b: Rational): Rational {
  return add(a, negate(b));
}

export function multiply(a: Rational, b: Rational): Rational {
  return makeRational(a.numerator * b.numerator, a.denominator * b.denominator);
}

/** Throws if `b` is zero. */
export function divide(a: Rational, b: Rational): Rational {
  if (b.numerator === 0n) {
    throw new Error("Rational: division by zero");
  }
  return makeRational(a.numerator * b.denominator, a.denominator * b.numerator);
}

export function negate(a: Rational): Rational {
  // `a` is already in canonical form (positive denominator, reduced), and
  // flipping the numerator's sign preserves both properties, so this can
  // skip re-reducing via makeRational.
  return { numerator: -a.numerator, denominator: a.denominator };
}

/** Throws if `a` is zero. */
export function reciprocal(a: Rational): Rational {
  if (a.numerator === 0n) {
    throw new Error("Rational: cannot take the reciprocal of zero");
  }
  return makeRational(a.denominator, a.numerator);
}

export function abs(a: Rational): Rational {
  return a.numerator < 0n ? negate(a) : a;
}

/** Three-way compare for sorting: negative if `a < b`, positive if `a > b`, `0` if equal. */
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const diff = a.numerator * b.denominator - b.numerator * a.denominator;
  if (diff < 0n) return -1;
  if (diff > 0n) return 1;
  return 0;
}

export function equals(a: Rational, b: Rational): boolean {
  return compare(a, b) === 0;
}

export function isZero(a: Rational): boolean {
  return a.numerator === 0n;
}

export function isNegative(a: Rational): boolean {
  return a.numerator < 0n;
}

export function isPositive(a: Rational): boolean {
  return a.numerator > 0n;
}
