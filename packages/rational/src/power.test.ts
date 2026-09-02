import { describe, expect, it } from "vitest";
import { powerAtClock, toApproximateNumber } from "./power";
import { of } from "./rational";

describe("toApproximateNumber", () => {
  it("converts a Rational to its nearest float", () => {
    expect(toApproximateNumber(of(1, 2))).toBe(0.5);
    expect(toApproximateNumber(of(-3, 4))).toBe(-0.75);
    expect(toApproximateNumber(of(5, 1))).toBe(5);
  });
});

describe("powerAtClock", () => {
  it("computes base * clock^exponent", () => {
    // base=10, clock=1 (100%) -> power == base regardless of exponent.
    expect(powerAtClock(of(10), of(1), 1.321929)).toBeCloseTo(10, 10);
  });

  it("matches the documented OverclockPowerExponent formula for a known case", () => {
    // Manufacturer base power 55, clock 200% (2/1), exponent 1321929/1000000.
    const base = of(55);
    const clock = of(2, 1);
    const exponent = 1321929 / 1000000;
    const result = powerAtClock(base, clock, exponent);
    expect(result).toBeCloseTo(55 * Math.pow(2, 1.321929), 10);
  });

  it("scales with clock speed away from 1", () => {
    const base = of(100);
    const exponent = 1.321929;
    const at150 = powerAtClock(base, of(3, 2), exponent);
    const at100 = powerAtClock(base, of(1, 1), exponent);
    expect(at150).toBeGreaterThan(at100);
  });
});
