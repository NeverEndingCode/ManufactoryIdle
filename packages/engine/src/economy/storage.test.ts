import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, type WorldState } from "../state/world.js";
import {
  canAffordBuild,
  canAffordLiquid,
  depositProduction,
  depositRefund,
  drainLiquid,
  itemStateTag,
  liquid,
  liquidCap,
  quantumCap,
  settleBound,
  SPEND_RESIDUAL_TOLERANCE,
  spendForBuild,
  spendFromLiquid,
  storageCap,
} from "./storage.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

function world(over: Partial<WorldState> = {}): WorldState {
  return { ...initialWorld(content, 1, 0), ...over };
}

describe("caps", () => {
  it("reads the item's base storage cap at level 0", () => {
    // iron_ore baseStorageCap 600, baseQuantumCap 2400.
    expect(storageCap(content, world(), "iron_ore").toNumber()).toBe(600);
    expect(quantumCap(content, world(), "iron_ore").toNumber()).toBe(2400);
    expect(liquidCap(content, world(), "iron_ore").toNumber()).toBe(3000);
  });

  it("grows storage geometrically with the per-item level", () => {
    const w = world({ storageLevel: { iron_ore: 2 } });
    // 600 * 1.6^2 = 1536
    expect(storageCap(content, w, "iron_ore").toNumber()).toBeCloseTo(1536, 6);
  });

  it("grows Quantum Storage per lane, lifting every item in it (spec B.4)", () => {
    const w = world({ qsLevel: { iron: 1, oil: 0 } });
    // iron_ore 2400 * 1.6 = 3840; iron_ingot 1600 * 1.6 = 2560; oil untouched.
    expect(quantumCap(content, w, "iron_ore").toNumber()).toBeCloseTo(3840, 6);
    expect(quantumCap(content, w, "iron_ingot").toNumber()).toBeCloseTo(2560, 6);
    expect(quantumCap(content, w, "crude_oil").toNumber()).toBe(1600);
  });
});

describe("itemStateTag (spec C.2)", () => {
  it("is EMPTY at zero", () => {
    expect(itemStateTag(content, world(), "iron_ore")).toBe("EMPTY");
  });

  it("is FLOWING between zero and the combined cap", () => {
    const w = world({ stored: { ...world().stored, iron_ore: D(100) } });
    expect(itemStateTag(content, w, "iron_ore")).toBe("FLOWING");
  });

  it("is FLOWING while storage is full but Quantum Storage has room", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(600) },
      quantum: { ...world().quantum, iron_ore: D(1000) },
    });
    expect(itemStateTag(content, w, "iron_ore")).toBe("FLOWING");
  });

  it("is FULL only when storage and Quantum Storage are both at cap (spec C.2)", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(600) },
      quantum: { ...world().quantum, iron_ore: D(2400) },
    });
    expect(liquid(w, "iron_ore").toNumber()).toBe(3000);
    expect(itemStateTag(content, w, "iron_ore")).toBe("FULL");
  });

  // Phase 2. `have` is accumulated by integration while `cap` comes from
  // capAtLevel's base * growth^level -- two different arithmetic paths, so they
  // agree only to about 1e-15 relative. Demanding `have >= cap` exactly left an
  // item parked a hair under its cap reading FLOWING forever: the solver never
  // pinned it, net stayed positive, and `resolve` scheduled a fill 1.4e-10 ms out,
  // floored the step at EPSILON_MS, integrated nothing, and re-fired -- 10,000
  // times per call until the guard tripped. Same defect class as the Phase 1
  // knife-edge, same shape of fix.
  it("is FULL a hair under the cap, where Decimal round-off lands", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(600) },
      quantum: { ...world().quantum, iron_ore: D(2400).minus(D("1e-10")) },
    });
    expect(liquid(w, "iron_ore").lt(liquidCap(content, w, "iron_ore"))).toBe(true);
    expect(itemStateTag(content, w, "iron_ore")).toBe("FULL");
  });

  it("is still FLOWING at a gap far wider than round-off", () => {
    // 1e-6 relative is a thousand times the tolerance: real headroom, not noise.
    const w = world({
      stored: { ...world().stored, iron_ore: D(600) },
      quantum: { ...world().quantum, iron_ore: D(2400).minus(D(3000).times(1e-6)) },
    });
    expect(itemStateTag(content, w, "iron_ore")).toBe("FLOWING");
  });
});

