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

// `power.ts` (Satisfactory's OverclockPowerExponent-based `powerAtClock`, and
// its `toApproximateNumber` float-boundary helper) is deliberately NOT
// re-exported here. Manufactory Idle has no overclock-power mechanic in
// spec, and `packages/engine` is allowed to import this package
// unconditionally (spec A.2) — so leaving `powerAtClock` reachable from the
// barrel would be a legal bypass of spec E.4's ban on transcendentals in
// state-affecting engine code (`Math.pow` under the hood). The source and
// its tests stay on disk unmodified (vendored from
// Satisfactory-Colab-Modeler; deleting files just adds diff noise against
// upstream), just unreachable from other packages. See `power.ts` and
// `packages/rational/README.md`'s modification notice.
