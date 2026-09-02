import { describe, expect, it } from "vitest";
import { formatRational, toDecimalString, toFractionString, toMixedNumberString } from "./format";
import { of, ZERO } from "./rational";

describe("toFractionString", () => {
  it("formats whole numbers without a denominator, matching game_data.json style", () => {
    expect(toFractionString(of(5, 1))).toBe("5");
    expect(toFractionString(of(-3, 1))).toBe("-3");
    expect(toFractionString(ZERO)).toBe("0");
  });

  it("formats proper/improper fractions as n/d", () => {
    expect(toFractionString(of(12, 5))).toBe("12/5");
    expect(toFractionString(of(-9, 5))).toBe("-9/5");
    expect(toFractionString(of(1321929, 1000000))).toBe("1321929/1000000");
  });
});

describe("toMixedNumberString", () => {
  it("formats improper fractions as whole + proper fraction", () => {
    expect(toMixedNumberString(of(7, 3))).toBe("2 1/3");
    expect(toMixedNumberString(of(-7, 3))).toBe("-2 1/3");
  });

  it("formats proper fractions with no whole part", () => {
    expect(toMixedNumberString(of(1, 3))).toBe("1/3");
    expect(toMixedNumberString(of(-1, 3))).toBe("-1/3");
  });

  it("formats whole numbers plainly", () => {
    expect(toMixedNumberString(of(5, 1))).toBe("5");
    expect(toMixedNumberString(ZERO)).toBe("0");
  });
});

describe("toDecimalString", () => {
  it("formats an exact terminating decimal", () => {
    expect(toDecimalString(of(1, 8), { digits: 3 })).toBe("0.125");
    expect(toDecimalString(of(1321929, 1000000), { digits: 6 })).toBe("1.321929");
  });

  it("defaults to 6 digits", () => {
    expect(toDecimalString(of(1, 8))).toBe("0.125");
  });

  it("trims trailing zeros by default", () => {
    expect(toDecimalString(of(1, 2), { digits: 6 })).toBe("0.5");
  });

  it("keeps trailing zeros when trimTrailingZeros is false", () => {
    expect(toDecimalString(of(1, 2), { digits: 4, trimTrailingZeros: false })).toBe("0.5000");
  });

  it("rounds half away from zero with the default rounding mode", () => {
    expect(toDecimalString(of(1, 3), { digits: 2 })).toBe("0.33");
    expect(toDecimalString(of(2, 3), { digits: 2 })).toBe("0.67");
    expect(toDecimalString(of(-2, 3), { digits: 2 })).toBe("-0.67");
  });

  it("truncates toward zero", () => {
    expect(toDecimalString(of(2, 3), { digits: 2, rounding: "truncate" })).toBe("0.66");
    expect(toDecimalString(of(-2, 3), { digits: 2, rounding: "truncate" })).toBe("-0.66");
  });

  it("floors toward negative infinity", () => {
    expect(toDecimalString(of(2, 3), { digits: 2, rounding: "floor" })).toBe("0.66");
    expect(toDecimalString(of(-2, 3), { digits: 2, rounding: "floor" })).toBe("-0.67");
  });

  it("ceils toward positive infinity", () => {
    expect(toDecimalString(of(2, 3), { digits: 2, rounding: "ceil" })).toBe("0.67");
    expect(toDecimalString(of(-2, 3), { digits: 2, rounding: "ceil" })).toBe("-0.66");
  });

  it("never produces a negative zero", () => {
    expect(toDecimalString(of(-1, 1000000), { digits: 2 })).toBe("0");
  });

  it("formats zero digits with no decimal point", () => {
    expect(toDecimalString(of(7, 2), { digits: 0, rounding: "truncate" })).toBe("3");
    expect(toDecimalString(of(7, 2), { digits: 0, rounding: "ceil" })).toBe("4");
  });

  it("rejects a negative digit count", () => {
    expect(() => toDecimalString(of(1, 2), { digits: -1 })).toThrow();
  });
});

describe("formatRational dispatcher", () => {
  it("defaults to fraction style", () => {
    expect(formatRational(of(12, 5))).toBe("12/5");
  });

  it("supports mixed and decimal styles", () => {
    expect(formatRational(of(7, 3), { style: "mixed" })).toBe("2 1/3");
    expect(formatRational(of(1, 8), { style: "decimal", digits: 3 })).toBe("0.125");
  });
});
