import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentCache } from "./content-cache.js";
import { minGapMs, nextFetchAt, nextRepoll, type RepollState } from "./refetch.js";
import { localTimeOf, makeSnapshot, type Snapshot } from "./snapshot.js";
import { CLIENT_T0, guestWorld, makeRig, type TestRig } from "./test-rig.js";

let rig: TestRig;
let base: Snapshot;
beforeAll(async () => {
  rig = await makeRig();
  const { world } = await guestWorld(rig);
  const content = await new ContentCache(rig.fetch).get(world.contentChecksum);
  base = makeSnapshot(world, content, CLIENT_T0);
});
afterAll(async () => {
  await rig.close();
});

/** The base snapshot with its boundary `aheadMs` past atMs (null: none) and an optional plateau. */
function snap(aheadMs: number | null, plateauAheadMs: number | null = null): Snapshot {
  const { atMs } = base.schedule;
  return {
    ...base,
    schedule: { ...base.schedule, nextBoundaryAtMs: aheadMs === null ? null : atMs + aheadMs },
    persistedAtMs:
      plateauAheadMs === null ? null : atMs + plateauAheadMs - base.content.offlineCapMs,
  };
}

const none: RepollState = { streak: 0 };

describe("nextFetchAt", () => {
  it("targets the boundary + 250 ms in local time", () => {
    const s = snap(37_000);
    expect(nextFetchAt(s, none)).toBe(localTimeOf(s, s.schedule.atMs + 37_000 + 250));
    expect(nextFetchAt(s, none)).toBe(CLIENT_T0 + 37_250);
  });

  it("never comes sooner than MIN_REPOLL_MS after the snapshot", () => {
    expect(nextFetchAt(snap(100), none)).toBe(CLIENT_T0 + 5_000);
  });

  it("is null with no boundary and no plateau", () => {
    expect(nextFetchAt(snap(null), none)).toBeNull();
  });

  it("guards at the plateau when there is no boundary", () => {
    const s = snap(null, 3_600_000);
    expect(nextFetchAt(s, none)).toBe(localTimeOf(s, s.schedule.atMs + 3_600_000 + 250));
  });

  it("targets the plateau when it comes before the boundary", () => {
    const s = snap(7_200_000, 3_600_000);
    expect(nextFetchAt(s, none)).toBe(CLIENT_T0 + 3_600_250);
  });

  it("is null once plateaued, even with a boundary (P-4)", () => {
    expect(nextFetchAt(snap(37_000, 0), none)).toBeNull();
    expect(nextFetchAt(snap(37_000, -1_000), none)).toBeNull();
  });
});

describe("nextRepoll / minGapMs", () => {
  it("backs off 5, 5, 10, 20, 40, 60, 60 s over consecutive short snapshots", () => {
    let r = none;
    const gaps: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      r = nextRepoll(r, snap(100), "get");
      gaps.push(minGapMs(r));
    }
    expect(gaps).toEqual([5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(nextFetchAt(snap(100), r)).toBe(CLIENT_T0 + 60_000);
  });

  it("resets on a POST, and on a boundary at least 1 s ahead or none", () => {
    const deep: RepollState = { streak: 6 };
    expect(nextRepoll(deep, snap(100), "post")).toEqual({ streak: 0 });
    expect(nextRepoll(deep, snap(1_000), "get")).toEqual({ streak: 0 });
    expect(nextRepoll(deep, snap(null), "get")).toEqual({ streak: 0 });
    expect(nextRepoll(deep, snap(999), "get")).toEqual({ streak: 7 });
    expect(minGapMs(none)).toBe(5_000);
  });
});
