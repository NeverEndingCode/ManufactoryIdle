import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { POWER_ITEM } from "../content/types.js";
import { computeExpansion } from "../graph/expand.js";
import { indexContent } from "../graph/index-content.js";
import { computeCapacity } from "../economy/capacity.js";
import { initialWorld, withInstalled, type PriorityEntry, type WorldState } from "../state/world.js";
import {
  RESERVE_FLOOR,
  effectivePriority,
  requirementVector,
  runWaterfall,
} from "./waterfall.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

/** The fixture start: 2 miners, 2 smelters, 1 constructor, all Mk1, ladder x1. */
function base(): WorldState {
  return initialWorld(content, 1, 0);
}

function vectorsFor(state: WorldState) {
  return computeExpansion(content, state.tier, state.activeRecipe);
}

const ALL_EMPTY = new Set(["iron_ore", "iron_ingot", "iron_plate"]);

function entry(itemId: string, over: Partial<PriorityEntry> = {}): PriorityEntry {
  return {
    id: `item:${itemId}`,
    kind: "item",
    itemId,
    mode: "guaranteed",
    share: 1,
    targetRate: null,
    paused: false,
    ...over,
  };
}

describe("requirementVector", () => {
  it("traverses through every pinned-EMPTY input", () => {
    const state = base();
    const v = requirementVector(
      content,
      vectorsFor(state),
      state.activeRecipe,
      "iron_plate",
      ALL_EMPTY,
      new Map(),
    );
    // 3 make_plate units per plate/s; they pull 1.5 ingot/s needing 3 smelt units;
    // those pull 1.5 ore/s needing 1.5 mine units.
    expect(v.get("make_plate")).toBeCloseTo(3, 12);
    expect(v.get("smelt_iron")).toBeCloseTo(3, 12);
    expect(v.get("mine_iron")).toBeCloseTo(1.5, 12);
    expect(v.size).toBe(3);
  });

  it("cuts at an item that has stock, because stock can cover the deficit", () => {
    const state = base();
    const v = requirementVector(
      content,
      vectorsFor(state),
      state.activeRecipe,
      "iron_plate",
      new Set(["iron_ingot"]),
      new Map(),
    );
    // iron_ingot is pinned so we walk into it, but iron_ore is not, so it is cut.
    expect(v.get("make_plate")).toBeCloseTo(3, 12);
    expect(v.get("smelt_iron")).toBeCloseTo(3, 12);
    expect(v.has("mine_iron")).toBe(false);
  });

  it("stops at the target itself when nothing upstream is pinned", () => {
    const state = base();
    const v = requirementVector(
      content,
      vectorsFor(state),
      state.activeRecipe,
      "iron_plate",
      new Set(),
      new Map(),
    );
    expect([...v.keys()]).toEqual(["make_plate"]);
  });

  it("is empty for an item with no live recipe", () => {
    const state = base();
    const v = requirementVector(
      content,
      vectorsFor(state),
      state.activeRecipe,
      POWER_ITEM,
      ALL_EMPTY,
      new Map(),
    );
    // burn_fuel unlocks at tier 3; the world is at tier 0.
    expect(v.size).toBe(0);
  });
});

