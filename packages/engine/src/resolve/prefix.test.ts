// PL-2: the resumable prefix. A resolve that spends its MAX_EVENTS fine steps without any
// of them being clipped by the window can hand its state at that point to a later resolve
// from the same start, which resumes there. It is an optimisation only: every result must be
// byte-identical to a cold resolve, so each test here compares against one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { indexContent } from "../graph/index-content.js";
import { deserializeWorld, serializeWorld } from "../state/serialize.js";
import type { WorldState } from "../state/world.js";
import { resolve, schedule, type ResolvePrefix, type ResolveResult } from "./index.js";

const sliceDir = fileURLToPath(new URL("../../../content/bundles/vertical-slice", import.meta.url));
const slice = indexContent(loadBundleDir(sliceDir));
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.world.json`, import.meta.url)), "utf8");
const FIXTURES = ["slice-tier-8-reinforced-full", "slice-tier-8"] as const;
const load = (name: string): WorldState => deserializeWorld(fixture(name));

const HOUR = 3_600_000;
const WINDOWS = [5_000, 60_000, HOUR, 8 * HOUR, 24 * HOUR];

/** A test cache: a Map, counting stores, so a test can show a prefix was really kept. */
function testCache() {
  const map = new Map<string, ResolvePrefix>();
  let stores = 0;
  return {
    map,
    get stores() {
      return stores;
    },
    get: (key: string) => map.get(key),
    set: (key: string, value: ResolvePrefix) => {
      stores += 1;
      map.set(key, value);
    },
  };
}

/** Everything a caller can see of a resolve, as one string. */
function bytes(out: ResolveResult): string {
  return JSON.stringify({
    state: serializeWorld(out.state),
    events: out.events,
    summary: out.summary,
    schedule: schedule(out.state, slice),
  });
}

describe("resolve — the resumable prefix (PL-2)", () => {
  // Precondition for the whole file: the reinforced-full world trips the guard after an
  // unclipped prefix, so a prefix is kept; without that every test below is vacuous.
  it("keeps a prefix when the guard trips, and none when it does not", () => {
    const cache = testCache();
    resolve(load("slice-tier-8-reinforced-full"), slice, 5_000, { prefixCache: cache, cacheKey: "a" });
    expect(cache.stores).toBe(0);
    const out = resolve(load("slice-tier-8-reinforced-full"), slice, 60_000, {
      prefixCache: cache,
      cacheKey: "a",
    });
    expect(out.summary.guardTripped).toBe(true);
    expect(cache.stores).toBe(1);
  });

  for (const name of FIXTURES) {
    for (const windowMs of WINDOWS) {
      it(`${name}, ${windowMs / 1000} s: a cached resolve is byte-identical to a cold one`, { timeout: 60_000 }, () => {
        const cold = bytes(resolve(load(name), slice, windowMs));
        // Primed by the same window, and by the shortest window that trips the guard.
        for (const primeMs of [windowMs, 60_000]) {
          const cache = testCache();
          const first = resolve(load(name), slice, primeMs, { prefixCache: cache, cacheKey: "w" });
          if (primeMs === windowMs) expect(bytes(first)).toBe(cold);
          const again = resolve(load(name), slice, windowMs, { prefixCache: cache, cacheKey: "w" });
          expect(bytes(again)).toBe(cold);
          // And once more from the same cache: resuming must not have changed the entry.
          const third = resolve(load(name), slice, windowMs, { prefixCache: cache, cacheKey: "w" });
          expect(bytes(third)).toBe(cold);
        }
      });
    }
  }

  /** A cache primed at 60 s whose entry is then poisoned, so a resume is visible. */
  function poisoned(key: string) {
    const cache = testCache();
    resolve(load("slice-tier-8-reinforced-full"), slice, 60_000, { prefixCache: cache, cacheKey: key });
    const entry = cache.map.get(key)!;
    expect(entry).toBeDefined();
    const fake = { kind: "timer" as const, atMs: -1, timerId: "poison" };
    cache.map.set(key, { ...entry, events: [...entry.events, fake] });
    return cache;
  }

  it("resumes from the entry (a poisoned entry shows in the result)", () => {
    const cache = poisoned("k");
    const out = resolve(load("slice-tier-8-reinforced-full"), slice, HOUR, { prefixCache: cache, cacheKey: "k" });
    expect(out.events.some((e) => e.timerId === "poison")).toBe(true);
  });

  it("ignores the cache for a window shorter than the cached prefix", () => {
    const cache = poisoned("k");
    // The prefix spans ~26.7 µs of game time: a 10 µs window cannot reach its end.
    const start = load("slice-tier-8-reinforced-full");
    const out = resolve(start, slice, 0.01, { prefixCache: cache, cacheKey: "k" });
    expect(bytes(out)).toBe(bytes(resolve(load("slice-tier-8-reinforced-full"), slice, 0.01)));
  });

  it("misses on a different key", () => {
    const cache = poisoned("k");
    const out = resolve(load("slice-tier-8-reinforced-full"), slice, HOUR, { prefixCache: cache, cacheKey: "other" });
    expect(bytes(out)).toBe(bytes(resolve(load("slice-tier-8-reinforced-full"), slice, HOUR)));
  });

  it("misses on the same key from a different start state (a caller's wrong key is harmless)", () => {
    const cache = poisoned("k");
    const moved = { ...load("slice-tier-8-reinforced-full"), tapStacks: 1 };
    const out = resolve(moved, slice, HOUR, { prefixCache: cache, cacheKey: "k" });
    expect(bytes(out)).toBe(bytes(resolve({ ...load("slice-tier-8-reinforced-full"), tapStacks: 1 }, slice, HOUR)));
  });

  it("misses when the window skips time past the offline cap differently", () => {
    // 24 h skips 16 h before simulating, so its fine steps start 16 h later than 60 s's.
    const cache = poisoned("k");
    const out = resolve(load("slice-tier-8-reinforced-full"), slice, 24 * HOUR, { prefixCache: cache, cacheKey: "k" });
    expect(out.events.some((e) => e.timerId === "poison")).toBe(false);
  });

  it("does not share mutable results with the cache", () => {
    const cache = testCache();
    const opts = { prefixCache: cache, cacheKey: "m" };
    resolve(load("slice-tier-8-reinforced-full"), slice, 60_000, opts);
    const cold = bytes(resolve(load("slice-tier-8-reinforced-full"), slice, 60_000));
    const out = resolve(load("slice-tier-8-reinforced-full"), slice, 60_000, opts);
    // A caller scribbling on what it got back cannot reach the next caller's result.
    for (const e of out.events) e.atMs = -1;
    for (const f of out.summary.filled) f.atMs = -1;
    out.events.length = 0;
    expect(bytes(resolve(load("slice-tier-8-reinforced-full"), slice, 60_000, opts))).toBe(cold);
  });
});