describe("depositProduction (spec C.5 fill order)", () => {
  it("fills storage first", () => {
    const r = depositProduction(content, world(), "iron_ore", D(500));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(500);
    expect(r.state.quantum.iron_ore!.toNumber()).toBe(0);
    expect(r.overflow.toNumber()).toBe(0);
  });

  it("spills into Quantum Storage once storage is at cap", () => {
    const r = depositProduction(content, world(), "iron_ore", D(1000));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(600);
    expect(r.state.quantum.iron_ore!.toNumber()).toBe(400);
    expect(r.overflow.toNumber()).toBe(0);
  });

  it("backpressures once both are at cap, and never creates bound", () => {
    const r = depositProduction(content, world(), "iron_ore", D(5000));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(600);
    expect(r.state.quantum.iron_ore!.toNumber()).toBe(2400);
    expect(r.state.bound.iron_ore!.toNumber()).toBe(0);
    expect(r.overflow.toNumber()).toBe(2000);
  });
});

describe("depositRefund (spec C.5, D4)", () => {
  it("fills Quantum Storage to its cap first", () => {
    const w = depositRefund(content, world(), "iron_ore", D(1000));
    expect(w.quantum.iron_ore!.toNumber()).toBe(1000);
    expect(w.bound.iron_ore!.toNumber()).toBe(0);
    expect(w.stored.iron_ore!.toNumber()).toBe(0);
  });

  it("puts the excess in bound, uncapped, so a dismantle never destroys material", () => {
    const w = depositRefund(content, world(), "iron_ore", D("4.01e9"));
    expect(w.quantum.iron_ore!.toNumber()).toBe(2400);
    expect(w.bound.iron_ore!.toNumber()).toBeCloseTo(4.01e9 - 2400, 0);
  });

  it("holds spec E.6's invariant: bound > 0 implies quantum is at cap", () => {
    const w = depositRefund(content, world(), "iron_ore", D(1e6));
    expect(w.bound.iron_ore!.gt(0)).toBe(true);
    expect(w.quantum.iron_ore!.toNumber()).toBe(quantumCap(content, w, "iron_ore").toNumber());
  });

  it("boundary: a refund of exactly the quantum cap fills it exactly and leaves bound at zero", () => {
    // iron_ore quantumCap at level 0 is exactly 2400.
    const w = depositRefund(content, world(), "iron_ore", D(2400));
    expect(w.quantum.iron_ore!.toNumber()).toBe(2400);
    expect(w.bound.iron_ore!.toNumber()).toBe(0);
  });
});

describe("settleBound", () => {
  it("flows bound down as room opens beneath it (spec D4)", () => {
    const start = world({
      quantum: { ...world().quantum, iron_ore: D(1000) },
      bound: { ...world().bound, iron_ore: D(5000) },
    });
    const settled = settleBound(content, start);
    expect(settled.quantum.iron_ore!.toNumber()).toBe(2400);
    expect(settled.bound.iron_ore!.toNumber()).toBe(3600);
  });

  it("is idempotent, which resolve's split-invariance depends on", () => {
    const once = settleBound(
      content,
      world({ quantum: { ...world().quantum, iron_ore: D(0) }, bound: { ...world().bound, iron_ore: D(5000) } }),
    );
    const twice = settleBound(content, once);
    expect(twice.quantum.iron_ore!.toString()).toBe(once.quantum.iron_ore!.toString());
    expect(twice.bound.iron_ore!.toString()).toBe(once.bound.iron_ore!.toString());
  });

  it("does nothing when bound is zero", () => {
    const w = world();
    expect(settleBound(content, w).bound.iron_ore!.toNumber()).toBe(0);
  });
});

describe("drainLiquid", () => {
  it("takes from storage first, then Quantum Storage", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(100) },
      quantum: { ...world().quantum, iron_ore: D(500) },
    });
    const r = drainLiquid(w, "iron_ore", D(300));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(0);
    expect(r.state.quantum.iron_ore!.toNumber()).toBe(300);
    expect(r.shortfall.toNumber()).toBe(0);
  });

  it("never touches bound and reports the shortfall", () => {
    const w = world({
      stored: { ...world().stored, iron_ore: D(50) },
      bound: { ...world().bound, iron_ore: D(1e6) },
    });
    const r = drainLiquid(w, "iron_ore", D(200));
    expect(r.state.stored.iron_ore!.toNumber()).toBe(0);
    expect(r.state.bound.iron_ore!.toNumber()).toBe(1e6);
    expect(r.shortfall.toNumber()).toBe(150);
  });
});