describe("runWaterfall — one target, no reserve floor", () => {
  it("depletes capacity down the chain and names the binding recipe", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });

    // Capacity is 1 constructor unit, 2 smelter units, 2 miner units.
    // Ratios: make_plate 1/3, smelt_iron 2/3, mine_iron 2/1.5. The constructor binds.
    const allocation = result.entries[0]!;
    expect(allocation.allocated).toBeCloseTo(1 / 3, 12);
    expect(allocation.limitedBy).toBe("make_plate");
    expect(allocation.limitingPerUnit).toBeCloseTo(3, 12);
    expect(allocation.runnerUpRate).toBeCloseTo(2 / 3, 12);

    expect(result.usedUnits.get("make_plate")).toBeCloseTo(1, 12);
    expect(result.usedUnits.get("smelt_iron")).toBeCloseTo(1, 12);
    expect(result.usedUnits.get("mine_iron")).toBeCloseTo(0.5, 12);
    expect(result.remainingUnits.get("make_plate")).toBeCloseTo(0, 12);
    expect(result.remainingUnits.get("smelt_iron")).toBeCloseTo(1, 12);
  });

  it("records the per-entry split that drives the split-bar UI (spec 4.2)", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate"), entry("iron_ingot")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    const smelt = result.allocations.get("smelt_iron")!;
    // iron_plate takes 1 smelter unit; iron_ingot then takes the remaining 1.
    expect(smelt.get("item:iron_plate")).toBeCloseTo(1, 12);
    expect(smelt.get("item:iron_ingot")).toBeCloseTo(1, 12);
  });

  it("honours a target rate cap and reports no limiting recipe when it is the cap", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate", { targetRate: 0.1 })],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    expect(result.entries[0]!.allocated).toBeCloseTo(0.1, 12);
    expect(result.entries[0]!.limitedBy).toBeNull();
  });

  it("skips paused entries entirely", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate", { paused: true }), entry("iron_ingot")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.itemId).toBe("iron_ingot");
    // The whole smelter capacity is now free for ingots: 2 units / 2 per ingot/s = 1.
    expect(result.entries[0]!.allocated).toBeCloseTo(1, 12);
  });
});

describe("runWaterfall — the reserve floor", () => {
  it("holds back 2% of contested capacity and hands it to a starved entry", () => {
    // 8 smelters (ladderInput 8, still under the interval of 10, so ladder x1) and
    // the 2 starting miners. iron_ingot will consume every miner unit in phase A.
    let state = base();
    state = withInstalled(state, "iron", "smelter", 1, 8);
    state = { ...state, assignment: { ...state.assignment, smelt_iron: 8 } };
    const capacity = computeCapacity(content, state);
    expect(capacity.unitsByRecipe.get("smelt_iron")).toBeCloseTo(8, 12);
    expect(capacity.unitsByRecipe.get("mine_iron")).toBeCloseTo(2, 12);

    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_ingot"), entry("iron_ore")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: RESERVE_FLOOR,
    });

    // mine_iron is contested, so phase A sees 2 * 0.98 = 1.96 units. iron_ingot
    // needs 1 mine unit per ingot/s and 2 smelt units, so it takes 1.96 ingot/s,
    // consuming 3.92 smelter units and all 1.96 available miner units.
    expect(result.entries[0]!.allocated).toBeCloseTo(1.96, 9);
    expect(result.entries[0]!.limitedBy).toBe("mine_iron");
    // iron_ore got nothing in phase A, so phase B gives it the held-back 0.04.
    expect(result.entries[1]!.allocated).toBeCloseTo(0.04, 9);
    expect(result.usedUnits.get("mine_iron")).toBeCloseTo(2, 9);
  });

  it("does not tax an uncontested recipe", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: RESERVE_FLOOR,
    });
    // Every recipe appears in exactly one vector, so nothing is contested and the
    // answer matches the reserveFloor-0 case exactly.
    expect(result.entries[0]!.allocated).toBeCloseTo(1 / 3, 12);
  });
});

describe("runWaterfall — share mode", () => {
  it("scales the group proportionally to fit remaining capacity (spec 4.2)", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [
        entry("iron_ingot", { mode: "share", share: 3 }),
        entry("iron_ore", { mode: "share", share: 1 }),
      ],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });

    // Weights 0.75 / 0.25. Group vector: smelt 0.75*2 = 1.5, mine 0.75*1 + 0.25*1 = 1.
    // Ratios against 2 smelt and 2 mine units: 2/1.5 = 4/3 and 2/1 = 2. Scale = 4/3.
    expect(result.entries[0]!.allocated).toBeCloseTo(1, 12);
    expect(result.entries[1]!.allocated).toBeCloseTo(1 / 3, 12);
    expect(result.usedUnits.get("smelt_iron")).toBeCloseTo(2, 12);
    expect(result.usedUnits.get("mine_iron")).toBeCloseTo(4 / 3, 12);
  });

  it("processes the whole group at the position of its first member", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [
        entry("iron_ore", { mode: "share", share: 1 }),
        entry("iron_plate"),
        entry("iron_ingot", { mode: "share", share: 1 }),
      ],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    expect(result.entries.map((e) => e.itemId)).toEqual([
      "iron_ore",
      "iron_ingot",
      "iron_plate",
    ]);
  });
});

