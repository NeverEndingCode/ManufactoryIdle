import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { quantumCap, storageCap } from "../economy/storage.js";
import { initialWorld, type WorldState } from "../state/world.js";
import {
  MAX_RESERVE_PERCENT,
  TAP_TIMER_ID,
  applyBuyQs,
  applyBuyStorage,
  applyReorderPriority,
  applySetPriorityMode,
  applySetReserve,
  applyTap,
} from "./economy.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const START = 1_700_000_000_000;

function rich(plate = 100_000): WorldState {
  const w = initialWorld(content, 1, START);
  return { ...w, stored: { ...w.stored, iron_plate: D(plate) } };
}

describe("BUY_STORAGE", () => {
  it("charges the geometric run of level costs and raises the cap", () => {
    // storage curve: baseCostAmount 50, costGrowth 2, capGrowth 1.6.
    // Levels 0, 1, 2 cost 50 * (1 + 2 + 4) = 350 iron_plate.
    const result = applyBuyStorage(rich(), content, {
      type: "BUY_STORAGE",
      itemId: "iron_ore",
      levels: 3,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.storageLevel.iron_ore).toBe(3);
    expect(result.state.stored.iron_plate!.toNumber()).toBeCloseTo(100_000 - 350, 6);
    // 600 * 1.6^3 = 600 * 4.096 = 2457.6
    expect(storageCap(content, result.state, "iron_ore").toNumber()).toBeCloseTo(2457.6, 6);
  });

  it("charges from the current level, not from zero", () => {
    const start = rich();
    const atTwo: WorldState = { ...start, storageLevel: { ...start.storageLevel, iron_ore: 2 } };
    // Levels 2 and 3 cost 50 * (4 + 8) = 600.
    const result = applyBuyStorage(atTwo, content, {
      type: "BUY_STORAGE",
      itemId: "iron_ore",
      levels: 2,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.storageLevel.iron_ore).toBe(4);
    expect(result.state.stored.iron_plate!.toNumber()).toBeCloseTo(100_000 - 600, 6);
  });

  it("rejects going past the curve's maximum level", () => {
    const result = applyBuyStorage(rich(), content, {
      type: "BUY_STORAGE",
      itemId: "iron_ore",
      levels: 21,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/level/i);
  });

  it("rejects an unknown item, a non-positive level count, and an unaffordable buy", () => {
    expect(
      applyBuyStorage(rich(), content, { type: "BUY_STORAGE", itemId: "ghost", levels: 1 }).rejected,
    ).toBe(true);
    expect(
      applyBuyStorage(rich(), content, { type: "BUY_STORAGE", itemId: "iron_ore", levels: 0 })
        .rejected,
    ).toBe(true);
    expect(
      applyBuyStorage(initialWorld(content, 1, START), content, {
        type: "BUY_STORAGE",
        itemId: "iron_ore",
        levels: 1,
      }).rejected,
    ).toBe(true);
  });

  it("can be paid out of bound stock, because a container is a build (spec C.5)", () => {
    // stored and quantum start at zero here, so this purchase can only succeed by
    // drawing from bound.
    const w = initialWorld(content, 1, START);
    const bounded: WorldState = { ...w, bound: { ...w.bound, iron_plate: D(1_000) } };
    const result = applyBuyStorage(bounded, content, {
      type: "BUY_STORAGE",
      itemId: "iron_ore",
      levels: 1,
    });
    if (result.rejected) throw new Error(result.reason);
    // Level 0 costs 50 * 2^0 = 50. spendForBuild's settleBound pass (Task 7)
    // immediately migrates any leftover bound into Quantum Storage when there is
    // room, so the 950 remainder lands in `quantum`, not `bound` -- summing the
    // three tiers is what is actually conserved, not any single tier's resting
    // place.
    const remaining = result.state.bound.iron_plate!.plus(result.state.quantum.iron_plate!).plus(
      result.state.stored.iron_plate!,
    );
    expect(remaining.toNumber()).toBeCloseTo(950, 6);
  });
});

describe("BUY_QS", () => {
  it("raises every item in the lane at once (spec B.4)", () => {
    // quantumStorage curve: baseCostAmount 500, costGrowth 2.5, capGrowth 1.6.
    // Levels 0 and 1 cost 500 * (1 + 2.5) = 1750 iron_plate.
    const result = applyBuyQs(rich(), content, { type: "BUY_QS", lane: "iron", levels: 2 });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.qsLevel.iron).toBe(2);
    expect(result.state.stored.iron_plate!.toNumber()).toBeCloseTo(100_000 - 1750, 6);
    // 2400 * 1.6^2 = 6144, and 1600 * 1.6^2 = 4096.
    expect(quantumCap(content, result.state, "iron_ore").toNumber()).toBeCloseTo(6144, 6);
    expect(quantumCap(content, result.state, "iron_ingot").toNumber()).toBeCloseTo(4096, 6);
    // The oil lane is untouched.
    expect(quantumCap(content, result.state, "crude_oil").toNumber()).toBe(1600);
  });

  it("rejects an unknown lane and going past the maximum level", () => {
    expect(applyBuyQs(rich(), content, { type: "BUY_QS", lane: "ghost", levels: 1 }).rejected).toBe(
      true,
    );
    expect(applyBuyQs(rich(), content, { type: "BUY_QS", lane: "iron", levels: 16 }).rejected).toBe(
      true,
    );
  });
});

describe("REORDER_PRIORITY", () => {
  it("reorders the list to the given permutation", () => {
    const start = initialWorld(content, 1, START);
    const ids = start.priority.map((e) => e.id);
    expect(ids[0]).toBe("power");
    expect(ids[1]).toBe("item:iron_plate");
    // Move the last entry to position 2, leaving the rest in order.
    const moved = [ids[0]!, ids[ids.length - 1]!, ...ids.slice(1, ids.length - 1)];
    const result = applyReorderPriority(start, content, {
      type: "REORDER_PRIORITY",
      entries: moved,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.priority.map((e) => e.id)).toEqual(moved);
  });

  it("lets power be moved off position 1 (spec F.1: movable, with a warning)", () => {
    const start = initialWorld(content, 1, START);
    const ids = start.priority.map((e) => e.id);
    const demoted = [...ids.slice(1), ids[0]!];
    const result = applyReorderPriority(start, content, {
      type: "REORDER_PRIORITY",
      entries: demoted,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.priority[result.state.priority.length - 1]!.kind).toBe("power");
  });

  it("rejects anything that is not a permutation of the current ids", () => {
    const start = initialWorld(content, 1, START);
    const ids = start.priority.map((e) => e.id);
    const bad = [
      ids.slice(0, ids.length - 1), // too short
      [...ids.slice(0, ids.length - 1), "item:ghost"], // unknown id
      [ids[0]!, ...ids.slice(0, ids.length - 1)], // duplicate
    ];
    for (const entries of bad) {
      expect(
        applyReorderPriority(start, content, { type: "REORDER_PRIORITY", entries }).rejected,
      ).toBe(true);
    }
  });
});

describe("SET_PRIORITY_MODE", () => {
  it("switches an entry to share mode with a weight", () => {
    const result = applySetPriorityMode(initialWorld(content, 1, START), content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ingot",
      mode: "share",
      share: 3,
    });
    if (result.rejected) throw new Error(result.reason);
    const entry = result.state.priority.find((e) => e.id === "item:iron_ingot")!;
    expect(entry.mode).toBe("share");
    expect(entry.share).toBe(3);
  });

  it("sets and clears a target rate, and sets the paused flag", () => {
    const start = initialWorld(content, 1, START);
    const capped = applySetPriorityMode(start, content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ore",
      mode: "guaranteed",
      targetRate: 2.5,
      paused: true,
    });
    if (capped.rejected) throw new Error(capped.reason);
    const entry = capped.state.priority.find((e) => e.id === "item:iron_ore")!;
    expect(entry.targetRate).toBe(2.5);
    expect(entry.paused).toBe(true);

    const cleared = applySetPriorityMode(capped.state, content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ore",
      mode: "guaranteed",
      targetRate: null,
    });
    if (cleared.rejected) throw new Error(cleared.reason);
    expect(cleared.state.priority.find((e) => e.id === "item:iron_ore")!.targetRate).toBeNull();
  });

  it("leaves omitted fields alone", () => {
    const start = initialWorld(content, 1, START);
    const first = applySetPriorityMode(start, content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ore",
      mode: "share",
      share: 4,
    });
    if (first.rejected) throw new Error(first.reason);
    const second = applySetPriorityMode(first.state, content, {
      type: "SET_PRIORITY_MODE",
      entryId: "item:iron_ore",
      mode: "share",
    });
    if (second.rejected) throw new Error(second.reason);
    expect(second.state.priority.find((e) => e.id === "item:iron_ore")!.share).toBe(4);
  });

  it("rejects an unknown entry, a non-positive share, and a negative target rate", () => {
    const start = initialWorld(content, 1, START);
    expect(
      applySetPriorityMode(start, content, {
        type: "SET_PRIORITY_MODE",
        entryId: "ghost",
        mode: "guaranteed",
      }).rejected,
    ).toBe(true);
    expect(
      applySetPriorityMode(start, content, {
        type: "SET_PRIORITY_MODE",
        entryId: "item:iron_ore",
        mode: "share",
        share: 0,
      }).rejected,
    ).toBe(true);
    expect(
      applySetPriorityMode(start, content, {
        type: "SET_PRIORITY_MODE",
        entryId: "item:iron_ore",
        mode: "guaranteed",
        targetRate: -1,
      }).rejected,
    ).toBe(true);
  });
});

