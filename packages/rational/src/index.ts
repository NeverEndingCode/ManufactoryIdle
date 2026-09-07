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

// `power.ts`'s Satisfactory-specific `powerAtClock` (OverclockPowerExponent) is
// deliberately NOT re-exported here. Manufactory Idle has no overclock-power
// mechanic in spec, and `packages/engine` is allowed to import this package
// unconditionally (spec A.2) — so leaving `powerAtClock` reachable from the
// barrel would be a legal bypass of spec E.4's ban on transcendentals in
// state-affecting engine code (`Math.pow` under the hood). It stays on disk
// unmodified (vendored from Satisfactory-Colab-Modeler; deleting it just adds
// diff noise against upstream), just unreachable from other packages.
//
// `toApproximateNumber` (also in `power.ts`) IS re-exported below. It is a plain
// `Number(numerator) / Number(denominator)` division — no transcendental, no
// `Math.pow` — so it carries none of the E.4 risk above. Phase 1's content indexer
// needs exactly this: the one place a bundle's exact-rational per-minute rates are
// allowed to become per-second float64 (see `packages/engine/src/graph/
// index-content.ts`). See `packages/rational/README.md`'s modification notice.
export { toApproximateNumber } from "./power.js";
