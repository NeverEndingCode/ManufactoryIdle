import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { indexContent } from "../graph/index-content.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";
import {
  capAtLevel,
  combinedMultiplier,
  ladderInput,
  ladderMultiplier,
  laneMultiplier,
  levelCostRange,
  machineCostRange,
  powIntDecimal,
  powIntNumber,
  softcap,
  tapMultiplier,
} from "./curves.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

describe("powIntNumber", () => {
  it("is exact on exact inputs", () => {
    expect(powIntNumber(2, 10)).toBe(1024);
    expect(powIntNumber(3, 5)).toBe(243);
    expect(powIntNumber(1.5, 2)).toBe(2.25);
  });

  it("returns 1 for exponent 0, including base 0", () => {
    expect(powIntNumber(1.09, 0)).toBe(1);
    expect(powIntNumber(0, 0)).toBe(1);
  });

  it("matches the hand-computed value of 1.09^10", () => {
    // 1.09^2 = 1.1881, ^4 = 1.41158161, ^5 = 1.5386239549, ^10 = 2.3673636746
    expect(powIntNumber(1.09, 10)).toBeCloseTo(2.3673636746, 9);
  });

  it("rejects a negative or non-integer exponent", () => {
    expect(() => powIntNumber(2, -1)).toThrow();
    expect(() => powIntNumber(2, 1.5)).toThrow();
  });
});

describe("powIntDecimal", () => {
  it("agrees with powIntNumber inside float64 range", () => {
    expect(powIntDecimal(2, 10).toNumber()).toBe(1024);
    expect(powIntDecimal(1.09, 10).toNumber()).toBeCloseTo(2.3673636746, 9);
  });

  it("survives magnitudes float64 cannot hold", () => {
    // 1.09^10000 is roughly 1e371, comfortably past float64's 1.8e308.
    expect(powIntDecimal(1.09, 10000).exponent).toBeGreaterThan(350);
    expect(Number.isFinite(powIntDecimal(1.09, 10000).exponent)).toBe(true);
  });

  it("is bitwise repeatable, which LIFO refund symmetry depends on", () => {
    expect(powIntDecimal(1.09, 137).toString()).toBe(powIntDecimal(1.09, 137).toString());
  });
});

describe("softcap", () => {
  it("passes values below the threshold straight through", () => {
    expect(softcap(30, { threshold: 50, slope: 0.25 })).toBe(30);
    expect(softcap(50, { threshold: 50, slope: 0.25 })).toBe(50);
  });

  it("charges the slope above the threshold", () => {
    // 50 + (100 - 50) * 0.25 = 62.5
    expect(softcap(100, { threshold: 50, slope: 0.25 })).toBe(62.5);
    // 50 + (250 - 50) * 0.25 = 100
    expect(softcap(250, { threshold: 50, slope: 0.25 })).toBe(100);
  });

  it("stays monotonic — a softcap slows growth, it never caps or reverses it", () => {
    const cap = { threshold: 50, slope: 0.25 };
    // Sentinel, not 0: softcap(0, cap) is 0 by the identity-below-threshold rule
    // above, so seeding `previous` at 0 would make the x = 0 sample spuriously
    // fail its own starting point (0 > 0 is false) regardless of correctness.
    let previous = Number.NEGATIVE_INFINITY;
    for (let x = 0; x < 500; x += 7) {
      const y = softcap(x, cap);
      expect(y).toBeGreaterThan(previous);
      previous = y;
    }
  });
});

