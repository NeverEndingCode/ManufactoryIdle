// U-9b / L-12 / L-13: the trend book, sparkline() and trendWord(), pure, on hand-made schedules.
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import type { AdoptEvent } from "../sync/store.js";
import {
  BUCKET_MS,
  createTrendBook,
  rowTrend,
  sparkline,
  STEADY_BAND,
  TREND_BUCKETS,
  trendWord,
} from "./trend.js";

/** A minute boundary on the server clock, so the buckets are easy to name. */
const T0 = 29_333_333 * BUCKET_MS;
const S = 1_000;
const MIN = 60 * S;

/** A Snapshot-like: only the schedule (and the arrival time, for the minute timer) matter. */
function snap(
  atMs: number,
  rates: Record<string, number>,
  opts: { boundary?: number | null; receivedAt?: number } = {},
): Snapshot {
  const items = Object.fromEntries(
    Object.entries(rates).map(([id, r]) => [id, { stock: "0", netPerSecond: r }]),
  );
  return {
    schedule: { atMs, items, nextBoundaryAtMs: opts.boundary ?? null },
    receivedAt: opts.receivedAt ?? 0,
  } as unknown as Snapshot;
}

const ev = (prev: Snapshot | null, next: Snapshot): AdoptEvent => ({ prev, next, settled: null });

/** A fake `later`: a queue of timers on a hand-moved clock. */
function fakeTimers() {
  let clock = 0;
  let queue: { at: number; fn: () => void }[] = [];
  return {
    now: () => clock,
    later(fn: () => void, ms: number) {
      const t = { at: clock + ms, fn };
      queue.push(t);
      return () => {
        queue = queue.filter((x) => x !== t);
      };
    },
    advance(ms: number) {
      const until = clock + ms;
      for (;;) {
        const due = queue.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        queue = queue.filter((t) => t !== due);
        clock = due.at;
        due.fn();
      }
      clock = until;
    },
    get queue() {
      return queue.map((t) => t.at);
    },
  };
}

function book() {
  const t = fakeTimers();
  return { t, b: createTrendBook({ later: t.later, now: t.now }) };
}

