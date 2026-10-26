import { describe, expect, it } from "vitest";
import { D, indexContent, installedAt, type WorldState } from "@manufactory/engine";
import { loadContent } from "./bootstrap.js";
import {
  evaluateAssert,
  explain,
  newSession,
  parseDuration,
  refresh,
  renderLane,
  renderPriority,
  renderStatus,
  runCommand,
  type Session,
} from "./commands.js";

const content = loadContent();

function session(): Session {
  return newSession(content, 42);
}

// The brief funded only iron_plate here, but fixture mk1 build costs are iron_ore
// (miner, smelter) and iron_ingot (constructor) -- mk2+ is iron_plate. Every test in
// this suite that buys a constructor needs ingot, so it is funded here alongside
// plate (which storage/QS purchases and mk2+ machines still spend). iron_ore is
// deliberately NOT funded here: the assert test below checks `liquid(iron_ore) ==
// 0`, and the two tests that buy a miner (which does need ore) fund it locally
// instead of through this shared helper.
function rich(): Session {
  const base = session();
  const state: WorldState = {
    ...base.state,
    stored: { ...base.state.stored, iron_ingot: D(100_000), iron_plate: D(100_000) },
  };
  return refresh({ ...base, state });
}

/** `rich()` plus enough iron_ore to buy miners, for the two tests that do. */
function richWithOre(): Session {
  const base = rich();
  const state: WorldState = { ...base.state, stored: { ...base.state.stored, iron_ore: D(100_000) } };
  return refresh({ ...base, state });
}

function run(s: Session, line: string): Session {
  const result = runCommand(s, line);
  return result.session;
}

describe("parseDuration", () => {
  it("understands seconds, minutes, hours and days", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("45m")).toBe(2_700_000);
    expect(parseDuration("8h")).toBe(28_800_000);
    expect(parseDuration("3d")).toBe(259_200_000);
  });

  it("accepts a decimal quantity", () => {
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });

  it("returns null for anything else", () => {
    for (const bad of ["8", "h", "8w", "", "-3h", "eight hours"]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });
});

describe("status and lane views", () => {
  it("renders the tier, the grid, and the bottleneck", () => {
    const text = renderStatus(session()).join("\n");
    expect(text).toContain("tier 0");
    expect(text).toContain("MW");
    // Spec 4.5: exactly one bottleneck, stated as a consequence and a fix.
    expect(text).toContain("make_plate");
    expect(text).toContain("1 more");
  });

  // A storage answer whose item is not its target's own item comes from two places: a
  // payer too small for a purchase (the item is not full), or a full item holding a
  // recipe up from downstream (the gridlock walk, a jammed power supplier). Only the
  // first is about a purchase fitting.
  function withStorageAdvice(fuelState: "FULL" | "FLOWING"): Session {
    const base = session();
    const itemStates = new Map(base.solution.itemStates);
    itemStates.set("fuel", fuelState);
    return {
      ...base,
      solution: {
        ...base.solution,
        itemStates,
        bottleneck: { kind: "storage", itemId: "fuel", limitingTarget: "item:rubber", upgrade: "storage" },
      },
    };
  }

  it("names a full item holding its target up, not a purchase that will not fit", () => {
    const text = renderStatus(withStorageAdvice("FULL")).join("\n");
    expect(text).toContain("fuel is at its cap, holding up item:rubber");
    expect(text).not.toContain("lets the purchase fit");
  });

  it("names a payer's storage when the item is not full", () => {
    const text = renderStatus(withStorageAdvice("FLOWING")).join("\n");
    expect(text).toContain("lets the purchase fit");
  });

  it("renders reserve advice as a share to set aside", () => {
    const base = session();
    const s: Session = {
      ...base,
      solution: {
        ...base.solution,
        bottleneck: { kind: "reserve", itemId: "steel_pipe", percent: 0.25, limitingTarget: "item:heavy_modular_frame" },
      },
    };
    expect(renderStatus(s).join("\n")).toContain(
      "BOTTLENECK  reserve 25% of steel_pipe so it can bank toward item:heavy_modular_frame",
    );
  });

  it("names the advised mark on recipe and power advice, when there is one", () => {
    const base = session();
    const withAdvice = (bottleneck: Session["solution"]["bottleneck"]): string =>
      renderStatus({ ...base, solution: { ...base.solution, bottleneck } }).join("\n");
    const recipe = { kind: "recipe", recipeId: "make_steel_pipe", limitingTarget: "tier 6", machinesToClear: 1 } as const;
    expect(withAdvice({ ...recipe, mark: 2 })).toContain("BOTTLENECK  make_steel_pipe Mk2 limiting tier 6 — 1 more clears it");
    expect(withAdvice({ ...recipe, mark: null })).toContain("BOTTLENECK  make_steel_pipe limiting tier 6 — 1 more clears it");
    const power = { kind: "power", limitingTarget: "tier 6", generatorRecipeId: "burn_biomass", machinesToClear: 3 } as const;
    expect(withAdvice({ ...power, mark: 1 })).toContain("— 3 more burn_biomass Mk1 clears it");
    expect(withAdvice({ ...power, generatorRecipeId: null, mark: null })).toContain("— 3 more generator clears it");
  });

  it("renders a lane with a rate and a storage readout per item", () => {
    const lines = renderLane(session(), "iron");
    expect(lines.join("\n")).toContain("Iron Plate");
    expect(lines.join("\n")).toMatch(/\/s/);
    expect(lines.join("\n")).toMatch(/EMPTY|FLOWING|FULL/);
  });

  it("renders the priority list in order with its modes", () => {
    const lines = renderPriority(session());
    expect(lines[0]).toContain("power");
    expect(lines.join("\n")).toContain("iron_plate");
    expect(lines.join("\n")).toContain("guaranteed");
  });

  it("reports an unknown lane rather than throwing", () => {
    const result = runCommand(session(), "lane ghost");
    expect(result.output.join("\n")).toMatch(/unknown lane/i);
  });
});

