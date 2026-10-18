import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContentCache } from "./content-cache.js";
import {
  isAdoptable,
  localTimeOf,
  makeSnapshot,
  plateauAtMs,
  serverNow,
  type Snapshot,
} from "./snapshot.js";
import { CLIENT_T0, guestWorld, makeRig, type TestRig } from "./test-rig.js";
import type { WorldResponse } from "./wire.js";

const at = (stateVersion: number, atMs: number) =>
  ({
    stateVersion,
    schedule: { atMs, items: {}, nextBoundaryAtMs: null },
    receivedAt: CLIENT_T0,
  }) as unknown as Snapshot;

describe("isAdoptable", () => {
  const current = at(5, 10_000);
  it("adopts anything when there is no current snapshot", () => {
    expect(isAdoptable(null, at(0, 0))).toBe(true);
  });
  it("adopts an equal version with a later atMs", () => {
    expect(isAdoptable(current, at(5, 10_001))).toBe(true);
  });
  it("does not adopt an equal version with an earlier atMs", () => {
    expect(isAdoptable(current, at(5, 9_999))).toBe(false);
  });
  it("adopts a higher version with an earlier atMs (a POST trails a GET by the round trip)", () => {
    expect(isAdoptable(current, at(6, 9_000))).toBe(true);
  });
  it("never adopts a lower version", () => {
    expect(isAdoptable(current, at(4, 99_999))).toBe(false);
  });
});

describe("serverNow / localTimeOf", () => {
  it("are inverses and never read Date.now", () => {
    const spy = vi.spyOn(Date, "now");
    try {
      const s = at(1, 1_760_000_123_456);
      for (const local of [CLIENT_T0, CLIENT_T0 + 1, CLIENT_T0 + 37_250.5, CLIENT_T0 - 400]) {
        expect(localTimeOf(s, serverNow(s, local))).toBeCloseTo(local, 6);
      }
      expect(serverNow(s, CLIENT_T0 + 1_000)).toBe(1_760_000_124_456);
      expect(localTimeOf(s, 1_760_000_124_456)).toBe(CLIENT_T0 + 1_000);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("makeSnapshot on a real GET", () => {
  let rig: TestRig;
  let world: WorldResponse;
  let snap: Snapshot;
  beforeAll(async () => {
    rig = await makeRig();
    ({ world } = await guestWorld(rig));
    const content = await new ContentCache(rig.fetch).get(world.contentChecksum);
    snap = makeSnapshot(world, content, CLIENT_T0);
  });
  afterAll(async () => {
    await rig.close();
  });

  it("keeps the server's schedule and the response fields", () => {
    expect(snap.schedule).toEqual(world.schedule);
    expect(snap.stateVersion).toBe(world.stateVersion);
    expect(snap.contentChecksum).toBe(world.contentChecksum);
    expect(snap.receivedAt).toBe(CLIENT_T0);
    expect(snap.persistedAtMs).toBe(world.persistedAtMs);
    expect(snap.state.lastResolvedAt).toBe(world.persistedAtMs);
  });

  it("solves the state schedule() advanced to, which agrees with the server's rates", () => {
    expect(snap.display.state.lastResolvedAt).toBe(snap.schedule.atMs);
    expect(snap.display.solution.itemRates.get("iron_ore")!.net).toBe(
      snap.schedule.items.iron_ore!.netPerSecond,
    );
  });

  it("plateaus at persistedAtMs + offlineCapMs, and never without persistedAtMs", () => {
    expect(plateauAtMs(snap)).toBe(world.persistedAtMs! + snap.content.offlineCapMs);
    const { persistedAtMs: _dropped, ...old } = world;
    expect(makeSnapshot(old, snap.content, CLIENT_T0).persistedAtMs).toBeNull();
    expect(plateauAtMs(makeSnapshot(old, snap.content, CLIENT_T0))).toBe(Infinity);
  });
});
