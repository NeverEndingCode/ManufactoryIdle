// BigInt-backed exact rational arithmetic. See PLAN.md §7 and
// jobs/002-rational-package.md for context: this package is the foundation
// every other package builds numeric correctness on, since game_data.json
// encodes every game rate as an exact rational string.

export type { Rational } from "./rational.js";
export {
  ZERO,
  ONE,
  makeRational,
  of,
  fromBigInt,
  add,
  subtract,
  multiply,
  divide,
  negate,
  reciprocal,
  abs,
  compare,
  equals,
  isZero,
  isNegative,
  isPositive,
} from "./rational.js";

export { parseRational, RationalParseError } from "./parse.js";

export type { RoundingMode, FormatStyle, FormatOptions, DecimalFormatOptions } from "./format.js";
export { formatRational, toFractionString, toMixedNumberString, toDecimalString } from "./format.js";

// The one deliberate float boundary — see power.ts for why this exists.
export { powerAtClock, toApproximateNumber } from "./power.js";
