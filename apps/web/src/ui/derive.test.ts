import { beforeAll, describe, expect, it } from "vitest";
import type { Solution } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { fixtureState, freshState, loadSlice, snapshotOf, type Slice } from "./test-fixtures.js";
import {
  affordability,
  bottleneckRow,
  laneRows,
  satisfaction,
  stateClass,
  unlockedLanes,
} from "./derive.js";

let slice: Slice;
let fresh: Snapshot;
let tier8: Snapshot; // slice-tier-8.world.json: QS stock, power bottleneck
let full: Snapshot; // slice-tier-8-reinforced-full.world.json: screw is contested
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  tier8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
  full = snapshotOf(slice, fixtureState("slice-tier-8-reinforced-full.world.json"));
});

const P3_BUY = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
} as const;

describe("laneRows", () => {
  it("1. lists the lane's unlocked items in bundle order, with the server's rates", () => {
    const rows = laneRows(fresh, "iron");
    expect(rows.map((r) => r.itemId)).toEqual(["iron_ore", "iron_ingot", "iron_plate", "iron_rod"]);
    for (const r of rows) {
      expect(r.netPerSecond).toBe(fresh.schedule.items[r.itemId]!.netPerSecond);
    }
    expect(rows[0]!.name).toBe("Iron Ore");
    expect(rows.some((r) => r.netPerSecond !== 0)).toBe(true);
  });

  it("unlockedLanes is by order, up to the world's tier", () => {
    expect(unlockedLanes(fresh).map((l) => l.id)).toEqual(["iron", "power"]);
    expect(unlockedLanes(tier8).map((l) => l.id)).toEqual([
      "iron",
      "power",
      "copper",
      "coal",
      "oil",
    ]);
  });

  it("3. a QS chip only where quantum is non-zero; no chips on a fresh world", () => {
    const iron = laneRows(tier8, "iron");
    const nonZero = iron.filter((r) => !tier8.state.quantum[r.itemId]!.eq(0));
    expect(nonZero.length).toBeGreaterThan(0);
    for (const r of iron) {
      expect(r.quantum !== null).toBe(!tier8.state.quantum[r.itemId]!.eq(0));
    }
    const all = unlockedLanes(tier8).flatMap((l) => laneRows(tier8, l.id));
    expect(all.filter((r) => r.quantum !== null)).toHaveLength(25);

    for (const lane of unlockedLanes(fresh)) {
      for (const r of laneRows(fresh, lane.id)) {
        expect(r.quantum).toBeNull();
        expect(r.bound).toBeNull();
      }
    }
  });

  it("4. a split bar on a contested item, from its producer's allocations", () => {
    const screw = laneRows(full, "iron").find((r) => r.itemId === "screw")!;
    expect(screw.split).not.toBeNull();
    expect(screw.split).toHaveLength(2);
    const byLabel = Object.fromEntries(screw.split!.map((e) => [e.label, e.share]));
    expect(byLabel["Reinforced Iron Plate"]).toBeCloseTo(0.79, 2);
    expect(byLabel["Rotor"]).toBeCloseTo(0.21, 2);

    for (const lane of unlockedLanes(fresh)) {
      for (const r of laneRows(fresh, lane.id)) expect(r.split).toBeNull();
    }
  });
});

describe("satisfaction (P-1)", () => {
  const stub = (rates: Record<string, [number, number]>) =>
    ({
      itemRates: new Map(
        Object.entries(rates).map(([id, [production, consumption]]) => [
          id,
          { production, consumption, net: production - consumption },
        ]),
      ),
    }) as unknown as Solution;

  it("2. production over consumption, capped at 1; producer-only is 1; neither is 0", () => {
    const s = stub({ short: [1, 4], over: [5, 1], only: [2, 0], none: [0, 0] });
    expect(satisfaction(s, "short")).toBeCloseTo(0.25, 12);
    expect(satisfaction(s, "short")).toBeLessThan(1);
    expect(satisfaction(s, "over")).toBe(1);
    expect(satisfaction(s, "only")).toBe(1);
    expect(satisfaction(s, "none")).toBe(0);
    expect(satisfaction(s, "missing")).toBe(0);
  });

  it("matches the display solve on a fresh world", () => {
    const sol = fresh.display.solution;
    // iron_ore is mined and not yet consumed: producer-only.
    const ore = sol.itemRates.get("iron_ore")!;
    expect(satisfaction(sol, "iron_ore")).toBe(
      ore.consumption > 0
        ? Math.min(1, ore.production / ore.consumption)
        : ore.production > 0
          ? 1
          : 0,
    );
    expect(laneRows(fresh, "iron")[0]!.satisfaction).toBe(satisfaction(sol, "iron_ore"));
  });
});

