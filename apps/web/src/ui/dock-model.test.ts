// The power dock's readouts (Q-12), over the slice and an engine fixture world.
import { TAP_TIMER_ID, withInstalled } from "@manufactory/engine";
import { beforeAll, describe, expect, it } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import { TAP_LABEL } from "../sync/constants.js";
import type { Batch } from "../sync/outbox.js";
import { dockModel, generatorRows, nextMachineDrawMw, powerByLane, tapName } from "./dock-model.js";
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

  it("2b. taps in an in-flight TAP batch still count: no dip while the flush is out", () => {
    const at = CLIENT_T0 + 1_000;
    const tap = (count: number): Batch => ({
      id: 1,
      key: "k",
      label: TAP_LABEL,
      actions: [{ type: "TAP", count, clientElapsedMs: 50 }],
    });
    const other: Batch = {
      id: 2,
      key: "j",
      label: "buy",
      actions: [{ type: "TAP", count: 7, clientElapsedMs: 5 }],
    };
    const flushed = { pending: 0, lastTapAt: at, holding: true };
    expect(dockModel(fresh, flushed, at, [tap(3)]).stacks).toBe(3);
    expect(dockModel(fresh, { ...flushed, pending: 2 }, at, [tap(3), other]).stacks).toBe(5);
    expect(dockModel(fresh, flushed, at, [tap(30)]).stacks).toBe(10);
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

  it("3b. a tap after the server's kick expired counts from 0, not on the expired stacks", () => {
    const state = {
      ...freshState(slice),
      tapStacks: 3,
      timers: [{ id: TAP_TIMER_ID, kind: "tapExpiry" as const, fireAt: SERVER_T0 + 12_000 }],
    };
    const s = snapshotOf(slice, state);
    const at = CLIENT_T0 + 13_000;
    const m = dockModel(s, { pending: 1, lastTapAt: at, holding: false }, at);
    expect(m.stacks).toBe(1);
    expect(m.remainingMs).toBe(30_000);
  });
});

const FIXTURES = ["slice-tier-8.world.json", "slice-tier-8-reinforced-full.world.json"] as const;

describe("the power panel's numbers (U-6b, V-21)", { timeout: 60_000 }, () => {
  // Catches: powerByLane on the pass clocks (Σ without the ratio, i.e. fullDemandMw), a dropped
  // lane, or generators counted in.
  it("1. powerByLane adds up to demandMw on both tier-8 worlds, and on a fresh one", () => {
    for (const file of FIXTURES) {
      const s = snapshotOf(slice, fixtureState(file));
      const { demandMw, ratio } = s.display.solution.power;
      expect(ratio, file).toBeLessThan(1); // so the pass clocks would disagree
      const groups = powerByLane(s);
      const sum = groups.reduce((n, g) => n + g.mw, 0);
      expect(Math.abs(sum - demandMw), file).toBeLessThanOrEqual(1e-9 * Math.max(1, demandMw));
      expect(groups.map((g) => g.mw)).toEqual([...groups.map((g) => g.mw)].sort((a, b) => b - a));
      expect(groups.every((g) => g.mw > 0)).toBe(true);
      expect(groups.map((g) => g.laneId)).not.toContain(undefined);
    }
    const groups = powerByLane(fresh);
    const demand = fresh.display.solution.power.demandMw;
    if (demand > 0) {
      expect(groups.map((g) => g.laneId)).toEqual(["iron"]);
      expect(groups[0]!.mw).toBeCloseTo(demand, 9);
    } else expect(groups).toEqual([]);
  });

  // Catches: a locked class offered a buy, the wrong unlock tier, a missing recipeId, eats or
  // MW off the display clocks.
  it("2. generatorRows: three classes on a fresh world; on tier 8 MW now adds up to supply", () => {
    const rows = generatorRows(fresh);
    expect(rows.map((r) => r.machineClass)).toEqual([
      "biomass_burner",
      "coal_generator",
      "fuel_generator",
    ]);
    const [burner, coal, fuel] = rows;
    expect(burner).toMatchObject({ mark: 1, recipeId: "burn_biomass", lane: "power", owned: 0 });
    expect(burner!.buy).toEqual({
      type: "BUY_MACHINE",
      lane: "power",
      machineClass: "biomass_burner",
      mark: 1,
      count: 1,
      recipeId: "burn_biomass",
    });
    expect(burner!.mwEach).toBe(30);
    expect(coal).toMatchObject({ mark: null, unlockTier: 4, buy: null });
    expect(fuel).toMatchObject({ mark: null, unlockTier: 7, buy: null });

    for (const file of FIXTURES) {
      const s = snapshotOf(slice, fixtureState(file));
      const { capacity, clocks, power } = s.display.solution;
      const tap = s.display.state.tapStacks > 0 ? s.content.bundle.tap.powerInjectionMw : 0;
      const gen = generatorRows(s);
      const supply =
        gen.reduce((n, r) => n + r.mwNow, 0) + s.content.bundle.baseGridCapacityMw + tap;
      expect(Math.abs(supply - power.supplyMw), file).toBeLessThanOrEqual(1e-9);
      for (const r of gen) {
        const recipe = s.content.recipes.get(r.recipeId)!;
        const units = capacity.unitsByRecipe.get(r.recipeId) ?? 0;
        const clock = clocks.get(r.recipeId) ?? 0;
        expect(r.eats).toEqual(
          [...recipe.inputPerSecond].map(([itemId, rate]) => ({
            itemId,
            perSecond: rate * units * clock,
          })),
        );
      }
      expect(gen[0]!.owned).toBeGreaterThan(0);
      expect(gen[0]!.mwNow).toBeGreaterThan(0);
    }
  });

  // Catches: drawPerMachine (a pool mean, 0 for an empty pool) in place of the content draw.
  // The fresh world's miners are the largest draw and their pool isn't empty, so the bite is on
  // the same world with the miners dismantled: the class is still live, its pool mean is 0.
  it("4. next machine needs up to the best unlocked mark's powerDraw", () => {
    const draw = (c: string) =>
      fresh.content.machineClasses.get(c)!.marks.find((m) => m.mark === 1)!.powerDraw;
    const most = Math.max(draw("miner"), draw("smelter"), draw("constructor"), draw("collector"));
    expect(most).toBe(draw("miner"));
    expect(nextMachineDrawMw(fresh)).toBe(most);
    const base = freshState(slice);
    const noMiners = snapshotOf(slice, {
      ...withInstalled(base, "iron", "miner", 1, 0),
      assignment: { ...base.assignment, mine_iron_ore: 0 },
    });
    expect(noMiners.display.solution.capacity.drawPerMachine.get("iron::miner")).toBe(0);
    expect(nextMachineDrawMw(noMiners)).toBe(most);
    expect(nextMachineDrawMw(tier8)).toBeGreaterThanOrEqual(most);
  });

  // Catches: a wrong kick, stack or seconds format; the countdown's ceil.
  it("5. the TAP's accessible name", () => {
    const at = CLIENT_T0;
    const m = dockModel(fresh, { pending: 7, lastTapAt: at - 9_000, holding: false }, at);
    expect(tapName(m)).toBe(
      "Tap, hold to keep tapping. Kick times 1.35, 7 of 10 stacks, 21 seconds left",
    );
    expect(tapName(dockModel(fresh, NO_TAPS, at))).toBe("Tap, hold to keep the kick");
  });
});