describe("ladderInput and ladderMultiplier", () => {
  function stacked(): WorldState {
    // 8 Mk1 (rate x1) + 4 Mk2 (rate x3) = 12 machines, 20 mark-weighted units.
    let w = initialWorld(content, 1, 0);
    w = withInstalled(w, "iron", "miner", 1, 8);
    w = withInstalled(w, "iron", "miner", 2, 4);
    return w;
  }

  it("weights the count by each mark's rate multiplier (spec B.2, C.0)", () => {
    expect(ladderInput(content, stacked(), "iron", "miner")).toBe(20);
  });

  it("steps the multiplier every `interval` weighted machines", () => {
    // ladder is x1.5 every 10; floor(20 / 10) = 2, so 1.5^2 = 2.25.
    expect(ladderMultiplier(content, stacked(), "iron", "miner")).toBeCloseTo(2.25, 12);
  });

  it("is 1 below the first threshold — the fixture starts with 2 miners", () => {
    const w = initialWorld(content, 1, 0);
    expect(ladderInput(content, w, "iron", "miner")).toBe(2);
    expect(ladderMultiplier(content, w, "iron", "miner")).toBe(1);
  });

  it("does not reset when a mark upgrade consolidates machines (spec B.2)", () => {
    // 45 Mk1 -> ladderInput 45 -> floor(4.5) = 4 -> 1.5^4 = 5.0625.
    // 15 Mk2 -> ladderInput 45 -> identical. That is the whole point.
    let raw = initialWorld(content, 1, 0);
    raw = withInstalled(raw, "iron", "miner", 1, 45);
    let upgraded = initialWorld(content, 1, 0);
    upgraded = withInstalled(upgraded, "iron", "miner", 1, 0);
    upgraded = withInstalled(upgraded, "iron", "miner", 2, 15);
    expect(ladderInput(content, raw, "iron", "miner")).toBe(45);
    expect(ladderInput(content, upgraded, "iron", "miner")).toBe(45);
    expect(ladderMultiplier(content, upgraded, "iron", "miner")).toBeCloseTo(5.0625, 12);
  });

  it("returns 1 for a lane-class with nothing installed", () => {
    expect(ladderMultiplier(content, initialWorld(content, 1, 0), "oil", "refinery")).toBe(1);
  });
});

describe("laneMultiplier", () => {
  it("is 1 before any milestone", () => {
    expect(laneMultiplier(content, 0, "iron")).toBe(1);
  });

  it("compounds every unlocked milestone's lane grant", () => {
    // Tier 1 grants iron x1.5; tier 2 grants iron x1.5 and oil x1.5.
    expect(laneMultiplier(content, 1, "iron")).toBeCloseTo(1.5, 12);
    expect(laneMultiplier(content, 2, "iron")).toBeCloseTo(2.25, 12);
    expect(laneMultiplier(content, 2, "oil")).toBeCloseTo(1.5, 12);
    // Tier 3 grants oil x1.5 again and nothing to iron.
    expect(laneMultiplier(content, 3, "iron")).toBeCloseTo(2.25, 12);
    expect(laneMultiplier(content, 3, "oil")).toBeCloseTo(2.25, 12);
  });
});

describe("tapMultiplier", () => {
  it("is 1 with no stacks", () => {
    expect(tapMultiplier(content, initialWorld(content, 1, 0))).toBe(1);
  });

  it("adds kickPerStack per stack as a step, not a curve (spec C.6)", () => {
    const w = { ...initialWorld(content, 1, 0), tapStacks: 3 };
    // 1 + 3 * 0.05 = 1.15
    expect(tapMultiplier(content, w)).toBeCloseTo(1.15, 12);
  });

  it("clamps to maxStacks, landing at spec 16.4's 1.5x active hour", () => {
    const w = { ...initialWorld(content, 1, 0), tapStacks: 99 };
    expect(tapMultiplier(content, w)).toBeCloseTo(1.5, 12);
  });
});

describe("combinedMultiplier", () => {
  it("multiplies the parts when the product is under the threshold", () => {
    // 2.25 * 2.25 * 1.5 = 7.59375, well under the product threshold of 5000.
    expect(combinedMultiplier(content, [2.25, 2.25, 1.5])).toBeCloseTo(7.59375, 12);
  });

  it("applies the product softcap on top of the per-category ones (spec D3)", () => {
    // 100 * 100 = 10000 > 5000, so 5000 + (10000 - 5000) * 0.2 = 6000.
    expect(combinedMultiplier(content, [100, 100])).toBeCloseTo(6000, 9);
  });

  it("is 1 for an empty stack", () => {
    expect(combinedMultiplier(content, [])).toBe(1);
  });
});

