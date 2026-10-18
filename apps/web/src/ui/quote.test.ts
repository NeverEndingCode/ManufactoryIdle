import { beforeAll, describe, expect, it } from "vitest";
import {
  apply,
  D,
  liquid,
  MAX_ACTION_COUNT,
  type Action,
  type Effect,
  type IndexedContent,
} from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { fixtureState, freshState, loadSlice, snapshotOf, type Slice } from "./test-fixtures.js";
import { affordability, creditFor, isSpend, maxAffordableCount, quote } from "./quote.js";

let slice: Slice;
let fresh: Snapshot;
let t8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  t8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});

const P3_BUY = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
} as const;

const SPENDS: Action[] = [
  { type: "BUY_MACHINE", lane: "power", machineClass: "collector", mark: 2, count: 10 },
  { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 3, count: 1 },
  { type: "DISMANTLE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 },
  { type: "UPGRADE_MARK", lane: "iron", machineClass: "constructor", fromMark: 1 },
  { type: "UPGRADE_MARK", lane: "iron", machineClass: "miner", fromMark: 1 },
  { type: "BUY_STORAGE", itemId: "iron_plate", levels: 1 },
  { type: "BUY_QS", lane: "copper", levels: 1 },
];

const strings = (m: Map<string, { toString(): string }>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v.toString()]));

function effectItems(effects: Effect[], kind: "spent" | "refunded"): Record<string, string> {
  const e = effects.find((x) => x.kind === kind);
  return e && (e.kind === "spent" || e.kind === "refunded") ? e.items : {};
}

describe("quote (Q-3)", () => {
  const label = (a: Action): string =>
    Object.values(a)
      .map((v) => String(v))
      .join(" ");
  it.each(SPENDS.map((a) => [label(a), a] as const))(
    "1. %s: cost and refund are the reducer's own spent and refunded effects",
    (_type, action) => {
      const base = t8.display.state;
      const r = apply(base, slice.content, action, base.seed);
      expect(r.rejected).toBe(false);
      if (r.rejected) return;
      const q = quote(slice.content, base, action);
      expect(strings(q.cost)).toEqual(effectItems(r.effects, "spent"));
      expect(strings(q.refund)).toEqual(effectItems(r.effects, "refunded"));
      expect(isSpend(action)).toBe(true);
    },
  );

  it("settings and TAP quote empty maps, and are not spends", () => {
    const base = t8.display.state;
    for (const a of [
      { type: "SET_RESERVE", itemId: "iron_plate", percent: 0.25 },
      { type: "TAP", count: 3, clientElapsedMs: 1000 },
      { type: "ASSIGN_MACHINES", recipeId: "make_iron_plate", count: 1 },
    ] as Action[]) {
      const q = quote(slice.content, base, a);
      expect([q.cost.size, q.refund.size]).toEqual([0, 0]);
      expect(isSpend(a)).toBe(false);
    }
  });

  it("an action the reducer would reject quotes empty maps and never throws", () => {
    const base = t8.display.state;
    for (const a of [
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 9, count: 1 },
      { type: "BUY_MACHINE", lane: "iron", machineClass: "nope", mark: 1, count: 1 },
      { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 0 },
      { type: "DISMANTLE", lane: "iron", machineClass: "constructor", mark: 1, count: 999 },
      { type: "UPGRADE_MARK", lane: "iron", machineClass: "constructor", fromMark: 3 },
      { type: "BUY_STORAGE", itemId: "iron_plate", levels: 99 },
    ] as Action[]) {
      const q = quote(slice.content, base, a);
      expect([q.cost.size, q.refund.size]).toEqual([0, 0]);
    }
  });

  it("creditFor is empty when the stock covers the cost", () => {
    const base = t8.display.state;
    const q = quote(slice.content, base, SPENDS[1]!);
    expect(creditFor(base, q).size).toBe(0);
  });
});

/** The slice with the iron Miner Mk2 priced in iron ore, so an upgrade's refund pays its cost. */
function minerMk2InOre(content: IndexedContent): IndexedContent {
  const miner = content.machineClasses.get("miner")!;
  const marks = miner.marks.map((m) =>
    m.mark === 2 ? { ...m, buildCost: [{ item: "iron_ore", amount: 50 }] } : m,
  );
  const machineClasses = new Map(content.machineClasses);
  machineClasses.set("miner", { ...miner, marks });
  return { ...content, machineClasses };
}

describe("affordability (W-13, Q-3)", () => {
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

  it("UPGRADE_MARK counts its refund, as the reducer refunds before it spends", () => {
    const content = minerMk2InOre(slice.content);
    const base = { ...freshState(slice), tier: 3 }; // Miner Mk2 unlocks at tier 3
    const state = { ...base, stored: { ...base.stored, iron_ore: D(25) } };
    const s = snapshotOf({ content, checksum: slice.checksum }, state);
    const up = { type: "UPGRADE_MARK", lane: "iron", machineClass: "miner", fromMark: 1 } as const;
    const q = quote(content, s.state, up);
    const cost = q.cost.get("iron_ore")!;
    // Short without the refund, enough with it.
    expect(liquid(s.state, "iron_ore").lt(cost)).toBe(true);
    expect(liquid(s.state, "iron_ore").plus(q.refund.get("iron_ore")!).gte(cost)).toBe(true);
    expect(apply(s.state, content, up, s.state.seed).rejected).toBe(false);
    expect(affordability(s, up, s.schedule.atMs)).toEqual({ affordable: true });
  });

  it("SET_RESERVE is always affordable", () => {
    const a = { type: "SET_RESERVE", itemId: "iron_plate", percent: 0.25 } as const;
    expect(affordability(fresh, a, fresh.schedule.atMs)).toEqual({ affordable: true });
  });

  it("maxAffordableCount is exact: n is affordable and n + 1 is not", () => {
    const at = t8.schedule.atMs;
    const n = maxAffordableCount(t8, "power", "collector", 2, at);
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThan(MAX_ACTION_COUNT);
    const buy = (count: number) =>
      ({ type: "BUY_MACHINE", lane: "power", machineClass: "collector", mark: 2, count }) as const;
    expect(affordability(t8, buy(n), at)).toEqual({ affordable: true });
    expect(affordability(t8, buy(n + 1), at).affordable).toBe(false);
  });
});