describe("the trend book (U-9b, L-13)", () => {
  it("has the spec's constants", () => {
    expect([TREND_BUCKETS, BUCKET_MS, STEADY_BAND]).toEqual([10, 60_000, 0.02]);
  });

  // Catches: an unweighted mean of rates (a 1 s segment counting as much as a 59 s one), or a
  // segment credited whole to the minute it started in.
  it("1. a bucket is the time-weighted mean; a segment across two minutes splits by time", () => {
    const { b } = book();
    const a = snap(T0, { x: 2 });
    const c = snap(T0 + 30 * S, { x: 4 });
    const d = snap(T0 + 60 * S, { x: 0 });
    b.record(ev(null, a));
    b.record(ev(a, c));
    b.record(ev(c, d));
    const w = b.window("x", d, T0 + 60 * S);
    expect(w).toHaveLength(10);
    expect(w[8]).toBeCloseTo(3, 9);

    // 45 s at +6 from T0+30 s: 30 s in the first minute, 15 s in the second.
    const { b: b2 } = book();
    const p = snap(T0, { x: 0 });
    const q = snap(T0 + 30 * S, { x: 6 });
    const r = snap(T0 + 75 * S, { x: 0 });
    b2.record(ev(null, p));
    b2.record(ev(p, q));
    b2.record(ev(q, r));
    const w2 = b2.window("x", r, T0 + 75 * S);
    // Minute 0: 30 s at 0 and 30 s at 6. Minute 1: 15 s at 6 (the open segment has no length).
    expect(w2[8]).toBeCloseTo(3, 9);
    expect(w2[9]).toBeCloseTo(6, 9);
  });

  // Catches: crediting the hidden-tab gap at stale rates.
  it("2. a segment is cut at its snapshot's boundary; the minutes after are unknown", () => {
    const { b } = book();
    const a = snap(T0, { x: 5 }, { boundary: T0 + 20 * S });
    const next = snap(T0 + 5 * MIN, { x: 1 });
    b.record(ev(null, a));
    b.record(ev(a, next));
    const w = b.window("x", next, T0 + 5 * MIN);
    // The window is minutes -4 … +5: minute 0 sits at index 4.
    expect(w[4]).toBeCloseTo(5, 9);
    expect(w.slice(5, 9)).toEqual([null, null, null, null]);
    // The open segment hasn't started yet (serverMs is next.atMs): unknown too.
    expect(w[9]).toBeNull();
  });

  // Catches: the open segment stored (double-counted on the next record), or not drawn at all.
  it("3. the open segment is credited in window, not stored", () => {
    const { b } = book();
    const a = snap(T0, { x: 2 });
    b.record(ev(null, a));
    const at = T0 + 30 * S;
    expect(b.window("x", a, at)[9]).toBeCloseTo(2, 9);
    expect(b.window("x", a, at)).toEqual(b.window("x", a, at));
    // A later record credits the segment once: 30 s at 2, then 29 s at 8 (not 30 s at 2 twice).
    const c = snap(at, { x: 8 });
    b.record(ev(a, c));
    expect(b.window("x", c, T0 + 59 * S)[9]).toBeCloseTo((30 * 2 + 29 * 8) / 59, 9);
    expect(b.window("x", c, T0 + 59 * S)).toEqual(b.window("x", c, T0 + 59 * S));
  });

  // Catches: dropping committedTo, so a POST whose atMs trails the last GET's credits the
  // overlap twice.
  it("4. the fence: a POST trailing the last credited end by 2 s adds nothing twice (L-13)", () => {
    const { b } = book();
    const a = snap(T0, { x: 0 });
    const get = snap(T0 + 30 * S, { x: 0 });
    const post = snap(T0 + 28 * S, { x: 6 });
    const later = snap(T0 + 60 * S, { x: 0 });
    b.record(ev(null, a));
    b.record(ev(a, get));
    b.record(ev(get, post));
    // The open segment starts at the fence too.
    expect(b.window("x", post, T0 + 40 * S)[9]).toBeCloseTo((30 * 0 + 10 * 6) / 40, 9);
    b.record(ev(post, later));
    // 30 s at 0, then the POST's 30 s at 6 (not 32 s): 3.
    expect(b.window("x", later, T0 + 60 * S)[8]).toBeCloseTo(3, 9);
  });

  // Catches: a fresh book drawing zeros (a flat line) where nothing is known.
  it("5. a fresh book is ten unknowns", () => {
    const { b } = book();
    const a = snap(T0, { x: 1 });
    const w = b.window("x", a, T0);
    expect(w).toEqual(Array(10).fill(null));
    expect(sparkline(w)).toBe("··········");
  });

  // Catches: an unknown bucket left in the ring past ten minutes, or an item that's gone kept.
  it("9. bounded: 1,000 one-minute adoptions keep ten slots and a ten-minute window", () => {
    const { b } = book();
    let prev = snap(T0, { x: 0, gone: 1 });
    b.record(ev(null, prev));
    for (let i = 1; i <= 1000; i++) {
      const next = snap(T0 + i * MIN, { x: i });
      b.record(ev(prev, next));
      prev = next;
    }
    expect(b.size()).toEqual({ slots: 10, numbers: 10 });
    const w = b.window("x", prev, T0 + 1000 * MIN);
    // Minute 999 was credited at 999; minutes 991 … 999 at their own rate; 1000 is open, empty.
    expect(w).toEqual([991, 992, 993, 994, 995, 996, 997, 998, 999, null]);
    expect(b.window("gone", prev, T0 + 1000 * MIN).slice(0, 9)).toEqual(Array(9).fill(0));
  });

  // Catches: one world's minutes drawn in another's rows, or the fence left in the future.
  it("10. a reset on prev === null empties the ring and the fence", () => {
    const { b } = book();
    const a = snap(T0, { x: 4 });
    const c = snap(T0 + 5 * MIN, { x: 4 });
    b.record(ev(null, a));
    b.record(ev(a, c));
    const v = b.version();
    // A new world whose clock reads earlier than the old fence.
    const n = snap(T0 + 2 * MIN, { x: 7 });
    b.record(ev(null, n));
    expect(b.version()).toBeGreaterThan(v);
    expect(b.size()).toEqual({ slots: 0, numbers: 0 });
    // The fence is gone: the open segment from T0+2 min counts.
    const w = b.window("x", n, T0 + 2 * MIN + 30 * S);
    expect(w.slice(0, 9)).toEqual(Array(9).fill(null));
    expect(w[9]).toBeCloseTo(7, 9);
  });

  // Catches: a timer leak (armed with no subscriber, or not cancelled with the last), a timer
  // per subscriber, or a timer that fires once and never again.
  it("11. the minute timer: armed while subscribed, bumps, re-arms, cancelled with the last", () => {
    const { t, b } = book();
    // The client clock is 0 at T0 + 15 s on the server.
    const a = snap(T0 + 15 * S, { x: 1 }, { receivedAt: 0 });
    b.record(ev(null, a));
    expect(t.queue).toEqual([]);
    const off1 = b.subscribe(() => {});
    let seen = 0;
    const off2 = b.subscribe(() => (seen += 1));
    expect(t.queue).toEqual([45 * S]);
    const v = b.version();
    t.advance(45 * S);
    expect(b.version()).toBe(v + 1);
    expect(seen).toBe(1);
    expect(t.queue).toEqual([105 * S]);
    t.advance(60 * S);
    expect(b.version()).toBe(v + 2);
    off1();
    expect(t.queue).toEqual([165 * S]);
    off2();
    expect(t.queue).toEqual([]);
    // A record bumps too, and with no subscriber arms nothing.
    b.record(ev(a, snap(T0 + 2 * MIN, { x: 1 }, { receivedAt: 105 * S })));
    expect(b.version()).toBe(v + 3);
    expect(t.queue).toEqual([]);

    // Subscribed before the first snapshot (RowList mounts before the first adoption): the
    // first record arms it.
    const { t: t2, b: b2 } = book();
    const off = b2.subscribe(() => {});
    expect(t2.queue).toEqual([]);
    b2.record(ev(null, a));
    expect(t2.queue).toEqual([45 * S]);
    off();
    expect(t2.queue).toEqual([]);
  });
});

