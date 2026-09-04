import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D, fromCanonical } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { liquid, liquidCap } from "../economy/storage.js";
import { initialWorld, type WorldState } from "../state/world.js";
import { COARSE_STEP_MS, EPSILON_MS, MAX_EVENTS, resolve } from "./index.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

const START = 1_700_000_000_000;
const base = (): WorldState => initialWorld(content, 42, START);

describe("guards", () => {
  it("exports the values spec C.7 names", () => {
    expect(MAX_EVENTS).toBe(10_000);
    expect(EPSILON_MS).toBe(1e-6);
    expect(COARSE_STEP_MS).toBe(60_000);
  });
});

describe("resolve — a window with no events", () => {
  it("integrates straight lines", () => {
    const r = resolve(base(), content, 60_000);
    // iron_ore and iron_ingot start at zero stock, so the very first instant sees
    // them EMPTY-pinned (spec C.3's seedPins): the requirement walk recurses
    // through them, contesting mine_iron/smelt_iron with the ore/ingot priority
    // entries and drawing the default 2% reserve floor (0.98 clock). That pin lasts
    // only until each item's liquid goes above zero, which happens at essentially
    // t=0 -- so resolve() re-solves immediately (an internal, EPSILON_MS-scale
    // "unpin" step, invisible in `events`) and the rest of the window integrates at
    // the unpinned, uncontested clock (1.0) instead. Over 60s that is, to floating
    // precision:
    //   ore   net = 2*1*1 - 2*1*0.5 = 1/s     -> 60 in 60s
    //   ingot net = 2*1*0.5 - 1*1*0.5 = 0.5/s -> 30
    //   plate net = 1*1*(1/3)         = 1/3/s -> 20 (never pinned/contested, so
    //                                             unaffected by the transition)
    expect(liquid(r.state, "iron_ore").toNumber()).toBeCloseTo(60, 6);
    expect(liquid(r.state, "iron_ingot").toNumber()).toBeCloseTo(30, 6);
    expect(liquid(r.state, "iron_plate").toNumber()).toBeCloseTo(20, 6);
    expect(r.state.tier).toBe(0);
  });

  it("accumulates gross lifetime production, not net", () => {
    const r = resolve(base(), content, 60_000);
    // Gross ore production is 2/s once unpinned, even though 1/s is consumed
    // downstream.
    expect(r.state.lifetime.iron_ore!.toNumber()).toBeCloseTo(120, 6);
    expect(r.state.lifetime.iron_ingot!.toNumber()).toBeCloseTo(60, 6);
  });

  it("reports what was produced during the window, not the lifetime total", () => {
    const first = resolve(base(), content, 60_000);
    const second = resolve(first.state, content, 60_000);
    // The second window produced another 20 plate; lifetime is now 40.
    expect(fromCanonical(second.summary.produced.iron_plate!).toNumber()).toBeCloseTo(20, 6);
    expect(second.state.lifetime.iron_plate!.toNumber()).toBeCloseTo(40, 6);
  });

  it("advances the clock and reports the window", () => {
    const r = resolve(base(), content, 60_000);
    expect(r.state.lastResolvedAt).toBe(START + 60_000);
    expect(r.summary.elapsedMs).toBe(60_000);
    expect(r.summary.simulatedMs).toBe(60_000);
    expect(r.summary.skippedMs).toBe(0);
    expect(r.summary.guardTripped).toBe(false);
  });

  it("is a no-op for zero or negative elapsed time", () => {
    for (const elapsed of [0, -5_000]) {
      const r = resolve(base(), content, elapsed);
      expect(liquid(r.state, "iron_plate").toNumber()).toBe(0);
      expect(r.state.lastResolvedAt).toBe(START);
    }
  });
});

