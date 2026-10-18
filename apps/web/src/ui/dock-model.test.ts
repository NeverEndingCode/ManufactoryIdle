// The power dock's readouts (Q-12), over the slice and an engine fixture world.
import { TAP_TIMER_ID } from "@manufactory/engine";
import { beforeAll, describe, expect, it } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import { dockModel } from "./dock-model.js";
import {
  CLIENT_T0,
  SERVER_T0,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  type Slice,
} from "./test-fixtures.js";

const NO_TAPS = { pending: 0, lastTapAt: null, holding: false };

let slice: Slice;
let fresh: Snapshot;
let tier8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  tier8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});

describe("dockModel (Q-12)", () => {
  it("1. tier 8: the grid, and power limits production", () => {
    const m = dockModel(tier8, NO_TAPS, CLIENT_T0);
    expect(m.demandMw).toBeCloseTo(472.5, 1);
    expect(m.supplyMw).toBeCloseTo(477.3, 1);
    expect(m.fullDemandMw).toBeCloseTo(2_898.5, 1);
    expect(m.ratio).toBeLessThan(1);
    const b = tier8.display.solution.bottleneck;
    expect(b?.kind === "recipe" && b.recipeId).toBe("collect_biomass");
    expect(m.limited).toBe(true);
  });

  it("2. pending taps show at once: stacks, kick, injection, 30 s from the last tap", () => {
    expect(dockModel(fresh, NO_TAPS, CLIENT_T0)).toMatchObject({
      stacks: 0,
      kick: 1,
      injectionMw: 0,
      remainingMs: 0,
      maxStacks: 10,
    });
    const at = CLIENT_T0 + 1_000;
    const m = dockModel(fresh, { pending: 5, lastTapAt: at, holding: true }, at);
    expect(m.stacks).toBe(5);
    expect(m.kick).toBeCloseTo(1.25, 10);
    expect(m.injectionMw).toBe(25);
    expect(m.remainingMs).toBe(30_000);
    expect(dockModel(fresh, { pending: 50, lastTapAt: at, holding: true }, at).stacks).toBe(10);
  });

  it("3. the server's tap-expiry timer, counted down on the client's clock", () => {
    const state = {
      ...freshState(slice),
      tapStacks: 3,
      timers: [{ id: TAP_TIMER_ID, kind: "tapExpiry" as const, fireAt: SERVER_T0 + 12_000 }],
    };
    const s = snapshotOf(slice, state);
    const m = dockModel(s, NO_TAPS, CLIENT_T0);
    expect(m.remainingMs).toBeCloseTo(12_000, 0);
    expect(m.stacks).toBe(3);
    expect(dockModel(s, NO_TAPS, CLIENT_T0 + 4_000).remainingMs).toBeCloseTo(8_000, 0);
    // Past the expiry, the kick is gone before the next snapshot says so.
    expect(dockModel(s, NO_TAPS, CLIENT_T0 + 13_000)).toMatchObject({ remainingMs: 0, stacks: 0 });
  });
});
