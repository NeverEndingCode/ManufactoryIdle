// U-9a, L-4..L-8: the factory log's model (pure drafts per adoption) and its book (the dedupe,
// the reset on a world change, the ring).
import { describe, expect, it, vi } from "vitest";
import {
  applyBatch,
  itemStateTag,
  liquidCap,
  withInstalled,
  type Action,
  type Bottleneck,
  type ItemId,
  type WorldState,
} from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import type { Batch } from "../sync/outbox.js";
import type { AdoptEvent } from "../sync/store.js";
import { BOTTLENECK_BUY_LABEL, bottleneckRow, rateText } from "./derive.js";
import { mwText } from "./dock-model.js";
import {
  createFactoryLog,
  DEDUPE_MS,
  FULL_EVERY_MS,
  itemOfLabel,
  LOG_CAP,
  logEntries,
  logTime,
  type LogDraft,
} from "./factory-log.js";
import { fmt } from "./notation.js";
import { unlockSummary, unlockedAt } from "./unlocks.js";
import { fixtureState, freshState, ID_LIKE, loadSlice, snapshotOf } from "./test-fixtures.js";

const slice = loadSlice();
const t8State = fixtureState("slice-tier-8.world.json");
const t8 = snapshotOf(slice, t8State);

function after(prev: Snapshot, actions: Action[]): Snapshot {
  const r = applyBatch(prev.state, slice.content, actions, prev.state.seed);
  if (r.rejected) throw new Error(r.reason);
  return snapshotOf(slice, r.state, { stateVersion: prev.stateVersion + 1 });
}

let batchId = 0;
function batch(label: string, actions: Action[], id = ++batchId): Batch {
  return { id, key: `k${id}`, actions, label };
}

/** The same snapshot with the display solve's bottleneck replaced. */
function withBottleneck(s: Snapshot, b: Bottleneck): Snapshot {
  return { ...s, display: { ...s.display, solution: { ...s.display.solution, bottleneck: b } } };
}

const storageOn = (itemId: ItemId): Bottleneck => ({
  kind: "storage",
  itemId,
  limitingTarget: itemId,
  upgrade: null,
});

/** Each listed item at its liquid cap: FULL. */
function topped(w: WorldState, ids: ItemId[]): WorldState {
  const stored = { ...w.stored };
  for (const id of ids) stored[id] = liquidCap(slice.content, w, id);
  return { ...w, stored };
}

const rates = (prev: Snapshot, next: Snapshot, id: ItemId) =>
  `${rateText(prev.schedule.items[id]!.netPerSecond).replace(/\/s$/, "")} → ${rateText(next.schedule.items[id]!.netPerSecond)}`;

const texts = (ds: readonly LogDraft[]) => ds.map((d) => d.text);

