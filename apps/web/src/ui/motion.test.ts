import { D } from "@manufactory/engine";
import { describe, expect, it } from "vitest";
import { conveyor, shouldTween, sweepPeriodS, tweenDec } from "./motion.js";

describe("motion (S-14)", () => {
  it("1. the sweep period: 6 s still, 4.8 s at 9/s, 0.8 s at the clamp", () => {
    expect(sweepPeriodS(0)).toBe(6);
    expect(sweepPeriodS(9)).toBeCloseTo(4.8, 10);
    expect(sweepPeriodS(1e9)).toBe(0.8);
  });

  it("2. the conveyor: no blocks when still, at most 12, never slower as the lane speeds up", () => {
    expect(conveyor(0).blocks).toBe(0);
    expect(conveyor(1e12).blocks).toBe(12);
    expect(conveyor(0).periodS).toBe(20);
    expect(conveyor(1e12).periodS).toBe(4);
    let last = Infinity;
    for (const sum of [0, 0.1, 1, 3, 10, 50, 100, 1e3, 1e4, 1e6, 1e9, 1e12, 1e15]) {
      const { periodS, blocks } = conveyor(sum);
      expect(periodS).toBeLessThanOrEqual(last);
      expect(blocks).toBeLessThanOrEqual(12);
      last = periodS;
    }
  });

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
