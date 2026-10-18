import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { toCanonical } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { liquid } from "../economy/storage.js";
import { initialWorld } from "../state/world.js";
import { deserializeWorld, serializeWorld } from "../state/serialize.js";
import { solve } from "../solve/solve.js";
import { EPSILON_MS, resolve, schedule, scheduleDetail } from "./index.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));
const sliceDir = fileURLToPath(new URL("../../../content/bundles/vertical-slice", import.meta.url));
const slice = indexContent(loadBundleDir(sliceDir));

const BIG = 3_600_000;
// The slice's first event (iron_ore fills) is ~4.0e6 ms out, past BIG.
const SLICE_BIG = 4 * BIG;

describe("schedule", () => {
  it("reports each stock item's liquid stock and net rate", () => {
    // Settled past the unpin, so schedule describes this exact state.
    const state = resolve(initialWorld(content, 1, 0), content, 1_000).state;
    const s = schedule(state, content);
    const solution = solve(state, content);
    expect(s.atMs).toBe(state.lastResolvedAt);
    expect(Object.keys(s.items).sort()).toEqual([...content.stockItemIds].sort());
    for (const id of content.stockItemIds) {
      expect(s.items[id]!.stock).toBe(toCanonical(liquid(state, id)));
      expect(s.items[id]!.netPerSecond).toBe(solution.itemRates.get(id)?.net ?? 0);
    }
  });

  it("on a fresh world steps past the internal unpin and matches the first reported event", () => {
    // iron_ore and iron_ingot start EMPTY-pinned, so resolve's first internal step is
    // the EPSILON unpin. That step is not a visible rate change, so schedule steps past it
    // (as resolve does) and reports the boundary after it.
    const state = initialWorld(content, 1, 0);
    const s = schedule(state, content);
    const { events } = resolve(state, content, BIG);
    expect(s.nextBoundaryAtMs).not.toBeNull();
    // Past the unpin step itself, not just "positive".
    expect(s.nextBoundaryAtMs!).toBeGreaterThan(state.lastResolvedAt + EPSILON_MS);
    expect(s.nextBoundaryAtMs!).toBeCloseTo(events[0]!.atMs, 6);
  });

  it("on a fresh vertical-slice world reports resolve's first event and the post-unpin rates", () => {
    // Skipping the unpin is not enough here: the pinned solve's rates are wrong
    // (iron_ore 0.98, not 1.0) and the boundary search must use the unpinned ones.
    const state = initialWorld(slice, 1, 0);
    const s = schedule(state, slice);
    const { events } = resolve(state, slice, SLICE_BIG);
    expect(events.length).toBeGreaterThan(0);
    expect(s.nextBoundaryAtMs).not.toBeNull();
    expect(s.nextBoundaryAtMs!).toBeCloseTo(events[0]!.atMs, 3);

    const advanced = resolve(state, slice, EPSILON_MS).state;
    const unpinned = solve(advanced, slice);
    expect(s.atMs).toBe(advanced.lastResolvedAt);
    expect(s.items["iron_ore"]!.netPerSecond).toBe(unpinned.itemRates.get("iron_ore")?.net ?? 0);
    expect(s.items["iron_ore"]!.netPerSecond).not.toBe(
      solve(state, slice).itemRates.get("iron_ore")?.net ?? 0,
    );
  });

  it("matches the first event resolve fires once nothing is pinned", () => {
    // Settle past the unpin first, so the first reported event is the first boundary.
    const state = resolve(initialWorld(content, 1, 0), content, 1_000).state;
    const s = schedule(state, content);
    const { events } = resolve(state, content, BIG);
    expect(events.length).toBeGreaterThan(0);
    expect(s.nextBoundaryAtMs).not.toBeNull();
    expect(s.nextBoundaryAtMs!).toBeCloseTo(events[0]!.atMs, 6);
    expect(s.nextBoundaryAtMs!).toBeGreaterThan(state.lastResolvedAt);
  });

  it("is null when nothing changes rate", () => {
    // A world with no machines assigned: every net is 0, no timers, and the
    // milestone is unreachable.
    const base = initialWorld(content, 1, 0);
    const idle = {
      ...base,
      assignment: Object.fromEntries(Object.keys(base.assignment).map((k) => [k, 0])),
    } as typeof base;
    const s = schedule(idle, content);
    for (const id of content.stockItemIds) expect(s.items[id]!.netPerSecond).toBe(0);
    expect(s.nextBoundaryAtMs).toBeNull();
  });
});

