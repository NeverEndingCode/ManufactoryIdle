// The GameStore (W-6, W-9, W-11, W-14): one framework-free store that owns the snapshot, the
// one boundary timer, the outbox and the guest identity. React reads it through
// useSyncExternalStore (use-game.ts).
import type { Action } from "@manufactory/engine";
import {
  MIN_REPOLL_MS,
  OFFLINE_AFTER_FAILURES,
  RETRY_STEPS_MS,
  TAP_FLUSH_AFTER_RELEASE_MS,
  TAP_FLUSH_EVERY_MS,
  TAP_LABEL,
  TAP_REPEAT_MS,
  TEXT_TICK_MS,
} from "./constants.js";
import { ContentCache } from "./content-cache.js";
import { classify, type Outcome } from "./errors.js";
import type { TokenStorage } from "./identity.js";
import { newIdempotencyKey } from "./ids.js";
import { isPlateaued } from "./interpolate.js";
import { MIN_WAIT_MS, Outbox, type Batch } from "./outbox.js";
import { nextFetchAt, nextRepoll, type RepollState } from "./refetch.js";
import { isAdoptable, makeSnapshot, type ClientClock, type Snapshot } from "./snapshot.js";
import { TapAccumulator } from "./taps.js";
import type {
  ActionsRequest,
  FetchLike,
  GuestResponse,
  HealthResponse,
  WorldResponse,
} from "./wire.js";

export type SyncStatus = "loading" | "ready" | "offline" | "error";

export interface Notice {
  kind:
    | "rejected"
    | "client-bug"
    | "guest-expired"
    | "guest-rate-limited"
    | "accounts-unavailable"
    | "ephemeral-token"
    | "plateau"
    | "tier-up";
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
  /** The tap (Q-11): taps not yet flushed, the last tap's ClientClock time, and the hold. */
  taps: { pending: number; lastTapAt: number | null; holding: boolean };
  /** The boundary timer is armed (Q-18). Mirrored as data-polling="armed|off". */
  polling: boolean;
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
type Adoption = "adopted" | "stale" | "failed";

export class GameStore {
  readonly #fetch: FetchLike;
  readonly #clock: ClientClock;
  readonly #tokens: TokenStorage;
  readonly #content: ContentCache;
  readonly #outbox: Outbox;
  readonly #random: GameStoreDeps["random"];

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
  /** The batch whose response is being adopted: its actions are in the snapshot already, so the
   * view stops counting it as pending from that adoption until the outbox settles it. */
  #settlingId: number | null = null;

  /** The one GET request in flight, if any; triggers coalesce into it. */
  #getting = false;
  #getRetries = 0;
  #boundaryTimer: number | null = null;
  /** A GET waiting on a pause or a network backoff. `force` skips the staleness check. */
  #deferred: { timer: number; force: boolean } | null = null;
  #guestTimer: number | null = null;
  /** The one POST /api/guests in flight: a second start() joins it, never a second guest. */
  #guesting: Promise<void> | null = null;
  #tickTimer: number | null = null;
  /** The ephemeral-token banner was raised once; a dismissed one doesn't come back. */
  #ephemeralShown = false;

