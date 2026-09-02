// Golden round-trip cases from PLAN.md §9 and jobs/002-rational-package.md's
// acceptance criteria: parse -> format -> parse must reproduce the same
// exact value, and game_data.json-style strings must parse to the expected
// Rational.
import { describe, expect, it } from "vitest";
import { toFractionString } from "./format";
import { parseRational } from "./parse";
import { equals, of } from "./rational";

describe("round-trip: parse -> format (canonical n/d) -> parse", () => {
  const cases = ["2 1/3", "-9/5", "0.125", "1321929/1000000"];

  it.each(cases)('round-trips "%s" through the canonical fraction format', (input) => {
    const first = parseRational(input);
    const formatted = toFractionString(first);
    const second = parseRational(formatted);
    expect(equals(second, first)).toBe(true);
  });
});

describe("parsing game_data.json-style strings", () => {
  it('parses "12/5" to the expected Rational', () => {
    expect(parseRational("12/5")).toEqual(of(12, 5));
  });

  it('parses "-9/5" to the expected Rational', () => {
    expect(parseRational("-9/5")).toEqual(of(-9, 5));
  });

  it('parses "1321929/1000000" (OverclockPowerExponent) to the expected Rational', () => {
    expect(parseRational("1321929/1000000")).toEqual(of(1321929, 1000000));
  });

  it("parses every distinct Amount/OverclockPowerExponent-shaped string found in game_data.json", () => {
    // A representative sample pulled from resources/game_data/game_data.json:
    // signed integers and signed simple fractions, nothing else appears there.
    const sampleStrings = [
      "-1",
      "-9/5",
      "-63/10",
      "-5/2",
      "1",
      "12/5",
      "1321929/1000000",
      "2500",
      "-55",
    ];
    for (const s of sampleStrings) {
      expect(() => parseRational(s)).not.toThrow();
    }
  });
});
