import { describe, expect, it } from "vitest";
import { D } from "./decimal.js";
import { format, letterSuffix } from "./format.js";

describe("letterSuffix", () => {
  it("starts at two letters and rolls over correctly", () => {
    expect(letterSuffix(0)).toBe("aa");
    expect(letterSuffix(1)).toBe("ab");
    expect(letterSuffix(25)).toBe("az");
    expect(letterSuffix(26)).toBe("ba");
    expect(letterSuffix(675)).toBe("zz");
    expect(letterSuffix(676)).toBe("aaa");
  });
});

describe("format", () => {
  it("renders small values without a suffix", () => {
    expect(format(D(0), "short")).toBe("0");
    expect(format(D(5), "short")).toBe("5.00");
    expect(format(D(42.5), "short")).toBe("42.5");
    expect(format(D(999), "short")).toBe("999");
  });

  it("renders negatives", () => {
    expect(format(D(-1234), "short")).toBe("-1.23 K");
  });

  // exponent 45 -> tier 15, scaled 1.23. short/doubled land 10 places past "T",
  // and letterSuffix(10) is "ak". hybrid deliberately stops at "T", so it falls
  // back to scientific here.
  it.each([
    ["sci", "1.23e45"],
    ["eng", "1.23e45"],
    ["short", "1.23 ak"],
    ["doubled", "1.23 AK"],
    ["hybrid", "1.23e45"],
  ] as const)("renders 1.23e45 in %s mode", (mode, expected) => {
    expect(format(D("1.23e45"), mode)).toBe(expected);
  });

  it("uses short suffixes below the letter threshold", () => {
    expect(format(D(1234), "short")).toBe("1.23 K");
    expect(format(D("1.5e6"), "short")).toBe("1.50 M");
    expect(format(D("2e9"), "short")).toBe("2.00 B");
    expect(format(D("7.7e12"), "short")).toBe("7.70 T");
  });

  it("switches to letters at 1e15", () => {
    expect(format(D("1e15"), "short")).toBe("1.00 aa");
    expect(format(D("1e18"), "short")).toBe("1.00 ab");
  });

  it("doubles and uppercases letters in doubled mode", () => {
    expect(format(D("1e15"), "doubled")).toBe("1.00 AA");
    expect(format(D(1234), "doubled")).toBe("1.23 K");
  });

  it("spells out names while it has them, then falls back to scientific", () => {
    expect(format(D(1234), "names")).toBe("1.23 thousand");
    expect(format(D("3e15"), "names")).toBe("3.00 quadrillion");
    expect(format(D("1e60"), "names")).toBe("1.00e60");
  });

  it("hybrid uses short suffixes then scientific", () => {
    expect(format(D("7.7e12"), "hybrid")).toBe("7.70 T");
    expect(format(D("1e15"), "hybrid")).toBe("1.00e15");
  });

  it("carries a tier-boundary rounding into the next tier's suffix", () => {
    // mantissa ~9.99999, exponent 5 -> tier 1, scaled 999.999, which rounds
    // to "1000.00" at 2 decimals. That must promote to tier 2 ("M"), not
    // print "1000.00 K".
    expect(format(D("9.99999e5"), "short")).toBe("1.00 M");
  });

  it("carries a sub-1000 rounding into the K suffix instead of a bare 4-digit number", () => {
    // 999.99 rounds to "1000" at 0 decimals in the un-suffixed plain path;
    // that must promote to the K tier instead of showing "1000".
    expect(format(D(999.99), "short")).toBe("1.00 K");
  });

  it("is pure — mode is an argument, not global state", () => {
    const value = D("1e15");
    expect(format(value, "short")).toBe("1.00 aa");
    expect(format(value, "sci")).toBe("1.00e15");
    expect(format(value, "short")).toBe("1.00 aa");
  });
});