describe("logEntries (U-9a, L-5..L-8)", { timeout: 60_000 }, () => {
  // Catches: dumping lines on the first snapshot of a session or of a new world (L-4).
  it("3. nothing on the first snapshot", () => {
    expect(logEntries(null, t8, null)).toEqual([]);
    expect(logEntries(null, t8, batch("drawer:iron_plate:buy", []))).toEqual([]);
  });

  // Catches: a wrong verb, count, machine, lane, item or rate; rates from the wrong snapshot; a
  // generator line with rates; ids in `said`; a key that isn't the batch's.
  it("4. a purchase, for each L-6 row", () => {
    const buy: Action = {
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 4,
    };
    const one = (label: string, action: Action, prev = t8) => {
      const next = after(prev, [action]);
      const b = batch(label, [action]);
      const ds = logEntries(prev, withBottleneck(next, prev.display.solution.bottleneck), b);
      const line = ds.find((d) => d.key === `buy:${b.id}`)!;
      expect(line, label).toBeDefined();
      expect(line.tone).toBe("normal");
      expect(line.said, line.said).not.toMatch(ID_LIKE);
      return { line, next };
    };

    let r = one("drawer:iron_plate:buy", buy);
    expect(r.line.text).toBe(
      `bought 4 CONSTRUCTOR_MK1 (IRON) · IRON_PLATE ${rates(t8, r.next, "iron_plate")}`,
    );
    expect(r.line.said).toBe(
      `Bought 4 Constructor Mk.1 (Iron) · Iron Plate ${rates(t8, r.next, "iron_plate")}`,
    );

    // The bottleneck buy names prev's framed item.
    const framed = withBottleneck(t8, storageOn("screw"));
    expect(bottleneckRow(framed)?.itemId).toBe("screw");
    r = one(BOTTLENECK_BUY_LABEL, buy, framed);
    expect(r.line.text).toBe(
      `bought 4 CONSTRUCTOR_MK1 (IRON) · SCREW ${rates(framed, r.next, "screw")}`,
    );

    const burner: Action = {
      type: "BUY_MACHINE",
      lane: "power",
      machineClass: "biomass_burner",
      mark: 1,
      count: 1,
    };
    // Biomass in stock, so the new burner adds supply.
    const fuelled = snapshotOf(slice, topped(t8State, ["biomass"]));
    r = one("power:biomass_burner:buy", burner, fuelled);
    const mw = (s: Snapshot) => mwText(s.display.solution.power.supplyMw);
    expect(mw(r.next)).not.toBe(mw(fuelled));
    expect(r.line.text).toBe(
      `bought 1 BIOMASS_BURNER_MK1 (POWER) · grid ${mw(fuelled)} → ${mw(r.next)} MW`,
    );
    expect(r.line.said).toBe(
      `Bought 1 Biomass Burner Mk.1 (Power) · grid ${mw(fuelled)} → ${mw(r.next)} MW`,
    );

    r = one("drawer:iron_plate:storage", { type: "BUY_STORAGE", itemId: "iron_plate", levels: 1 });
    const cap = (s: Snapshot) => fmt(liquidCap(s.content, s.state, "iron_plate"));
    expect(cap(r.next)).not.toBe(cap(t8));
    expect(r.line.text).toBe(`storage +1 IRON_PLATE · cap ${cap(t8)} → ${cap(r.next)}`);
    expect(r.line.said).toBe(`Storage +1 Iron Plate · cap ${cap(t8)} → ${cap(r.next)}`);

    r = one("drawer:iron_plate:dismantle", { ...buy, type: "DISMANTLE", count: 2 });
    expect(r.line.text).toBe(
      `dismantled 2 CONSTRUCTOR_MK1 (IRON) · IRON_PLATE ${rates(t8, r.next, "iron_plate")}`,
    );

    r = one("drawer:iron_plate:upgrade", {
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "constructor",
      fromMark: 1,
    });
    expect(r.line.text).toBe(
      `upgraded CONSTRUCTOR_MK1 → CONSTRUCTOR_MK2 (IRON) · IRON_PLATE ${rates(t8, r.next, "iron_plate")}`,
    );
    expect(r.line.said).toBe(
      `Upgraded Constructor Mk.1 → Constructor Mk.2 (Iron) · Iron Plate ${rates(t8, r.next, "iron_plate")}`,
    );

    // Everything in stock, so the QS level is affordable.
    const rich = snapshotOf(slice, topped(t8State, slice.content.stockItemIds));
    r = one("drawer:iron_plate:qs", { type: "BUY_QS", lane: "iron", levels: 1 }, rich);
    expect(r.line.text).toBe("qs +1 --lane IRON");
    expect(r.line.said).toBe("Quantum storage +1 · Iron lane");

    // An unknown label: no rate clause.
    r = one("somewhere else", buy);
    expect(r.line.text).toBe("bought 4 CONSTRUCTOR_MK1 (IRON)");
    expect(r.line.said).toBe("Bought 4 Constructor Mk.1 (Iron)");

    // The first spend in the batch, after a setting.
    const mixed = batch("drawer:iron_plate:buy", [
      { type: "SET_RESERVE", itemId: "iron_plate", percent: 0.1 },
      buy,
      { ...buy, count: 9 },
    ]);
    expect(texts(logEntries(t8, t8, mixed))[0]).toMatch(/^bought 4 CONSTRUCTOR_MK1 \(IRON\)/);
  });

  it("4b. itemOfLabel", () => {
    expect(itemOfLabel("drawer:iron_plate:buy", t8)).toBe("iron_plate");
    expect(itemOfLabel("drawer:no_such_item:buy", t8)).toBeNull();
    expect(itemOfLabel("power:biomass_burner:buy", t8)).toBeNull();
    expect(itemOfLabel(BOTTLENECK_BUY_LABEL, withBottleneck(t8, storageOn("rotor")))).toBe("rotor");
    expect(itemOfLabel(BOTTLENECK_BUY_LABEL, withBottleneck(t8, null))).toBeNull();
    expect(itemOfLabel("nonsense", t8)).toBeNull();
  });

  // Catches: deciding by label, not by action (the reserve shares BOTTLENECK_BUY_LABEL).
  it("5. settings never log", () => {
    const next = snapshotOf(slice, t8State, { stateVersion: 1 });
    const settings: [string, Action][] = [
      [BOTTLENECK_BUY_LABEL, { type: "SET_RESERVE", itemId: "screw", percent: 0.25 }],
      ["priority", { type: "REORDER_PRIORITY", entries: t8.state.priority.map((e) => e.id) }],
      [
        "drawer:iron_plate:assign",
        { type: "ASSIGN_MACHINES", recipeId: "make_iron_plate", count: 3 },
      ],
      [
        "drawer:iron_plate:recipe",
        { type: "SELECT_RECIPE", itemId: "iron_plate", recipeId: "make_iron_plate" },
      ],
      ["tap", { type: "TAP", count: 3, clientElapsedMs: 100 }],
    ];
    for (const [label, action] of settings) {
      expect(logEntries(t8, next, batch(label, [action])), label).toEqual([]);
    }
    expect(logEntries(t8, next, null)).toEqual([]);
  });

  // Catches: logging a tag already FULL in prev, an item with no row, or a wrong key or tone.
  it("6. storage full", () => {
    const tag = (s: Snapshot, id: ItemId) => itemStateTag(s.content, s.display.state, id);
    expect(tag(t8, "iron_plate")).not.toBe("FULL");
    const full = snapshotOf(slice, topped(t8State, ["iron_plate", "heavy_modular_frame"]), {
      stateVersion: 1,
    });
    expect(tag(full, "iron_plate")).toBe("FULL");
    expect(tag(full, "heavy_modular_frame")).toBe("FULL");
    const fulls = (ds: LogDraft[]) => ds.filter((d) => d.key.startsWith("full:"));

    const ds = fulls(logEntries(t8, full, null));
    // heavy_modular_frame is tier 9: no row at tier 8, so no line.
    expect(ds).toEqual([
      {
        tone: "normal",
        key: "full:iron_plate",
        text: "IRON_PLATE storage full · raise it or use it",
        said: "Iron Plate storage full · raise it or use it",
      },
    ]);
    const again = snapshotOf(slice, topped(t8State, ["iron_plate"]), { stateVersion: 2 });
    expect(fulls(logEntries(full, again, null))).toEqual([]);
  });

  // Catches: a missed move, appearance or clearance; a key that isn't the destination's; a line
  // for the same key; an id for a frameless bottleneck.
  it("7. the bottleneck", () => {
    const at = (b: Bottleneck) => withBottleneck(t8, b);
    const only = (prev: Snapshot, next: Snapshot) => {
      const ds = logEntries(prev, next, null);
      expect(ds.every((d) => d.tone === "advice")).toBe(true);
      for (const d of ds) expect(d.said, d.said).not.toMatch(ID_LIKE);
      return ds.map(({ key, text, said }) => ({ key, text, said }));
    };
    expect(only(at(storageOn("screw")), at(storageOn("rotor")))).toEqual([
      {
        key: "bottleneck:item:rotor",
        text: "bottleneck moved: SCREW → ROTOR",
        said: "Bottleneck moved: Screw → Rotor",
      },
    ]);
    expect(only(at(null), at(storageOn("rotor")))).toEqual([
      { key: "bottleneck:item:rotor", text: "bottleneck: ROTOR", said: "Bottleneck: Rotor" },
    ]);
    expect(only(at(storageOn("rotor")), at(null))).toEqual([
      { key: "bottleneck:none", text: "bottleneck cleared", said: "Bottleneck cleared" },
    ]);
    const power: Bottleneck = {
      kind: "power",
      limitingTarget: "power",
      generatorRecipeId: null,
      machinesToClear: 1,
      mark: null,
    };
    expect(only(at(storageOn("screw")), at(power))).toEqual([
      {
        key: "bottleneck:\u0000frameless",
        text: "bottleneck moved: SCREW → power",
        said: "Bottleneck moved: Screw → power",
      },
    ]);
    // Frameless and not power: an item with no row (tier 9 at tier 8).
    expect(only(at(null), at(storageOn("heavy_modular_frame")))).toEqual([
      {
        key: "bottleneck:\u0000frameless",
        text: "bottleneck: unlisted",
        said: "Bottleneck: unlisted",
      },
    ]);
    expect(only(at(storageOn("rotor")), at(storageOn("rotor")))).toEqual([]);
    expect(only(at(power), at(storageOn("heavy_modular_frame")))).toEqual([]);
  });

  // Catches: a tier-up missed, logged as normal, or out of L-8's order.
  it("8. a tier-up: one milestone, after the purchase, before full and the bottleneck", () => {
    const base = freshState(slice);
    const prevState: WorldState = { ...base, tier: 2 };
    let nextState: WorldState = withInstalled({ ...base, tier: 3 }, "iron", "miner", 1, 3);
    nextState = topped(nextState, ["iron_ore"]);
    const prev = withBottleneck(snapshotOf(slice, prevState), null);
    const next = withBottleneck(
      snapshotOf(slice, nextState, { stateVersion: 1 }),
      storageOn("screw"),
    );
    const buy: Action = {
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "miner",
      mark: 1,
      count: 1,
    };
    const b = batch("drawer:iron_ore:buy", [buy]);
    const ds = logEntries(prev, next, b);
    const summary = unlockSummary(next, unlockedAt(slice.content, 3), "shell");
    expect(summary).toBe("ROTOR, COPPER_SHEET +5");
    expect(ds.map((d) => [d.tone, d.key])).toEqual([
      ["normal", `buy:${b.id}`],
      ["milestone", "tier:3"],
      ["normal", "full:iron_ore"],
      ["advice", "bottleneck:item:screw"],
    ]);
    expect(ds[1]!.text).toBe("TIER 3 reached · ROTOR, COPPER_SHEET +5 unlocked");
    expect(ds[1]!.said).toBe("Tier 3 reached · Rotor, Copper Sheet +5 unlocked");
    expect(ds.filter((d) => d.tone === "milestone")).toHaveLength(1);
  });
});

