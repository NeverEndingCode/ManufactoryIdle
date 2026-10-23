import { beforeAll, describe, expect, it } from "vitest";
import { applyBatch, type Effect } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import {
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  starvedPipeState,
  type Slice,
} from "./test-fixtures.js";
import {
  buyAction,
  dismantleAction,
  drawerModel,
  idleMove,
  ladderProgress,
  moveMachines,
} from "./machines.js";
import { preview } from "./preview.js";

let slice: Slice;
let fresh: Snapshot;
let t8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  t8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});

describe("drawerModel: machines (Q-4, Q-6)", () => {
  it("7. a fresh world's iron ore: the Miner section and its ladder", () => {
    const m = drawerModel(fresh, "iron_ore");
    expect(m.name).toBe("Iron Ore");
    expect(m.laneId).toBe("iron");
    expect(m.machines!.machineClass).toBe("miner");
    expect(m.machines!.ladder!.text).toBe("8 more Miners → ×1.50");
  });

  it("7. tier-8 iron plate: Constructors, the ladder counts the best mark", () => {
    const sec = drawerModel(t8, "iron_plate").machines!;
    expect(sec.machineClass).toBe("constructor");
    expect(sec.className).toBe("Constructor");
    expect(sec.bestMark).toBe(3);
    expect(sec.pool).toBe(11 + 3 + 17);
    expect(sec.ladder!.text).toBe("2 more Constructors → ×1.50");
    expect(sec.ladder!.multiplier).toBeCloseTo(25.63, 2);
    expect(sec.ladder!.input).toBe(85);
    expect(sec.ladder!.nextAt).toBe(90);
    expect(sec.ladder!.more).toBe(2);
    expect(ladderProgress(t8, "iron", "constructor")).toEqual(sec.ladder);
  });

  it("7. marks: consolidations, and no upgrade past the last mark", () => {
    const sec = drawerModel(t8, "iron_plate").machines!;
    const [mk1, mk2, mk3] = sec.marks;
    expect(mk1!.owned).toBe(11);
    expect(mk1!.consolidation).toEqual({ from: 11, to: 5, toMark: 2 });
    expect(mk1!.upgrade).toEqual({
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "constructor",
      fromMark: 1,
    });
    expect(mk2!.consolidation).toEqual({ from: 3, to: 1, toMark: 3 });
    expect(mk3!.upgrade).toBeNull();
    expect(mk3!.consolidation).toBeNull();
    for (const m of sec.marks) expect(m.unlocked).toBe(true);
  });

  it("7. a fresh Constructor Mk1 cannot upgrade: Mk2 unlocks at tier 2", () => {
    const sec = drawerModel(fresh, "iron_plate").machines!;
    expect(sec.marks[0]!.upgrade).toBeNull();
    expect(sec.marks[1]!.unlocked).toBe(false);
  });

  it("an upgrade that consolidates to nothing is blocked with the reducer's words", () => {
    // One Mk2 at rate 2 consolidates to floor(2 / 4) = 0 Mk3.
    const s = snapshotOf(slice, {
      ...t8.state,
      installed: { ...t8.state.installed, iron: { ...t8.state.installed.iron, constructor: [11, 1, 17] } },
    });
    const mk2 = drawerModel(s, "iron_plate").machines!.marks[1]!;
    expect(mk2.consolidation).toEqual({ from: 1, to: 0, toMark: 3 });
    expect(mk2.upgradeBlocked).toBe("need at least 2 to upgrade");
    expect(preview(s, [mk2.upgrade!])).toEqual({ ok: false, reason: "need at least 2 to upgrade" });
  });

  it("7. consolidations are the counts the upgrade's preview removes and installs", () => {
    const sec = drawerModel(t8, "iron_plate").machines!;
    for (const m of sec.marks) {
      if (m.upgrade === null || m.consolidation === null) continue;
      const p = preview(t8, [m.upgrade]);
      if (!p.ok) throw new Error(p.reason);
      const removed = p.effects.find((e): e is Extract<Effect, { kind: "removed" }> => e.kind === "removed")!;
      const installed = p.effects.find(
        (e): e is Extract<Effect, { kind: "installed" }> => e.kind === "installed",
      )!;
      expect([removed.mark, removed.count]).toEqual([m.mark, m.consolidation.from]);
      expect([installed.mark, installed.count]).toEqual([m.consolidation.toMark, m.consolidation.to]);
    }
  });

  it("7. buyAction names the recipe while it is live; dismantleAction has none", () => {
    const sec = drawerModel(fresh, "iron_plate").machines!;
    expect(buyAction(sec, 1, 1)).toEqual({
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 1,
      recipeId: "make_iron_plate",
    });
    expect(dismantleAction(sec, 1, 1)).toEqual({
      type: "DISMANTLE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 1,
    });
  });

  it("is memoised per snapshot and item", () => {
    expect(drawerModel(t8, "iron_plate")).toBe(drawerModel(t8, "iron_plate"));
  });
});