  // The tap (Q-11). Two timers, both on the ClientClock: the 10 Hz repeat while held, and
  // the one flush timer, which is never due before #lastFlushAt + TAP_FLUSH_EVERY_MS.
  readonly #taps: TapAccumulator;
  #holding = false;
  #pressAt = 0;
  #lastTapAt: number | null = null;
  /** The last flush that sent something; a flush with nothing pending doesn't count. */
  #lastFlushAt = -Infinity;
  #repeatTimer: number | null = null;
  #flushTimer: { timer: number; at: number } | null = null;

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
    this.#random = d.random;
    this.#taps = new TapAccumulator(() => d.clock.now(), d.clock.now());
    this.#outbox = new Outbox({
      fetch: d.fetch,
      clock: d.clock,
      authHeader: () => this.#authHeader(),
      baseVersion: () => this.#snapshot?.stateVersion ?? 0,
      onOutcome: async (b, o) => {
        await this.#handle(o, "post", this.#clock.now(), b.id);
      },
      isPaused: () => Math.max(0, this.#pausedUntil - this.#clock.now()),
      onChange: () => {
        if (this.#settlingId !== null && this.#outbox.inFlight?.id !== this.#settlingId) {
          this.#settlingId = null;
        }
        this.#emit();
      },
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
    this.#checkPersistence();
    this.#outbox.start();
    // stop() cleared the flush timer; the taps it left pending still go out.
    if (this.#taps.pending > 0 && !this.#holding) {
      this.#armFlush(Math.max(this.#clock.now(), this.#lastFlushAt + TAP_FLUSH_EVERY_MS));
    }
    this.#armTick();
    this.#track(this.#loadHealth());
    if (this.#tokens.get() !== null) this.#wantGet(true);
    else this.#createGuest();
    return this.idle();
  }

  /** Clears every timer. A response landing afterwards is ignored (a new guest token is still
   * kept, so the next start() reuses it). */
  stop(): void {
    this.#stopped = true;
    this.#clearBoundary();
    this.#clearDeferred();
    this.#clearTick();
    if (this.#guestTimer !== null) this.#clock.clearTimeout(this.#guestTimer);
    this.#guestTimer = null;
    this.#holding = false;
    this.#clearRepeat();
    this.#clearFlush();
    this.#outbox.stop();
    this.#emit();
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

  // ---- the tap (W-12, Q-11) ----

  /** Taps once now and repeats every TAP_REPEAT_MS until releaseTap(). While held, the flush
   * is due at max(lastFlushAt, pressAt) + TAP_FLUSH_EVERY_MS. */
  pressTap(): void {
    if (this.#stopped || this.#holding) return;
    this.#holding = true;
    this.#pressAt = this.#clock.now();
    this.#tapOnce();
    this.#armRepeat();
    this.#armFlush(Math.max(this.#lastFlushAt, this.#pressAt) + TAP_FLUSH_EVERY_MS);
    this.#emit();
  }

  /** Stops the repeat, and pulls the flush to max(now + 300 ms, lastFlushAt + 1 s). */
  releaseTap(): void {
    if (!this.#holding) return;
    this.#holding = false;
    this.#clearRepeat();
    if (this.#taps.pending === 0) this.#clearFlush();
    else
      this.#armFlush(
        Math.max(
          this.#clock.now() + TAP_FLUSH_AFTER_RELEASE_MS,
          this.#lastFlushAt + TAP_FLUSH_EVERY_MS,
        ),
      );
    this.#emit();
  }

  /** keepalive (hidden, pagehide): send the pending taps now, bypassing the outbox and the 1 s
   * floor. Otherwise flush now only if the floor allows it, else leave the timer as it is. */
  flushTaps(opts: { keepalive?: boolean } = {}): void {
    if (this.#stopped) return;
    if (opts.keepalive) {
      this.#flushKeepalive();
      return;
    }
    if (this.#clock.now() >= this.#lastFlushAt + TAP_FLUSH_EVERY_MS) this.#flushNow();
  }

  #tapOnce(): void {
    this.#taps.tap();
    this.#lastTapAt = this.#clock.now();
  }

  #armRepeat(): void {
    this.#repeatTimer = this.#clock.setTimeout(() => {
      this.#repeatTimer = null;
      if (!this.#holding || this.#stopped) return;
      this.#tapOnce();
      this.#armRepeat();
      this.#emit();
    }, TAP_REPEAT_MS);
  }

  #clearRepeat(): void {
    if (this.#repeatTimer !== null) this.#clock.clearTimeout(this.#repeatTimer);
    this.#repeatTimer = null;
  }

  /** Only ever moves the flush earlier. Each caller's `at` is already at or past
   * lastFlushAt + TAP_FLUSH_EVERY_MS (Q-11's floor): press, release and the next held flush. */
  #armFlush(due: number): void {
    if (this.#flushTimer !== null && this.#flushTimer.at <= due) return;
    this.#clearFlush();
    const timer = this.#clock.setTimeout(() => {
      this.#flushTimer = null;
      this.#flushNow();
    }, due - this.#clock.now());
    this.#flushTimer = { timer, at: due };
  }

  #clearFlush(): void {
    if (this.#flushTimer !== null) this.#clock.clearTimeout(this.#flushTimer.timer);
    this.#flushTimer = null;
  }

  /** Takes the pending taps, if any (never a count:0 TAP), and marks the flush. While held,
   * the next flush is armed a second on. */
  #take(): Action | null {
    this.#clearFlush();
    const action = this.#taps.take();
    if (action !== null) this.#lastFlushAt = this.#clock.now();
    if (this.#holding) {
      const next = Math.max(this.#lastFlushAt, this.#pressAt) + TAP_FLUSH_EVERY_MS;
      this.#armFlush(Math.max(next, this.#clock.now() + TAP_FLUSH_EVERY_MS));
    }
    return action;
  }

  /** A flush through the outbox: its own one-action batch, never merged with a spend. */
  #flushNow(): void {
    if (this.#stopped) return;
    const action = this.#take();
    if (action === null) return;
    void this.#outbox.enqueue([action], TAP_LABEL);
    this.#emit();
  }

  /** Q-11: a queued request can't outlive the page, so this one goes straight out with
   * keepalive and a fresh key. If the page survives a retry or a pause, the outbox resends it
   * with the same key. */
  #flushKeepalive(): void {
    const action = this.#take();
    if (action === null) return;
    this.#emit();
    const key = newIdempotencyKey(this.#random);
    const auth = this.#authHeader();
    // No identity, or a 429/503 pause: a request now would only be refused. The outbox holds
    // the batch under this key and sends it when the pause ends.
    if (auth === null || this.#pausedUntil > this.#clock.now()) {
      void this.#outbox.enqueue([action], TAP_LABEL, { key });
      return;
    }
    const body: ActionsRequest = {
      idempotencyKey: key,
      baseVersion: this.#snapshot?.stateVersion ?? 0,
      actions: [action],
    };
    this.#track(
      (async () => {
        let outcome: Outcome;
        try {
          const res = await this.#fetch("/api/actions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: auth },
            body: JSON.stringify(body),
            keepalive: true,
          }).catch(() => null);
          outcome = await classify(res);
        } catch {
          outcome = { kind: "retry" };
        }
        if (this.#stopped) return;
        await this.#handle(outcome, "post", this.#clock.now());
        if (outcome.kind === "retry" || outcome.kind === "paused") {
          void this.#outbox.enqueue([action], TAP_LABEL, { key });
        }
      })(),
    );
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

  /** Nothing in flight: no request, no adoption, no content load (P-9). It does NOT wait for
   * the outbox to empty: a batch (or a GET) waiting out a backoff or a pause timer is not in
   * flight, and waits for the clock. Under a FakeClientClock, advance it instead. */
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
    this.#checkPersistence();
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

  /** W-14: the banner, once the token lives only in memory. Storage can fail mid-session. */
  #checkPersistence(): void {
    if (this.#tokens.persistent || this.#ephemeralShown) return;
    this.#ephemeralShown = true;
    this.#setNotice({ kind: "ephemeral-token", text: TEXT["ephemeral-token"] });
  }

  #createGuest(): void {
    if (this.#stopped || this.#guesting) return;
    const guesting = this.#postGuest().finally(() => {
      this.#guesting = null;
    });
    this.#guesting = guesting;
    this.#track(guesting);
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
    if (this.#stopped && outcome.kind !== "adopt") return;
    switch (outcome.kind) {
      case "adopt": {
        const { guestToken, world } = outcome.body as unknown as GuestResponse;
        // Kept even after stop(): the guest exists now, and the next start() must reuse it.
        this.#tokens.set(guestToken);
        if (this.#stopped) return;
        this.#checkPersistence();
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
        if (this.#stopped) return;
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
    if (this.#stopped || this.#halted) return;
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
    if (this.#stopped) return;
    const result = await this.#handle(outcome, "get", receivedAt);
    // A GET dropped as stale (W-6) re-arms from the snapshot it lost to. Nothing else re-arms
    // here: a failure's deferred retry is its re-trigger, and re-arming from a boundary already
    // past would fire at once and skip the backoff.
    if (result === "stale") this.#arm();
  }

  /** One handler for every response, GET and POST alike (W-11). */
  async #handle(
    o: Outcome,
    cause: Cause,
    receivedAt: number,
    settling?: number,
  ): Promise<Adoption | void> {
    if (this.#stopped) return;
    switch (o.kind) {
      case "adopt":
        return this.#adopt(o.body, cause, receivedAt, settling);
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
        // W-11 re-syncs a POST. A GET would only loop on the same 4xx: polling stops until
        // focus, visible or online (Q-18).
        if (cause === "post") this.#wantGet(true);
        else this.#clearBoundary();
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
    // Batches made for the lost world must never reach a new one (newFactory).
    this.#outbox.clear({ kind: "unauthorized" });
    this.#setNotice({ kind: "guest-expired", text: TEXT["guest-expired"] });
  }

  /** Content first (a re-pin loads the new bundle, W-5), then the ordering check (W-6). */
  async #adopt(
    body: WorldResponse,
    cause: Cause,
    receivedAt: number,
    settling?: number,
  ): Promise<Adoption> {
    let next: Snapshot;
    try {
      const content = await this.#content.get(body.contentChecksum);
      next = makeSnapshot(body, content, receivedAt);
    } catch (err) {
      // The content load, or a body makeSnapshot can't read: back off and GET again.
      if (this.#stopped) return "failed";
      console.error("adopt", err);
      this.#failures += 1;
      const step = RETRY_STEPS_MS[Math.min(this.#getRetries, RETRY_STEPS_MS.length - 1)]!;
      this.#getRetries += 1;
      this.#defer(step, true);
      this.#emit();
      return "failed";
    }
    if (this.#stopped) return "failed";
    // A whole exchange worked: only now do the failure counters reset.
    this.#failures = 0;
    this.#notFound = 0;
    this.#getRetries = 0;
    this.#dropNotice("accounts-unavailable", false);
    // A pending GET retry is moot after any good response (bar one waiting out a pause).
    if (this.#pausedUntil <= this.#clock.now()) this.#clearDeferred();
    if (!isAdoptable(this.#snapshot, next)) {
      this.#emit();
      return "stale";
    }
    const prev = this.#snapshot;
    // From the swap on, the snapshot counts this batch's actions: the view stops listing it.
    if (settling !== undefined) this.#settlingId = settling;
    this.#snapshot = next;
    this.#repoll = nextRepoll(this.#repoll, next, cause);
    // Q-13: the one celebration W-18 allows.
    if (prev !== null && next.state.tier > prev.state.tier) {
      this.#setNotice({ kind: "tier-up", text: `Tier ${next.state.tier} reached.` }, false);
    }
    if (isPlateaued(next)) {
      this.#setNotice({ kind: "plateau", text: plateauText(next.content.offlineCapMs) }, false);
    } else {
      this.#dropNotice("plateau", false);
    }
    this.#arm();
    this.#emit();
    return "adopted";
  }

  // ---- timers ----

  /** The one boundary timer, from nextFetchAt (W-9, P-4, P-6). */
  #arm(): void {
    const was = this.#boundaryTimer !== null;
    this.#clearBoundary(false);
    if (!this.#stopped && !this.#halted && this.#visible && this.#snapshot) {
      const at = nextFetchAt(this.#snapshot, this.#repoll);
      if (at !== null) {
        this.#boundaryTimer = this.#clock.setTimeout(() => {
          this.#boundaryTimer = null;
          this.#emit();
          this.#wantGet(true);
        }, at - this.#clock.now());
      }
    }
    if (was !== (this.#boundaryTimer !== null)) this.#emit();
  }

  /** Emits when polling changes (StoreView.polling). */
  #clearBoundary(emit = true): void {
    if (this.#boundaryTimer === null) return;
    this.#clock.clearTimeout(this.#boundaryTimer);
    this.#boundaryTimer = null;
    if (emit) this.#emit();
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
    const pending = head ? [head, ...this.#outbox.queued] : [...this.#outbox.queued];
    return {
      status: this.#status(),
      snapshot: this.#snapshot,
      pending: pending.filter((b) => b.id !== this.#settlingId),
      notices: this.#notices,
      failures: this.#failures,
      taps: { pending: this.#taps.pending, lastTapAt: this.#lastTapAt, holding: this.#holding },
      polling: this.#boundaryTimer !== null,
    };
  }

  #emit(): void {
    this.#view = this.#makeView();
    for (const fn of this.#listeners) fn();
  }
}