const GOLDEN_FRESH_SLICE =
  '{"atMs":0.000001,"items":{"iron_ore":{"stock":"9.799999999999999e-10","netPerSecond":1},"iron_ingot":{"stock":"4.799999999999999e-10","netPerSecond":0.5},"iron_plate":{"stock":"3.3333333333333326e-10","netPerSecond":0.3333333333333333},"iron_rod":{"stock":"0e0","netPerSecond":0},"screw":{"stock":"0e0","netPerSecond":0},"reinforced_iron_plate":{"stock":"0e0","netPerSecond":0},"rotor":{"stock":"0e0","netPerSecond":0},"modular_frame":{"stock":"0e0","netPerSecond":0},"smart_plating":{"stock":"0e0","netPerSecond":0},"heavy_modular_frame":{"stock":"0e0","netPerSecond":0},"biomass":{"stock":"0e0","netPerSecond":0},"copper_ore":{"stock":"0e0","netPerSecond":0},"copper_ingot":{"stock":"0e0","netPerSecond":0},"wire":{"stock":"0e0","netPerSecond":0},"cable":{"stock":"0e0","netPerSecond":0},"copper_sheet":{"stock":"0e0","netPerSecond":0},"limestone":{"stock":"0e0","netPerSecond":0},"concrete":{"stock":"0e0","netPerSecond":0},"coal":{"stock":"0e0","netPerSecond":0},"steel_ingot":{"stock":"0e0","netPerSecond":0},"steel_beam":{"stock":"0e0","netPerSecond":0},"steel_pipe":{"stock":"0e0","netPerSecond":0},"encased_industrial_beam":{"stock":"0e0","netPerSecond":0},"water":{"stock":"0e0","netPerSecond":0},"crude_oil":{"stock":"0e0","netPerSecond":0},"heavy_oil_residue":{"stock":"0e0","netPerSecond":0},"plastic":{"stock":"0e0","netPerSecond":0},"rubber":{"stock":"0e0","netPerSecond":0},"fuel":{"stock":"0e0","netPerSecond":0},"empty_canister":{"stock":"0e0","netPerSecond":0},"packaged_fuel":{"stock":"0e0","netPerSecond":0},"polymer_resin":{"stock":"0e0","netPerSecond":0}},"nextBoundaryAtMs":4000000.00000002}';

// Equal to fec8408^'s schedule(), checked 2026-10-18 (a probe on both fixtures, byte for byte).
const GOLDEN_TIER_8 =
  '{"atMs":48802190.91156746,"items":{"iron_ore":{"stock":"1.38238953472e5","netPerSecond":0},"iron_ingot":{"stock":"1.03679215104e5","netPerSecond":0},"iron_plate":{"stock":"3.137730260477581e3","netPerSecond":-85.08865865964813},"iron_rod":{"stock":"8.63993459200001e4","netPerSecond":0},"screw":{"stock":"8.06844924122807e3","netPerSecond":-205.94603042388042},"reinforced_iron_plate":{"stock":"4.60329104591241e4","netPerSecond":15.595431437127145},"rotor":{"stock":"2.47584665792468e4","netPerSecond":3.5989457162601104},"modular_frame":{"stock":"1.72502688063713e4","netPerSecond":9.597188576693625},"smart_plating":{"stock":"0e0","netPerSecond":0},"heavy_modular_frame":{"stock":"0e0","netPerSecond":0},"biomass":{"stock":"0e0","netPerSecond":0},"copper_ore":{"stock":"4e3","netPerSecond":0},"copper_ingot":{"stock":"3e3","netPerSecond":0},"wire":{"stock":"4.5e3","netPerSecond":0},"cable":{"stock":"2.5e3","netPerSecond":0},"copper_sheet":{"stock":"4.22144e3","netPerSecond":0},"limestone":{"stock":"4e3","netPerSecond":0},"concrete":{"stock":"2.5e3","netPerSecond":0},"coal":{"stock":"4e3","netPerSecond":0},"steel_ingot":{"stock":"4.8576e3","netPerSecond":0},"steel_beam":{"stock":"2e3","netPerSecond":0},"steel_pipe":{"stock":"2e3","netPerSecond":0},"encased_industrial_beam":{"stock":"2.11072e3","netPerSecond":0},"water":{"stock":"0e0","netPerSecond":0},"crude_oil":{"stock":"5.44870912e4","netPerSecond":0},"heavy_oil_residue":{"stock":"0e0","netPerSecond":0},"plastic":{"stock":"3.75809638400001e4","netPerSecond":0},"rubber":{"stock":"3.758096384e4","netPerSecond":0},"fuel":{"stock":"1.1794760124435e4","netPerSecond":-6.161671571249069},"empty_canister":{"stock":"3.4054432e4","netPerSecond":0},"packaged_fuel":{"stock":"1.42282433707882e4","netPerSecond":7.394005885498882},"polymer_resin":{"stock":"0e0","netPerSecond":0}},"nextBoundaryAtMs":48839066.92195362}';
