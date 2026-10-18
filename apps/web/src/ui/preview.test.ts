import { beforeAll, describe, expect, it } from "vitest";
import {
  apply,
  D,
  itemStateTag,
  liquid,
  scheduleDetail,
  solve,
  type Action,
  type Dec,
  withInstalled,
  type WorldState,
} from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { fixtureState, freshState, loadSlice, snapshotOf, type Slice } from "./test-fixtures.js";
import { creditFor, quote } from "./quote.js";
import { preview, previewLines } from "./preview.js";

let slice: Slice;
let fresh: Snapshot;
let t8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  t8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});

const MK3 = { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 3, count: 1 } as const;
const P3_BUY = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
} as const;

const dec = (r: Readonly<Record<string, Dec>>, k: string): Dec =>
  Object.hasOwn(r, k) ? r[k]! : D(0);

describe("preview (W-13, Q-1)", () => {
  it("2. an affordable preview is the real purchase", () => {
    const base = t8.display.state;
    expect(creditFor(base, quote(slice.content, base, MK3)).size).toBe(0);
    const p = preview(t8, [MK3]);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const real = apply(base, slice.content, MK3, base.seed);
    if (real.rejected) throw new Error(real.reason);
    expect(p.state).toEqual(real.state);
    const after = scheduleDetail(real.state, slice.content).solution;
    expect(p.deltas.length).toBeGreaterThan(0);
    for (const d of p.deltas) {
      expect(d.after).toBe(after.itemRates.get(d.itemId)?.net ?? 0);
      expect(d.before).toBe(t8.display.solution.itemRates.get(d.itemId)?.net ?? 0);
    }
  });

  it("3. an unaffordable preview drains the shortfall exactly", () => {
    const base = fresh.display.state;
    const p = preview(fresh, [P3_BUY]);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.credit.get("iron_ingot")!.toNumber()).toBeCloseTo(21.3138, 3);
    expect([...p.credit.keys()]).toEqual(["iron_ingot"]);
    const left = liquid(p.state, "iron_ingot").plus(dec(p.state.bound, "iron_ingot"));
    expect(left.lte(21.31 * 1e-9)).toBe(true);
    expect(dec(p.state.bound, "iron_ingot").eq(0)).toBe(true);
    // Exactly drained, as the real buy at the moment it becomes affordable: EMPTY, not FLOWING.
    expect(liquid(p.state, "iron_ingot").eq(0)).toBe(true);
    expect(itemStateTag(slice.content, p.state, "iron_ingot")).toBe("EMPTY");
    for (const id of slice.content.stockItemIds) {
      if (id === "iron_ingot") continue;
      for (const field of ["stored", "quantum", "bound"] as const) {
        expect(dec(p.state[field], id).eq(dec(base[field], id))).toBe(true);
      }
    }
    const byItem = new Map(p.deltas.map((d) => [d.itemId, d]));
    expect(byItem.get("iron_plate")!.before).toBeCloseTo(0.3333, 4);
    expect(byItem.get("iron_plate")!.after).toBeCloseTo(0.6667, 4);
    expect(byItem.get("iron_ingot")!.before).toBeCloseTo(0.5, 6);
    expect(byItem.get("iron_ingot")!.after).toBeCloseTo(0, 6);
    expect(p.power.before.demandMw).toBeCloseTo(22, 6);
    expect(p.power.after.demandMw).toBeCloseTo(26, 6);
  });

  it("3. two Constructors: the after rates are an exactly drained state's, ingot-clamped", () => {
    // Three constructors want 1.5 ingot/s against the smelters' 1/s.
    const two = { ...P3_BUY, count: 2 };
    const p = preview(fresh, [two]);
    if (!p.ok) throw new Error(p.reason);
    expect(liquid(p.state, "iron_ingot").eq(0)).toBe(true);
    expect(itemStateTag(slice.content, p.state, "iron_ingot")).toBe("EMPTY");

    const base = fresh.display.state;
    let ref = withInstalled(base, "iron", "constructor", 1, 3);
    ref = {
      ...ref,
      assignment: { ...ref.assignment, make_iron_plate: 3 },
      stored: { ...ref.stored, iron_ingot: D(0) },
      quantum: { ...ref.quantum, iron_ingot: D(0) },
      bound: { ...ref.bound, iron_ingot: D(0) },
    };
    const want = scheduleDetail(ref, slice.content).solution;
    for (const id of ["iron_ingot", "iron_plate"]) {
      expect(p.solution.itemRates.get(id)?.net ?? 0).toBe(want.itemRates.get(id)?.net ?? 0);
    }
    expect(p.solution.itemRates.get("iron_ingot")!.net).toBeCloseTo(0, 9);
    // Unclamped, three constructors would make 1/s; the ingot holds them to 2/3 of that.
    expect(p.solution.itemRates.get("iron_plate")!.net).toBeLessThan(0.9);
    expect(p.detailState.lastResolvedAt).toBeGreaterThanOrEqual(p.state.lastResolvedAt);
  });

  it("deltas are ordered by relative change, largest first", () => {
    const p = preview(fresh, [P3_BUY]);
    if (!p.ok) throw new Error(p.reason);
    const rel = p.deltas.map((d) => Math.abs(d.after - d.before) / Math.max(Math.abs(d.before), 1e-9));
    for (let i = 1; i < rel.length; i += 1) expect(rel[i]!).toBeLessThanOrEqual(rel[i - 1]!);
  });

  it.each(["slice-tier-8.world.json", "slice-tier-8-reinforced-full.world.json"])(
    "4. bound changes no rate: %s",
    (file) => {
      const s = fixtureState(file);
      const bound = Object.fromEntries(slice.content.stockItemIds.map((id) => [id, D(1e6)]));
      const withBound: WorldState = { ...s, bound };
      const x = solve(s, slice.content);
      const y = solve(withBound, slice.content);
      for (const id of slice.content.stockItemIds) {
        expect(y.itemRates.get(id)?.net ?? 0).toBe(x.itemRates.get(id)?.net ?? 0);
      }
      expect(y.bottleneck).toEqual(x.bottleneck);
    },
  );

  it("5. passes the reducer's rejection through", () => {
    const up = { type: "UPGRADE_MARK", lane: "iron", machineClass: "constructor", fromMark: 1 } as const;
    expect(preview(fresh, [up])).toEqual({
      ok: false,
      reason: '"constructor" mk2 unlocks at tier 2',
    });
  });

  it("5. memoises per snapshot and action list", () => {
    const a = preview(fresh, [{ ...P3_BUY }]);
    const b = preview(fresh, [{ ...P3_BUY }]);
    expect(b).toBe(a);
    const again = snapshotOf(slice, freshState(slice));
    const c = preview(again, [{ ...P3_BUY }]);
    expect(c).not.toBe(a);
    expect(c).toEqual(a);
  });

  it("5. two spends in one call throw", () => {
    expect(() => preview(fresh, [P3_BUY, P3_BUY])).toThrow();
  });

  it("a batch of settings previews with no credit", () => {
    const moves: Action[] = [{ type: "SET_RESERVE", itemId: "iron_plate", percent: 0.25 }];
    const p = preview(fresh, moves);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.credit.size).toBe(0);
  });
});

describe("previewLines", () => {
  it("rate lines with the lane's items first, the power line, and the bottleneck line", () => {
    const p = preview(fresh, [P3_BUY]);
    if (!p.ok) throw new Error(p.reason);
    const lines = previewLines(fresh, p, "iron");
    expect(lines).toContain("Iron Plate +0.333/s → +0.667/s");
    expect(lines).toContain("Power 22.0 / 200 MW → 26.0 / 200 MW");
    const rates = lines.filter((l) => l.endsWith("/s"));
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.length).toBeLessThanOrEqual(4);
    if (JSON.stringify(p.bottleneck.after) !== JSON.stringify(p.bottleneck.before)) {
      expect(lines).toContain("Clears the bottleneck");
    }
    expect(lines).not.toContain("No change to rates now");
  });

  it("no rate change says so (pillar 4)", () => {
    const p = preview(fresh, [{ type: "SET_RESERVE", itemId: "iron_rod", percent: 0 }]);
    if (!p.ok) throw new Error(p.reason);
    expect(p.deltas).toEqual([]);
    expect(previewLines(fresh, p, "iron")).toEqual(["No change to rates now"]);
  });
});