describe("spendForBuild (spec C.5)", () => {
  it("spends bound first, then quantum, then stored", () => {
    const w = world({
      stored: { ...world().stored, iron_plate: D(100) },
      quantum: { ...world().quantum, iron_plate: D(200) },
      bound: { ...world().bound, iron_plate: D(50) },
    });
    const next = spendForBuild(content, w, new Map([["iron_plate", D(220)]]))!;
    expect(next.bound.iron_plate!.toNumber()).toBe(0);
    expect(next.quantum.iron_plate!.toNumber()).toBe(30);
    expect(next.stored.iron_plate!.toNumber()).toBe(100);
  });

  it("returns null and changes nothing when the total is short", () => {
    const w = world({ stored: { ...world().stored, iron_plate: D(10) } });
    expect(spendForBuild(content, w, new Map([["iron_plate", D(11)]]))).toBeNull();
  });

  it("boundary: a spend equal to bound exactly empties it and touches nothing else", () => {
    const w = world({ bound: { ...world().bound, iron_plate: D(50) } });
    const next = spendForBuild(content, w, new Map([["iron_plate", D(50)]]))!;
    expect(next.bound.iron_plate!.toNumber()).toBe(0);
    expect(next.quantum.iron_plate!.toNumber()).toBe(0);
    expect(next.stored.iron_plate!.toNumber()).toBe(0);
  });

  it("boundary: a spend larger than every tier combined is refused and changes nothing", () => {
    const w = world({
      stored: { ...world().stored, iron_plate: D(10) },
      quantum: { ...world().quantum, iron_plate: D(20) },
      bound: { ...world().bound, iron_plate: D(5) },
    });
    // Combined stock is 35; ask for one more than that.
    expect(canAffordBuild(w, new Map([["iron_plate", D(36)]]))).toBe(false);
    const result = spendForBuild(content, w, new Map([["iron_plate", D(36)]]));
    expect(result).toBeNull();
  });

  it("lets a build be paid for entirely out of bound (spec D4)", () => {
    const w = world({ bound: { ...world().bound, iron_plate: D(1e6) } });
    expect(canAffordBuild(w, new Map([["iron_plate", D(500)]]))).toBe(true);
    const next = spendForBuild(content, w, new Map([["iron_plate", D(500)]]))!;
    // The fixture world starts with bound = 1e6 but quantum = 0, an
    // invariant-violating state (spec E.6: bound > 0 implies quantum == qsCap)
    // that can only arise here because the test constructs it by hand -- a real
    // `bound` balance is only ever produced by depositRefund, which always fills
    // quantum to its cap first. spendForBuild settles bound after spending
    // (spec D4: "whenever quantum < cap && bound > 0, bound flows down
    // automatically"), so it heals that violation: iron_plate's quantum cap at
    // qsLevel 0 is 1200, so 1200 flows bound -> quantum, leaving
    // 1e6 - 500 - 1200 = 998300 in bound and quantum at its 1200 cap.
    expect(next.quantum.iron_plate!.toNumber()).toBe(1200);
    expect(next.bound.iron_plate!.toNumber()).toBe(1e6 - 500 - 1200);
  });

  // Task 14c found this bug via spendFromLiquid (resolve/resolve.test.ts's
  // "task 14c: the milestone knife-edge"), but spendForBuild shares the exact
  // same spendInOrder internals -- just a different field order (bound ->
  // quantum -> stored) -- so it carries the identical latent defect for the
  // machine-purchase path. A spurious decline there is a player pressing buy
  // and nothing happening. These values are break_infinity's own real
  // renormalization gap, not a contrived edge case: `bound(1228.8).plus(
  // quantum(771.199999999995))` displays as exactly 2000 (canAffordBuild says
  // yes), but subtracting the 2000 cost from each field in turn -- 1228.8 from
  // bound, then the remaining 771.2 from quantum's actual 771.199999999995 --
  // leaves a ~5e-12 residue spendInOrder's per-field walk can see and the
  // aggregate check can't.
  describe("SPEND_RESIDUAL_TOLERANCE (task 14c)", () => {
    it("spends cleanly to zero when the aggregate affords it but the field walk finds a sub-tolerance residue", () => {
      const w = world({
        stored: { ...world().stored, iron_plate: D(0) },
        quantum: { ...world().quantum, iron_plate: D("771.199999999995") },
        bound: { ...world().bound, iron_plate: D("1228.8") },
      });
      const costs = new Map([["iron_plate", D(2000)]]);
      // The aggregate gate: stored.plus(quantum).plus(bound) rounds to exactly
      // 2000, so this must say yes even though no single field holds it alone.
      expect(canAffordBuild(w, costs)).toBe(true);

      const next = spendForBuild(content, w, costs);
      expect(next).not.toBeNull();
      expect(next!.bound.iron_plate!.toNumber()).toBe(0);
      expect(next!.quantum.iron_plate!.toNumber()).toBe(0);
      expect(next!.stored.iron_plate!.toNumber()).toBe(0);
    });

    it("still refuses a genuine shortfall, not just one inside the tolerance", () => {
      // Same shape, but short by 1: no amount of renormalization forgiveness
      // should paper over a real missing unit.
      const w = world({
        stored: { ...world().stored, iron_plate: D(0) },
        quantum: { ...world().quantum, iron_plate: D("771.199999999995") },
        bound: { ...world().bound, iron_plate: D("1228.8") },
      });
      const costs = new Map([["iron_plate", D(2001)]]);
      expect(canAffordBuild(w, costs)).toBe(false);
      expect(spendForBuild(content, w, costs)).toBeNull();
    });

    it("the tolerance is a fraction of the cost, not an absolute constant", () => {
      // Documents the derivation in storage.ts's comment: 1e-9 is a relative
      // bound (spec A.4 zone 3's costs range over many orders of magnitude),
      // so the forgiven residue scales with the amount being spent.
      expect(D(2000).times(SPEND_RESIDUAL_TOLERANCE).toNumber()).toBeCloseTo(2e-6, 12);
    });
  });
});