describe("machineCostRange", () => {
  it("sums the geometric run of costs for a batch purchase", () => {
    // Constructor mk1 costs 20 iron_ingot at n=0, r = 1.09. (Fixture FIX 2 moved
    // this off iron_plate to break the plate-needs-a-constructor bootstrap cycle;
    // see machines.yaml and commit 56d9193.)
    // n=0, count=3: 20 * (1 + 1.09 + 1.1881) = 20 * 3.2781 = 65.562
    const cost = machineCostRange(content, "constructor", 1, 0, 3);
    expect(cost.get("iron_ingot")!.toNumber()).toBeCloseTo(65.562, 6);
  });

  it("charges more further up the curve", () => {
    // n=3, count=2: 20 * (1.09^3 + 1.09^4) = 20 * (1.295029 + 1.41158161)
    //             = 20 * 2.70661061 = 54.1322122
    const cost = machineCostRange(content, "constructor", 1, 3, 2);
    expect(cost.get("iron_ingot")!.toNumber()).toBeCloseTo(54.1322122, 6);
  });

  it("is bitwise symmetric, which LIFO dismantle refunds depend on (spec D4)", () => {
    const bought = machineCostRange(content, "constructor", 1, 0, 3);
    const refunded = machineCostRange(content, "constructor", 1, 0, 3);
    expect(refunded.get("iron_ingot")!.toString()).toBe(bought.get("iron_ingot")!.toString());
  });

  it("uses the mark's own absolute build cost, so the curve resets per mark", () => {
    // Miner mk1 costs 10 iron_ore (FIX 2, see above), mk2 costs 30 iron_plate.
    // Both start at n=0 on their own curve.
    expect(machineCostRange(content, "miner", 1, 0, 1).get("iron_ore")!.toNumber()).toBe(10);
    expect(machineCostRange(content, "miner", 2, 0, 1).get("iron_plate")!.toNumber()).toBe(30);
  });

  it("uses the class's own cost ratio", () => {
    // Refinery mk1 costs 120 plate at r = 1.12. n=0, count=2: 120 * (1 + 1.12) = 254.4
    const cost = machineCostRange(content, "refinery", 1, 0, 2);
    expect(cost.get("iron_plate")!.toNumber()).toBeCloseTo(254.4, 6);
  });

  it("returns an empty map for a zero count", () => {
    expect(machineCostRange(content, "miner", 1, 0, 0).size).toBe(0);
  });

  it("throws on an unknown class or mark, rather than silently costing nothing", () => {
    expect(() => machineCostRange(content, "ghost", 1, 0, 1)).toThrow(/ghost/);
    expect(() => machineCostRange(content, "miner", 9, 0, 1)).toThrow(/mk9/);
  });
});

describe("levelCostRange and capAtLevel", () => {
  it("sums the geometric run of level costs", () => {
    // storage: baseCostAmount 50, costGrowth 2. Levels 0..2: 50 * (1 + 2 + 4) = 350
    const cost = levelCostRange(content.bundle.storage, 0, 3);
    expect(cost.get("iron_plate")!.toNumber()).toBeCloseTo(350, 9);
    // Levels 2..3: 50 * (4 + 8) = 600
    expect(levelCostRange(content.bundle.storage, 2, 2).get("iron_plate")!.toNumber()).toBeCloseTo(
      600,
      9,
    );
  });

  it("costs nothing when the curve names no item", () => {
    const free = { ...content.bundle.storage, baseCostItem: null };
    expect(levelCostRange(free, 0, 5).size).toBe(0);
  });

  it("grows the cap geometrically per level", () => {
    // 600 * 1.6^2 = 1536
    expect(capAtLevel(600, content.bundle.storage, 2).toNumber()).toBeCloseTo(1536, 6);
    expect(capAtLevel(600, content.bundle.storage, 0).toNumber()).toBe(600);
  });
});
