import { describe, expect, it } from "vitest";
import { parseRational, RationalParseError } from "./parse";
import { of } from "./rational";

describe("parseRational — integers", () => {
  it("parses plain integers", () => {
    expect(parseRational("5")).toEqual(of(5, 1));
    expect(parseRational("-3")).toEqual(of(-3, 1));
    expect(parseRational("+5")).toEqual(of(5, 1));
    expect(parseRational("0")).toEqual(of(0, 1));
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseRational("  5  ")).toEqual(of(5, 1));
  });
});

describe("parseRational — simple fractions", () => {
  it("parses game_data.json-style fraction strings", () => {
    expect(parseRational("12/5")).toEqual(of(12, 5));
    expect(parseRational("-9/5")).toEqual(of(-9, 5));
    expect(parseRational("1321929/1000000")).toEqual(of(1321929, 1000000));
  });

  it("reduces to canonical form", () => {
    expect(parseRational("4/8")).toEqual(of(1, 2));
  });

  it("normalizes a negative denominator onto the numerator", () => {
    expect(parseRational("3/-4")).toEqual(of(-3, 4));
  });

  it("throws on a zero denominator", () => {
    expect(() => parseRational("1/0")).toThrow(RationalParseError);
  });
});

describe("parseRational — decimals", () => {
  it("parses standard decimals", () => {
    expect(parseRational("0.125")).toEqual(of(1, 8));
    expect(parseRational("-0.125")).toEqual(of(-1, 8));
  });

  it("parses decimals with no leading digit", () => {
    expect(parseRational(".5")).toEqual(of(1, 2));
    expect(parseRational("-.5")).toEqual(of(-1, 2));
  });

  it("parses decimals with no trailing digit", () => {
    expect(parseRational("5.")).toEqual(of(5, 1));
  });

  it("rejects a bare dot", () => {
    expect(() => parseRational(".")).toThrow(RationalParseError);
  });
});

describe("parseRational — mixed numbers", () => {
  it('parses "2 1/3" style input', () => {
    expect(parseRational("2 1/3")).toEqual(of(7, 3));
  });

  it("applies the sign to the whole mixed value, not just the whole part", () => {
    expect(parseRational("-2 1/3")).toEqual(of(-7, 3));
  });

  it("tolerates multiple spaces between the whole part and the fraction", () => {
    expect(parseRational("2   1/3")).toEqual(of(7, 3));
  });
});

describe("parseRational — invalid input", () => {
  it("throws a clear RationalParseError for garbage input", () => {
    expect(() => parseRational("abc")).toThrow(RationalParseError);
    expect(() => parseRational("")).toThrow(RationalParseError);
    expect(() => parseRational("1/2/3")).toThrow(RationalParseError);
    expect(() => parseRational("1..2")).toThrow(RationalParseError);
    expect(() => parseRational("1 2 3")).toThrow(RationalParseError);
  });

  it("error messages include the offending input", () => {
    expect(() => parseRational("nonsense")).toThrow(/nonsense/);
  });
});