describe("spendFromLiquid (spec C.5, D4)", () => {
  it("spends stored then quantum", () => {
    const w = world({
      stored: { ...world().stored, iron_plate: D(100) },
      quantum: { ...world().quantum, iron_plate: D(200) },
    });
    const next = spendFromLiquid(content, w, new Map([["iron_plate", D(250)]]))!;
    expect(next.stored.iron_plate!.toNumber()).toBe(0);
    expect(next.quantum.iron_plate!.toNumber()).toBe(50);
  });

  it("refuses to spend bound, closing the D4 dismantle-before-delivery exploit", () => {
    const w = world({ bound: { ...world().bound, iron_plate: D("4.01e9") } });
    expect(canAffordLiquid(w, new Map([["iron_plate", D(1000)]]))).toBe(false);
    expect(spendFromLiquid(content, w, new Map([["iron_plate", D(1000)]]))).toBeNull();
    // The same cost is payable as a build, because bound is re-instantiable.
    expect(canAffordBuild(w, new Map([["iron_plate", D(1000)]]))).toBe(true);
  });

  it("settles bound downward after freeing quantum room", () => {
    // iron_plate baseQuantumCap is 1200 at qsLevel 0 (items.yaml, curves.yaml
    // capGrowth 1.6^0 = 1). quantum starts at that cap, so bound = 5000 is legal
    // (spec E.6: bound > 0 implies quantum == qsCap).
    const w = world({
      stored: { ...world().stored, iron_plate: D(100) },
      quantum: { ...world().quantum, iron_plate: D(1200) },
      bound: { ...world().bound, iron_plate: D(5000) },
    });
    // Cost 300 exceeds stored (100), so spendFromLiquid's stored -> quantum order
    // must draw the remaining 200 out of quantum: quantum drops to 1000, opening
    // 200 of room beneath its 1200 cap. settleBound then refills exactly that
    // 200 from bound, landing quantum back at its cap and bound down by 200.
    const next = spendFromLiquid(content, w, new Map([["iron_plate", D(300)]]))!;
    expect(next.stored.iron_plate!.toNumber()).toBe(0);
    expect(next.quantum.iron_plate!.toNumber()).toBe(1200);
    expect(next.bound.iron_plate!.toNumber()).toBe(4800);
  });
});
