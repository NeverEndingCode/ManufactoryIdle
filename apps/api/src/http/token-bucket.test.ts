import { describe, expect, it } from "vitest";
import { TokenBucket } from "./token-bucket.js";

describe("TokenBucket", () => {
  it("allows capacity calls, refuses the next, and says when to retry", () => {
    const now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1 }, () => now);
    for (let i = 0; i < 3; i++) expect(bucket.take("a")).toEqual({ ok: true });
    expect(bucket.take("a")).toEqual({ ok: false, retryAfterSec: 1 });
  });

  it("refills with the clock and never beyond capacity", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1 }, () => now);
    for (let i = 0; i < 3; i++) bucket.take("a");
    now = 2_000;
    expect(bucket.take("a").ok).toBe(true);
    expect(bucket.take("a").ok).toBe(true);
    expect(bucket.take("a").ok).toBe(false);
    now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(bucket.take("a").ok).toBe(true);
    expect(bucket.take("a").ok).toBe(false);
  });

  it("keeps keys apart", () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1 }, () => 0);
    expect(bucket.take("a").ok).toBe(true);
    expect(bucket.take("a").ok).toBe(false);
    expect(bucket.take("b").ok).toBe(true);
  });

  it("rounds Retry-After up to whole seconds, at least 1", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 5 / 3600 }, () => now);
    bucket.take("a");
    expect(bucket.take("a")).toEqual({ ok: false, retryAfterSec: 720 });
    now = 719_500;
    expect(bucket.take("a")).toEqual({ ok: false, retryAfterSec: 1 });
  });

  it("forgets keys whose bucket is full again", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1 }, () => now, { sweepAbove: 0 });
    bucket.take("a");
    now = 30_000;
    bucket.take("b");
    expect(bucket.size).toBe(1);
  });

  it("sweeps at most once per 30 s, or once per 1,000 new keys", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1 }, () => now, { sweepAbove: 0 });
    bucket.take("a"); // the interval runs from construction, at 0
    now = 10_000; // "a" has long refilled, but the last sweep was 10 s ago
    bucket.take("b");
    expect(bucket.size).toBe(2);
    now = 29_999;
    bucket.take("c");
    expect(bucket.size).toBe(3);
    now = 30_000; // 30 s since the last sweep: a and b are full again and go; c, 1 ms old, stays
    bucket.take("d");
    expect(bucket.size).toBe(2);

    // 1,000 new keys since the last sweep also trigger one, before 30 s have passed.
    now = 40_000;
    for (let i = 0; i < 999; i++) bucket.take(`k${i}`);
    expect(bucket.size).toBe(1_001); // no sweep yet: 10 s, and 999 new keys plus d
    now = 41_000; // every key has refilled (1 per second, capacity 1)
    bucket.take("k999"); // the 1,000th insert since the sweep at 30 s
    expect(bucket.size).toBe(1);
  });

  it("holds at most maxKeys, evicting the least recently used", () => {
    const now = 0;
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 1 }, () => now, { maxKeys: 3 });
    bucket.take("a");
    bucket.take("b");
    bucket.take("c");
    expect(bucket.take("a").ok).toBe(false); // touches "a": "b" is now the oldest
    bucket.take("d");
    expect(bucket.size).toBe(3);
    expect(bucket.take("a").ok).toBe(false); // kept, still empty
    expect(bucket.take("c").ok).toBe(false); // kept
    expect(bucket.take("b").ok).toBe(true); // evicted, so it starts full again
  });

  it("defaults to a 100,000-key cap", () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 0 }, () => 0);
    for (let i = 0; i < 100_001; i++) bucket.take(String(i));
    expect(bucket.size).toBe(100_000);
  });
});