describe("resolve — discrete events", () => {
  it("stops at a fill and backpressures afterwards", () => {
    const start = base();
    // Ore caps are 600 storage and 2400 quantum, so 600 + 2300 is 2900 of 3000 with
    // storage legally full. Net 0.98/s closes the last 100 in about 102 seconds.
    const primed: WorldState = {
      ...start,
      stored: { ...start.stored, iron_ore: D(600) },
      quantum: { ...start.quantum, iron_ore: D(2_300) },
    };
    const r = resolve(primed, content, 200_000);
    expect(r.summary.filled.some((f) => f.itemId === "iron_ore")).toBe(true);
    expect(liquid(r.state, "iron_ore").toNumber()).toBeCloseTo(3_000, 6);
    expect(liquidCap(content, r.state, "iron_ore").toNumber()).toBe(3_000);
    expect(r.events.some((e) => e.kind === "fill" && e.itemId === "iron_ore")).toBe(true);
  });

  it("delivers a milestone out of liquid stock and advances the tier (ruling R7)", () => {
    // Tier 1 needs 200 iron_plate; production is 1/3 per second, so 600 seconds.
    const r = resolve(base(), content, 700_000);
    expect(r.state.tier).toBe(1);
    expect(r.summary.tiersUnlocked).toEqual([1]);
    const milestone = r.events.find((e) => e.kind === "milestone");
    expect(milestone).toBeDefined();
    expect(milestone!.atMs).toBeGreaterThan(START + 599_000);
    expect(milestone!.atMs).toBeLessThan(START + 601_000);
    // The 200 plate was spent on delivery, then 100s at the tier-1 rate. The iron
    // lane multiplier is now x1.5, so the constructor makes 1.5 * (1/3) = 0.5/s.
    expect(liquid(r.state, "iron_plate").toNumber()).toBeCloseTo(50, 4);
  });

  it("never spends bound stock on a milestone (spec D4)", () => {
    // Tier 1's 200-plate requirement is smaller than iron_plate's own combined cap
    // (300 storage + 1200 quantum = 1500), so priming stored+quantum to zero and
    // handing settleBound a huge bound would just let D4's automatic bound->quantum
    // flow-down (already established and tested in economy/storage.test.ts) refill
    // past 200 on the very first settle() and pass trivially either way. Tier 3's
    // 20,000-plate requirement is not: it exceeds iron_plate's cap outright, so no
    // amount of bound can ever become liquid for it -- settleBound only moves stock
    // into open room (spec D4), and there is none once storage and Quantum Storage
    // are both already full. Plastic is provisioned directly as pure liquid so
    // iron_plate is the sole gate under test.
    const start = base();
    const gated: WorldState = {
      ...start,
      tier: 2,
      stored: { ...start.stored, iron_plate: D(300), plastic: D(500) },
      quantum: { ...start.quantum, iron_plate: D(1_200) },
      bound: { ...start.bound, iron_plate: D("1e9") },
    };
    const r = resolve(gated, content, 1_000);
    expect(r.state.tier).toBe(2);
    expect(r.state.bound.iron_plate!.toString()).toBe(D("1e9").toString());
  });

  it("fires a tap expiry timer and drops the stacks", () => {
    const start = base();
    const tapped: WorldState = {
      ...start,
      tapStacks: 5,
      timers: [{ id: "tap", kind: "tapExpiry", fireAt: START + 30_000 }],
    };
    const r = resolve(tapped, content, 60_000);
    expect(r.state.tapStacks).toBe(0);
    expect(r.state.timers).toEqual([]);
    expect(r.events.some((e) => e.kind === "timer" && e.timerId === "tap")).toBe(true);
  });

  it("keeps a timer that has not come due", () => {
    const start = base();
    const tapped: WorldState = {
      ...start,
      tapStacks: 5,
      timers: [{ id: "tap", kind: "tapExpiry", fireAt: START + 90_000 }],
    };
    const r = resolve(tapped, content, 60_000);
    expect(r.state.tapStacks).toBe(5);
    expect(r.state.timers).toHaveLength(1);
  });
});

