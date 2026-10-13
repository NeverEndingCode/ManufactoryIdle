// Display notation. Spec section 9: idle players have strong preferences here,
// so several notations are offered and the choice lives in player preferences.
// This is one pure function taking mode as an argument — never a branch at the
// call site.
import type { Dec } from "./decimal.js";

export type NotationMode = "sci" | "eng" | "names" | "short" | "doubled" | "hybrid";

const SHORT = ["", "K", "M", "B", "T"] as const;
const NAMES = [
  "",
  "thousand",
  "million",
  "billion",
  "trillion",
  "quadrillion",
  "quintillion",
  "sextillion",
  "septillion",
  "octillion",
  "nonillion",
  "decillion",
] as const;

// 0 -> "aa", 25 -> "az", 26 -> "ba", 675 -> "zz", 676 -> "aaa".
// Fixed-width base-26 blocks, widest-first, starting at two letters.
export function letterSuffix(index: number): string {
  let n = index;
  let width = 2;
  let block = 26 * 26;
  while (n >= block) {
    n -= block;
    width += 1;
    block *= 26;
  }
  let out = "";
  for (let i = 0; i < width; i += 1) {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

// Below this exponent a fixed-point rendering is nothing but leading zeros,
// so `format` hands off to scientific notation instead of calling `plain`.
const PLAIN_FLOOR_EXPONENT = -4;

function plain(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  // Below 1 the two-decimal cap the branches above use would render every
  // early-game rate "0.00" — spec A.4 zone 2 puts clocks and satisfaction in
  // [0, 1], and during calibration "0.00" is indistinguishable from stalled.
  // Keep the same three significant figures, minus the zeros toPrecision pads
  // with. `format` guarantees abs >= 1e-4 here, so the result always starts
  // "0." and trimming can never strip a significant digit.
  return value.toPrecision(3).replace(/0+$/, "");
}

// Renders an already-tiered magnitude (`scaled` in [1, 1000), grouped into
// tier `tier`) for every mode. Shared by the normal exponent>=3 path and by
// the two carry-promotion paths in `format` below — everywhere a value has
// to be displayed one tier up from where its raw exponent first put it.
function renderTier(tier: number, scaled: number, mode: NotationMode): string {
  const sci = () => `${scaled.toFixed(2)}e${tier * 3}`;

  switch (mode) {
    case "sci":
      return sci();
    case "eng":
      return `${scaled.toFixed(2)}e${tier * 3}`;
    case "names":
      return tier < NAMES.length ? `${scaled.toFixed(2)} ${NAMES[tier]}` : sci();
    case "hybrid":
      return tier < SHORT.length ? `${scaled.toFixed(2)} ${SHORT[tier]}` : sci();
    case "short":
    case "doubled": {
      if (tier < SHORT.length) return `${scaled.toFixed(2)} ${SHORT[tier]}`;
      const letters = letterSuffix(tier - SHORT.length);
      const suffix = mode === "doubled" ? letters.toUpperCase() : letters;
      return `${scaled.toFixed(2)} ${suffix}`;
    }
  }
}

export function format(value: Dec, mode: NotationMode): string {
  if (value.mantissa === 0) return "0";

  const negative = value.mantissa < 0;
  const sign = negative ? "-" : "";
  const exponent = value.exponent;
  const mantissa = Math.abs(value.mantissa);

  // Too small for fixed point. This also guards the magnitude below, which
  // underflows to 0 at very negative exponents; rendering straight from
  // mantissa/exponent is exact at any scale.
  if (exponent < PLAIN_FLOOR_EXPONENT) {
    return `${sign}${mantissa.toFixed(2)}e${exponent}`;
  }

  if (exponent < 3) {
    // eslint-disable-next-line no-restricted-properties -- display-only (spec E.4 exemption); do not copy into economy/
    const magnitude = mantissa * Math.pow(10, exponent);
    const plainStr = plain(magnitude);
    // toFixed can round the display up to 1000 even though the true value
    // sits just under it (999.99 at 0 decimals -> "1000"). That has
    // effectively crossed into the next tier, so render it there instead of
    // showing a bare 4-digit number with no suffix.
    if (Number(plainStr) < 1000) return sign + plainStr;
    return sign + renderTier(1, magnitude / 1000, mode);
  }

  // tier counts groups of three digits; scaled sits in [1, 1000).
  const tier = Math.floor(exponent / 3);

  // sci mode renders from the raw mantissa/exponent, not the tier grouping
  // below, so it never needs the boundary-carry fix that follows and is
  // handled first.
  if (mode === "sci") return `${sign}${mantissa.toFixed(2)}e${exponent}`;

  // eslint-disable-next-line no-restricted-properties -- display-only (spec E.4 exemption); do not copy into economy/
  const scaled = mantissa * Math.pow(10, exponent - tier * 3);

  // Same carry, one tier up: toFixed(2) can round `scaled` up to "1000.00"
  // right at a tier boundary (9.99999e5 -> tier 1, scaled 999.999 ->
  // "1000.00 K" instead of "1.00 M"). Promote to the next tier instead.
  if (Number(scaled.toFixed(2)) >= 1000) {
    return sign + renderTier(tier + 1, scaled / 1000, mode);
  }

  return sign + renderTier(tier, scaled, mode);
}