describe("drawerModel: recipes, storage and QS (Q-6)", () => {
  it("7. tier-8 plastic offers both unlocked recipes, one active", () => {
    const { recipes } = drawerModel(t8, "plastic");
    const ids = recipes.map((r) => r.recipeId);
    expect(ids).toContain("refine_plastic");
    expect(ids).toContain("refine_residual_plastic");
    expect(recipes.filter((r) => r.active)).toHaveLength(1);
    for (const r of recipes) {
      if (r.active || r.inCycle || r.unlockTier > t8.state.tier) expect(r.select).toBeNull();
      else expect(r.select).toEqual({ type: "SELECT_RECIPE", itemId: "plastic", recipeId: r.recipeId });
    }
  });

  it("7. iron plate has no recipe choice (its alt makes a different item)", () => {
    expect(drawerModel(t8, "iron_plate").recipes).toEqual([]);
  });

  it("7. storage +1 for the item and QS +1 for its lane; none at the maximum", () => {
    const m = drawerModel(fresh, "iron_ore");
    expect(m.storage.buy).toEqual({ type: "BUY_STORAGE", itemId: "iron_ore", levels: 1 });
    expect(m.storage.level).toBe(0);
    expect(m.storage.maxLevel).toBe(22);
    expect(m.storage.nextCap!.gt(m.storage.cap)).toBe(true);
    expect(m.qs.buy).toEqual({ type: "BUY_QS", lane: "iron", levels: 1 });
    expect(m.qs.maxLevel).toBe(16);

    const maxed = snapshotOf(slice, {
      ...freshState(slice),
      storageLevel: { iron_ore: 22 },
      qsLevel: { iron: 16 },
    });
    const top = drawerModel(maxed, "iron_ore");
    expect([top.storage.buy, top.storage.nextCap, top.qs.buy, top.qs.nextCap]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("idleMove (Q-6, the sim's idleReassignments)", () => {
  it("8. STARVED_PIPE: three idle concrete Constructors move to steel pipe", () => {
    const s = snapshotOf(slice, starvedPipeState(slice));
    const sec = drawerModel(s, "steel_pipe").machines!;
    expect([sec.lane, sec.machineClass]).toEqual(["coal", "constructor"]);
    const byId = new Map(sec.assign.map((r) => [r.recipeId, r]));
    expect(byId.get("make_concrete")).toMatchObject({ assigned: 6, idle: true, starved: false });
    expect(byId.get("make_steel_beam")).toMatchObject({ assigned: 0, starved: false });
    expect(byId.get("make_steel_pipe")).toMatchObject({ assigned: 0, live: true, starved: true });

    const move = idleMove(s, sec);
    expect(move).toEqual({ from: "make_concrete", to: "make_steel_pipe", n: 3 });
    const batch = moveMachines(sec, move!.from, move!.to, move!.n);
    expect(batch).toEqual([
      { type: "ASSIGN_MACHINES", recipeId: "make_concrete", count: 3 },
      { type: "ASSIGN_MACHINES", recipeId: "make_steel_pipe", count: 3 },
    ]);
    expect(applyBatch(s.state, slice.content, batch, s.state.seed).rejected).toBe(false);
  });

  it("no move with a single live recipe", () => {
    const sec = drawerModel(fresh, "iron_plate").machines!;
    expect(idleMove(fresh, sec)).toBeNull();
  });
});