describe("sparkline and trendWord (U-9b)", () => {
  // Catches: an off-by-one in the eight levels, or a scale that assumes values ≥ 0.
  it("6. the scale runs min to max over the eight cells, negative ranges too", () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe("▁▂▃▄▅▆▇█");
    expect(sparkline([-7, -6, -5, -4, -3, -2, -1, 0])).toBe("▁▂▃▄▅▆▇█");
    expect(sparkline([null, 0, null, 7])).toBe("·▁·█");
  });

  // Catches: dividing by zero, or a flat line drawn as ▁.
  it("7. inside the steady band every known cell is ▄; all zero is ▄", () => {
    expect(sparkline([100, 101, 99, null, 100.5])).toBe("▄▄▄·▄");
    expect(sparkline([0, 0, 0])).toBe("▄▄▄");
    expect(sparkline([1, 1.05])).toBe("▁█");
  });

  // Catches: the word from the first and last cells (unknowns included), a word with one value,
  // or "rising" inside the band.
  it("8. trendWord: rising, falling, steady, and null with fewer than two known", () => {
    expect(trendWord([null, 1, 5, 2, null])).toBe("rising");
    expect(trendWord([3, 9, 1])).toBe("falling");
    expect(trendWord([-3, -1])).toBe("rising");
    expect(trendWord([100, 50, 101])).toBe("steady");
    expect(trendWord([0, 0])).toBe("steady");
    expect(trendWord([null, 4, null])).toBeNull();
    expect(trendWord(Array(10).fill(null))).toBeNull();
  });

  it("rowTrend: the cells, the word, and down from the snapshot's own rate", () => {
    const { b } = book();
    const a = snap(T0, { x: -1, y: 2 });
    const c = snap(T0 + MIN, { x: -3, y: 2 });
    b.record(ev(null, a));
    b.record(ev(a, c));
    expect(rowTrend(b, c, "x", T0 + MIN + 30 * S)).toEqual({
      cells: "········█▁",
      word: "falling",
      down: true,
    });
    expect(rowTrend(b, c, "y", T0 + MIN + 30 * S)).toEqual({
      cells: "········▄▄",
      word: "steady",
      down: false,
    });
  });
});
