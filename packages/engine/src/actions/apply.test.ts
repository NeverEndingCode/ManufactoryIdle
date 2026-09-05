import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, installedAt, makePrng, type WorldState } from "../state/index.js";
import { apply, applyBatch } from "./index.js";
import type { Action } from "./types.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const START = 1_700_000_000_000;

// Funds every iron-lane currency this file's purchases might draw on: constructor
// mk1 costs iron_ingot, miner mk1 costs iron_ore, miner mk2 and BUY_STORAGE/BUY_QS
// cost iron_plate.
function rich(): WorldState {
  const w = initialWorld(content, 1, START);
  return {
    ...w,
    stored: {
      ...w.stored,
      iron_plate: D(100_000),
      iron_ingot: D(100_000),
      iron_ore: D(100_000),
    },
  };
}

describe("apply", () => {
  it("dispatches ten of spec D.1's eleven actions in sequence", () => {
    const ids = rich().priority.map((e) => e.id);
    const actions: Action[] = [
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
      { type: "ASSIGN_MACHINES", recipeId: "make_plate", count: 1 },
      { type: "SELECT_RECIPE", itemId: "iron_plate", recipeId: "make_plate" },
      { type: "DISMANTLE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
      // Any permutation of the current ids; here, the last entry moved to the front.
      { type: "REORDER_PRIORITY", entries: [ids[ids.length - 1]!, ...ids.slice(0, ids.length - 1)] },
      { type: "SET_PRIORITY_MODE", entryId: "item:iron_ore", mode: "share", share: 2 },
      { type: "SET_RESERVE", itemId: "iron_ore", percent: 0.1 },
      { type: "BUY_STORAGE", itemId: "iron_ore", levels: 1 },
      { type: "BUY_QS", lane: "iron", levels: 1 },
      { type: "TAP", count: 3, clientElapsedMs: 1_000 },
    ];
    let state = rich();
    for (const action of actions) {
      const result = apply(state, content, action, state.seed);
      if (result.rejected) throw new Error(`${action.type}: ${result.reason}`);
      state = result.state;
    }
    expect(state.reserve.iron_ore).toBe(0.1);
    expect(state.storageLevel.iron_ore).toBe(1);
    expect(state.qsLevel.iron).toBe(1);
    expect(state.tapStacks).toBe(3);
  });

  it("dispatches the eleventh, UPGRADE_MARK, once its mark is unlocked", () => {
    // 45 Mk1 miners at tier 1 consolidate to floor(45 * 1 / 3) = 15 Mk2.
    const start = rich();
    const bought = apply(
      { ...start, tier: 1 },
      content,
      { type: "BUY_MACHINE", lane: "iron", machineClass: "miner", mark: 1, count: 43 },
      start.seed,
    );
    if (bought.rejected) throw new Error(bought.reason);
    expect(installedAt(bought.state, "iron", "miner", 1)).toBe(45);

    const upgraded = apply(
      bought.state,
      content,
      { type: "UPGRADE_MARK", lane: "iron", machineClass: "miner", fromMark: 1 },
      bought.state.seed,
    );
    if (upgraded.rejected) throw new Error(upgraded.reason);
    expect(installedAt(upgraded.state, "iron", "miner", 1)).toBe(0);
    expect(installedAt(upgraded.state, "iron", "miner", 2)).toBe(15);
  });

  it("threads the seed onto the returned state", () => {
    const seed = makePrng(4242);
    const result = apply(
      rich(),
      content,
      { type: "SET_RESERVE", itemId: "iron_ore", percent: 0.1 },
      seed,
    );
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.seed).toEqual(seed);
  });

  it("returns a rejection rather than throwing on an invalid action", () => {
    const result = apply(
      rich(),
      content,
      { type: "BUY_MACHINE", lane: "ghost", machineClass: "miner", mark: 1, count: 1 },
      makePrng(1),
    );
    expect(result.rejected).toBe(true);
  });

  it("never mutates the state it was given", () => {
    const start = rich();
    const snapshot = JSON.stringify(start.assignment);
    apply(
      start,
      content,
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 3 },
      start.seed,
    );
    expect(JSON.stringify(start.assignment)).toBe(snapshot);
    expect(installedAt(start, "iron", "constructor", 1)).toBe(1);
  });
});

describe("applyBatch", () => {
  it("applies actions in order and concatenates their effects", () => {
    const result = applyBatch(
      rich(),
      content,
      [
        { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 2 },
        { type: "ASSIGN_MACHINES", recipeId: "make_plate", count: 3 },
      ],
      makePrng(1),
    );
    if (result.rejected) throw new Error(result.reason);
    expect(installedAt(result.state, "iron", "constructor", 1)).toBe(3);
    expect(result.state.assignment.make_plate).toBe(3);
    expect(result.effects.length).toBeGreaterThanOrEqual(3);
  });

  it("aborts the whole batch on the first failure and names which one (spec D.1)", () => {
    const result = applyBatch(
      rich(),
      content,
      [
        { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
        { type: "ASSIGN_MACHINES", recipeId: "make_plate", count: 99 },
        { type: "SET_RESERVE", itemId: "iron_ore", percent: 0.1 },
      ],
      makePrng(1),
    );
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.failedIndex).toBe(1);
    expect(result.reason).toMatch(/installed/i);
  });

  it("accepts an empty batch as a no-op", () => {
    const start = rich();
    const result = applyBatch(start, content, [], makePrng(7));
    if (result.rejected) throw new Error(result.reason);
    expect(result.effects).toEqual([]);
    expect(result.state.tier).toBe(start.tier);
  });
});
