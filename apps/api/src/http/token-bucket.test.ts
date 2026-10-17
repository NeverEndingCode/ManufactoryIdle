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
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 1 }, () => now, 0);
    bucket.take("a");
    now = 10_000;
    bucket.take("b");
    expect(bucket.size).toBe(1);
  });
});
