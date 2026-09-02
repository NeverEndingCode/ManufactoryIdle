import { describe, expect, it } from "vitest";
import { D, DECIMAL_ONE, DECIMAL_ZERO, fromCanonical, toCanonical } from "./decimal.js";

describe("D", () => {
  it("builds from number, string, and Decimal", () => {
    expect(D(42).toNumber()).toBe(42);
    expect(D("1e100").exponent).toBe(100);
    expect(D(D(7)).toNumber()).toBe(7);
  });

  it("exposes zero and one", () => {
    expect(DECIMAL_ZERO.toNumber()).toBe(0);
    expect(DECIMAL_ONE.toNumber()).toBe(1);
  });
});

describe("canonical serialization", () => {
  const cases = ["0e0", "1e0", "1.5e0", "1e300", "1e-300", "1.2345e678", "9.999999e9999"];

  it.each(cases)("round-trips %s", (text) => {
    expect(toCanonical(fromCanonical(text))).toBe(text);
  });

  it("is stable across a second round trip", () => {
    const once = toCanonical(D("1.2345e678"));
    expect(toCanonical(fromCanonical(once))).toBe(once);
  });

  it("normalizes zero to a single representation", () => {
    expect(toCanonical(D(0))).toBe("0e0");
    expect(toCanonical(D("0e50"))).toBe("0e0");
  });

  it("survives magnitudes far past float64", () => {
    const big = D("1e6000");
    expect(fromCanonical(toCanonical(big)).exponent).toBe(6000);
  });
});
