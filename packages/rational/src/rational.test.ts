import { describe, expect, it } from "vitest";
import {
  ONE,
  ZERO,
  abs,
  add,
  compare,
  divide,
  equals,
  fromBigInt,
  isNegative,
  isPositive,
  isZero,
  makeRational,
  multiply,
  negate,
  of,
  reciprocal,
  subtract,
  type Rational,
} from "./rational";

describe("makeRational canonical form", () => {
  it("reduces numerator/denominator by their gcd", () => {
    expect(makeRational(4n, 8n)).toEqual({ numerator: 1n, denominator: 2n });
    expect(makeRational(-6n, 9n)).toEqual({ numerator: -2n, denominator: 3n });
  });

  it("always normalizes the denominator to be positive, sign lives on the numerator", () => {
    expect(makeRational(3n, -4n)).toEqual({ numerator: -3n, denominator: 4n });
    expect(makeRational(-3n, -4n)).toEqual({ numerator: 3n, denominator: 4n });
  });

  it("represents zero canonically regardless of the input denominator", () => {
    expect(makeRational(0n, 5n)).toEqual({ numerator: 0n, denominator: 1n });
    expect(makeRational(0n, -5n)).toEqual({ numerator: 0n, denominator: 1n });
  });

  it("throws on a zero denominator", () => {
    expect(() => makeRational(1n, 0n)).toThrow();
  });

  it("leaves already-coprime pairs unchanged", () => {
    expect(makeRational(12n, 5n)).toEqual({ numerator: 12n, denominator: 5n });
  });
});

describe("of / fromBigInt constructors", () => {
  it("accepts number or bigint operands", () => {
    expect(of(1, 2)).toEqual({ numerator: 1n, denominator: 2n });
    expect(of(1n, 2n)).toEqual({ numerator: 1n, denominator: 2n });
    expect(of(5)).toEqual({ numerator: 5n, denominator: 1n });
  });

  it("rejects unsafe integer inputs", () => {
    expect(() => of(2 ** 60)).toThrow();
  });

  it("fromBigInt builds an integer-valued rational", () => {
    expect(fromBigInt(7n)).toEqual({ numerator: 7n, denominator: 1n });
  });
});

describe("arithmetic — canonical form is preserved by every op", () => {
  const allReduced = (r: Rational) => {
    expect(r.denominator).toBeGreaterThan(0n);
    // Re-reducing should be a no-op if r is already canonical.
    expect(makeRational(r.numerator, r.denominator)).toEqual(r);
  };

  it("add", () => {
    const result = add(of(1, 2), of(1, 3));
    expect(result).toEqual(of(5, 6));
    allReduced(result);

    // Reduction after add: 1/2 + 1/2 = 1 (not 2/2).
    expect(add(of(1, 2), of(1, 2))).toEqual(ONE);
  });

  it("subtract", () => {
    expect(subtract(of(1, 2), of(1, 3))).toEqual(of(1, 6));
    expect(subtract(of(1, 3), of(1, 2))).toEqual(of(-1, 6));
  });

  it("multiply", () => {
    const result = multiply(of(2, 3), of(3, 4));
    expect(result).toEqual(of(1, 2)); // reduces from 6/12
    allReduced(result);
  });

  it("divide", () => {
    expect(divide(of(1, 2), of(1, 3))).toEqual(of(3, 2));
    expect(divide(of(2, 4), of(1, 1))).toEqual(of(1, 2));
  });

  it("divide throws on division by zero", () => {
    expect(() => divide(of(1, 2), ZERO)).toThrow();
  });

  it("negate", () => {
    expect(negate(of(3, 4))).toEqual(of(-3, 4));
    expect(negate(of(-3, 4))).toEqual(of(3, 4));
    expect(negate(ZERO)).toEqual(ZERO);
  });

  it("reciprocal", () => {
    expect(reciprocal(of(3, 4))).toEqual(of(4, 3));
    expect(reciprocal(of(-3, 4))).toEqual(of(-4, 3));
  });

  it("reciprocal throws for zero", () => {
    expect(() => reciprocal(ZERO)).toThrow();
  });

  it("abs", () => {
    expect(abs(of(-3, 4))).toEqual(of(3, 4));
    expect(abs(of(3, 4))).toEqual(of(3, 4));
    expect(abs(ZERO)).toEqual(ZERO);
  });
});

describe("comparison", () => {
  it("compare orders across different denominators", () => {
    expect(compare(of(1, 2), of(2, 3))).toBe(-1);
    expect(compare(of(2, 3), of(1, 2))).toBe(1);
    expect(compare(of(1, 2), of(2, 4))).toBe(0);
  });

  it("equals is denominator-insensitive", () => {
    expect(equals(of(1, 2), of(2, 4))).toBe(true);
    expect(equals(of(1, 2), of(1, 3))).toBe(false);
  });

  it("isZero / isNegative / isPositive", () => {
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(of(0, 5))).toBe(true);
    expect(isZero(ONE)).toBe(false);

    expect(isNegative(of(-1, 2))).toBe(true);
    expect(isNegative(of(1, 2))).toBe(false);
    expect(isNegative(ZERO)).toBe(false);

    expect(isPositive(of(1, 2))).toBe(true);
    expect(isPositive(of(-1, 2))).toBe(false);
    expect(isPositive(ZERO)).toBe(false);
  });
});

describe("property: (a/b + c/d) - c/d == a/b, exactly", () => {
  it("holds across a grid of generated fractions, including negatives and zero", () => {
    const numerators = [-13, -7, -1, 0, 1, 2, 5, 9, 17];
    const denominators = [1, 2, 3, 4, 5, 7, 11, 100];

    let checked = 0;
    for (const a of numerators) {
      for (const b of denominators) {
        for (const c of numerators) {
          for (const d of denominators) {
            const ab = of(a, b);
            const cd = of(c, d);
            const roundTripped = subtract(add(ab, cd), cd);
            expect(equals(roundTripped, ab)).toBe(true);
            checked++;
          }
        }
      }
    }
    // Sanity check the property actually ran across a meaningful grid.
    expect(checked).toBe(numerators.length * denominators.length * numerators.length * denominators.length);
  });

  it("holds for large bigint numerators/denominators outside the safe-integer range", () => {
    const ab = makeRational(123456789012345678901234567890n, 987654321098765432109876543211n);
    const cd = makeRational(-99999999999999999999999999999n, 3n);
    expect(equals(subtract(add(ab, cd), cd), ab)).toBe(true);
  });
});