describe("action commands route through the engine reducers (spec A.2)", () => {
  it("buys for a named recipe, taking the lane from it (spec 2026-10-14)", () => {
    let s = rich();
    s = run(s, "tier 3");
    s = run(s, "buy refinery 1 --recipe residual_fuel");
    expect(s.actionLog.at(-1)).toEqual({
      type: "BUY_MACHINE",
      lane: "oil",
      machineClass: "refinery",
      mark: 1,
      count: 1,
      recipeId: "residual_fuel",
    });
    expect(s.state.assignment.residual_fuel).toBe(1);
  });

  it("takes the lane from the named recipe, not from the class's first lane (spec 2026-10-14)", () => {
    // In the shipped content every class lives in one lane, so laneOf and recipe.lane agree.
    // Give refinery a recipe on iron, authored before oil, so they differ.
    const bundle = content.bundle;
    const oilRecipe = bundle.recipes.find((r) => r.id === "residual_fuel")!;
    const variant = indexContent({
      ...bundle,
      recipes: [...bundle.recipes, { ...oilRecipe, id: "iron_refining", lane: "iron" }],
    });
    expect([...variant.lanes.keys()].indexOf("iron")).toBeLessThan([...variant.lanes.keys()].indexOf("oil"));
    const base = newSession(variant, 42);
    const stocked = refresh({
      ...base,
      state: {
        ...base.state,
        stored: { ...base.state.stored, iron_ingot: D(100_000), iron_plate: D(100_000) },
      },
    });
    let s = run(stocked, "tier 3");
    s = run(s, "buy refinery 1 --recipe residual_fuel");
    expect(s.actionLog.at(-1)).toMatchObject({ lane: "oil", recipeId: "residual_fuel" });

    // An explicit --lane still wins, and the engine then refuses the mismatch.
    const refused = runCommand(run(stocked, "tier 3"), "buy refinery 1 --lane iron --recipe residual_fuel");
    expect(refused.output.join("\n")).toMatch(/does not run on/);
    expect(refused.session.actionLog).toHaveLength(0);
  });

  it("surfaces the engine's rejection for a recipe the class does not run", () => {
    const result = runCommand(rich(), "buy constructor 1 --recipe residual_fuel");
    expect(result.output.join("\n")).toMatch(/does not run on/);
    expect(result.session.actionLog).toHaveLength(0);
  });

  it("refuses an unknown recipe", () => {
    const result = runCommand(rich(), "buy constructor 1 --recipe no_such_recipe");
    expect(result.output.join("\n")).toMatch(/unknown recipe "no_such_recipe"/);
    expect(result.session.actionLog).toHaveLength(0);
  });

  it("refuses --recipe on dismantle", () => {
    const result = runCommand(rich(), "dismantle constructor 1 --recipe residual_fuel");
    expect(result.output).toEqual(["--recipe applies only to buy"]);
    expect(result.session.actionLog).toHaveLength(0);
  });

  it("buys, dismantles, and records the action log", () => {
    let s = rich();
    s = run(s, "buy constructor 2");
    expect(installedAt(s.state, "iron", "constructor", 1)).toBe(3);
    expect(s.actionLog.at(-1)).toEqual({
      type: "BUY_MACHINE",
      lane: "iron",
      machineClass: "constructor",
      mark: 1,
      count: 2,
    });
    s = run(s, "dismantle constructor 2");
    expect(installedAt(s.state, "iron", "constructor", 1)).toBe(1);
  });

  it("defaults count to 1 and picks the best unlocked mark", () => {
    const s = run(richWithOre(), "buy miner");
    expect(installedAt(s.state, "iron", "miner", 1)).toBe(3);
  });

  it("honours an explicit lane and mark", () => {
    let s = rich();
    s = run(s, "tier 1");
    s = run(s, "buy miner 1 --mark 2");
    expect(installedAt(s.state, "iron", "miner", 2)).toBe(1);
  });

  it("surfaces a rejection instead of applying it", () => {
    const result = runCommand(session(), "buy constructor 1");
    expect(result.output.join("\n")).toMatch(/afford/i);
    expect(result.session.actionLog).toHaveLength(0);
  });

  it("assigns, selects, reserves, and buys storage and Quantum Storage", () => {
    let s = rich();
    s = run(s, "buy constructor 2");
    s = run(s, "assign make_plate 3");
    expect(s.state.assignment.make_plate).toBe(3);
    s = run(s, "select iron_plate make_plate");
    expect(s.state.activeRecipe.iron_plate).toBe("make_plate");
    s = run(s, "reserve iron_ore 0.25");
    expect(s.state.reserve.iron_ore).toBe(0.25);
    s = run(s, "storage iron_ore 2");
    expect(s.state.storageLevel.iron_ore).toBe(2);
    s = run(s, "qs iron 1");
    expect(s.state.qsLevel.iron).toBe(1);
  });

  it("taps and reorders and re-modes the priority list", () => {
    let s = rich();
    s = run(s, "tap 5");
    expect(s.state.tapStacks).toBe(5);
    const before = s.state.priority.map((e) => e.id);
    s = run(s, `priority move ${before.at(-1)!} 1`);
    expect(s.state.priority[0]!.id).toBe(before.at(-1));
    s = run(s, "priority mode item:iron_ore share 3");
    const entry = s.state.priority.find((e) => e.id === "item:iron_ore")!;
    expect(entry.mode).toBe("share");
    expect(entry.share).toBe(3);
    s = run(s, "priority pause item:iron_ore on");
    expect(s.state.priority.find((e) => e.id === "item:iron_ore")!.paused).toBe(true);
  });

  it("upgrades a mark in one command (spec D.1)", () => {
    let s = richWithOre();
    s = run(s, "tier 1");
    // --mark 1 is required: at tier 1 the default is the best unlocked mark, Mk2.
    s = run(s, "buy miner 43 --mark 1");
    expect(installedAt(s.state, "iron", "miner", 1)).toBe(45);
    s = run(s, "upgrade miner");
    expect(installedAt(s.state, "iron", "miner", 1)).toBe(0);
    expect(installedAt(s.state, "iron", "miner", 2)).toBe(15);
  });
});

