import { beforeAll, describe, expect, it } from "vitest";
import { apply, POWER_ENTRY_ID, type ItemId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import {
  dropIndex,
  powerMoveNeedsConfirm,
  reorderVisible,
  visiblePriority,
} from "./priority-model.js";
import { fixtureState, freshState, loadSlice, snapshotOf, type Slice } from "./test-fixtures.js";

let slice: Slice;
let fresh: Snapshot;
let t8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  t8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});

const ids = (s: Snapshot) => s.state.priority.map((e) => e.id);
const visibleIds = (s: Snapshot) => visiblePriority(s).map((r) => r.entryId);

/** mulberry32: a fixed-seed generator for the property test. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("1. visiblePriority (Q-8)", () => {
  it("a fresh world shows power and the five unlocked items, in list order, of 33", () => {
    // The brief says 32: start.priority names all 32 items, and power makes 33.
    expect(fresh.state.priority).toHaveLength(33);
    expect(visibleIds(fresh)).toEqual([
      "power",
      "item:iron_plate",
      "item:iron_rod",
      "item:iron_ingot",
      "item:iron_ore",
      "item:biomass",
    ]);
  });

  it("tier 8 shows every entry whose item is unlocked", () => {
    const { content, state } = t8;
    const unlocked = state.priority
      .filter((e) => {
        if (e.kind === "power") return true;
        const item = content.items.get(e.itemId as ItemId);
        const lane = item && content.lanes.get(item.lane);
        return !!item && !!lane && item.tier <= state.tier && lane.unlockTier <= state.tier;
      })
      .map((e) => e.id);
    expect(visibleIds(t8)).toEqual(unlocked);
    expect(unlocked.length).toBeGreaterThan(6);
  });

  it("power's satisfaction on tier 8 is min(1, the power ratio), about 0.163", () => {
    const power = visiblePriority(t8).find((r) => r.entryId === POWER_ENTRY_ID)!;
    expect(power.kind).toBe("power");
    expect(power.itemId).toBeNull();
    expect(power.satisfaction).toBeCloseTo(0.163, 3);
    expect(power.satisfaction).toBe(Math.min(1, t8.display.solution.power.ratio));
  });

  it("nonDefault reads mode, share, target and reserve, but not paused", () => {
    const base = t8.state.priority.find((e) => e.id === "item:iron_plate")!;
    const variants = [{ mode: "share" as const }, { share: 2 }, { targetRate: 3 }];
    for (const v of variants) {
      const state = {
        ...t8.state,
        priority: t8.state.priority.map((e) => (e.id === base.id ? { ...e, ...v } : e)),
      };
      const row = visiblePriority(snapshotOf(slice, state)).find((r) => r.entryId === base.id)!;
      expect(row.nonDefault).toBe(true);
    }
    const reserved = snapshotOf(slice, {
      ...t8.state,
      reserve: { ...t8.state.reserve, iron_plate: 0.25 },
    });
    const r = visiblePriority(reserved).find((x) => x.entryId === base.id)!;
    expect(r.reserve).toBe(0.25);
    expect(r.nonDefault).toBe(true);
    const paused = snapshotOf(slice, {
      ...t8.state,
      priority: t8.state.priority.map((e) => (e.id === base.id ? { ...e, paused: true } : e)),
    });
    const p = visiblePriority(paused).find((x) => x.entryId === base.id)!;
    expect(p.paused).toBe(true);
    expect(p.nonDefault).toBe(false);
  });
});

describe("2. reorderVisible (Q-8)", () => {
  it("moving iron_rod to visible index 1 swaps it with iron_plate; the 27 hidden ids stay put", () => {
    const all = ids(fresh);
    const visible = visibleIds(fresh);
    const next = reorderVisible(all, visible, "item:iron_rod", 1);
    expect(next.filter((id) => visible.includes(id))).toEqual([
      "power",
      "item:iron_rod",
      "item:iron_plate",
      "item:iron_ingot",
      "item:iron_ore",
      "item:biomass",
    ]);
    const r = apply(
      fresh.state,
      slice.content,
      { type: "REORDER_PRIORITY", entries: next },
      fresh.state.seed,
    );
    expect(r.rejected ? r.reason : "accepted").toBe("accepted");
    const hidden = all.filter((id) => !visible.includes(id));
    expect(hidden).toHaveLength(27);
    for (const id of hidden) expect(next.indexOf(id)).toBe(all.indexOf(id));
  });

  it("is always a permutation that keeps hidden ids in place, and the reducer accepts it", () => {
    const next = rng(0x5eed);
    for (const s of [fresh, t8]) {
      const all = ids(s);
      const visible = visibleIds(s);
      const hidden = all.filter((id) => !visible.includes(id));
      let order = all;
      for (let i = 0; i < 200; i += 1) {
        const shown = order.filter((id) => visible.includes(id));
        const id = shown[Math.floor(next() * shown.length)]!;
        const to = Math.floor(next() * shown.length);
        const after = reorderVisible(order, shown, id, to);
        expect([...after].sort()).toEqual([...all].sort());
        for (const h of hidden) expect(after.indexOf(h)).toBe(all.indexOf(h));
        expect(after.filter((x) => visible.includes(x)).indexOf(id)).toBe(to);
        order = after;
      }
      const r = apply(
        s.state,
        slice.content,
        { type: "REORDER_PRIORITY", entries: order },
        s.state.seed,
      );
      expect(r.rejected ? r.reason : "accepted").toBe("accepted");
    }
  });
});

describe("3. powerMoveNeedsConfirm (Q-9)", () => {
  const before = ["power", "a", "b", "c"];
  it("power moving to index 1 needs the confirm", () => {
    expect(powerMoveNeedsConfirm(before, ["a", "power", "b", "c"])).toBe(true);
  });
  it("an item moving to index 0 needs the confirm", () => {
    expect(powerMoveNeedsConfirm(before, ["b", "power", "a", "c"])).toBe(true);
  });
  it("a move between items 1 and 2 does not", () => {
    expect(powerMoveNeedsConfirm(before, ["power", "b", "a", "c"])).toBe(false);
  });
  it("no move needs it once power is already off index 0", () => {
    const off = ["a", "power", "b", "c"];
    expect(powerMoveNeedsConfirm(off, ["power", "a", "b", "c"])).toBe(false);
    expect(powerMoveNeedsConfirm(off, ["a", "b", "power", "c"])).toBe(false);
    expect(powerMoveNeedsConfirm(off, ["b", "a", "power", "c"])).toBe(false);
  });
});

describe("4. dropIndex (W-21)", () => {
  it("counts the midpoints above the pointer", () => {
    const mids = [10, 30, 50];
    expect(dropIndex(mids, 0)).toBe(0);
    expect(dropIndex(mids, 20)).toBe(1);
    expect(dropIndex(mids, 45)).toBe(2);
    expect(dropIndex(mids, 99)).toBe(3);
  });
});
