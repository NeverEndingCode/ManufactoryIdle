// The GameStore (W-6, W-9, W-11, W-14): one framework-free store that owns the snapshot, the
// one boundary timer, the outbox and the guest identity. React reads it through
// useSyncExternalStore (use-game.ts).
import type { Action } from "@manufactory/engine";
import {
  MIN_REPOLL_MS,
  OFFLINE_AFTER_FAILURES,
  RETRY_STEPS_MS,
  TEXT_TICK_MS,
} from "./constants.js";
import { ContentCache } from "./content-cache.js";
import { classify, type Outcome } from "./errors.js";
import type { TokenStorage } from "./identity.js";
import { isPlateaued } from "./interpolate.js";
import { MIN_WAIT_MS, Outbox, type Batch } from "./outbox.js";
import { nextFetchAt, nextRepoll, type RepollState } from "./refetch.js";
import { isAdoptable, makeSnapshot, type ClientClock, type Snapshot } from "./snapshot.js";
import type { FetchLike, GuestResponse, HealthResponse, WorldResponse } from "./wire.js";

export type SyncStatus = "loading" | "ready" | "offline" | "error";

export interface Notice {
  kind:
    | "rejected"
    | "client-bug"
    | "guest-expired"
    | "guest-rate-limited"
    | "accounts-unavailable"
    | "ephemeral-token"
    | "plateau";
  text: string;
  /** guest-rate-limited: the ClientClock time a retry may succeed. */
  retryAt?: number;
}

export interface StoreView {
  status: SyncStatus;
  snapshot: Snapshot | null;
  /** The outbox: the batch in flight (or waiting to resend) first, then the queue. */
  pending: readonly Batch[];
  notices: readonly Notice[];
  /** Consecutive network/5xx failures, GET and POST alike (P-7). */
  failures: number;
}

export interface GameStoreDeps {
  fetch: FetchLike;
  clock: ClientClock;
  tokens: TokenStorage;
  random?: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;
}

const TEXT = {
  "client-bug": "Something went wrong. The game re-synced with the server.",
  "guest-expired":
    "This guest factory was removed after 30 days without a visit. Start a new factory to play.",
  "guest-rate-limited": "Too many new factories from this address. Try again shortly.",
  "accounts-unavailable": "Accounts are unavailable right now.",
  "ephemeral-token": "This factory will be lost when the tab closes.",
} as const;

function plateauText(offlineCapMs: number): string {
  const hours = offlineCapMs / 3_600_000;
  return `Production paused ${hours} h after your last action. Do anything to resume.`;
}

type Cause = "get" | "post";

export class GameStore {
  readonly #fetch: FetchLike;
  readonly #clock: ClientClock;
  readonly #tokens: TokenStorage;
  readonly #content: ContentCache;
  readonly #outbox: Outbox;

  #snapshot: Snapshot | null = null;
  #repoll: RepollState = { streak: 0 };
  #notices: Notice[] = [];
  #failures = 0;
  /** The identity is gone (401, or a second 404) or guest creation was refused. */
  #halted = false;
  #visible = true;
  #stopped = false;
  /** ClientClock time until which polling and the outbox wait (429/503, one bucket). */
  #pausedUntil = 0;
  /** 404s in a row: the first re-syncs, the second is treated as a 401 (W-11). */
  #notFound = 0;

  /** The one GET request in flight, if any; triggers coalesce into it. */
  #getting = false;
  #getRetries = 0;
  #boundaryTimer: number | null = null;
  /** A GET waiting on a pause or a network backoff. `force` skips the staleness check. */
  #deferred: { timer: number; force: boolean } | null = null;
  #guestTimer: number | null = null;
  #tickTimer: number | null = null;

  /** Everything in flight that idle() waits on, bar the outbox's own request. */
  readonly #work = new Set<Promise<unknown>>();
  readonly #listeners = new Set<() => void>();
  readonly #tickers = new Set<() => void>();
  #view: StoreView;