describe("advance — time warp as a first-class verb (spec 16.3)", () => {
  it("advances by a duration and reports what happened", () => {
    const result = runCommand(session(), "advance 1m");
    expect(result.session.nowMs).toBe(60_000);
    expect(result.session.state.lastResolvedAt).toBe(60_000);
    // 1/3 plate per second for 60 seconds.
    expect(result.session.state.stored.iron_plate!.toNumber()).toBeCloseTo(20, 6);
  });

  it("crosses a milestone and says so", () => {
    // Tier 1 needs 200 plate at 1/3 per second, so 600 seconds; 11 minutes clears it
    // with margin rather than landing exactly on the float boundary.
    const result = runCommand(session(), "advance 11m");
    expect(result.session.state.tier).toBe(1);
    expect(result.output.join("\n")).toMatch(/tier 1/i);
  });

  it("advances until a tier is reached", () => {
    const result = runCommand(session(), "advance until tier:1");
    expect(result.session.state.tier).toBeGreaterThanOrEqual(1);
  });

  it("rejects a duration it cannot parse", () => {
    const result = runCommand(session(), "advance soon");
    expect(result.output.join("\n")).toMatch(/duration/i);
    expect(result.session.nowMs).toBe(0);
  });
});

describe("explain (spec E.3)", () => {
  it("names the rate, the item state, and every producer and consumer", () => {
    const text = explain(session(), "iron_ingot").join("\n");
    expect(text).toContain("iron_ingot");
    expect(text).toContain("EMPTY");
    expect(text).toContain("smelt_iron");
    expect(text).toContain("make_plate");
    expect(text).toMatch(/clock/i);
  });

  it("reports what the fixed point pinned, in order", () => {
    const text = explain(session(), "iron_plate").join("\n");
    expect(text).toMatch(/pinned/i);
    expect(text).toContain("iron_ore");
  });

  it("names the binding constraint for the item's own target", () => {
    expect(explain(session(), "iron_plate").join("\n")).toContain("make_plate");
  });

  it("reports an unknown item rather than throwing", () => {
    expect(explain(session(), "ghost").join("\n")).toMatch(/unknown item/i);
  });

  it("traces an item back to its raw extraction cost (spec F.1's Handbook)", () => {
    // One plate is 1.5 ingot is 1.5 ore.
    expect(explain(session(), "iron_plate").join("\n")).toContain("1.5");
  });
});