describe("SET_RESERVE", () => {
  it("stores the fraction", () => {
    const result = applySetReserve(initialWorld(content, 1, START), content, {
      type: "SET_RESERVE",
      itemId: "iron_ore",
      percent: 0.25,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.reserve.iron_ore).toBe(0.25);
  });

  it("rejects above the 50% ceiling rather than clamping silently (ruling R8)", () => {
    expect(MAX_RESERVE_PERCENT).toBe(0.5);
    const result = applySetReserve(initialWorld(content, 1, START), content, {
      type: "SET_RESERVE",
      itemId: "iron_ore",
      percent: 0.6,
    });
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("unreachable");
    expect(result.reason).toMatch(/50/);
  });

  it("rejects a negative percent and an unknown item", () => {
    const start = initialWorld(content, 1, START);
    expect(
      applySetReserve(start, content, { type: "SET_RESERVE", itemId: "iron_ore", percent: -0.1 })
        .rejected,
    ).toBe(true);
    expect(
      applySetReserve(start, content, { type: "SET_RESERVE", itemId: "ghost", percent: 0.1 })
        .rejected,
    ).toBe(true);
  });
});

describe("TAP", () => {
  it("adds stacks and arms one shared expiry timer (spec C.6)", () => {
    const result = applyTap(initialWorld(content, 1, START), content, {
      type: "TAP",
      count: 4,
      clientElapsedMs: 1_000,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.tapStacks).toBe(4);
    // tap.durationSeconds is 30 in the fixture.
    expect(result.state.timers).toEqual([
      { id: TAP_TIMER_ID, kind: "tapExpiry", fireAt: START + 30_000 },
    ]);
  });

  it("clamps to the tap ceiling and discards the surplus silently (spec D.5)", () => {
    // 100ms of client time allows floor(100 / 50) = 2 taps.
    const result = applyTap(initialWorld(content, 1, START), content, {
      type: "TAP",
      count: 50,
      clientElapsedMs: 100,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.tapStacks).toBe(2);
    const tapped = result.effects.find((e) => e.kind === "tapped");
    if (tapped?.kind !== "tapped") throw new Error("unreachable");
    expect(tapped.stacks).toBe(2);
    expect(tapped.discarded).toBe(48);
  });

  it("clamps stacks to the content maximum", () => {
    const result = applyTap(initialWorld(content, 1, START), content, {
      type: "TAP",
      count: 40,
      clientElapsedMs: 10_000,
    });
    if (result.rejected) throw new Error(result.reason);
    expect(result.state.tapStacks).toBe(content.bundle.tap.maxStacks);
  });

  it("refreshes the single expiry rather than adding a second timer", () => {
    const first = applyTap(initialWorld(content, 1, START), content, {
      type: "TAP",
      count: 1,
      clientElapsedMs: 1_000,
    });
    if (first.rejected) throw new Error(first.reason);
    const later: WorldState = { ...first.state, lastResolvedAt: START + 10_000 };
    const second = applyTap(later, content, { type: "TAP", count: 1, clientElapsedMs: 1_000 });
    if (second.rejected) throw new Error(second.reason);
    expect(second.state.timers).toHaveLength(1);
    expect(second.state.timers[0]!.fireAt).toBe(START + 40_000);
    expect(second.state.tapStacks).toBe(2);
  });

  it("rejects a negative count or a negative client elapsed time", () => {
    const start = initialWorld(content, 1, START);
    expect(applyTap(start, content, { type: "TAP", count: -1, clientElapsedMs: 100 }).rejected).toBe(
      true,
    );
    expect(applyTap(start, content, { type: "TAP", count: 1, clientElapsedMs: -1 }).rejected).toBe(
      true,
    );
  });
});
