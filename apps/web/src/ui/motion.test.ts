import { D } from "@manufactory/engine";
import { describe, expect, it } from "vitest";
import { shouldTween, tweenDec } from "./motion.js";

describe("motion (S-14)", () => {
  it("3. tweenDec runs in log space and is exact at both ends", () => {
    const from = D(1e12);
    const to = D(1e14);
    const mid = tweenDec(from, to, 0.5).toNumber();
    expect(Math.abs(mid / 1e13 - 1)).toBeLessThan(0.01);
    expect(tweenDec(from, to, 0)).toBe(from);
    expect(tweenDec(from, to, 1)).toBe(to);
    expect(tweenDec(D("1e600"), D("1e602"), 0.5).log10()).toBeCloseTo(601, 6);
  });

  it("4. shouldTween: only past 1%, never 0→0", () => {
    expect(shouldTween(D(100), D(100.5))).toBe(false);
    expect(shouldTween(D(100), D(102))).toBe(true);
    expect(shouldTween(D(100), D(98))).toBe(true);
    expect(shouldTween(D(0), D(0))).toBe(false);
    expect(shouldTween(D(0), D(5))).toBe(true);
  });
});
