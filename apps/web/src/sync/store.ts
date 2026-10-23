// The GameStore (W-6, W-9, W-11, W-14 to W-16): one framework-free store that owns the
// snapshot, the one boundary timer, the outbox and the identity (a guest token or a session).
// React reads it through useSyncExternalStore (use-game.ts).
import type { Action } from "@manufactory/engine";
import type { AccountClient, AuthResult, ResetResult } from "../auth/accounts.js";
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
import { memoryTokenStorage, type TokenStorage } from "./identity.js";
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
    | "tier-up"
    | "account-has-factory"
    | "signed-out"
    | "session-ended";
  text: string;
  /** guest-rate-limited: the ClientClock time a retry may succeed. */
  retryAt?: number;
}

export type Identity = "unknown" | "guest" | "session";

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
  /** GET /api/health's accounts flag; "unknown" until health answers (S-3). */
  accounts: "unknown" | "off" | "on";
  identity: Identity;
  /** Signed in: the email when this tab signed in, else null. */
  account: { email: string | null } | null;
  /** "held": a sign-in is in progress (S-4); "claiming": the claim is retrying (S-5). */
  auth: "idle" | "held" | "claiming";
  /** A guest token is parked (S-6), in storage or only in memory: signing out returns to it. */
  parked: boolean;
}

export interface GameStoreDeps {
  fetch: FetchLike;
  clock: ClientClock;
  tokens: TokenStorage;
  /** S-6: the guest token parked while signed in. Default: memory. */
  parked?: TokenStorage;
  /** W-15: initialised only when health says accounts: true. Omitted: guest-only. */
  accounts?: AccountClient;
  random?: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;
}

const TEXT = {
  "client-bug": "Something went wrong. The game re-synced with the server.",
  "guest-expired":
    "This guest factory was removed after 30 days without a visit. Start a new factory to play.",
  "guest-rate-limited": "Too many new factories from this address. Try again shortly.",
  "accounts-unavailable": "Accounts are unavailable right now.",
  "ephemeral-token": "This factory will be lost when the tab closes.",
  "account-has-factory":
    "This account already has a factory. Your guest factory is kept on this device: sign out to return to it.",
  "signed-out": "Signed out. Sign in to return to your saved factory.",
  "session-ended": "Your session ended. Sign in to return to your saved factory.",
} as const;

const UNAVAILABLE = { ok: false, kind: "unavailable" } as const;

/** Notices about one world, dropped when the store moves to another (#resetWorld). */
const WORLD_NOTICES = new Set<Notice["kind"]>([
  "guest-expired",
  "guest-rate-limited",
  "plateau",
  "tier-up",
]);

function plateauText(offlineCapMs: number): string {
  const hours = offlineCapMs / 3_600_000;
  return `Production paused ${hours} h after your last action. Do anything to resume.`;
}

type Cause = "get" | "post";
/** "ignored": the response belongs to a world the store has since left (#epoch). */
type Adoption = "adopted" | "stale" | "failed" | "ignored";

export class GameStore {
  readonly #fetch: FetchLike;
  readonly #clock: ClientClock;
  readonly #tokens: TokenStorage;
  readonly #parked: TokenStorage;
  readonly #accounts: AccountClient | undefined;
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

