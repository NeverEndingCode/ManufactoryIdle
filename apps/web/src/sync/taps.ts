// The tap accumulator (W-12, P-16): count locally, flush as one TAP batch. Built in 4a;
// the holdable tap UI that drives it is 4b.

export class TapAccumulator {
  readonly #now: () => number;
  #origin: number;
  #pending = 0;

  /** `loadedAt`: the clock reading at page load, the first flush's elapsed origin. */
  constructor(now: () => number, loadedAt: number) {
    this.#now = now;
    this.#origin = loadedAt;
  }

  tap(): void {
    this.#pending += 1;
  }

  /** null when nothing is pending (never a count:0 TAP, which would still refresh the expiry);
   * else the action, and pending and the elapsed origin reset. */
  take(): { type: "TAP"; count: number; clientElapsedMs: number } | null {
    if (this.#pending === 0) return null;
    const now = this.#now();
    const action = {
      type: "TAP" as const,
      count: this.#pending,
      clientElapsedMs: now - this.#origin,
    };
    this.#pending = 0;
    this.#origin = now;
    return action;
  }

  get pending(): number {
    return this.#pending;
  }

  /** The dock's stacks before the response lands. */
  optimistic(stacks: number, maxStacks: number): number {
    return Math.min(maxStacks, stacks + this.#pending);
  }
}
