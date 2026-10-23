import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D, deserializeWorld, liquidCap, schedule, type IndexedContent } from "@manufactory/engine";
import { ContentCache } from "./content-cache.js";
import { isPlateaued, shownStock, storageFraction, storageTransition } from "./interpolate.js";
import { makeSnapshot, type Snapshot } from "./snapshot.js";
import { CLIENT_T0, guestWorld, makeRig, type TestRig } from "./test-rig.js";
import type { WorldResponse } from "./wire.js";

const FIXTURES = new URL("../../../../packages/engine/src/resolve/fixtures/", import.meta.url);

let rig: TestRig;
let content: IndexedContent;
let fresh: Snapshot; // a fresh slice guest, from a real GET
// The tier-8 fixtures, hand-wrapped with the engine's own schedule and no persistedAtMs.
// reinforced-full has rising items short of their cap but no falling one at its schedule's
// state; plain tier-8 has falling ones (iron_plate, screw, fuel).
let tier8: Snapshot;
let tier8Falling: Snapshot;
beforeAll(async () => {
  rig = await makeRig();
  const { world } = await guestWorld(rig);
  content = await new ContentCache(rig.fetch).get(world.contentChecksum);
  fresh = makeSnapshot(world, content, CLIENT_T0);
  const wrap = (file: string): Snapshot => {
    const text = readFileSync(new URL(file, FIXTURES), "utf8");
    const resp: WorldResponse = {
      state: JSON.parse(text) as unknown,
      schedule: schedule(deserializeWorld(text), content),
      stateVersion: 1,
      contentChecksum: world.contentChecksum,
    };
    return makeSnapshot(resp, content, CLIENT_T0);
  };
  tier8 = wrap("slice-tier-8-reinforced-full.world.json");
  tier8Falling = wrap("slice-tier-8.world.json");
});
afterAll(async () => {
  await rig.close();
});

const stockOf = (s: Snapshot, item: string) => Number(s.schedule.items[item]!.stock);
const netOf = (s: Snapshot, item: string) => s.schedule.items[item]!.netPerSecond;
const capOf = (s: Snapshot, item: string) => liquidCap(s.content, s.state, item).toNumber();
const noPlateau = (s: Snapshot): Snapshot => ({ ...s, persistedAtMs: null });
const plateauAt = (s: Snapshot, plateauMs: number): Snapshot => ({
  ...s,
  persistedAtMs: plateauMs - s.content.offlineCapMs,
});

describe("shownStock", () => {
  it("draws a straight line from the server's stock and rate", () => {
    const { atMs } = fresh.schedule;
    expect(netOf(fresh, "iron_ore")).toBeGreaterThan(0);
    const expected = stockOf(fresh, "iron_ore") + 10 * netOf(fresh, "iron_ore");
    expect(shownStock(fresh, "iron_ore", atMs + 10_000).toNumber()).toBeCloseTo(expected, 9);
    // Before atMs it holds the snapshot's stock.
    expect(shownStock(fresh, "iron_ore", atMs - 5_000).toNumber()).toBe(stockOf(fresh, "iron_ore"));
  });

  it("clamps to liquidCap and to 0", () => {
    const { atMs } = tier8.schedule;
    const rising = content.stockItemIds.find(
      (id) => netOf(tier8, id) > 0 && stockOf(tier8, id) < capOf(tier8, id),
    )!;
    const falling = content.stockItemIds.find(
      (id) => netOf(tier8Falling, id) < 0 && stockOf(tier8Falling, id) > 0,
    )!;
    expect(rising).toBeDefined();
    expect(falling).toBeDefined();
    const toFull = ((capOf(tier8, rising) - stockOf(tier8, rising)) / netOf(tier8, rising)) * 1000;
    const toEmpty = (stockOf(tier8Falling, falling) / -netOf(tier8Falling, falling)) * 1000;
    const cap = liquidCap(content, tier8.state, rising);
    expect(shownStock(tier8, rising, atMs + toFull / 2).lt(cap)).toBe(true);
    expect(shownStock(tier8, rising, atMs + 2 * toFull).eq(cap)).toBe(true);
    const fallAt = tier8Falling.schedule.atMs;
    expect(shownStock(tier8Falling, falling, fallAt + toEmpty / 2).gt(D(0))).toBe(true);
    expect(shownStock(tier8Falling, falling, fallAt + 2 * toEmpty).eq(D(0))).toBe(true);
  });

  it("stops at the plateau", () => {
    const { atMs } = fresh.schedule;
    const s = plateauAt(fresh, atMs + 5_000);
    const atPlateau = shownStock(s, "iron_ore", atMs + 5_000);
    expect(shownStock(s, "iron_ore", atMs + 60_000).eq(atPlateau)).toBe(true);
    expect(atPlateau.gt(shownStock(s, "iron_ore", atMs + 1_000))).toBe(true);
  });
});