describe("createFactoryLog (U-9a, L-8)", { timeout: 60_000 }, () => {
  function rig() {
    let now = 5_000_000;
    const wall = new Date(2026, 10, 7, 14, 2, 11).getTime();
    const book = createFactoryLog({ now: () => now, wallNow: () => wall });
    const fired = vi.fn();
    book.subscribe(fired);
    return {
      book,
      fired,
      wall,
      at(ms: number, e: AdoptEvent) {
        now = 5_000_000 + ms;
        book.record(e);
      },
    };
  }
  const A = withBottleneck(t8, storageOn("screw"));
  const B = withBottleneck(t8, storageOn("rotor"));
  const none = withBottleneck(t8, null);
  const ev = (prev: Snapshot | null, next: Snapshot, settled: Batch | null = null): AdoptEvent => ({
    prev,
    next,
    settled,
  });

  // Catches: deduping on text (the "bottleneck: ROTOR" line shares A→B's key), or on the wall
  // clock (frozen here), or a window that slides with each dropped repeat.
  it("9. the 60 s dedupe, per key, on the monotonic clock", () => {
    const r = rig();
    r.at(0, ev(A, B));
    r.at(10_000, ev(B, A));
    r.at(20_000, ev(A, B));
    r.at(30_000, ev(none, B));
    expect(r.book.entries().map((e) => e.text)).toEqual([
      "bottleneck moved: SCREW → ROTOR",
      "bottleneck moved: ROTOR → SCREW",
    ]);
    expect(DEDUPE_MS).toBe(60_000);
    r.at(61_000, ev(A, B));
    expect(r.book.entries()).toHaveLength(3);
    expect(r.book.entries()[2]!.atLocalMs).toBe(r.wall);
    expect(r.book.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  // Catches: two identical buys merged (purchases are keyed by batch, never deduped: L-6).
  it("9b. two identical buys 5 s apart are both kept", () => {
    const r = rig();
    const buy: Action = {
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 1,
    };
    const next = after(none, [buy]);
    r.at(0, ev(none, withBottleneck(next, null), batch("drawer:iron_plate:buy", [buy])));
    r.at(5_000, ev(none, withBottleneck(next, null), batch("drawer:iron_plate:buy", [buy])));
    expect(r.book.entries().filter((e) => e.text.startsWith("bought"))).toHaveLength(2);
  });

  // Catches: the EPSILON flip (PL-2) logging FULL at every boundary: at most one line per 10 min.
  it("10. storage full at most once per 10 minutes, however often it flickers", () => {
    const r = rig();
    const full = withBottleneck(snapshotOf(slice, topped(t8State, ["iron_plate"])), null);
    const fulls = () => r.book.entries().filter((e) => e.key === "full:iron_plate");
    expect(FULL_EVERY_MS).toBe(600_000);
    // A flip every minute: FULL at each even minute.
    for (let m = 0; m < 10; m++) r.at(m * 60_000, m % 2 === 0 ? ev(none, full) : ev(full, none));
    expect(fulls()).toHaveLength(1);
    r.at(10 * 60_000, ev(none, full));
    expect(fulls()).toHaveLength(2);
    // Every 15 s for 25 more minutes: one line at 20 min and one at 30 min, no more.
    for (let t = 10 * 60_000 + 15_000; t < 35 * 60_000; t += 15_000) {
      const i = t / 15_000;
      r.at(t, i % 2 === 0 ? ev(none, full) : ev(full, none));
    }
    expect(fulls()).toHaveLength(4);
  });

  // Catches: a world change keeping the old world's lines or its dedupe memory (L-4).
  it("11. prev null resets: entries, both dedupe maps, and the version", () => {
    const r = rig();
    const full = withBottleneck(snapshotOf(slice, topped(t8State, ["iron_plate"])), null);
    r.at(0, ev(A, B));
    r.at(1_000, ev(none, full));
    expect(r.book.entries()).toHaveLength(2);
    const v = r.book.version();
    r.fired.mockClear();
    r.at(2_000, ev(null, none));
    expect(r.book.entries()).toEqual([]);
    expect(r.book.version()).toBeGreaterThan(v);
    expect(r.fired).toHaveBeenCalledTimes(1);
    r.at(3_000, ev(none, full));
    r.at(4_000, ev(A, B));
    expect(r.book.entries().map((e) => e.key)).toEqual([
      "full:iron_plate",
      "bottleneck:item:rotor",
    ]);
  });

  // Catches: an unbounded log, a fresh array on every record (a re-render per poll), or a
  // notification with nothing new.
  it("12. the ring keeps the newest 200; entries() is stable; subscribe fires on change only", () => {
    const r = rig();
    const buy: Action = {
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 1,
    };
    expect(LOG_CAP).toBe(200);
    for (let i = 0; i < 250; i++) r.at(i * 1_000, ev(none, none, batch("x", [buy], 10_000 + i)));
    const kept = r.book.entries();
    expect(kept).toHaveLength(200);
    expect(kept[0]!.key).toBe("buy:10050");
    expect(kept.at(-1)!.key).toBe("buy:10249");
    expect(r.fired).toHaveBeenCalledTimes(250);
    const v = r.book.version();
    r.at(300_000, ev(none, none));
    r.at(
      301_000,
      ev(none, none, batch("x", [{ type: "SET_RESERVE", itemId: "screw", percent: 0.1 }])),
    );
    expect(r.book.entries()).toBe(kept);
    expect(r.book.version()).toBe(v);
    expect(r.fired).toHaveBeenCalledTimes(250);
    const unsubscribe = r.book.subscribe(r.fired);
    unsubscribe();
  });

  it("13. logTime is local and zero-padded", () => {
    expect(logTime(new Date(2026, 10, 7, 4, 5, 6).getTime())).toBe("04:05:06");
    expect(logTime(new Date(2026, 10, 7, 23, 59, 9).getTime())).toBe("23:59:09");
  });
});