  constructor(d: GameStoreDeps) {
    this.#fetch = d.fetch;
    this.#clock = d.clock;
    this.#tokens = d.tokens;
    this.#content = new ContentCache(d.fetch);
    this.#outbox = new Outbox({
      fetch: d.fetch,
      clock: d.clock,
      authHeader: () => this.#authHeader(),
      baseVersion: () => this.#snapshot?.stateVersion ?? 0,
      onOutcome: (_b, o) => this.#handle(o, "post", this.#clock.now()),
      isPaused: () => Math.max(0, this.#pausedUntil - this.#clock.now()),
      onChange: () => this.#emit(),
      ...(d.random ? { random: d.random } : {}),
    });
    this.#view = this.#makeView();
  }

  // ---- React (useSyncExternalStore) ----

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  /** Referentially stable between changes. */
  getView = (): StoreView => this.#view;

  /** The W-7 text tick: 4 Hz while visible and someone listens. It never changes the view. */
  subscribeTick = (fn: () => void): (() => void) => {
    this.#tickers.add(fn);
    this.#armTick();
    return () => {
      this.#tickers.delete(fn);
      if (this.#tickers.size === 0) this.#clearTick();
    };
  };

  /** The client clock, for serverNow(snapshot, store.now()). */
  now(): number {
    return this.#clock.now();
  }

  // ---- lifecycle ----

  /** First load: health ║ (token ? GET : POST /api/guests) → content(checksum) → snapshot. */
  start(): Promise<void> {
    this.#stopped = false;
    if (!this.#tokens.persistent)
      this.#setNotice({ kind: "ephemeral-token", text: TEXT["ephemeral-token"] });
    this.#track(this.#loadHealth());
    if (this.#tokens.get() !== null) this.#wantGet(true);
    else this.#createGuest();
    return this.idle();
  }

  /** Clears every timer. */
  stop(): void {
    this.#stopped = true;
    this.#clearBoundary();
    this.#clearDeferred();
    this.#clearTick();
    if (this.#guestTimer !== null) this.#clock.clearTimeout(this.#guestTimer);
    this.#guestTimer = null;
    this.#outbox.stop();
  }

  /** Hidden: no boundary timer, no text tick. Visible: GET if the snapshot is stale. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (!visible) {
      this.#clearBoundary();
      this.#clearTick();
      return;
    }
    this.#armTick();
    this.#wantGet(false);
    if (!this.#getting) this.#arm();
  }

  onFocus(): void {
    this.#wantGet(false);
  }

  onOnline(): void {
    this.#outbox.kick();
    if (this.#deferred && this.#pausedUntil <= this.#clock.now()) {
      const { force } = this.#deferred;
      this.#clearDeferred();
      this.#wantGet(force);
    } else {
      this.#wantGet(false);
    }
  }

  /** Via the outbox. Spends are pessimistic (W-13): nothing changes until the response. */
  send(actions: Action[], label: string): Promise<Outcome> {
    // The outbox awaits the adoption before it settles the batch, so this resolves with the
    // response's snapshot already in the view.
    return this.#outbox.enqueue(actions, label);
  }

  /** After guest-expired (or a refused guest creation): drop the token, POST /api/guests. */
  newFactory(): Promise<void> {
    this.#tokens.clear();
    this.#halted = false;
    this.#snapshot = null;
    this.#repoll = { streak: 0 };
    this.#notFound = 0;
    this.#clearBoundary();
    this.#clearDeferred();
    this.#notices = this.#notices.filter(
      (n) => n.kind !== "guest-expired" && n.kind !== "guest-rate-limited" && n.kind !== "plateau",
    );
    this.#emit();
    this.#createGuest();
    return this.idle();
  }

  /** Nothing in flight: no request, no adoption, no content load (P-9). A batch or GET waiting
   * on a backoff or pause timer is not in flight. */
  async idle(): Promise<void> {
    for (;;) {
      await this.#outbox.idle();
      if (this.#work.size === 0) {
        // One more turn: an outbox attempt can end by starting new work.
        await Promise.resolve();
        if (this.#work.size === 0) return;
      }
      await Promise.allSettled([...this.#work]);
    }
  }

  // ---- requests ----

  #authHeader(): string | null {
    const token = this.#tokens.get();
    return token === null ? null : `Guest ${token}`;
  }

  #track(p: Promise<unknown>): void {
    const tracked = p.catch((err: unknown) => console.error("sync", err));
    this.#work.add(tracked);
    void tracked.finally(() => this.#work.delete(tracked));
  }

  async #loadHealth(): Promise<void> {
    try {
      const res = await this.#fetch("/api/health");
      if (!res.ok) return;
      const health = (await res.json()) as HealthResponse;
      // Warm the cache: on the common path the world pins the same bundle.
      await this.#content.get(health.contentChecksum).catch(() => {});
    } catch {
      // Health only warms the cache; the world request reports the real failure.
    }
  }

  #createGuest(): void {
    if (this.#stopped) return;
    this.#track(this.#postGuest());
  }

  async #postGuest(): Promise<void> {
    let outcome: Outcome;
    try {
      outcome = await classify(
        await this.#fetch("/api/guests", { method: "POST" }).catch(() => null),
      );
    } catch {
      outcome = { kind: "retry" };
    }
    const receivedAt = this.#clock.now();
    switch (outcome.kind) {
      case "adopt": {
        const { guestToken, world } = outcome.body as unknown as GuestResponse;
        this.#tokens.set(guestToken);
        if (!this.#tokens.persistent)
          this.#setNotice({ kind: "ephemeral-token", text: TEXT["ephemeral-token"] });
        this.#failures = 0;
        await this.#adopt(world, "get", receivedAt);
        return;
      }
      case "paused":
        // 5 per hour per IP (W-14): the player retries, with a countdown to retryAt.
        this.#halted = true;
        this.#setNotice({
          kind: "guest-rate-limited",
          text: TEXT["guest-rate-limited"],
          retryAt: receivedAt + Math.max(MIN_WAIT_MS, outcome.retryAfterMs),
        });
        return;
      case "retry": {
        this.#failures += 1;
        const step = RETRY_STEPS_MS[Math.min(this.#getRetries++, RETRY_STEPS_MS.length - 1)]!;
        this.#guestTimer = this.#clock.setTimeout(() => {
          this.#guestTimer = null;
          this.#createGuest();
        }, step);
        this.#emit();
        return;
      }
      default:
        console.error("POST /api/guests", outcome);
        this.#halted = true;
        this.#setNotice({ kind: "client-bug", text: TEXT["client-bug"] });
    }
  }

  /** A GET trigger. Boundary, re-sync and retry triggers force it; visible / focus / online
   * only fire when the snapshot is older than MIN_REPOLL_MS (W-9). */
  #wantGet(force: boolean): void {
    if (this.#stopped || this.#halted || this.#getting) return;
    if (this.#tokens.get() === null) return;
    const now = this.#clock.now();
    if (this.#pausedUntil > now) {
      this.#defer(this.#pausedUntil - now, force);
      return;
    }
    if (!force && this.#snapshot && now - this.#snapshot.receivedAt < MIN_REPOLL_MS) return;
    this.#clearDeferred();
    this.#getting = true;
    this.#track(this.#runGet());
  }

  #defer(ms: number, force: boolean): void {
    const keepForce = force || (this.#deferred?.force ?? false);
    this.#clearDeferred();
    const timer = this.#clock.setTimeout(() => {
      this.#deferred = null;
      this.#wantGet(keepForce);
    }, ms);
    this.#deferred = { timer, force: keepForce };
  }

  async #runGet(): Promise<void> {
    let outcome: Outcome;
    try {
      const auth = this.#authHeader();
      const res = await this.#fetch("/api/world", {
        headers: auth === null ? {} : { authorization: auth },
      }).catch(() => null);
      outcome = await classify(res);
    } catch {
      outcome = { kind: "retry" };
    }
    const receivedAt = this.#clock.now();
    this.#getting = false;
    await this.#handle(outcome, "get", receivedAt);
    // A dropped or failed GET leaves the old snapshot's timer to re-arm.
    if (outcome.kind !== "adopt") this.#arm();
  }

  /** One handler for every response, GET and POST alike (W-11). */
  async #handle(o: Outcome, cause: Cause, receivedAt: number): Promise<void> {
    switch (o.kind) {
      case "adopt":
        this.#failures = 0;
        this.#notFound = 0;
        if (cause === "get") this.#getRetries = 0;
        this.#dropNotice("accounts-unavailable");
        await this.#adopt(o.body, cause, receivedAt);
        return;
      case "rejected":
        this.#failures = 0;
        this.#setNotice({ kind: "rejected", text: o.body.reason });
        this.#wantGet(true);
        return;
      case "paused":
        this.#pausedUntil = Math.max(
          this.#pausedUntil,
          this.#clock.now() + Math.max(MIN_WAIT_MS, o.retryAfterMs),
        );
        if (o.banner) this.#setNotice({ kind: o.banner, text: TEXT[o.banner] });
        if (cause === "get") this.#defer(this.#pausedUntil - this.#clock.now(), true);
        else this.#emit();
        return;
      case "retry":
        this.#failures += 1;
        if (cause === "get") {
          const step = RETRY_STEPS_MS[Math.min(this.#getRetries, RETRY_STEPS_MS.length - 1)]!;
          this.#getRetries += 1;
          this.#defer(step, true);
        }
        this.#emit();
        return;
      case "client-bug":
        console.error(`client bug: ${o.status}`, o.body);
        this.#setNotice({ kind: "client-bug", text: TEXT["client-bug"] });
        if (cause === "post") this.#wantGet(true);
        return;
      case "no-world":
        if (this.#notFound++ === 0) {
          this.#wantGet(true);
          return;
        }
        this.#expire();
        return;
      case "unauthorized":
        this.#expire();
        return;
    }
  }

  /** A 401 on a guest token: the 30-day cleanup deleted it. Polling stops (4a has no session). */
  #expire(): void {
    this.#halted = true;
    this.#clearBoundary();
    this.#clearDeferred();
    this.#setNotice({ kind: "guest-expired", text: TEXT["guest-expired"] });
  }

  /** Content first (a re-pin loads the new bundle, W-5), then the ordering check (W-6). */
  async #adopt(body: WorldResponse, cause: Cause, receivedAt: number): Promise<void> {
    let content;
    try {
      content = await this.#content.get(body.contentChecksum);
    } catch {
      this.#failures += 1;
      this.#defer(RETRY_STEPS_MS[0], true);
      this.#emit();
      return;
    }
    const next = makeSnapshot(body, content, receivedAt);
    if (!isAdoptable(this.#snapshot, next)) return;
    this.#snapshot = next;
    this.#repoll = nextRepoll(this.#repoll, next, cause);
    if (isPlateaued(next)) {
      this.#setNotice({ kind: "plateau", text: plateauText(next.content.offlineCapMs) }, false);
    } else {
      this.#dropNotice("plateau", false);
    }
    this.#arm();
    this.#emit();
  }

  // ---- timers ----

  /** The one boundary timer, from nextFetchAt (W-9, P-4, P-6). */
  #arm(): void {
    this.#clearBoundary();
    if (this.#stopped || this.#halted || !this.#visible || !this.#snapshot) return;
    const at = nextFetchAt(this.#snapshot, this.#repoll);
    if (at === null) return;
    this.#boundaryTimer = this.#clock.setTimeout(() => {
      this.#boundaryTimer = null;
      this.#wantGet(true);
    }, at - this.#clock.now());
  }

  #clearBoundary(): void {
    if (this.#boundaryTimer !== null) this.#clock.clearTimeout(this.#boundaryTimer);
    this.#boundaryTimer = null;
  }

  #clearDeferred(): void {
    if (this.#deferred) this.#clock.clearTimeout(this.#deferred.timer);
    this.#deferred = null;
  }

  #armTick(): void {
    if (this.#tickTimer !== null || this.#stopped || !this.#visible || this.#tickers.size === 0)
      return;
    this.#tickTimer = this.#clock.setTimeout(() => {
      this.#tickTimer = null;
      for (const fn of this.#tickers) fn();
      this.#armTick();
    }, TEXT_TICK_MS);
  }

  #clearTick(): void {
    if (this.#tickTimer !== null) this.#clock.clearTimeout(this.#tickTimer);
    this.#tickTimer = null;
  }

  // ---- the view ----

  #setNotice(n: Notice, emit = true): void {
    this.#notices = [...this.#notices.filter((x) => x.kind !== n.kind), n];
    if (emit) this.#emit();
  }

  #dropNotice(kind: Notice["kind"], emit = true): void {
    if (!this.#notices.some((n) => n.kind === kind)) return;
    this.#notices = this.#notices.filter((n) => n.kind !== kind);
    if (emit) this.#emit();
  }

  /** Dismisses a toast (rejected, client-bug) or a banner. */
  dismiss(kind: Notice["kind"]): void {
    this.#dropNotice(kind);
  }

  #status(): SyncStatus {
    if (this.#halted) return "error";
    if (this.#failures >= OFFLINE_AFTER_FAILURES) return "offline";
    return this.#snapshot === null ? "loading" : "ready";
  }

  #makeView(): StoreView {
    const head = this.#outbox.inFlight;
    return {
      status: this.#status(),
      snapshot: this.#snapshot,
      pending: head ? [head, ...this.#outbox.queued] : [...this.#outbox.queued],
      notices: this.#notices,
      failures: this.#failures,
    };
  }

  #emit(): void {
    this.#view = this.#makeView();
    for (const fn of this.#listeners) fn();
  }
}
