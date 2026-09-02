// Magnitude arithmetic. Spec A.4 zone 3: stockpiles, rates, build costs, and
// multipliers reach 1e600 and beyond, so they are mantissa/exponent Decimals
// rather than rationals or plain floats.
import Decimal from "break_infinity.js";

export type Dec = Decimal;

export const DECIMAL_ZERO: Dec = new Decimal(0);
export const DECIMAL_ONE: Dec = new Decimal(1);

export function D(value: number | string | Dec): Dec {
  return value instanceof Decimal ? value : new Decimal(value);
}

// Spec A.5: Decimals persist as canonical strings in JSONB, never as `numeric`.
// We serialize mantissa and exponent explicitly rather than relying on
// `toString()`, whose formatting switches representation by magnitude.
// Number#toString() emits the shortest round-trippable form, so no precision
// is lost.
export function toCanonical(value: Dec): string {
  if (value.mantissa === 0) return "0e0";
  return `${value.mantissa.toString()}e${value.exponent.toString()}`;
}

export function fromCanonical(text: string): Dec {
  return new Decimal(text);
}