describe("bottleneckRow (P-2, P-3)", () => {
  it("5a. fresh world: iron plate, one constructor for make_iron_plate", () => {
    const b = bottleneckRow(fresh)!;
    expect(b.laneId).toBe("iron");
    expect(b.itemId).toBe("iron_plate");
    expect(b.buy).toEqual(P3_BUY);
    expect(b.text).toBe("Limiting iron plate. 1 more Constructor clears it.");
  });

  it("5b. tier-8: power is the limit; biomass is framed, ten of its collector", () => {
    // The engine reports it as a recipe bottleneck whose limiting target is the power entry.
    expect(tier8.display.solution.bottleneck).toMatchObject({
      kind: "recipe",
      recipeId: "collect_biomass",
      limitingTarget: "power",
    });
    const b = bottleneckRow(tier8)!;
    expect(b.laneId).toBe("power");
    expect(b.itemId).toBe("biomass");
    expect(b.buy).toMatchObject({ type: "BUY_MACHINE", count: 10, recipeId: "collect_biomass" });
    expect(b.text).toMatch(/^Power is limited by biomass\. 10 more \S.* clear it\.$/);
  });

  it("5c. a storage bottleneck frames its item with no button", () => {
    const solution = {
      ...fresh.display.solution,
      bottleneck: {
        kind: "storage",
        itemId: "iron_plate",
        limitingTarget: "item:iron_plate",
        upgrade: "storage",
      },
    } as Solution;
    const stub: Snapshot = { ...fresh, display: { ...fresh.display, solution } };
    const b = bottleneckRow(stub)!;
    expect(b.laneId).toBe("iron");
    expect(b.itemId).toBe("iron_plate");
    expect(b.buy).toBeNull();
    expect(b.text.length).toBeGreaterThan(0);
  });
});

describe("bottleneckRow, the power kind (P-2)", () => {
  const withBottleneck = (bottleneck: Solution["bottleneck"]): Snapshot => ({
    ...fresh,
    display: { ...fresh.display, solution: { ...fresh.display.solution, bottleneck } },
  });

  it("a generator frames its primary output", () => {
    const b = bottleneckRow(
      withBottleneck({
        kind: "power",
        limitingTarget: "power",
        generatorRecipeId: "collect_biomass",
        machinesToClear: 3,
      }),
    )!;
    expect([b.laneId, b.itemId]).toEqual(["power", "biomass"]);
    expect(b.buy).toMatchObject({ count: 3, recipeId: "collect_biomass" });
  });

  it("no generator: no row, a notice", () => {
    const b = bottleneckRow(
      withBottleneck({
        kind: "power",
        limitingTarget: "power",
        generatorRecipeId: null,
        machinesToClear: 0,
      }),
    )!;
    expect([b.laneId, b.itemId, b.buy]).toEqual([null, null, null]);
  });
});

describe("bottleneckRow, rows not shown (P-2)", () => {
  it("an item outside the unlocked lanes frames nothing and marks no tab", () => {
    // Copper unlocks at tier 2; a fresh world is tier 0.
    const solution = {
      ...fresh.display.solution,
      bottleneck: {
        kind: "recipe",
        recipeId: "make_wire",
        limitingTarget: "item:iron_plate",
        machinesToClear: 2,
      },
    } as Solution;
    const b = bottleneckRow({ ...fresh, display: { ...fresh.display, solution } })!;
    expect([b.laneId, b.itemId, b.buy]).toEqual([null, null, null]);
    expect(b.text).toBe("Limiting iron plate. 2 more Constructors clear it.");
  });

  it("an item above the tier in an unlocked lane frames nothing either", () => {
    // Screw is tier 1, in iron.
    const solution = {
      ...fresh.display.solution,
      bottleneck: {
        kind: "recipe",
        recipeId: "make_screw",
        limitingTarget: "item:iron_plate",
        machinesToClear: 1,
      },
    } as Solution;
    const b = bottleneckRow({ ...fresh, display: { ...fresh.display, solution } })!;
    expect([b.laneId, b.itemId]).toEqual([null, null]);
  });
});

describe("stateClass", () => {
  it("fed at 98%, throttled below, paused, and idle for an item nothing makes or uses", () => {
    expect(stateClass({ satisfaction: 0.98, paused: false, idle: false })).toBe("fed");
    expect(stateClass({ satisfaction: 0.5, paused: false, idle: false })).toBe("throttled");
    expect(stateClass({ satisfaction: 1, paused: true, idle: false })).toBe("paused");
    expect(stateClass({ satisfaction: 0, paused: false, idle: true })).toBe("idle");
  });

  it("a fresh world's unmade items are idle, not throttled", () => {
    const rows = laneRows(fresh, "iron");
    const idle = rows.filter((r) => r.idle);
    expect(idle.length).toBeGreaterThan(0);
    for (const r of idle) {
      expect(r.satisfaction).toBe(0);
      expect(stateClass(r)).toBe("idle");
    }
    for (const r of rows.filter((x) => !x.idle)) {
      const flow = fresh.display.solution.itemRates.get(r.itemId)!;
      expect(flow.production > 0 || flow.consumption > 0).toBe(true);
    }
  });
});

describe("affordability (W-13)", () => {
  it("6. a fresh world's buy is ~42.6 s away, then affordable", () => {
    const { atMs } = fresh.schedule;
    const now = affordability(fresh, P3_BUY, atMs);
    expect(now.affordable).toBe(false);
    if (now.affordable) return;
    expect(now.inMs).not.toBeNull();
    expect(Math.abs(now.inMs! - 42_600)).toBeLessThanOrEqual(1_000);
    expect(affordability(fresh, P3_BUY, atMs + 60_000)).toEqual({ affordable: true });
  });

  it("an unreachable cost has inMs null", () => {
    const huge = { ...P3_BUY, count: 1000 };
    const a = affordability(fresh, huge, fresh.schedule.atMs);
    expect(a).toEqual({ affordable: false, inMs: null });
  });
});
