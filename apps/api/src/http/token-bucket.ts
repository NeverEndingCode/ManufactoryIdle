// In-memory token buckets (R-23): per instance, keyed by player id or IP. The clock is
// injected so tests drive refills deterministically.
export interface BucketConfig {
  /** Burst size, and the most tokens a key can hold. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface BucketLimits {
  /** Sweeping starts only past this many keys. Default 10,000. */
  sweepAbove?: number;
  /** The most keys held; inserting past it evicts the least recently used. Default 100,000. */
  maxKeys?: number;
  /** At most one sweep per this many ms, ... Default 30,000. */
  sweepEveryMs?: number;
  /** ... or sooner once this many new keys arrived since the last sweep. Default 1,000. */
  sweepEveryInserts?: number;
}

export class TokenBucket {
  /** In least-recently-used order: every take re-inserts its key at the end. */
  private readonly entries = new Map<string, { tokens: number; at: number }>();
  private readonly limits: Required<BucketLimits>;
  private lastSweepAt: number;
  private insertsSinceSweep = 0;

  constructor(
    private readonly config: BucketConfig,
    private readonly clock: () => number,
    limits: BucketLimits = {},
  ) {
    this.limits = {
      sweepAbove: 10_000,
      maxKeys: 100_000,
      sweepEveryMs: 30_000,
      sweepEveryInserts: 1_000,
      ...limits,
    };
    this.lastSweepAt = clock();
  }

  get size(): number {
    return this.entries.size;
  }

  take(key: string): TakeResult {
    const { capacity, refillPerSec } = this.config;
    const now = this.clock();
    // A sweep walks every key, so it is throttled: without that, a flood of distinct keys
    // that never refill (an attacker's IPs) would make every take O(keys).
    const { sweepAbove, sweepEveryMs, sweepEveryInserts, maxKeys } = this.limits;
    if (
      this.entries.size > sweepAbove &&
      (now - this.lastSweepAt >= sweepEveryMs || this.insertsSinceSweep >= sweepEveryInserts)
    ) {
      this.sweep(now);
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
    } else {
      this.insertsSinceSweep += 1;
      // The hard cap. An evicted key starts full again on its next call: a flood of distinct
      // keys can only reset the coldest buckets, and memory stays bounded.
      if (this.entries.size >= maxKeys) this.entries.delete(this.entries.keys().next().value!);
    }
    const entry = existing ?? { tokens: capacity, at: now };
    const elapsedSec = Math.max(0, now - entry.at) / 1000;
    const tokens = Math.min(capacity, entry.tokens + elapsedSec * refillPerSec);
    if (tokens >= 1) {
      this.entries.set(key, { tokens: tokens - 1, at: now });
      return { ok: true };
    }
    this.entries.set(key, { tokens, at: now });
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / refillPerSec)) };
  }

  private sweep(now: number): void {
    this.lastSweepAt = now;
    this.insertsSinceSweep = 0;
    const { capacity, refillPerSec } = this.config;
    for (const [key, entry] of this.entries) {
      const tokens = entry.tokens + (Math.max(0, now - entry.at) / 1000) * refillPerSec;
      if (tokens >= capacity) this.entries.delete(key);
    }
  }
}
