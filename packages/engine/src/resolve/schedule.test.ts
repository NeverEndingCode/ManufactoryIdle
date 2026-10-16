import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { toCanonical } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { liquid } from "../economy/storage.js";
import { initialWorld } from "../state/world.js";
import { solve } from "../solve/solve.js";
import { EPSILON_MS, resolve, schedule } from "./index.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

const BIG = 3_600_000;

describe("schedule", () => {
  it("reports each stock item's liquid stock and net rate", () => {
    const state = initialWorld(content, 1, 0);
    const s = schedule(state, content);
    const solution = solve(state, content);
    expect(s.atMs).toBe(state.lastResolvedAt);
    expect(Object.keys(s.items).sort()).toEqual([...content.stockItemIds].sort());
    for (const id of content.stockItemIds) {
      expect(s.items[id]!.stock).toBe(toCanonical(liquid(state, id)));
      expect(s.items[id]!.netPerSecond).toBe(solution.itemRates.get(id)?.net ?? 0);
    }
  });

  it("on a fresh world skips the internal unpin and matches the first reported event", () => {
    // iron_ore and iron_ingot start EMPTY-pinned, so resolve's first internal step is
    // the EPSILON unpin. It is not a visible rate change, so schedule must not report it.
    const state = initialWorld(content, 1, 0);
    const s = schedule(state, content);
    const { events } = resolve(state, content, BIG);
    expect(s.nextBoundaryAtMs).not.toBeNull();
    expect(s.nextBoundaryAtMs!).toBeGreaterThan(EPSILON_MS * 1000);
    expect(s.nextBoundaryAtMs!).toBeCloseTo(events[0]!.atMs, 6);
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
