import { beforeAll, describe, expect, it } from "vitest";
import { withInstalled, type Solution } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { fixtureState, freshState, loadSlice, snapshotOf, type Slice } from "./test-fixtures.js";
import {
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
    expect(b.action).toEqual(P3_BUY);
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
    expect(b.action).toMatchObject({ type: "BUY_MACHINE", count: 10, recipeId: "collect_biomass" });
    expect(b.text).toMatch(/^Power is limited by biomass\. 10 more \S.* clear it\.$/);
  });

  it("5c. a storage bottleneck frames its item, with storage +1", () => {
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
    expect(b.action).toEqual({ type: "BUY_STORAGE", itemId: "iron_plate", levels: 1 });
    expect(b.text.length).toBeGreaterThan(0);
  });
});

describe("bottleneckRow, the power kind (P-2)", () => {
  const withBottleneck = (bottleneck: Solution["bottleneck"]): Snapshot => ({
    ...fresh,
    display: { ...fresh.display, solution: { ...fresh.display.solution, bottleneck } },
  });

  it("a generator frames its scarcest stock input, never __power__", () => {
    const b = bottleneckRow(
      withBottleneck({
        kind: "power",
        limitingTarget: "power",
        generatorRecipeId: "burn_biomass",
        machinesToClear: 3,
      }),
    )!;
    expect([b.laneId, b.itemId]).toEqual(["power", "biomass"]);
    expect(b.action).toMatchObject({ count: 3, machineClass: "biomass_burner", recipeId: "burn_biomass" });
    expect(b.text).toMatch(/^Power is limited by burn biomass\. 3 more \S.* clear it\.$/);
    expect(JSON.stringify(b)).not.toContain("__power__");
  });

  it("a real engine power bottleneck frames a real row, marks its tab, and buys", () => {
    let w = { ...freshState(slice), tier: 0 };
    w = withInstalled(w, "iron", "miner", 1, 400);
    w = withInstalled(w, "power", "biomass_burner", 1, 0); // no generator installed: the engine says "buy one"
    w = { ...w, assignment: { ...w.assignment, mine_iron_ore: 400 } };
    const snap = snapshotOf(slice, w);
    expect(snap.display.solution.bottleneck).toMatchObject({
      kind: "power",
      generatorRecipeId: "burn_biomass",
    });
    const b = bottleneckRow(snap)!;
    expect(b.itemId).toBe("biomass");
    expect(b.laneId).toBe("power");
    expect(b.action).toMatchObject({ type: "BUY_MACHINE", recipeId: "burn_biomass" });
    expect(laneRows(snap, "power").some((r) => r.itemId === b.itemId)).toBe(true);
    expect(JSON.stringify(b)).not.toContain("__power__");
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
    expect([b.laneId, b.itemId, b.action]).toEqual([null, null, null]);
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
    expect([b.laneId, b.itemId, b.action]).toEqual([null, null, null]);
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

describe("bottleneckRow, the frame's other actions (Q-5)", () => {
  const withBottleneck = (s: Snapshot, bottleneck: Solution["bottleneck"]): Snapshot => ({
    ...s,
    display: { ...s.display, solution: { ...s.display.solution, bottleneck } },
  });

  it("9. storage: BUY_STORAGE for upgrade storage, BUY_QS for quantum, none for null", () => {
    const at = (upgrade: "storage" | "quantum" | null) =>
      bottleneckRow(
        withBottleneck(fresh, {
          kind: "storage",
          itemId: "iron_rod",
          limitingTarget: "item:iron_rod",
          upgrade,
        }),
      )!;
    expect(at("storage").action).toEqual({ type: "BUY_STORAGE", itemId: "iron_rod", levels: 1 });
    expect(at("quantum").action).toEqual({ type: "BUY_QS", lane: "iron", levels: 1 });
    expect(at(null).action).toBeNull();
    expect(at("quantum").itemId).toBe("iron_rod");
  });

  it("9. reserve: SET_RESERVE until the reserve is already set", () => {
    const reserve = {
      kind: "reserve",
      itemId: "iron_plate",
      percent: 0.25,
      limitingTarget: "item:iron_rod",
    } as const;
    expect(bottleneckRow(withBottleneck(fresh, reserve))!.action).toEqual({
      type: "SET_RESERVE",
      itemId: "iron_plate",
      percent: 0.25,
    });
    const set: Snapshot = { ...fresh, state: { ...fresh.state, reserve: { iron_plate: 0.25 } } };
    expect(bottleneckRow(withBottleneck(set, reserve))!.action).toBeNull();
  });

  it("10. a generator frames its scarcest stock input", () => {
    const tier6 = snapshotOf(slice, { ...freshState(slice), tier: 6 });
    const short = (scarce: string, fed: string): Snapshot => {
      const itemRates = new Map(tier6.display.solution.itemRates);
      itemRates.set(scarce, { production: 0.5, consumption: 1, net: -0.5 });
      itemRates.set(fed, { production: 0.9, consumption: 1, net: -0.1 });
      const solution = {
        ...tier6.display.solution,
        itemRates,
        bottleneck: {
          kind: "power",
          limitingTarget: "power",
          generatorRecipeId: "burn_coal",
          machinesToClear: 2,
        },
      } as Solution;
      return { ...tier6, display: { ...tier6.display, solution } };
    };
    const water = bottleneckRow(short("water", "coal"))!;
    expect([water.laneId, water.itemId]).toEqual(["oil", "water"]);
    expect(water.action).toMatchObject({ type: "BUY_MACHINE", machineClass: "coal_generator" });
    const coal = bottleneckRow(short("coal", "water"))!;
    expect([coal.laneId, coal.itemId]).toEqual(["coal", "coal"]);
  });
});