const GOLDEN_TIER_8_REINFORCED_FULL =
  '{"atMs":51082190.91156746,"items":{"iron_ore":{"stock":"1.38238953472e5","netPerSecond":0},"iron_ingot":{"stock":"1.03679215104e5","netPerSecond":0},"iron_plate":{"stock":"0e0","netPerSecond":0},"iron_rod":{"stock":"8.63993459200001e4","netPerSecond":0},"screw":{"stock":"0e0","netPerSecond":0},"reinforced_iron_plate":{"stock":"5.17321790892296e4","netPerSecond":2.772215697073225},"rotor":{"stock":"3.20629231049577e4","netPerSecond":3.8683108332239073},"modular_frame":{"stock":"5.23835557426673e4","netPerSecond":18.815909798232735},"smart_plating":{"stock":"0e0","netPerSecond":0},"heavy_modular_frame":{"stock":"0e0","netPerSecond":0},"biomass":{"stock":"0e0","netPerSecond":0},"copper_ore":{"stock":"4e3","netPerSecond":0},"copper_ingot":{"stock":"3e3","netPerSecond":0},"wire":{"stock":"4.5e3","netPerSecond":0},"cable":{"stock":"2.5e3","netPerSecond":0},"copper_sheet":{"stock":"4.22144e3","netPerSecond":0},"limestone":{"stock":"4e3","netPerSecond":0},"concrete":{"stock":"2.5e3","netPerSecond":0},"coal":{"stock":"4e3","netPerSecond":0},"steel_ingot":{"stock":"4.8576e3","netPerSecond":0},"steel_beam":{"stock":"2e3","netPerSecond":0},"steel_pipe":{"stock":"2e3","netPerSecond":0},"encased_industrial_beam":{"stock":"2.11072e3","netPerSecond":0},"water":{"stock":"0e0","netPerSecond":0},"crude_oil":{"stock":"5.44870912e4","netPerSecond":0},"heavy_oil_residue":{"stock":"0e0","netPerSecond":0},"plastic":{"stock":"3.75809638400001e4","netPerSecond":0},"rubber":{"stock":"3.758096384e4","netPerSecond":0},"fuel":{"stock":"0e0","netPerSecond":0},"empty_canister":{"stock":"3.4054432e4","netPerSecond":7.6446004055658445},"packaged_fuel":{"stock":"2.97439986568912e4","netPerSecond":1.5289200811131691},"polymer_resin":{"stock":"0e0","netPerSecond":0}},"nextBoundaryAtMs":51120942.75287758}';

const loadFixture = (name: string) =>
  deserializeWorld(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  );

const detailWorlds = [
  ["fresh fixture", () => initialWorld(content, 1, 0), content],
  ["fresh slice", () => initialWorld(slice, 1, 0), slice],
  ["slice tier 8", () => loadFixture("slice-tier-8.world.json"), slice],
  ["slice tier 8 reinforced full", () => loadFixture("slice-tier-8-reinforced-full.world.json"), slice],
] as const;

describe("scheduleDetail", () => {
  it.each(detailWorlds)("%s: schedule is byte-identical to schedule()", (_n, make, c) => {
    const s = make();
    expect(JSON.stringify(scheduleDetail(s, c).schedule)).toBe(JSON.stringify(schedule(s, c)));
  });

  it("keeps the fresh slice schedule byte-identical to the pre-refactor golden", () => {
    expect(JSON.stringify(schedule(initialWorld(slice, 1, 0), slice))).toBe(GOLDEN_FRESH_SLICE);
  });

  it("keeps the tier-8 schedules byte-identical to the pre-refactor goldens", () => {
    expect(JSON.stringify(schedule(loadFixture("slice-tier-8.world.json"), slice))).toBe(GOLDEN_TIER_8);
    expect(JSON.stringify(schedule(loadFixture("slice-tier-8-reinforced-full.world.json"), slice))).toBe(
      GOLDEN_TIER_8_REINFORCED_FULL,
    );
  });

  it.each(detailWorlds)("%s: scheduleDetail leaves its input unmutated", (_n, make, c) => {
    const s = make();
    const before = serializeWorld(s);
    scheduleDetail(s, c);
    expect(serializeWorld(s)).toBe(before);
  });

  it("returns the state advanced past the internal unpin", () => {
    const initial = initialWorld(slice, 1, 0);
    const detail = scheduleDetail(initial, slice);
    expect(detail.state.lastResolvedAt).toBe(detail.schedule.atMs);
    expect(detail.state).toEqual(resolve(initial, slice, EPSILON_MS).state);
  });

  it.each(detailWorlds)("%s: solution holds the rates schedule.items came from", (_n, make, c) => {
    const detail = scheduleDetail(make(), c);
    for (const id of c.stockItemIds) {
      expect(detail.solution.itemRates.get(id)?.net ?? 0).toBe(detail.schedule.items[id]!.netPerSecond);
    }
  });

  it("does not advance a world with nothing pinned", () => {
    const tier8 = loadFixture("slice-tier-8.world.json");
    expect(scheduleDetail(tier8, slice).state).toEqual(tier8);
  });
});
