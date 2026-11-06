// U-4: the command line's words, and the NEXT_BUY model (U-4c), over the derive fixtures: a
// fresh BUY_MACHINE, a tier-8 storage cap, the quantum world, the reserve, and power with no
// generator (frameless).
import { D, DECIMAL_ZERO, liquidCap, type Solution, type WorldState } from "@manufactory/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { shownStock } from "../sync/interpolate.js";
import type { Snapshot } from "../sync/snapshot.js";
import {
  commandText,
  nextBuyModel,
  runLabel,
  runName,
  shortText,
  whyName,
  type RunKind,
} from "./command.js";
import { bottleneckRow, rateText, type BottleneckModel } from "./derive.js";
import { fmt } from "./notation.js";
import { preview } from "./preview.js";
import { fixtureState, freshState, loadSlice, snapshotOf, type Slice } from "./test-fixtures.js";
import { themeDef } from "./theme.js";

const TERMINAL = themeDef("terminal");
const AFFORDABLE = { affordable: true } as const;
const IN_12S = { affordable: false, inMs: 11_200 } as const;
const NEVER = { affordable: false, inMs: null } as const;

const withBottleneck = (s: Snapshot, bottleneck: Solution["bottleneck"]): Snapshot => ({
  ...s,
  display: { ...s.display, solution: { ...s.display.solution, bottleneck } },
});

let slice: Slice;
let fresh: Snapshot;
let tier8: Snapshot;
let storage: Snapshot;
let qs: Snapshot;
let reserve: Snapshot;
let frameless: Snapshot;
/** Ten machines: a hard-coded 1 or a dropped plural shows. */
let many: Snapshot;
const model = (s: Snapshot) => bottleneckRow(s)!;

beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  const t8 = fixtureState("slice-tier-8.world.json");
  tier8 = snapshotOf(slice, t8);
  // Tier 8 with iron plate at its liquid cap, and the solve's verdict that its storage limits
  // screw (the power shortfall would otherwise outrank it).
  const capped: WorldState = {
    ...t8,
    stored: { ...t8.stored, iron_plate: liquidCap(slice.content, t8, "iron_plate") },
    quantum: { ...t8.quantum, iron_plate: DECIMAL_ZERO },
  };
  storage = withBottleneck(snapshotOf(slice, capped), {
    kind: "storage",
    itemId: "iron_plate",
    limitingTarget: "item:screw",
    upgrade: "storage",
  });
  qs = withBottleneck(fresh, {
    kind: "storage",
    itemId: "iron_rod",
    limitingTarget: "item:iron_rod",
    upgrade: "quantum",
  });
  reserve = withBottleneck(fresh, {
    kind: "reserve",
    itemId: "iron_plate",
    percent: 0.25,
    limitingTarget: "item:iron_rod",
  });
  many = withBottleneck(fresh, {
    kind: "recipe",
    recipeId: "make_iron_plate",
    limitingTarget: "item:iron_rod",
    machinesToClear: 10,
    mark: 1,
  });
  frameless = withBottleneck(fresh, {
    kind: "power",
    limitingTarget: "item:iron_plate",
    generatorRecipeId: null,
    machinesToClear: 0,
    mark: null,
  });
});

