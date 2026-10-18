import { describe, expect, it } from "vitest";
import { TapAccumulator } from "./taps.js";

describe("TapAccumulator (W-12)", () => {
  it("counts taps and measures elapsed time from load, then from each take", () => {
    let now = 1_000;
    const taps = new TapAccumulator(() => now, 400);
    taps.tap();
    taps.tap();
    taps.tap();
    expect(taps.pending).toBe(3);
    now = 1_700;
    expect(taps.take()).toEqual({ type: "TAP", count: 3, clientElapsedMs: 1_300 });
    expect(taps.pending).toBe(0);

    now = 2_000;
    expect(taps.take()).toBeNull();

    taps.tap();
    taps.tap();
    now = 2_950;
    expect(taps.take()).toEqual({ type: "TAP", count: 2, clientElapsedMs: 1_250 });
  });

  it("shows stacks optimistically, capped at maxStacks", () => {
    const taps = new TapAccumulator(() => 0, 0);
    for (let i = 0; i < 5; i += 1) taps.tap();
    expect(taps.optimistic(9, 10)).toBe(10);
    expect(taps.optimistic(2, 10)).toBe(7);
  });
});
