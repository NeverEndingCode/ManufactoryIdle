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

function plain(value: number): string {
  const abs = Math.abs(value);
  if (abs < 10) return value.toFixed(2);
  if (abs < 100) return value.toFixed(1);
  return value.toFixed(0);
}

export function format(value: Dec, mode: NotationMode): string {
  if (value.mantissa === 0) return "0";

  const negative = value.mantissa < 0;
  const sign = negative ? "-" : "";
  const exponent = value.exponent;
  const mantissa = Math.abs(value.mantissa);

  if (exponent < 3) return sign + plain(mantissa * Math.pow(10, exponent));

  // tier counts groups of three digits; scaled sits in [1, 1000).
  const tier = Math.floor(exponent / 3);
  const scaled = mantissa * Math.pow(10, exponent - tier * 3);

  const sci = () => `${sign}${mantissa.toFixed(2)}e${exponent}`;

  switch (mode) {
    case "sci":
      return sci();
    case "eng":
      return `${sign}${scaled.toFixed(2)}e${tier * 3}`;
    case "names":
      return tier < NAMES.length ? `${sign}${scaled.toFixed(2)} ${NAMES[tier]}` : sci();
    case "hybrid":
      return tier < SHORT.length ? `${sign}${scaled.toFixed(2)} ${SHORT[tier]}` : sci();
    case "short":
    case "doubled": {
      if (tier < SHORT.length) return `${sign}${scaled.toFixed(2)} ${SHORT[tier]}`;
      const letters = letterSuffix(tier - SHORT.length);
      const suffix = mode === "doubled" ? letters.toUpperCase() : letters;
      return `${sign}${scaled.toFixed(2)} ${suffix}`;
    }
  }
}