describe("isPlateaued", () => {
  it("is true once atMs reaches the plateau", () => {
    const { atMs } = fresh.schedule;
    expect(isPlateaued(plateauAt(fresh, atMs))).toBe(true);
    expect(isPlateaued(plateauAt(fresh, atMs - 1))).toBe(true);
    expect(isPlateaued(plateauAt(fresh, atMs + 1))).toBe(false);
    expect(isPlateaued(noPlateau(fresh))).toBe(false);
  });
});

describe("storageFraction / storageTransition", () => {
  const item = "iron_ore";
  const toFullMs = (s: Snapshot) => ((capOf(s, item) - stockOf(s, item)) / netOf(s, item)) * 1000;
  const withBoundary = (s: Snapshot, boundaryMs: number | null): Snapshot => ({
    ...s,
    schedule: { ...s.schedule, nextBoundaryAtMs: boundaryMs },
  });

  it("storageFraction is shown / liquidCap in [0, 1]", () => {
    const s = noPlateau(fresh);
    const { atMs } = s.schedule;
    expect(storageFraction(s, item, atMs + 10_000)).toBeCloseTo(
      (stockOf(s, item) + 10 * netOf(s, item)) / capOf(s, item),
      9,
    );
    expect(storageFraction(s, item, atMs + 100 * toFullMs(s))).toBe(1);
  });

  it("runs to full when full comes before the boundary", () => {
    const s = noPlateau(fresh);
    const { atMs } = s.schedule;
    const full = toFullMs(s);
    const t = storageTransition(withBoundary(s, atMs + 10 * full), item, atMs);
    expect(t.from).toBeCloseTo(stockOf(s, item) / capOf(s, item), 9);
    expect(t.to).toBe(1);
    expect(t.durationMs).toBeCloseTo(full, 3);
  });

  it("runs to the boundary when the boundary comes first", () => {
    const s = noPlateau(fresh);
    const { atMs } = s.schedule;
    const half = toFullMs(s) / 2;
    const t = storageTransition(withBoundary(s, atMs + half), item, atMs);
    expect(t.durationMs).toBeCloseTo(half, 3);
    expect(t.to).toBeCloseTo(storageFraction(s, item, atMs + half), 9);
    expect(t.to).toBeLessThan(1);
  });

  // slice-tier-8 (tier8Falling): reinforced-full has no falling item at its schedule's state.
  it("runs to empty when a draining item empties before the boundary", () => {
    const { atMs, nextBoundaryAtMs } = tier8Falling.schedule;
    const id = Object.keys(tier8Falling.schedule.items).find((k) => {
      const net = netOf(tier8Falling, k);
      return net < 0 && (stockOf(tier8Falling, k) / -net) * 1000 < (nextBoundaryAtMs ?? Infinity) - atMs;
    })!;
    expect(id).toBeDefined();
    const toEmptyMs = (stockOf(tier8Falling, id) / -netOf(tier8Falling, id)) * 1000;
    const t = storageTransition(noPlateau(tier8Falling), id, atMs);
    expect(t.to).toBe(0);
    expect(Math.abs(t.durationMs - toEmptyMs)).toBeLessThanOrEqual(1);
  });

  it("stops at the plateau", () => {
    const { atMs } = fresh.schedule;
    const s = withBoundary(plateauAt(fresh, atMs + 1_000), null);
    expect(storageTransition(s, item, atMs).durationMs).toBeCloseTo(1_000, 6);
  });
});