describe("assert (spec E.3)", () => {
  it("evaluates a rate comparison", () => {
    const s = session();
    expect(evaluateAssert(s, "rate(iron_plate) > 0.3").ok).toBe(true);
    expect(evaluateAssert(s, "rate(iron_plate) > 10").ok).toBe(false);
  });

  it("evaluates stockpiles, clocks, levels and machine counts", () => {
    const s = run(rich(), "buy constructor 2");
    expect(evaluateAssert(s, "stored(iron_plate) > 1000").ok).toBe(true);
    expect(evaluateAssert(s, "liquid(iron_ore) == 0").ok).toBe(true);
    expect(evaluateAssert(s, "clock(make_plate) <= 1").ok).toBe(true);
    expect(evaluateAssert(s, "machines(iron,constructor) >= 3").ok).toBe(true);
    expect(evaluateAssert(s, "level(iron_ore) == 0").ok).toBe(true);
  });

  it("evaluates the bare scalars", () => {
    const s = session();
    expect(evaluateAssert(s, "tier == 0").ok).toBe(true);
    expect(evaluateAssert(s, "power >= 0.99").ok).toBe(true);
    expect(evaluateAssert(s, "taps == 0").ok).toBe(true);
  });

  it("handles every comparison operator", () => {
    const s = session();
    expect(evaluateAssert(s, "tier < 1").ok).toBe(true);
    expect(evaluateAssert(s, "tier <= 0").ok).toBe(true);
    expect(evaluateAssert(s, "tier != 1").ok).toBe(true);
    expect(evaluateAssert(s, "tier >= 0").ok).toBe(true);
  });

  it("reports a parse failure rather than throwing", () => {
    for (const bad of ["", "tier", "tier ~ 1", "ghost(x) > 1", "rate(ghost) > 1"]) {
      const outcome = evaluateAssert(session(), bad);
      expect(outcome.ok).toBe(false);
      expect(outcome.text.length).toBeGreaterThan(0);
    }
  });

  it("records passing assertions on the session, for export as a regression test", () => {
    const s = run(session(), "assert tier == 0");
    expect(s.assertions).toEqual(["tier == 0"]);
  });

  it("does not record a failing assertion", () => {
    const s = run(session(), "assert tier == 9");
    expect(s.assertions).toEqual([]);
  });
});

describe("session plumbing", () => {
  it("reports an unknown command with a pointer to help", () => {
    const result = runCommand(session(), "frobnicate");
    expect(result.output.join("\n")).toMatch(/unknown command/i);
    expect(result.output.join("\n")).toMatch(/help/i);
  });

  it("ignores a blank line", () => {
    const result = runCommand(session(), "   ");
    expect(result.output).toEqual([]);
  });

  it("quits", () => {
    expect(runCommand(session(), "quit").quit).toBe(true);
  });

  it("keeps solution and state in step after every command", () => {
    const s = run(rich(), "buy constructor 4");
    expect(s.solution.capacity.unitsByRecipe.get("make_plate")).toBeCloseTo(5, 9);
  });
});
