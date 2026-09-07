import { describe, expect, it } from "vitest";
import { makePrng, nextFloat, nextUint32 } from "./prng.js";

describe("makePrng", () => {
  it("is a pure function of the seed", () => {
    expect(makePrng(42)).toEqual(makePrng(42));
    expect(makePrng(42)).not.toEqual(makePrng(43));
  });

  it("never produces the all-zero state, which would be a fixed point", () => {
    const s = makePrng(0);
    expect(s.a | s.b | s.c | s.d).not.toBe(0);
  });
});

describe("nextUint32", () => {
  it("returns unsigned 32-bit integers", () => {
    let state = makePrng(7);
    for (let i = 0; i < 500; i += 1) {
      const step = nextUint32(state);
      expect(Number.isInteger(step.value)).toBe(true);
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThanOrEqual(0xffffffff);
      state = step.state;
    }
  });

  it("is deterministic - the same seed replays the same stream", () => {
    const draw = (seed: number, n: number): number[] => {
      let state = makePrng(seed);
      const out: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const step = nextUint32(state);
        out.push(step.value);
        state = step.state;
      }
      return out;
    };
    expect(draw(1234, 20)).toEqual(draw(1234, 20));
    expect(draw(1234, 20)).not.toEqual(draw(1235, 20));
  });

  it("does not mutate the state it is given", () => {
    const state = makePrng(99);
    const snapshot = { ...state };
    nextUint32(state);
    expect(state).toEqual(snapshot);
  });
});

describe("nextFloat", () => {
  it("stays in [0, 1) and covers the range", () => {
    let state = makePrng(5);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 2000; i += 1) {
      const step = nextFloat(state);
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThan(1);
      min = Math.min(min, step.value);
      max = Math.max(max, step.value);
      state = step.state;
    }
    expect(min).toBeLessThan(0.02);
    expect(max).toBeGreaterThan(0.98);
  });
});