describe("commandText, shortText (U-4a, U-4b)", () => {
  it("1. every FrameAction kind, in both voices", () => {
    const cases: [Snapshot, string, string, string, string][] = [
      [
        many,
        "buy 10 constructor_mk1 --lane iron --for iron_plate",
        "Buy 10 Constructor Mk.1 for Iron Plate",
        "10 constructor → IRON_PLATE",
        "10 Constructor → Iron Plate",
      ],
      [
        fresh,
        "buy 1 constructor_mk1 --lane iron --for iron_plate",
        "Buy 1 Constructor Mk.1 for Iron Plate",
        "1 constructor → IRON_PLATE",
        "1 Constructor → Iron Plate",
      ],
      [
        storage,
        "storage +1 iron_plate",
        "Buy storage for Iron Plate",
        "storage → IRON_PLATE",
        "Storage → Iron Plate",
      ],
      [qs, "qs +1 --lane iron", "Buy Quantum Storage for Iron", "qs → IRON", "QS → Iron"],
      [
        reserve,
        "reserve iron_plate 25%",
        "Reserve 25% of Iron Plate",
        "reserve 25% → IRON_PLATE",
        "Reserve 25% → Iron Plate",
      ],
    ];
    for (const [s, shell, plain, short, plainShort] of cases) {
      const m = model(s);
      expect(commandText(m, s, "shell")).toBe(shell);
      expect(commandText(m, s, "plain")).toBe(plain);
      expect(shortText(m, s, "shell")).toBe(short);
      expect(shortText(m, s, "plain")).toBe(plainShort);
    }
  });

  it("1. a null action is the advice as a comment; no bottleneck is all lines fed", () => {
    const m = model(frameless);
    expect(m.action).toBeNull();
    expect(commandText(m, frameless, "shell")).toBe(`# ${m.text.toLowerCase()}`);
    expect(commandText(m, frameless, "shell")).toMatch(/^# power is short, limiting iron plate\./);
    expect(commandText(m, frameless, "plain")).toBe(m.text);
    expect(shortText(m, frameless, "shell")).toBe(commandText(m, frameless, "shell"));
    expect(commandText(null, fresh, "shell")).toBe("# all lines fed");
    expect(commandText(null, fresh, "plain")).toBe("Everything is running");
    expect(shortText(null, fresh, "shell")).toBe("# all lines fed");
  });

  it("1. the why button's name uses content names", () => {
    expect(whyName(model(fresh), fresh)).toBe(
      "Why: next buy is 1 Constructor for Iron Plate. Open details",
    );
    expect(whyName(null, fresh)).toBe("Why: everything is running. Open details");
  });
});

describe("runLabel, runName (U-4a, V-17)", () => {
  it("1. the affordable label per kind and voice", () => {
    const cases: [Snapshot, Record<RunKind, string>, Record<RunKind, string>][] = [
      [
        many,
        { bar: "run", split: "[ buy 10 ]", card: "buy 10", sheet: "[ buy 10 ]" },
        { bar: "Run", split: "Buy 10", card: "Buy 10", sheet: "Buy 10" },
      ],
      [
        fresh,
        { bar: "run", split: "[ buy 1 ]", card: "buy 1", sheet: "[ buy 1 ]" },
        { bar: "Run", split: "Buy 1", card: "Buy 1", sheet: "Buy 1" },
      ],
      [
        storage,
        { bar: "run", split: "[ store ]", card: "store", sheet: "[ store ]" },
        { bar: "Run", split: "Store", card: "Store", sheet: "Store" },
      ],
      [
        qs,
        { bar: "run", split: "[ qs ]", card: "qs", sheet: "[ qs ]" },
        { bar: "Run", split: "QS", card: "QS", sheet: "QS" },
      ],
      [
        reserve,
        { bar: "run", split: "[ reserve ]", card: "reserve", sheet: "[ reserve ]" },
        { bar: "Run", split: "Reserve", card: "Reserve", sheet: "Reserve" },
      ],
    ];
    for (const [s, shell, plain] of cases)
      for (const kind of ["bar", "split", "card", "sheet"] as const) {
        expect(runLabel(model(s), s, "shell", kind, AFFORDABLE, false)).toBe(shell[kind]);
        expect(runLabel(model(s), s, "plain", kind, AFFORDABLE, false)).toBe(plain[kind]);
      }
  });

  it("1. busy, the countdown and not affordable yet", () => {
    const m = model(fresh);
    expect(runLabel(m, fresh, "shell", "bar", AFFORDABLE, true)).toBe("running…");
    expect(runLabel(m, fresh, "shell", "split", IN_12S, true)).toBe("running…");
    expect(runLabel(m, fresh, "plain", "bar", AFFORDABLE, true)).toBe("Running…");
    expect(runLabel(m, fresh, "shell", "bar", IN_12S, false)).toBe("affordable in 12s");
    expect(runLabel(m, fresh, "shell", "card", IN_12S, false)).toBe("affordable in 12s");
    expect(runLabel(m, fresh, "shell", "split", IN_12S, false)).toBe("[ 12s ]");
    expect(runLabel(m, fresh, "shell", "sheet", IN_12S, false)).toBe("[ 12s ]");
    expect(runLabel(m, fresh, "shell", "bar", NEVER, false)).toBe("not affordable yet");
    // The plain voice's countdown.
    expect(runLabel(m, fresh, "plain", "bar", IN_12S, false)).toBe("Affordable in 12s");
    expect(runLabel(m, fresh, "plain", "card", IN_12S, false)).toBe("Affordable in 12s");
    expect(runLabel(m, fresh, "plain", "split", IN_12S, false)).toBe("[ 12s ]");
    expect(runLabel(m, fresh, "plain", "bar", NEVER, false)).toBe("Not affordable yet");
    expect(runLabel(m, fresh, "plain", "split", NEVER, false)).toBe("Not affordable yet");
    expect(runLabel(m, fresh, "shell", "split", NEVER, false)).toBe("not affordable yet");
    expect(runLabel(model(frameless), frameless, "shell", "split", AFFORDABLE, false)).toBe("—");
  });

  it("1. the name is the plain spend text, plus the wait when off", () => {
    expect(runName(model(fresh), fresh, AFFORDABLE)).toBe("Buy 1 Constructor");
    expect(runName(model(fresh), fresh, IN_12S)).toBe(
      "Buy 1 Constructor, affordable in 12 seconds",
    );
    expect(runName(model(fresh), fresh, NEVER)).toBe("Buy 1 Constructor, not affordable yet");
    expect(runName(model(fresh), fresh, { affordable: false, inMs: 800 })).toBe(
      "Buy 1 Constructor, affordable in 1 second",
    );
    expect(runName(model(many), many, AFFORDABLE)).toBe("Buy 10 Constructors");
    expect(runName(model(many), many, IN_12S)).toBe(
      "Buy 10 Constructors, affordable in 12 seconds",
    );
    expect(runName(model(storage), storage, AFFORDABLE)).toBe("Buy storage for Iron Plate");
    expect(runName(model(qs), qs, AFFORDABLE)).toBe("Buy Quantum Storage for Iron");
    expect(runName(model(reserve), reserve, AFFORDABLE)).toBe("Reserve 25% of Iron Plate");
  });
});

describe("nextBuyModel (U-4c)", { timeout: 60_000 }, () => {
  const at = (s: Snapshot) => s.schedule.atMs + 5_000;

  it("2. a machine buy: why, cost, and the effect from preview's own delta", () => {
    const m = model(fresh);
    const n = nextBuyModel(fresh, m, at(fresh), TERMINAL)!;
    expect(n.action).toBe("+1 CONSTRUCTOR_MK1 → IRON_PLATE");
    // The framed item is its own target: it's short of machines, not "X limits X".
    expect(n.why).toBe("IRON_PLATE is short of machines");
    expect(nextBuyModel(many, model(many), at(many), TERMINAL)!.why).toBe(
      "IRON_PLATE limits IRON_ROD",
    );
    expect(n.lane).toBe("IRON");
    expect(n.open).toBe("iron_plate");
    const p = preview(fresh, [m.action!]);
    if (!p.ok) throw new Error(p.reason);
    const d = p.deltas.find((x) => x.itemId === "iron_plate")!;
    expect(n.effect).toEqual([`IRON_PLATE ${rateText(d.before)} → ${rateText(d.after)}`]);
    expect(n.cost).toHaveLength(1);
    expect(n.cost[0]).toMatch(/^\S+ IRON_INGOT \(have \S+\)$/);
    // Count 1: no "buy 1".
    expect(n.buyOne).toBeNull();
  });

  it("2. buy 1 only for a machine buy with a count above 1", () => {
    const m = model(tier8);
    expect(m.action).toMatchObject({ type: "BUY_MACHINE", count: 10 });
    const n = nextBuyModel(tier8, m, at(tier8), TERMINAL)!;
    expect(n.buyOne).toEqual({ ...m.action, count: 1 });
    expect(n.why).toBe("BIOMASS limits power");
    const gen = withBottleneck(fresh, {
      kind: "power",
      limitingTarget: "item:iron_plate",
      generatorRecipeId: "burn_biomass",
      machinesToClear: 3,
      mark: 1,
    });
    const g = nextBuyModel(gen, model(gen), at(gen), TERMINAL)!;
    expect(g.why).toBe("power limits IRON_PLATE");
    expect(g.buyOne).toMatchObject({ machineClass: "biomass_burner", count: 1 });
    for (const s of [storage, qs, reserve])
      expect(nextBuyModel(s, model(s), at(s), TERMINAL)!.buyOne).toBeNull();
  });

  it("2. have is the shown stock plus bound at serverMs", () => {
    const base = freshState(slice);
    const bound = D(7);
    const s = snapshotOf(slice, { ...base, bound: { ...base.bound, iron_ingot: bound } });
    const ms = at(s);
    const n = nextBuyModel(s, model(s), ms, TERMINAL)!;
    const have = shownStock(s, "iron_ingot", ms).plus(bound);
    expect(n.cost[0]).toMatch(
      new RegExp(` IRON_INGOT \\(have ${fmt(have).replace(".", "\\.")}\\)$`),
    );
    expect(fmt(have)).not.toBe(fmt(shownStock(s, "iron_ingot", ms)));
    // And it moves with the 4 Hz serverMs.
    const later = nextBuyModel(s, model(s), ms + 60_000, TERMINAL)!;
    expect(later.cost[0]).not.toBe(n.cost[0]);
  });

  it("2. storage, QS and reserve: why and effect per kind", () => {
    const st = nextBuyModel(storage, model(storage), at(storage), TERMINAL)!;
    expect(st.action).toBe("+1 storage → IRON_PLATE");
    expect(st.why).toBe("IRON_PLATE is full, limiting SCREW");
    const level = storage.state.storageLevel.iron_plate ?? 0;
    const before = liquidCap(storage.content, storage.state, "iron_plate");
    const after = liquidCap(
      storage.content,
      { ...storage.state, storageLevel: { ...storage.state.storageLevel, iron_plate: level + 1 } },
      "iron_plate",
    );
    expect(after.gt(before)).toBe(true);
    expect(st.effect).toEqual([`IRON_PLATE cap ${fmt(before)} → ${fmt(after)}`]);
    expect(st.cost.length).toBeGreaterThan(0);

    const q = nextBuyModel(qs, model(qs), at(qs), TERMINAL)!;
    expect(q.action).toBe("+1 qs → IRON");
    expect(q.why).toBe("IRON_ROD is full, limiting IRON_ROD");
    expect(q.effect).toEqual(["IRON quantum +1 level"]);

    const r = nextBuyModel(reserve, model(reserve), at(reserve), TERMINAL)!;
    expect(r.action).toBe("reserve 25% → IRON_PLATE");
    expect(r.why).toBe("IRON_PLATE never banks, limiting IRON_ROD");
    expect(r.effect).toEqual(["IRON_PLATE keeps 25% in stock"]);
    expect(r.cost).toEqual([]);
  });

  it("2. the plain themes name things by content name; frameless has no model", () => {
    const n = nextBuyModel(fresh, model(fresh), at(fresh), themeDef("clean-dark"))!;
    expect(n.action).toBe("+1 Constructor Mk.1 → Iron Plate");
    expect(n.lane).toBe("Iron");
    expect(n.why).toBe("Iron Plate is short of machines");
    const m: BottleneckModel = model(frameless);
    expect(nextBuyModel(frameless, m, at(frameless), TERMINAL)).toBeNull();
  });
});
