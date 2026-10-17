// In-memory token buckets (R-23): per instance, keyed by player id or IP. The clock is
// injected so tests drive refills deterministically.
export interface BucketConfig {
  /** Burst size, and the most tokens a key can hold. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

export class TokenBucket {
  private readonly entries = new Map<string, { tokens: number; at: number }>();

  /** `sweepAbove`: past this many keys, keys whose bucket has refilled are forgotten. */
  constructor(
    private readonly config: BucketConfig,
    private readonly clock: () => number,
    private readonly sweepAbove = 10_000,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  take(key: string): TakeResult {
    const { capacity, refillPerSec } = this.config;
    const now = this.clock();
    if (this.entries.size > this.sweepAbove) this.sweep(now);
    const entry = this.entries.get(key) ?? { tokens: capacity, at: now };
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
    const { capacity, refillPerSec } = this.config;
    for (const [key, entry] of this.entries) {
      const tokens = entry.tokens + (Math.max(0, now - entry.at) / 1000) * refillPerSec;
      if (tokens >= capacity) this.entries.delete(key);
    }
  }
}
