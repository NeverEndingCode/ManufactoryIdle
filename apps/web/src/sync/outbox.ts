// The outbox (W-10, W-11, P-7): every intent is one batch, queued FIFO, one request in flight.
// The idempotency key is made when the batch is queued and reused for every retry of it.
import type { Action } from "@manufactory/engine";
import { RETRY_STEPS_MS } from "./constants.js";
import { classify, type Outcome } from "./errors.js";
import { newIdempotencyKey } from "./ids.js";
import type { ClientClock } from "./snapshot.js";
import type { ActionsRequest, FetchLike } from "./wire.js";

export interface Batch {
  id: number;
  key: string;
  actions: Action[];
  label: string;
}

/** The floor on any pause or retry wait, so a `Retry-After: 0` can't make a tight loop. */
export const MIN_WAIT_MS = 1_000;

export interface OutboxDeps {
  fetch: FetchLike;
  clock: ClientClock;
  authHeader: () => string | null;
  baseVersion: () => number;
  /** Every attempt's outcome, retries included. A returned promise is awaited before the
   * batch settles or the next one sends, so its adoption sets the next baseVersion. */
  onOutcome: (b: Batch, o: Outcome) => void | Promise<void>;
  /** Local ms until the shared 429/503 pause ends, 0 if not paused. */
  isPaused: () => number;
  /** inFlight or queued changed. */
  onChange?: () => void;
  random?: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;
}

const SETTLED = new Set<Outcome["kind"]>([
  "adopt",
  "rejected",
  "client-bug",
  "unauthorized",
  "no-world",
]);

export class Outbox {
  readonly #d: OutboxDeps;
  #nextId = 1;
  #head: Batch | null = null;
  #queue: Batch[] = [];
  #resolvers = new Map<number, (o: Outcome) => void>();
  #attempt: Promise<void> | null = null;
  #timer: number | null = null;
  /** Consecutive network/5xx failures of the head batch: the RETRY_STEPS_MS index. */
  #retries = 0;
  #stopped = false;

  constructor(d: OutboxDeps) {
    this.#d = d;
  }

  /** Queues one batch (FIFO), its key made NOW (W-10) unless `opts.key` carries one from an
   * earlier send of the same intent (the keepalive tap flush, Q-11); resolves when the batch
   * is settled (adopt / rejected / client-bug / unauthorized / no-world). */
  enqueue(actions: Action[], label: string, opts: { key?: string } = {}): Promise<Outcome> {
    const batch: Batch = {
      id: this.#nextId++,
      key: opts.key ?? newIdempotencyKey(this.#d.random),
      actions,
      label,
    };
    const settled = new Promise<Outcome>((resolve) => this.#resolvers.set(batch.id, resolve));
    this.#queue.push(batch);
    this.#d.onChange?.();
    this.#pump();
    return settled;
  }

  /** The batch being sent, or waiting to be resent. */
  get inFlight(): Batch | null {
    return this.#head;
  }

  get queued(): readonly Batch[] {
    return this.#queue;
  }

  /** Retry now (an `online` event). A 429/503 pause still holds. */
  kick(): void {
    this.#clearTimer();
    this.#pump();
  }

  /** Resolves when no request is in flight. A batch waiting out a backoff or a pause is not in
   * flight: under a fake clock it waits for the clock, so idle() must not wait for it. */
  async idle(): Promise<void> {
    while (this.#attempt) await this.#attempt;
  }

  /** Clears the timer; nothing sends again until start(). A response landing after stop() is
   * not reported and settles nothing: its batch stays at the head and start() resends it with
   * the same key, so a committed batch replays. Queued promises stay pending meanwhile. */
  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
  }

  /** Resumes after stop(). A no-op on a running outbox. */
  start(): void {
    this.#stopped = false;
    this.#pump();
  }

  /** Drops every batch not in flight (W-14: the identity is gone, so they must never reach a new
   * world), settling each with `outcome`. A batch in flight settles when its response lands. */
  clear(outcome: Outcome): void {
    this.#clearTimer();
    const dropped = [...(this.#head && !this.#attempt ? [this.#head] : []), ...this.#queue];
    if (this.#head && !this.#attempt) this.#head = null;
    this.#queue = [];
    for (const b of dropped) this.#settle(b, outcome);
    if (dropped.length > 0) this.#d.onChange?.();
  }

  #settle(batch: Batch, outcome: Outcome): void {
    if (this.#head === batch) this.#head = null;
    this.#resolvers.get(batch.id)?.(outcome);
    this.#resolvers.delete(batch.id);
  }

  #clearTimer(): void {
    if (this.#timer !== null) this.#d.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #wait(ms: number): void {
    if (this.#stopped) return;
    this.#timer = this.#d.clock.setTimeout(() => {
      this.#timer = null;
      this.#pump();
    }, ms);
  }

  #pump(): void {
    if (this.#stopped || this.#attempt || this.#timer !== null) return;
    if (!this.#head) {
      this.#head = this.#queue.shift() ?? null;
      if (!this.#head) return;
      this.#retries = 0;
      this.#d.onChange?.();
    }
    const paused = this.#d.isPaused();
    if (paused > 0) {
      this.#wait(paused);
      return;
    }
    const head = this.#head;
    const attempt = this.#send(head)
      .catch((err: unknown) => {
        // Only a throw outside the request (authHeader, baseVersion): settle the batch anyway,
        // so its promise never hangs and the queue moves on.
        console.error("outbox", err);
        if (this.#head === head) {
          this.#settle(head, { kind: "client-bug", status: 0, body: String(err) });
          this.#d.onChange?.();
        }
      })
      .finally(() => {
        this.#attempt = null;
      });
    this.#attempt = attempt;
    void attempt.then(() => this.#pump());
  }

  async #send(batch: Batch): Promise<void> {
    const auth = this.#d.authHeader();
    const body: ActionsRequest = {
      idempotencyKey: batch.key,
      baseVersion: this.#d.baseVersion(),
      actions: batch.actions,
    };
    let outcome: Outcome;
    try {
      const res = await this.#d
        .fetch("/api/actions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth === null ? {} : { authorization: auth }),
          },
          body: JSON.stringify(body),
        })
        .catch(() => null);
      outcome = await classify(res);
    } catch {
      outcome = { kind: "retry" }; // the body failed mid-read
    }
    if (this.#stopped) return;
    try {
      await this.#d.onOutcome(batch, outcome);
    } catch (err) {
      console.error("outbox onOutcome", err);
    }
    if (SETTLED.has(outcome.kind)) {
      this.#retries = 0;
      this.#settle(batch, outcome);
      this.#d.onChange?.();
    } else if (outcome.kind === "paused") {
      this.#wait(Math.max(MIN_WAIT_MS, outcome.retryAfterMs, this.#d.isPaused()));
    } else {
      const step = RETRY_STEPS_MS[Math.min(this.#retries, RETRY_STEPS_MS.length - 1)]!;
      this.#retries += 1;
      this.#wait(step);
    }
  }
}