describe("runWaterfall — boundaries", () => {
  it("yields zero, not NaN/Infinity, when the limiting subtree has exactly zero capacity", () => {
    // No constructors installed: make_plate capacity is exactly 0, not absent.
    const state = withInstalled(base(), "iron", "constructor", 1, 0);
    const capacity = computeCapacity(content, state);
    expect(capacity.unitsByRecipe.get("make_plate")).toBe(0);

    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });

    expect(result.entries[0]!.allocated).toBe(0);
    expect(Number.isFinite(result.entries[0]!.allocated)).toBe(true);
    expect(result.entries[0]!.limitedBy).toBe("make_plate");
    expect(result.usedUnits.get("make_plate")).toBe(0);
  });

  it("saturates exactly when two share entries' combined demand equals capacity", () => {
    // Weights 0.5/0.5: groupVector is smelt_iron 1, mine_iron 1 -- crafted to match
    // capacity exactly, so both constraints bind at ratio 1 with no slack.
    const capacityUnits = new Map<string, number>([
      ["smelt_iron", 1],
      ["mine_iron", 1],
    ]);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(base()),
      activeRecipe: base().activeRecipe,
      capacityUnits,
      entries: [
        entry("iron_ingot", { mode: "share", share: 1 }),
        entry("iron_ore", { mode: "share", share: 1 }),
      ],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });

    expect(result.entries[0]!.allocated).toBeCloseTo(0.5, 12);
    expect(result.entries[1]!.allocated).toBeCloseTo(0.5, 12);
    expect(result.usedUnits.get("smelt_iron")).toBeCloseTo(1, 12);
    expect(result.usedUnits.get("mine_iron")).toBeCloseTo(1, 12);
    expect(result.remainingUnits.get("smelt_iron")).toBeCloseTo(0, 12);
    expect(result.remainingUnits.get("mine_iron")).toBeCloseTo(0, 12);
  });

  it("reports no limiting recipe when a targetRate cap binds exactly at available capacity", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    // Capacity ceiling for iron_plate is exactly 1/3 (see the no-reserve-floor
    // test above). Requesting exactly that should read as satisfied, not limited.
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [entry("iron_plate", { targetRate: 1 / 3 })],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    expect(result.entries[0]!.allocated).toBeCloseTo(1 / 3, 12);
    expect(result.entries[0]!.limitedBy).toBeNull();
  });
});

describe("effectivePriority", () => {
  it("overrides the power entry's target rate with the grid demand", () => {
    const state = base();
    const capacity = computeCapacity(content, state);
    const entries = effectivePriority(content, state, capacity, 137);
    expect(entries[0]!.kind).toBe("power");
    expect(entries[0]!.targetRate).toBe(137);
  });

  it("injects a reserve entry right after power (ruling R8)", () => {
    const state = { ...base(), reserve: { ...base().reserve, iron_ore: 0.25 } };
    const capacity = computeCapacity(content, state);
    const entries = effectivePriority(content, state, capacity, 0);
    expect(entries[1]!.id).toBe("reserve:iron_ore");
    // Unconstrained ore production is 2 units x 1 ore/s = 2/s; 25% of it is 0.5/s.
    expect(entries[1]!.targetRate).toBeCloseTo(0.5, 12);
    expect(entries[2]!.itemId).toBe("iron_plate");
  });

  it("drops paused entries and adds no reserve entry at zero percent", () => {
    const state = base();
    const paused = {
      ...state,
      priority: state.priority.map((e) =>
        e.itemId === "iron_ingot" ? { ...e, paused: true } : e,
      ),
    };
    const entries = effectivePriority(content, paused, computeCapacity(content, paused), 0);
    expect(entries.some((e) => e.itemId === "iron_ingot")).toBe(false);
    expect(entries.some((e) => e.id.startsWith("reserve:"))).toBe(false);
  });
});