describe("resolve — the offline cap", () => {
  it("simulates at most the cap but advances the clock by the whole window", () => {
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const r = resolve(base(), content, twentyFourHours);
    expect(r.summary.simulatedMs).toBe(content.offlineCapMs);
    expect(r.summary.skippedMs).toBe(twentyFourHours - content.offlineCapMs);
    expect(r.state.lastResolvedAt).toBe(START + twentyFourHours);
  });

  it("discards timers that expired during the unsimulated gap", () => {
    const start = base();
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const tapped: WorldState = {
      ...start,
      tapStacks: 5,
      timers: [{ id: "tap", kind: "tapExpiry", fireAt: START + 30_000 }],
    };
    const r = resolve(tapped, content, twentyFourHours);
    expect(r.state.timers).toEqual([]);
    expect(r.state.tapStacks).toBe(0);
  });
});

describe("resolve — split invariance (spec E.6)", () => {
  const halves = [60_000, 300_000, 350_000, 1_800_000];

  it.each(halves)("resolve(s, 2*%i) matches resolve(resolve(s, t), t)", (t) => {
    const whole = resolve(base(), content, 2 * t);
    const first = resolve(base(), content, t);
    const split = resolve(first.state, content, t);

    // Discrete state must match exactly (spec E.4).
    expect(split.state.tier).toBe(whole.state.tier);
    expect(split.state.installed).toEqual(whole.state.installed);
    expect(split.state.storageLevel).toEqual(whole.state.storageLevel);
    expect(split.state.qsLevel).toEqual(whole.state.qsLevel);
    expect(split.state.timers).toEqual(whole.state.timers);
    expect(split.state.tapStacks).toBe(whole.state.tapStacks);
    expect(split.state.lastResolvedAt).toBe(whole.state.lastResolvedAt);

    // Magnitudes match within spec E.4's relative tolerance.
    for (const itemId of content.stockItemIds) {
      for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
        const a = whole.state[field][itemId]!.toNumber();
        const b = split.state[field][itemId]!.toNumber();
        const scale = Math.max(1, Math.abs(a));
        expect(Math.abs(a - b) / scale).toBeLessThan(1e-9);
      }
    }
  });

  it("agrees when the split lands exactly on the milestone instant", () => {
    // The tier-1 milestone completes at exactly 600 seconds. Both branches must
    // actually deliver it here, not merely agree with each other -- settle() has to
    // run on the iteration that breaks the loop (rule 2), or a window ending exactly
    // on a milestone (or fill/drain) instant silently drops it on both sides at once,
    // which a whole-vs-split comparison alone would not catch.
    const whole = resolve(base(), content, 600_000);
    const split = resolve(resolve(base(), content, 300_000).state, content, 300_000);
    expect(whole.state.tier).toBe(1);
    expect(split.state.tier).toBe(whole.state.tier);
    expect(liquid(split.state, "iron_plate").toNumber()).toBeCloseTo(
      liquid(whole.state, "iron_plate").toNumber(),
      6,
    );
  });
});

describe("resolve — invariants", () => {
  it("never produces a negative stockpile or a NaN over a long window", () => {
    const r = resolve(base(), content, 8 * 60 * 60 * 1000);
    for (const itemId of content.stockItemIds) {
      for (const field of ["stored", "quantum", "bound", "lifetime"] as const) {
        const value = r.state[field][itemId]!;
        expect(Number.isNaN(value.toNumber())).toBe(false);
        expect(value.gte(0)).toBe(true);
      }
    }
  });

  it("never leaves an item above its combined cap", () => {
    const r = resolve(base(), content, 8 * 60 * 60 * 1000);
    for (const itemId of content.stockItemIds) {
      expect(liquid(r.state, itemId).lte(liquidCap(content, r.state, itemId).plus(1e-6))).toBe(true);
    }
  });

  it("does not trip the guards on a legitimate factory", () => {
    const r = resolve(base(), content, 8 * 60 * 60 * 1000);
    expect(r.summary.guardTripped).toBe(false);
    expect(r.summary.events).toBeLessThan(MAX_EVENTS);
  });
});