  // Identity (S-3 to S-7). Nothing world-shaped is sent while it is "unknown" (before health
  // answers) or while #auth isn't "idle" (a sign-in, its claim, or a sign-out is deciding).
  #accountsState: StoreView["accounts"] = "unknown";
  #identity: Identity = "unknown";
  #account: StoreView["account"] = null;
  #auth: StoreView["auth"] = "idle";
  /** The one boot (health, then identity) in flight; a second start() joins it. */
  #booting: Promise<void> | null = null;
  #bootTimer: number | null = null;
  #bootRetries = 0;
  /** The one GET in flight, for the hold to wait on. */
  #getRun: Promise<void> | null = null;
  /** A sign-in succeeded and its claim (S-5) is not decided yet. */
  #claimPending = false;
  #claimRun: Promise<void> | null = null;
  #claimTimer: number | null = null;
  #claimRetries = 0;
  /** The world epoch: #resetWorld bumps it. Every request captures it when sent, and a
   * response from an older epoch is ignored (#handle, #adopt): it is about a world we left. */
  #epoch = 0;
  /** The guest token came from the park (S-7) and hasn't loaded a world since. A 401 on it is
   * a claim that committed before its tab closed: quietly make a new guest (fix round 1, E). */
  #tokenFromPark = false;

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
    this.#parked = d.parked ?? memoryTokenStorage();
    this.#accounts = d.accounts;
    this.#content = new ContentCache(d.fetch);
    this.#random = d.random;
    this.#taps = new TapAccumulator(() => d.clock.now(), d.clock.now());
    this.#outbox = new Outbox({
      fetch: d.fetch,
      clock: d.clock,
      authHeader: () => this.#authHeader(),
      baseVersion: () => this.#snapshot?.stateVersion ?? 0,
      onOutcome: async (b, o, sentIn) => {
        await this.#handle(o, "post", this.#clock.now(), sentIn, b.id);
      },
      epoch: () => this.#epoch,
      isPaused: () => Math.max(0, this.#pausedUntil - this.#clock.now()),
      onChange: () => {
        if (this.#settlingId !== null && this.#outbox.inFlight?.id !== this.#settlingId) {
          this.#settlingId = null;
        }
        this.#emit();
      },
      ...(d.random ? { random: d.random } : {}),
    });
    // Nothing is sent until boot knows the identity (S-3).
    this.#outbox.stop();
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

  /** First load (S-3): health → (accounts: init, hasSession) → session ? GET : token ? GET :
   * POST /api/guests → content(checksum) → snapshot. A restart resumes the identity it has. */
  start(): Promise<void> {
    this.#stopped = false;
    this.#checkPersistence();
    if (this.#identity !== "unknown" && this.#auth === "idle") this.#outbox.start();
    // stop() cleared the flush timer; the taps it left pending still go out.
    if (this.#taps.pending > 0 && !this.#holding) {
      this.#armFlush(Math.max(this.#clock.now(), this.#lastFlushAt + TAP_FLUSH_EVERY_MS));
    }
    this.#armTick();
    if (this.#identity === "unknown") this.#bootOnce();
    else if (this.#claimPending) this.#claimOnce();
    else if (this.#auth === "idle") this.#resume();
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
    if (this.#bootTimer !== null) this.#clock.clearTimeout(this.#bootTimer);
    this.#bootTimer = null;
    if (this.#claimTimer !== null) this.#clock.clearTimeout(this.#claimTimer);
    this.#claimTimer = null;
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
    // No identity, a sign-in deciding (S-4), or a 429/503 pause: a request now would be refused
    // or reach the wrong world. The outbox holds the batch under this key and sends it later.
    if (!this.#hasIdentity() || this.#auth !== "idle" || this.#pausedUntil > this.#clock.now()) {
      void this.#outbox.enqueue([action], TAP_LABEL, { key });
      return;
    }
    const body: ActionsRequest = {
      idempotencyKey: key,
      baseVersion: this.#snapshot?.stateVersion ?? 0,
      actions: [action],
    };
    const epoch = this.#epoch;
    this.#track(
      (async () => {
        let outcome: Outcome;
        try {
          const res = await this.#fetch("/api/actions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(auth === null ? {} : { authorization: auth }),
            },
            body: JSON.stringify(body),
            keepalive: true,
          }).catch(() => null);
          outcome = await classify(res);
        } catch {
          outcome = { kind: "retry" };
        }
        if (this.#stopped) return;
        // Taps for a world we left (a reset since) are not resent to the new one.
        if (epoch !== this.#epoch) return;
        await this.#handle(outcome, "post", this.#clock.now(), epoch);
        if (outcome.kind === "retry" || outcome.kind === "paused") {
          void this.#outbox.enqueue([action], TAP_LABEL, { key });
        }
      })(),
    );
  }

  /** After guest-expired (or a refused guest creation): drop the token, POST /api/guests. */
  newFactory(): Promise<void> {
    // Never under a session or a sign-in: the token may be about to be claimed or parked.
    if (this.#auth !== "idle" || this.#identity === "session") return this.idle();
    this.#tokens.clear();
    this.#tokenFromPark = false;
    this.#resetWorld();
    this.#emit();
    this.#createGuest();
    return this.idle();
  }

  /** Forgets the world on screen: the next one is another world (a new guest, a claim's 409,
   * a sign-out), which isAdoptable must not compare with this one. */
  #resetWorld(): void {
    this.#epoch += 1;
    this.#halted = false;
    this.#snapshot = null;
    this.#repoll = { streak: 0 };
    this.#notFound = 0;
    this.#getRetries = 0;
    this.#settlingId = null;
    this.#clearBoundary(false);
    this.#clearDeferred();
    this.#notices = this.#notices.filter((n) => !WORLD_NOTICES.has(n.kind));
  }

  // ---- accounts (W-15, W-16, S-4 to S-7) ----

  signUp(email: string, password: string): Promise<AuthResult> {
    return this.#signIn((c) => c.signUp(email, password));
  }

  signIn(email: string, password: string): Promise<AuthResult> {
    return this.#signIn((c) => c.signIn(email, password));
  }

  /** S-7: back to the parked guest, or a new one. False (the session kept) when the server
   * couldn't be reached. */
  async signOut(): Promise<boolean> {
    const client = this.#client();
    if (client === null || this.#identity !== "session" || this.#auth !== "idle") return false;
    await this.#hold();
    let ok: boolean;
    try {
      ok = await client.signOut();
    } catch {
      ok = false;
    }
    if (!ok) {
      this.#release();
      return false;
    }
    this.#leaveSession("signed-out");
    return true;
  }

  sendReset(email: string): Promise<ResetResult> {
    const client = this.#client();
    return client === null ? Promise.resolve(UNAVAILABLE) : client.sendReset(email);
  }

  submitNewPassword(password: string): Promise<ResetResult> {
    const client = this.#client();
    return client === null ? Promise.resolve(UNAVAILABLE) : client.submitNewPassword(password);
  }

  #client(): AccountClient | null {
    return this.#accountsState === "on" && this.#accounts ? this.#accounts : null;
  }

  /** S-4: hold, sign in, then claim (S-5) or release. Resolves with the sign-in's result; the
   * claim runs on (idle() waits for it). */
  async #signIn(call: (c: AccountClient) => Promise<AuthResult>): Promise<AuthResult> {
    const client = this.#client();
    if (client === null || this.#identity !== "guest" || this.#auth !== "idle") return UNAVAILABLE;
    const drained = this.#hold();
    let result: AuthResult;
    try {
      result = await call(client);
    } catch {
      result = UNAVAILABLE;
    }
    await drained;
    if (!result.ok) {
      this.#release();
      return result;
    }
    this.#identity = "session";
    this.#account = { email: result.email };
    this.#claimPending = true;
    this.#claimRetries = 0;
    this.#emit();
    this.#claimOnce();
    return result;
  }

  /** S-4: from now until #release(), nothing world-shaped is sent. The tap hold ends and its
   * taps join the outbox; the boundary timer, the guest-creation retry and GET triggers stop;
   * the outbox stops. A batch whose response lands after the stop is not reported: it stays at
   * the head and, after a 200 claim, resends with its key (a replay if it committed). After a
   * 409 or 404 it is dropped with the held batches and settles as "unauthorized" even if it
   * committed to the guest's world: misreported, but nothing is lost, since that world is
   * parked (409) or gone (404). Resolves once the GET, guest creation and outbox attempt in
   * flight have landed. */
  async #hold(): Promise<void> {
    this.#auth = "held";
    if (this.#guestTimer !== null) this.#clock.clearTimeout(this.#guestTimer);
    this.#guestTimer = null;
    if (this.#holding) {
      this.#holding = false;
      this.#clearRepeat();
    }
    const tap = this.#take();
    if (tap !== null) void this.#outbox.enqueue([tap], TAP_LABEL);
    this.#outbox.stop();
    this.#clearBoundary(false);
    this.#clearDeferred();
    this.#emit();
    await Promise.allSettled([this.#outbox.idle(), this.#getRun, this.#guesting]);
  }

  /** A failed sign-in or sign-out: everything resumes as it was. */
  #release(): void {
    this.#auth = "idle";
    this.#emit();
    if (this.#stopped) return;
    this.#outbox.start();
    this.#arm();
    this.#resume();
  }

  #claimOnce(): void {
    if (this.#stopped || this.#claimRun !== null || this.#claimTimer !== null) return;
    const run: Promise<void> = this.#claim().finally(() => {
      if (this.#claimRun === run) this.#claimRun = null;
    });
    this.#claimRun = run;
    this.#track(run);
  }

  /** S-5: POST /api/auth/claim { guestToken } under the new session (no Authorization),
   * retried while held until it answers. Without a guest token there is nothing to claim. */
  async #claim(): Promise<void> {
    const guestToken = this.#tokens.get();
    if (guestToken === null) {
      this.#settleClaim();
      this.#outbox.clear({ kind: "unauthorized" });
      this.#resetWorld();
      this.#afterClaim();
      return;
    }
    const epoch = this.#epoch;
    let outcome: Outcome;
    /** Only the API's own 404 deletes the token; a proxy's or a deploy's 404 parks it. */
    let unknownGuest = false;
    try {
      const res = await this.#fetch("/api/auth/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guestToken }),
      }).catch(() => null);
      if (res?.status === 404) {
        const body = (await res
          .clone()
          .json()
          .catch(() => null)) as { error?: unknown } | null;
        unknownGuest = body?.error === "unknown-guest";
      }
      outcome = await classify(res);
    } catch {
      outcome = { kind: "retry" };
    }
    const receivedAt = this.#clock.now();
    // The store moved to another world while the claim was out (a reset mid-claim). The answer
    // still decides where the guest token goes (W-16: moved, never lost), but its world is not
    // adopted and nothing is retried: the claim settles and the hold is released, so auth and
    // the outbox never stay stranded.
    const stale = epoch !== this.#epoch;
    if (stale) console.error("claim: answered after the store left its world; releasing");
    // The token moves happen even after stop(): the server has decided, and start() resumes.
    switch (outcome.kind) {
      case "adopt":
        // 200: the same player, now the account's, so the held batches' keys still match.
        this.#tokens.clear();
        this.#settleClaim();
        if (stale) {
          this.#release();
          return;
        }
        if (this.#stopped) return;
        await this.#adopt(outcome.body, "get", receivedAt, epoch);
        this.#afterClaim();
        return;
      case "unauthorized":
        // 401: the cookie didn't stick. A failed sign-in: stay a guest.
        this.#settleClaim();
        this.#identity = "guest";
        this.#account = null;
        this.#setNotice({ kind: "client-bug", text: TEXT["client-bug"] }, false);
        this.#release();
        return;
      case "retry":
      case "paused": {
        // A network error, a 5xx, a 503, a 429: the same claim again, still held.
        if (stale) {
          this.#settleClaim();
          this.#release();
          return;
        }
        if (this.#stopped) return;
        this.#auth = "claiming";
        this.#failures += 1;
        const step = RETRY_STEPS_MS[Math.min(this.#claimRetries++, RETRY_STEPS_MS.length - 1)]!;
        const wait = outcome.kind === "paused" ? Math.max(step, outcome.retryAfterMs) : step;
        this.#claimTimer = this.#clock.setTimeout(() => {
          this.#claimTimer = null;
          this.#claimOnce();
        }, wait);
        this.#emit();
        return;
      }
      default:
        // 404 unknown-guest: the guest is gone. 409 already-has-world: park the token, never
        // delete it (S-6). Any other 4xx (or a 404 that isn't the API's) is a bug: park too,
        // so no world is ever lost.
        if (unknownGuest) this.#tokens.clear();
        else this.#park(guestToken);
        this.#settleClaim();
        if (stale) {
          this.#release();
          return;
        }
        // Batches made for the guest's world must never reach the account's.
        this.#outbox.clear({ kind: "unauthorized" });
        this.#resetWorld();
        if (outcome.kind === "rejected") {
          this.#setNotice(
            { kind: "account-has-factory", text: TEXT["account-has-factory"] },
            false,
          );
        } else if (!unknownGuest) {
          console.error("claim:", outcome);
          this.#setNotice({ kind: "client-bug", text: TEXT["client-bug"] }, false);
        }
        this.#afterClaim();
    }
  }

  #settleClaim(): void {
    this.#claimPending = false;
    this.#claimRetries = 0;
    this.#auth = "idle";
  }

  /** The claim is decided: the outbox resumes under the session, and the world loads. */
  #afterClaim(): void {
    this.#emit();
    if (this.#stopped) return;
    this.#outbox.start();
    if (this.#snapshot === null) this.#wantGet(true);
    else this.#arm();
  }

  /** S-6: at most one guest token across both keys. A token is never dropped unless it is
   * safely in the park: an occupied park is never overwritten (the token then stays where it
   * is), and a park that fell back to memory keeps the stored token too. Under a session the
   * guest token is never sent, so leaving it in place is harmless. */
  #park(token: string): void {
    const held = this.#parked.get();
    if (held !== null && held !== token) {
      console.error("park: occupied by another guest token; this one stays in place");
      return;
    }
    this.#parked.set(token);
    if (this.#parked.persistent || !this.#tokens.persistent) this.#tokens.clear();
    else console.error("park: storage fell back to memory; the guest token stays stored");
    this.#checkPersistence();
  }

  /** S-7: the parked token back into the guest key. A different token already there is never
   * overwritten (the park then stays), and the park is cleared only once the token is stored
   * as durably as it was. */
  #unpark(): void {
    const parked = this.#parked.get();
    if (parked === null) return;
    if (this.#tokens.get() === null) this.#tokens.set(parked);
    if (this.#tokens.get() !== parked) {
      console.error("unpark: both keys hold different guest tokens; the parked one is kept");
      return;
    }
    this.#tokenFromPark = true;
    if (this.#tokens.persistent || !this.#parked.persistent) this.#parked.clear();
    this.#checkPersistence();
  }

  /** S-7: a sign-out, or a lost session. Back to the parked guest, or a new one. The account's
   * batches never reach the guest's world. */
  #leaveSession(kind: "signed-out" | "session-ended"): void {
    this.#outbox.clear({ kind: "unauthorized" });
    this.#identity = "guest";
    this.#account = null;
    this.#auth = "idle";
    this.#resetWorld();
    this.#unpark();
    this.#dropNotice("account-has-factory", false);
    this.#setNotice({ kind, text: TEXT[kind] }, false);
    this.#emit();
    if (this.#stopped) return;
    this.#outbox.start();
    this.#resume();
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

  /** W-14: `Guest <token>`, or nothing under a session (the cookie is the identity). */
  #authHeader(): string | null {
    if (this.#identity === "session") return null;
    const token = this.#tokens.get();
    this.#checkPersistence();
    return token === null ? null : `Guest ${token}`;
  }

  #hasIdentity(): boolean {
    return (
      this.#identity === "session" || (this.#identity === "guest" && this.#tokens.get() !== null)
    );
  }

  /** The identity is known: GET it, or make a guest. */
  #resume(): void {
    if (this.#identity === "session" || this.#tokens.get() !== null) this.#wantGet(true);
    else this.#createGuest();
  }

  #track(p: Promise<unknown>): void {
    const tracked = p.catch((err: unknown) => console.error("sync", err));
    this.#work.add(tracked);
    void tracked.finally(() => this.#work.delete(tracked));
  }

  #bootOnce(): void {
    if (this.#stopped || this.#booting !== null || this.#bootTimer !== null) return;
    const booting: Promise<void> = this.#boot().finally(() => {
      if (this.#booting === booting) this.#booting = null;
    });
    this.#booting = booting;
    this.#track(booting);
  }

  /** S-3: health first (retried on RETRY_STEPS_MS, counted toward offline), then the SDK and
   * its session, then the identity. Nothing world-shaped is sent before health answers. */
  async #boot(): Promise<void> {
    let health: HealthResponse | null = null;
    try {
      const res = await this.#fetch("/api/health").catch(() => null);
      if (res !== null && res.ok) {
        const body = (await res.json()) as unknown;
        if (typeof body === "object" && body !== null) health = body as HealthResponse;
      }
    } catch {
      health = null;
    }
    if (this.#stopped) return;
    if (health === null) {
      this.#failures += 1;
      const step = RETRY_STEPS_MS[Math.min(this.#bootRetries++, RETRY_STEPS_MS.length - 1)]!;
      this.#bootTimer = this.#clock.setTimeout(() => {
        this.#bootTimer = null;
        this.#bootOnce();
      }, step);
      this.#emit();
      return;
    }
    this.#failures = 0;
    this.#bootRetries = 0;
    // Warm the cache: on the common path the world pins the same bundle.
    this.#track(this.#content.get(health.contentChecksum).catch(() => {}));
    let session = false;
    if (health.accounts === true && this.#accounts) {
      this.#accountsState = "on";
      this.#accounts.init();
      // A transient refresh failure here reads as no session: the player boots as a guest
      // (the parked token returns, S-7), and a later sign-in's 409 parks it again.
      try {
        session = await this.#accounts.hasSession();
      } catch {
        session = false;
      }
      if (this.#stopped) return;
    } else {
      this.#accountsState = "off";
    }
    if (session) {
      this.#identity = "session";
      this.#account = { email: null };
      // S-6: a session and a guest token (a claim cut short): park it, never claim.
      const token = this.#tokens.get();
      if (token !== null) {
        this.#park(token);
        this.#setNotice({ kind: "account-has-factory", text: TEXT["account-has-factory"] }, false);
      }
    } else {
      this.#identity = "guest";
      // A parked token only exists while signed in: the session ended while away (S-7).
      if (this.#parked.get() !== null) {
        this.#unpark();
        this.#setNotice({ kind: "session-ended", text: TEXT["session-ended"] }, false);
      }
    }
    this.#emit();
    this.#outbox.start();
    this.#resume();
  }

  /** W-14: the banner, once the token lives only in memory. Storage can fail mid-session. */
  #checkPersistence(): void {
    if (this.#ephemeralShown) return;
    const parkAtRisk = !this.#parked.persistent && this.#parked.get() !== null;
    if (this.#tokens.persistent && !parkAtRisk) return;
    this.#ephemeralShown = true;
    this.#setNotice({ kind: "ephemeral-token", text: TEXT["ephemeral-token"] });
  }

  #createGuest(): void {
    if (this.#stopped || this.#guesting) return;
    // Never during a sign-in, a claim or a sign-out, and never under a session (S-4).
    if (this.#auth !== "idle" || this.#identity === "session") return;
    const guesting = this.#postGuest().finally(() => {
      this.#guesting = null;
    });
    this.#guesting = guesting;
    this.#track(guesting);
  }

  async #postGuest(): Promise<void> {
    const epoch = this.#epoch;
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
    // A guest made for a world we left: kept only if a guest is still exactly what's wanted
    // (newFactory joins the creation in flight); never under a session or a sign-in.
    const wanted =
      this.#identity === "guest" && this.#auth === "idle" && this.#tokens.get() === null;
    if (epoch !== this.#epoch && !wanted) return;
    const adoptIn = this.#epoch;
    switch (outcome.kind) {
      case "adopt": {
        const { guestToken, world } = outcome.body as unknown as GuestResponse;
        // Kept even after stop(): the guest exists now, and the next start() must reuse it.
        this.#tokens.set(guestToken);
        this.#tokenFromPark = false;
        if (this.#stopped) return;
        this.#checkPersistence();
        await this.#adopt(world, "get", receivedAt, adoptIn);
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
    // S-3 and S-4: no identity yet, or a sign-in deciding which world is ours.
    if (this.#auth !== "idle" || !this.#hasIdentity()) return;
    const now = this.#clock.now();
    if (this.#pausedUntil > now) {
      this.#defer(this.#pausedUntil - now, force);
      return;
    }
    if (!force && this.#snapshot && now - this.#snapshot.receivedAt < MIN_REPOLL_MS) return;
    this.#clearDeferred();
    this.#getting = true;
    const run: Promise<void> = this.#runGet().finally(() => {
      if (this.#getRun === run) this.#getRun = null;
    });
    this.#getRun = run;
    this.#track(run);
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
    const epoch = this.#epoch;
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
    const result = await this.#handle(outcome, "get", receivedAt, epoch);
    // A GET dropped as stale (W-6) re-arms from the snapshot it lost to. Nothing else re-arms
    // here: a failure's deferred retry is its re-trigger, and re-arming from a boundary already
    // past would fire at once and skip the backoff. A GET for a world we left asks again.
    if (result === "stale") this.#arm();
    else if (result === "ignored") this.#wantGet(true);
  }

  /** One handler for every response, GET and POST alike (W-11). */
  async #handle(
    o: Outcome,
    cause: Cause,
    receivedAt: number,
    epoch: number,
    settling?: number,
  ): Promise<Adoption | void> {
    if (this.#stopped) return;
    if (epoch !== this.#epoch) return "ignored";
    switch (o.kind) {
      case "adopt":
        return this.#adopt(o.body, cause, receivedAt, epoch, settling);
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
        this.#expire(false);
        return;
      case "unauthorized":
        this.#expire(o.apiGuest === true);
        return;
    }
  }

  /** A 401 on a guest token: the 30-day cleanup deleted it, and polling stops. Under a session
   * (the SDK's refresh failed): back to a guest, never a wall (S-7). `apiGuest`: the API's own
   * guest 401 (errors.ts), the only one that may take the quiet path below. */
  #expire(apiGuest: boolean): void {
    if (this.#identity === "session") {
      this.#leaveSession("session-ended");
      return;
    }
    if (this.#tokenFromPark && apiGuest) {
      // A parked token whose claim committed (its tab closed before the answer): the world is
      // the account's now. Quietly start a new guest instead of the guest-expired wall.
      this.#tokenFromPark = false;
      this.#outbox.clear({ kind: "unauthorized" });
      this.#tokens.clear();
      this.#resetWorld();
      this.#emit();
      this.#createGuest();
      return;
    }
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
    epoch: number,
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
    // The content load can outlast a reset: then this body is about a world we left.
    if (epoch !== this.#epoch) return "ignored";
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
    // A world loaded on this token: a later 401 on it is a real expiry, not a dead park (E).
    if (this.#identity === "guest") this.#tokenFromPark = false;
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
    if (
      !this.#stopped &&
      !this.#halted &&
      this.#auth === "idle" &&
      this.#visible &&
      this.#snapshot
    ) {
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
      accounts: this.#accountsState,
      identity: this.#identity,
      account: this.#account,
      auth: this.#auth,
      parked: this.#parked.get() !== null,
    };
  }

  #emit(): void {
    this.#view = this.#makeView();
    for (const fn of this.#listeners) fn();
  }
}
