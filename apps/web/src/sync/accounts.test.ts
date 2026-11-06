// Accounts in the store (W-14 to W-16, S-3 to S-7, O-5 to O-11): the real buildServer on
// PGlite with the API's header-based test verifier (x-test-user, the simulated cookie) and
// rigAccounts in place of the SDK. A sign-in is the redirect: page 1's beginSignIn, then page 2
// booting on the callback (redirect()). Every test makes its own rig; every wait is on store
// state (P-9).
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@manufactory/engine";
import type { StartResult } from "../auth/accounts.js";
import {
  ACCOUNT_LABEL_KEY,
  LEAVE_TIMEOUT_MS,
  MIN_REPOLL_MS,
  PARKED_GUEST_TOKEN_KEY,
} from "./constants.js";
import { browserTokenStorage, memoryTokenStorage, type TokenStorage } from "./identity.js";
import { GameStore, type SignInCallback } from "./store.js";
import { guestWorld, makeRig, rigAccounts, type RigTab, type TestRig } from "./test-rig.js";
import type { ActionsRequest, FetchLike } from "./wire.js";

const ACCOUNT_HAS_FACTORY =
  "This account already has a factory. Your guest factory is kept on this device: sign out to return to it.";
const SIGNED_OUT = "Signed out. Sign in to return to your saved factory.";
const SESSION_ENDED = "Your session ended. Sign in to return to your saved factory.";
/** O-10's sign-in-failed texts, for Discord. */
const FAILED = {
  denied: "Sign-in with Discord was cancelled. You're still playing as a guest.",
  stale:
    "That sign-in didn't finish in this tab, or it took too long. Start it again from Settings.",
  "no-email":
    "Discord didn't share an email address, and an account needs one. Check the email on your Discord account, then try again.",
  unavailable:
    "Couldn't reach the server to finish signing in. You're still playing as a guest; try again from Settings.",
  "unknown-provider": "That sign-in provider isn't available here.",
} as const;
/** Past a fresh slice world's first boundary (4000 s) and its 250 ms slack. */
const PAST_BOUNDARY_MS = 4_001_000;

let rigs: TestRig[] = [];
let stores: GameStore[] = [];

afterEach(async () => {
  for (const s of stores) s.stop();
  stores = [];
  for (const r of rigs) await r.close();
  rigs = [];
});

async function newRig(sessions = true): Promise<TestRig> {
  const rig = await makeRig({ sessions });
  rigs.push(rig);
  return rig;
}

interface Made {
  store: GameStore;
  tokens: TokenStorage;
  parked: TokenStorage;
  accountLabel: TokenStorage;
  client: ReturnType<typeof rigAccounts>;
  tab: RigTab;
  /** Every URL navigate() was given. */
  navigated: string[];
  /** view.pending.length at each navigate(). */
  pendingAtNavigate: number[];
  /** This store's fetches (`METHOD /path`), client calls and navigations, in order. */
  log: string[];
}

interface StoreOpts {
  tokens?: TokenStorage;
  parked?: TokenStorage;
  accountLabel?: TokenStorage;
  /** authorisationURL waits for it. */
  startGate?: Promise<void>;
  signOutFails?: boolean;
  tab?: RigTab;
  finishGate?: Promise<void>;
  startFails?: StartResult;
  callback?: SignInCallback;
  /** Wraps rig.fetch, to fake a response the server wouldn't give. */
  fetch?: FetchLike;
}

/** By default the three keys live in one localStorage stand-in, persistent like a browser's:
 * beginSignIn refuses a memory-only guest token (O-5). */
function storeOn(rig: TestRig, opts: StoreOpts = {}): Made {
  const ls = stubStorage();
  const tokens = opts.tokens ?? browserTokenStorage(ls);
  const parked = opts.parked ?? browserTokenStorage(ls, PARKED_GUEST_TOKEN_KEY);
  const accountLabel = opts.accountLabel ?? browserTokenStorage(ls, ACCOUNT_LABEL_KEY);
  const log: string[] = [];
  const client = rigAccounts(rig, {
    ...(opts.startGate ? { startGate: opts.startGate } : {}),
    ...(opts.signOutFails ? { signOutFails: true } : {}),
    ...(opts.tab ? { tab: opts.tab } : {}),
    ...(opts.finishGate ? { finishGate: opts.finishGate } : {}),
    ...(opts.startFails ? { startFails: opts.startFails } : {}),
    log,
  });
  const base = opts.fetch ?? rig.fetch;
  const fetch: FetchLike = (url, init) => {
    log.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
    return base(url, init);
  };
  const navigated: string[] = [];
  const pendingAtNavigate: number[] = [];
  const store: GameStore = new GameStore({
    fetch,
    clock: rig.clock,
    tokens,
    parked,
    accountLabel,
    accounts: client,
    navigate: (url) => {
      log.push(`navigate ${url}`);
      navigated.push(url);
      pendingAtNavigate.push(store.getView().pending.length);
    },
    ...(opts.callback ? { callback: opts.callback } : {}),
  });
  stores.push(store);
  rig.clock.settleWith = async () => {
    for (const s of stores) await s.idle();
  };
  return {
    store,
    tokens,
    parked,
    accountLabel,
    client,
    tab: client.tab,
    navigated,
    pendingAtNavigate,
    log,
  };
}

/** A started guest store on a sessions rig. */
async function guestStart(opts: StoreOpts = {}) {
  const rig = await newRig();
  const made = storeOn(rig, opts);
  await made.store.start();
  await made.store.idle();
  expect(made.store.getView().identity).toBe("guest");
  return { rig, ...made };
}

function gated(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

interface RedirectOpts extends StoreOpts {
  provider?: string;
  /** The callback's query, from the state page 1 stored. Default: `?code=<user>&state=<state>`. */
  search?: (state: string) => string;
}

interface Redirected extends Made {
  rig: TestRig;
  /** done()'s call count so far. */
  done: () => number;
  /** Page 2's start(). Awaited already unless a finishGate holds it. */
  started: Promise<void>;
}

/** The redirect, end to end: page 1's beginSignIn (navigate captured), page 1 stopped (the page
 * unloads), then page 2 built on the same storage and tab with the callback, and started. With
 * a finishGate, page 2's start() isn't awaited (it waits on the gate). */
async function redirect(
  page1: Made & { rig: TestRig },
  user: string,
  opts: RedirectOpts = {},
): Promise<Redirected> {
  const { rig } = page1;
  const provider = opts.provider ?? "discord";
  expect(await page1.store.beginSignIn(provider)).toEqual({ ok: true });
  const url = page1.navigated.at(-1)!;
  const state = new URL(url, "https://game.example").searchParams.get("state")!;
  page1.store.stop();
  let done = 0;
  const search = opts.search ? opts.search(state) : `?code=${user}&state=${state}`;
  const page2 = storeOn(rig, {
    tokens: page1.tokens,
    parked: page1.parked,
    accountLabel: page1.accountLabel,
    tab: page1.tab,
    callback: { provider, search, done: () => void (done += 1) },
    ...opts,
  });
  const started = page2.store.start();
  if (!opts.finishGate) {
    await started;
    await page2.store.idle();
  }
  return { ...page2, rig, done: () => done, started };
}

/** A fetch whose first `url` request reaches the server, and then the response is lost. */
function dropFirst(rig: TestRig, path: string): FetchLike {
  let dropped = false;
  return async (url, init) => {
    const res = await rig.fetch(url, init);
    if (url === path && !dropped) {
      dropped = true;
      throw new TypeError("network");
    }
    return res;
  };
}

const WORLDISH = new Set(["/api/world", "/api/actions", "/api/guests", "/api/auth/claim"]);
const worldCalls = (rig: TestRig, from = 0) =>
  rig.fetch.calls.slice(from).filter((c) => WORLDISH.has(c.url));
const getsSince = (rig: TestRig, from = 0) =>
  rig.fetch.calls.slice(from).filter((c) => c.method === "GET" && c.url === "/api/world");

function reorder(store: GameStore): Action {
  return {
    type: "REORDER_PRIORITY",
    entries: store.getView().snapshot!.state.priority.map((e) => e.id),
  };
}

async function accountWorld(rig: TestRig, user: string) {
  const rows = await rig.db.query<{ id: string; seed: unknown }>(
    `select p.id, w.state->'seed' as seed from players p join player_worlds w on w.player_id = p.id
      where p.supertokens_user_id = $1`,
    [user],
  );
  return rows[0] ?? null;
}

async function logRows(rig: TestRig, playerId: string): Promise<string[]> {
  const rows = await rig.db.query<{ k: string }>(
    "select idempotency_key as k from action_log where player_id = $1 order by id",
    [playerId],
  );
  return rows.map((r) => r.k);
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const kinds = (store: GameStore) => store.getView().notices.map((n) => n.kind);

describe("GameStore accounts (W-14 to W-16)", { timeout: 60_000 }, () => {
  it("1. accounts off: no client.init, the 4a guest start, accounts: off", async () => {
    const rig = await newRig(false);
    const { store, tokens, client } = storeOn(rig);
    await store.start();
    await store.idle();
    expect(client.calls).toEqual([]);
    const calls = rig.fetch.calls.map(
      (c) => `${c.method} ${c.url.replace(/[0-9a-f]{64}$/, "<sum>")}`,
    );
    expect([...calls].sort()).toEqual(
      ["GET /api/content/<sum>", "GET /api/health", "POST /api/guests"].sort(),
    );
    expect(calls[0]).toBe("GET /api/health");
    expect(tokens.get()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const view = store.getView();
    expect(view.status).toBe("ready");
    expect(view.accounts).toBe("off");
    expect(view.identity).toBe("guest");
    expect(view.account).toBeNull();
    expect(view.auth).toBe("idle");
  });

  it("2. health first: nothing world-shaped starts before its response", async () => {
    const rig = await newRig();
    const { store, client } = storeOn(rig);
    const release = rig.fetch.hold("GET", "/api/health");
    const started = store.start();
    for (let i = 0; i < 20; i++) await turn();
    expect(rig.fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/health"]);
    expect(client.calls).toEqual([]);
    expect(store.getView().accounts).toBe("unknown");
    release();
    await started;
    await store.idle();
    expect(rig.fetch.calls[0]!.url).toBe("/api/health");
    expect(worldCalls(rig).map((c) => c.url)).toEqual(["/api/guests"]);
    expect(client.calls).toEqual(["init", "hasSession"]);
    expect(store.getView().accounts).toBe("on");
  });

  it("3. a session at boot without a guest token: no guest, no Authorization", async () => {
    const rig = await newRig();
    rig.session.user = "u:s@x";
    const { store, tokens } = storeOn(rig);
    await store.start();
    await store.idle();
    expect(rig.fetch.calls.some((c) => c.url === "/api/guests")).toBe(false);
    const gets = getsSince(rig);
    expect(gets.length).toBeGreaterThan(0);
    for (const g of gets) expect(g.headers.authorization).toBeUndefined();
    const view = store.getView();
    expect(view.identity).toBe("session");
    expect(view.account).toEqual({ provider: null, email: null });
    expect(tokens.get()).toBeNull();
    const players = await rig.db.query<{ n: string }>("select count(*)::text as n from players");
    expect(players[0]!.n).toBe("1");
    expect(view.snapshot!.state.seed).toEqual((await accountWorld(rig, "u:s@x"))!.seed);
  });

  /** I-1 (final review): a sign-in cut short. The tab closed after the callback signed in, so the
   * session and the guest token both survive into the next boot, which claims (migration 003
   * makes a repeat claim idempotent). The claim's response is held: nothing may reach
   * /api/world, or the account's world would be made empty before the guest's is claimed. */
  async function bootWithBoth(rig: TestRig, guestToken: string, user: string) {
    const tokens = memoryTokenStorage();
    tokens.set(guestToken);
    rig.session.user = user;
    const from = rig.fetch.calls.length;
    const made = storeOn(rig, { tokens });
    const release = rig.fetch.hold("POST", "/api/auth/claim");
    const started = made.store.start();
    await until(() => worldCalls(rig, from).length > 0);
    for (let i = 0; i < 20; i++) await turn();
    const early = worldCalls(rig, from);
    expect(early.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/auth/claim"]);
    expect(early[0]!.body).toEqual({ guestToken });
    expect(early[0]!.headers.authorization).toBeUndefined();
    expect(made.store.getView().identity).toBe("session");
    expect(made.store.getView().auth).not.toBe("idle");
    release();
    await started;
    await made.store.idle();
    for (const g of getsSince(rig, from)) expect(g.headers.authorization).toBeUndefined();
    expect(made.store.getView().auth).toBe("idle");
    return { ...made, from };
  }

  const claimNow = (rig: TestRig, guestToken: string) =>
    rig.fetch("/api/auth/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guestToken }),
    });

  it("4a. a session at boot with a guest token whose claim committed: the repeat is 200", async () => {
    const rig = await newRig();
    const { guestToken, world } = await guestWorld(rig);
    rig.session.user = "u:c@x";
    expect((await claimNow(rig, guestToken)).status).toBe(200);
    const { store, tokens, parked } = await bootWithBoth(rig, guestToken, "u:c@x");
    expect(tokens.get()).toBeNull();
    expect(parked.get()).toBeNull();
    const view = store.getView();
    expect(view.identity).toBe("session");
    expect(view.notices.some((n) => n.kind === "account-has-factory")).toBe(false);
    expect(view.snapshot!.state.seed).toEqual((world.state as { seed: unknown }).seed);
  });

  it("4b. a session at boot with a guest token never claimed: the claim succeeds", async () => {
    const rig = await newRig();
    const { guestToken, world } = await guestWorld(rig);
    const { store, tokens, parked } = await bootWithBoth(rig, guestToken, "u:f@x");
    expect(tokens.get()).toBeNull();
    expect(parked.get()).toBeNull();
    const view = store.getView();
    expect(view.identity).toBe("session");
    expect(view.notices.some((n) => n.kind === "account-has-factory")).toBe(false);
    expect(view.snapshot!.state.seed).toEqual((world.state as { seed: unknown }).seed);
    expect((await accountWorld(rig, "u:f@x"))!.seed).toEqual(
      (world.state as { seed: unknown }).seed,
    );
  });

  it("4c. a session at boot with a guest token, the account has a world: 409 parks it", async () => {
    const rig = await newRig();
    rig.session.user = "u:b@x";
    expect((await rig.fetch("/api/world")).status).toBe(200);
    rig.session.user = null;
    const account = (await accountWorld(rig, "u:b@x"))!;
    const { guestToken } = await guestWorld(rig);
    const { store, tokens, parked } = await bootWithBoth(rig, guestToken, "u:b@x");
    expect(parked.get()).toBe(guestToken);
    expect(tokens.get()).toBeNull();
    const view = store.getView();
    expect(view.identity).toBe("session");
    expect(view.notices).toContainEqual({
      kind: "account-has-factory",
      text: ACCOUNT_HAS_FACTORY,
    });
    expect(view.snapshot!.state.seed).toEqual(account.seed);
  });

  it("4d. a session at boot with an unknown guest token: 404 drops it", async () => {
    const rig = await newRig();
    const dead = "D".repeat(43);
    const { store, tokens, parked } = await bootWithBoth(rig, dead, "u:g@x");
    expect(tokens.get()).toBeNull();
    expect(parked.get()).toBeNull();
    const view = store.getView();
    expect(view.identity).toBe("session");
    expect(view.notices.some((n) => n.kind === "account-has-factory")).toBe(false);
    expect(view.snapshot!.state.seed).toEqual((await accountWorld(rig, "u:g@x"))!.seed);
  });

  /** Test 7's setup: u:a already has a world; a guest signs in with Discord as "a". */
  async function conflicted() {
    const made = await guestStart();
    const { rig, store, tokens } = made;
    rig.session.user = "u:a";
    expect((await rig.fetch("/api/world")).status).toBe(200);
    rig.session.user = null;
    const account = (await accountWorld(rig, "u:a"))!;
    const guestToken = tokens.get()!;
    const guestSeed = store.getView().snapshot!.state.seed;
    const from = rig.fetch.calls.length;
    const page2 = await redirect(made, "a");
    return { ...page2, account, guestToken, guestSeed, from };
  }

  it("7. a 409 parks the guest token (S-5, S-6)", async () => {
    const { rig, store, tokens, parked, account, guestToken, from } = await conflicted();
    const claim = worldCalls(rig, from)[0]!;
    expect(claim.url).toBe("/api/auth/claim");
    expect(parked.get()).toBe(guestToken);
    expect(tokens.get()).toBeNull();
    expect(store.getView().snapshot!.state.seed).toEqual(account.seed);
    expect(await logRows(rig, account.id)).toEqual([]);
    expect(store.getView().notices).toContainEqual({
      kind: "account-has-factory",
      text: ACCOUNT_HAS_FACTORY,
    });
    expect(store.getView().identity).toBe("session");
    expect(store.getView().parked).toBe(true);
  });

  it("8. a 404 drops the token and loads the account's world (S-5)", async () => {
    const made = await guestStart();
    const { rig } = made;
    await rig.db.query("delete from players where guest_token is not null");
    const from = rig.fetch.calls.length;
    const { store, tokens, parked } = await redirect(made, "n");
    expect(worldCalls(rig, from)[0]!.url).toBe("/api/auth/claim");
    expect(tokens.get()).toBeNull();
    expect(parked.get()).toBeNull();
    const account = await accountWorld(rig, "u:n");
    expect(account).not.toBeNull();
    expect(store.getView().snapshot!.state.seed).toEqual(account!.seed);
    expect(getsSince(rig, from)[0]!.headers["x-test-user"]).toBe("u:n");
  });

  it("9a. sign-out returns to the parked guest (S-7)", async () => {
    const { rig, store, tokens, parked, guestToken, guestSeed } = await conflicted();
    const from = rig.fetch.calls.length;
    expect(await store.signOut()).toBe(true);
    await store.idle();
    expect(parked.get()).toBeNull();
    expect(tokens.get()).toBe(guestToken);
    const [get] = getsSince(rig, from);
    expect(get!.headers.authorization).toBe(`Guest ${guestToken}`);
    expect(get!.headers["x-test-user"]).toBeUndefined();
    const view = store.getView();
    expect(view.snapshot!.state.seed).toEqual(guestSeed);
    expect(view.identity).toBe("guest");
    expect(view.account).toBeNull();
    expect(view.notices).toContainEqual({ kind: "signed-out", text: SIGNED_OUT });
    expect(view.notices.some((n) => n.kind === "account-has-factory")).toBe(false);
    expect(worldCalls(rig, from).some((c) => c.url === "/api/guests")).toBe(false);
    expect(view.parked).toBe(false);
  });

  it("9b. sign-out with nothing parked makes one new guest (S-7)", async () => {
    const { rig, store, tokens } = await redirect(await guestStart(), "c");
    expect(store.getView().identity).toBe("session");
    expect(tokens.get()).toBeNull();
    const from = rig.fetch.calls.length;
    expect(await store.signOut()).toBe(true);
    await store.idle();
    expect(worldCalls(rig, from).filter((c) => c.url === "/api/guests")).toHaveLength(1);
    expect(tokens.get()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.getView().identity).toBe("guest");
    expect(store.getView().status).toBe("ready");
    for (const c of rig.fetch.calls.slice(from)) expect(c.headers["x-test-user"]).toBeUndefined();
  });

  it("10. a lost session returns to the parked guest with session-ended (S-7)", async () => {
    const rig = await newRig();
    const { guestToken, world } = await guestWorld(rig);
    const tokens = memoryTokenStorage();
    const parked = memoryTokenStorage();
    parked.set(guestToken); // parked by an earlier 409
    rig.session.user = "u:l@x";
    const { store } = storeOn(rig, { tokens, parked });
    await store.start();
    await store.idle();
    expect(parked.get()).toBe(guestToken);

    rig.session.user = null;
    const from = rig.fetch.calls.length;
    await rig.advance(PAST_BOUNDARY_MS);
    await store.idle();
    const gets = getsSince(rig, from);
    expect(gets[0]!.headers.authorization).toBeUndefined(); // the 401, under the lost session
    expect(gets[1]!.headers.authorization).toBe(`Guest ${guestToken}`);
    for (const c of rig.fetch.calls.slice(from)) expect(c.headers["x-test-user"]).toBeUndefined();
    const view = store.getView();
    expect(view.notices).toContainEqual({ kind: "session-ended", text: SESSION_ENDED });
    expect(view.identity).toBe("guest");
    expect(view.status).toBe("ready");
    expect(tokens.get()).toBe(guestToken);
    expect(parked.get()).toBeNull();
    expect(view.snapshot!.state.seed).toEqual((world.state as { seed: unknown }).seed);
  });

  it("12. a lost claim response retries the same claim after 1 s, still held", async () => {
    const made = await guestStart();
    const { rig } = made;
    const from = rig.fetch.calls.length;
    const { store, tokens, parked } = await redirect(made, "r", {
      fetch: dropFirst(rig, "/api/auth/claim"),
    });
    expect(worldCalls(rig, from).map((c) => c.url)).toEqual(["/api/auth/claim"]);
    expect(store.getView().auth).toBe("claiming");
    await rig.advance(999);
    expect(worldCalls(rig, from)).toHaveLength(1);
    await rig.advance(1);
    await store.idle();
    const calls = worldCalls(rig, from);
    expect(calls.slice(0, 2).map((c) => c.url)).toEqual(["/api/auth/claim", "/api/auth/claim"]);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(store.getView().auth).toBe("idle");
    // The first claim committed; the repeat is idempotent (migration 003), not a 409.
    expect(tokens.get()).toBeNull();
    expect(parked.get()).toBeNull();
    expect(store.getView().identity).toBe("session");
    expect(store.getView().notices.some((n) => n.kind === "account-has-factory")).toBe(false);
  });
});

/** A Storage stand-in (as identity.test.ts); `failKey`'s writes throw, as a full quota would. */
function stubStorage(failKey?: string): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (k === failKey) throw new DOMException("full", "QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

/** Waits, a macrotask at a time, until `done()` (for tests where idle() would wait on a held
 * response). */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await turn();
  expect(done()).toBe(true);
}

describe("GameStore accounts: never lose a guest token (fix round 1)", { timeout: 60_000 }, () => {
  it("B. an occupied park is never overwritten, and sign-out never overwrites a token", async () => {
    const rig = await newRig();
    const g0 = await guestWorld(rig);
    const g1 = await guestWorld(rig);
    const tokens = memoryTokenStorage();
    const parked = memoryTokenStorage();
    tokens.set(g1.guestToken);
    parked.set(g0.guestToken);
    rig.session.user = "u:o@x";
    // The account has a world, so the boot's claim of g1 (I-1) is a 409 and g1 wants the park.
    expect((await rig.fetch("/api/world")).status).toBe(200);
    const booted = rig.fetch.calls.length;
    const { store } = storeOn(rig, { tokens, parked });
    await store.start();
    await store.idle();
    expect(worldCalls(rig, booted)[0]!.url).toBe("/api/auth/claim");
    expect(store.getView().identity).toBe("session");
    expect(tokens.get()).toBe(g1.guestToken);
    expect(parked.get()).toBe(g0.guestToken);
    for (const g of getsSince(rig, booted)) expect(g.headers.authorization).toBeUndefined();

    const from = rig.fetch.calls.length;
    expect(await store.signOut()).toBe(true);
    await store.idle();
    expect(tokens.get()).toBe(g1.guestToken);
    expect(parked.get()).toBe(g0.guestToken);
    expect(getsSince(rig, from)[0]!.headers.authorization).toBe(`Guest ${g1.guestToken}`);
  });

  it("B. a guest boot with both keys holding different tokens keeps the park", async () => {
    const rig = await newRig();
    const g0 = await guestWorld(rig);
    const g1 = await guestWorld(rig);
    const tokens = memoryTokenStorage();
    const parked = memoryTokenStorage();
    tokens.set(g1.guestToken);
    parked.set(g0.guestToken);
    const { store } = storeOn(rig, { tokens, parked });
    await store.start();
    await store.idle();
    expect(tokens.get()).toBe(g1.guestToken);
    expect(parked.get()).toBe(g0.guestToken);
    expect(getsSince(rig, 4)[0]!.headers.authorization).toBe(`Guest ${g1.guestToken}`);
    expect(store.getView().snapshot!.state.seed).toEqual(
      (g1.world.state as { seed: unknown }).seed,
    );
  });

  it("B. a park that falls back to memory keeps the stored token, and warns", async () => {
    const ls = stubStorage(PARKED_GUEST_TOKEN_KEY);
    const tokens = browserTokenStorage(ls);
    const parked = browserTokenStorage(ls, PARKED_GUEST_TOKEN_KEY);
    const made = await guestStart({ tokens, parked });
    const { rig } = made;
    rig.session.user = "u:a";
    expect((await rig.fetch("/api/world")).status).toBe(200);
    rig.session.user = null;
    const guestToken = tokens.get()!;
    const { store } = await redirect(made, "a");
    expect(rig.fetch.calls.some((c) => c.url === "/api/auth/claim")).toBe(true);
    expect(parked.get()).toBe(guestToken);
    expect(parked.persistent).toBe(false);
    expect(tokens.get()).toBe(guestToken);
    expect(ls.map.get("mi.guestToken")).toBe(guestToken);
    expect(store.getView().notices.map((n) => n.kind)).toContain("ephemeral-token");
    const last = getsSince(rig).at(-1)!;
    expect(last.headers.authorization).toBeUndefined();

    const from = rig.fetch.calls.length;
    expect(await store.signOut()).toBe(true);
    await store.idle();
    expect(tokens.get()).toBe(guestToken);
    expect(parked.get()).toBeNull();
    expect(getsSince(rig, from)[0]!.headers.authorization).toBe(`Guest ${guestToken}`);
  });

  it("C. a claim 404 that isn't the API's unknown-guest parks the token", async () => {
    const made = await guestStart();
    const { rig } = made;
    let fakes = 0;
    const fetch: FetchLike = async (url, init) => {
      if (url === "/api/auth/claim" && fakes++ === 0) {
        return new Response('{"error":"not found"}', { status: 404 });
      }
      return rig.fetch(url, init);
    };
    const guestToken = made.tokens.get()!;
    const { store, tokens, parked } = await redirect(made, "p", { fetch });
    expect(parked.get()).toBe(guestToken);
    expect(tokens.get()).toBeNull();
    expect(store.getView().notices.map((n) => n.kind)).toContain("client-bug");
    expect(store.getView().identity).toBe("session");
    expect(store.getView().snapshot!.state.seed).toEqual((await accountWorld(rig, "u:p"))!.seed);
  });

  it("D. a callback boot with no guest token sends no POST /api/guests before finishSignIn answers", async () => {
    const { gate, open } = gated();
    const rig = await newRig();
    const tab: RigTab = { state: { provider: "discord", state: "s1" }, consumed: null };
    let done = 0;
    const { store, tokens, client } = storeOn(rig, {
      tab,
      finishGate: gate,
      callback: { provider: "discord", search: "?code=g&state=s1", done: () => void done++ },
    });
    rig.clock.settleWith = null; // idle() would wait on the gate
    const started = store.start();
    await until(() => client.calls.includes("finishSignIn discord"));
    await rig.advance(30_000);
    store.onFocus();
    store.onOnline();
    expect(worldCalls(rig)).toEqual([]);
    expect(done).toBe(0);
    open();
    await started;
    await store.idle();
    expect(done).toBe(1);
    expect(worldCalls(rig).some((c) => c.url === "/api/guests")).toBe(false);
    expect(rig.fetch.calls.some((c) => c.url === "/api/auth/claim")).toBe(false);
    expect(tokens.get()).toBeNull();
    expect(store.getView().identity).toBe("session");
    expect(store.getView().snapshot!.state.seed).toEqual((await accountWorld(rig, "u:g"))!.seed);
  });

  it("D. a keepalive response that lands after a reset is ignored (the epoch)", async () => {
    // Since O-1 a sign-in is a page load, so the reset here is the sign-out that follows a
    // callback sign-in: the session's keepalive is in flight (sign-out's hold doesn't wait on
    // keepalives), it commits to the account's world, and lands after the new guest's world.
    const { rig, store, tokens } = await redirect(await guestStart(), "k");
    expect(store.getView().identity).toBe("session");
    await rig.advance(60_000);
    store.pressTap();
    store.releaseTap();
    const from = rig.fetch.calls.length;
    const release = rig.fetch.hold("POST", "/api/actions");
    store.flushTaps({ keepalive: true });
    await until(() => rig.fetch.calls.slice(from).some((c) => c.url === "/api/actions"));
    rig.clock.settleWith = null;

    expect(await store.signOut()).toBe(true);
    await until(
      () =>
        store.getView().identity === "guest" &&
        tokens.get() !== null &&
        store.getView().snapshot !== null,
    );
    const guest = store.getView().snapshot!;
    expect(guest.stateVersion).toBe(0);
    release();
    for (let i = 0; i < 20; i++) await turn();
    await store.idle();
    // The account world's v1 (the tap committed) is not adopted over the new guest's v0.
    const account = (await accountWorld(rig, "u:k"))!;
    expect(account.seed).not.toEqual(guest.state.seed);
    expect(store.getView().snapshot!.state.seed).toEqual(guest.state.seed);
    expect(store.getView().snapshot!.stateVersion).toBe(0);
    expect(store.getView().identity).toBe("guest");
    expect(kinds(store)).not.toContain("session-ended");
  });

  it("E. a dead parked token restored at sign-out quietly becomes a new guest", async () => {
    const rig = await newRig();
    const dead = "D".repeat(43);
    const tokens = memoryTokenStorage();
    // Parked by a 409, then claimed from another tab: the server no longer knows it.
    const parked = memoryTokenStorage();
    parked.set(dead);
    rig.session.user = "u:d@x";
    const { store } = storeOn(rig, { tokens, parked });
    await store.start();
    await store.idle();
    expect(parked.get()).toBe(dead);
    const from = rig.fetch.calls.length;
    expect(await store.signOut()).toBe(true);
    await store.idle();
    const view = store.getView();
    expect(getsSince(rig, from)[0]!.headers.authorization).toBe(`Guest ${dead}`);
    expect(worldCalls(rig, from).filter((c) => c.url === "/api/guests")).toHaveLength(1);
    expect(tokens.get()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.get()).not.toBe(dead);
    expect(parked.get()).toBeNull();
    expect(view.notices.some((n) => n.kind === "guest-expired")).toBe(false);
    expect(view.notices).toContainEqual({ kind: "signed-out", text: SIGNED_OUT });
    expect(view.status).toBe("ready");
    expect(view.identity).toBe("guest");
  });

  it("F. a 503 claim retries the same claim while held", async () => {
    const made = await guestStart();
    const { rig } = made;
    let fakes = 0;
    const fetch: FetchLike = async (url, init) => {
      if (url === "/api/auth/claim" && fakes++ === 0) {
        return new Response('{"error":"x"}', { status: 503, headers: { "retry-after": "1" } });
      }
      return rig.fetch(url, init);
    };
    const from = rig.fetch.calls.length;
    const { store, tokens } = await redirect(made, "q", { fetch });
    expect(store.getView().auth).toBe("claiming");
    await rig.advance(999);
    expect(fakes).toBe(1);
    expect(worldCalls(rig, from)).toEqual([]); // the 503 was faked: nothing reached the world
    await rig.advance(1);
    await store.idle();
    expect(fakes).toBe(2);
    expect(worldCalls(rig, from)[0]!.url).toBe("/api/auth/claim");
    expect(store.getView().auth).toBe("idle");
    expect(tokens.get()).toBeNull();
  });

  it("F. a 401 claim releases: the guest resumes with its token, with client-bug", async () => {
    const made = await guestStart();
    const { rig } = made;
    expect((await made.store.send([reorder(made.store)], "reorder")).kind).toBe("adopt");
    const fetch: FetchLike = async (url, init) => {
      // The cookie didn't stick.
      if (url === "/api/auth/claim") rig.session.user = null;
      return rig.fetch(url, init);
    };
    const guestToken = made.tokens.get()!;
    const from = rig.fetch.calls.length;
    const { store, tokens } = await redirect(made, "z", { fetch });
    const after = worldCalls(rig, from);
    expect(after.map((c) => c.url)).toEqual(["/api/auth/claim", "/api/world"]);
    expect(after[1]!.headers.authorization).toBe(`Guest ${guestToken}`);
    const view = store.getView();
    expect(view.identity).toBe("guest");
    expect(view.account).toBeNull();
    expect(view.auth).toBe("idle");
    expect(view.notices.map((n) => n.kind)).toContain("client-bug");
    expect(tokens.get()).toBe(guestToken);
    expect(view.snapshot!.stateVersion).toBe(1);
  });

  it("F. stop() and start() mid-hold: nothing is sent while stopped, then the claim", async () => {
    const { gate, open } = gated();
    const made = await guestStart();
    const { rig } = made;
    const from = rig.fetch.calls.length;
    const { store, tokens, client, started } = await redirect(made, "s", { finishGate: gate });
    rig.clock.settleWith = null;
    await until(() => client.calls.includes("finishSignIn discord"));
    store.stop();
    open();
    await started;
    await store.idle();
    expect(worldCalls(rig, from)).toEqual([]);
    expect(rig.clock.pendingTimers).toBe(0);
    await store.start();
    await store.idle();
    expect(worldCalls(rig, from).map((c) => c.url)).toEqual(["/api/auth/claim"]);
    expect(tokens.get()).toBeNull();
    expect(store.getView().identity).toBe("session");
  });

  it("F. stop() and start() mid-claim: the repeat claim is idempotent", async () => {
    const made = await guestStart();
    const { rig } = made;
    const seed = made.store.getView().snapshot!.state.seed;
    const { store, tokens, parked } = await redirect(made, "m", {
      fetch: dropFirst(rig, "/api/auth/claim"),
    });
    expect(store.getView().auth).toBe("claiming");
    store.stop();
    expect(rig.clock.pendingTimers).toBe(0);
    await store.start();
    await store.idle();
    const claims = rig.fetch.calls.filter((c) => c.url === "/api/auth/claim");
    expect(claims).toHaveLength(2);
    expect(store.getView().auth).toBe("idle");
    expect(tokens.get()).toBeNull();
    expect(parked.get()).toBeNull();
    expect(store.getView().snapshot!.state.seed).toEqual(seed);
    expect(store.getView().notices.some((n) => n.kind === "account-has-factory")).toBe(false);
  });

  it("F. a failed sign-out returns false, keeps the session and releases", async () => {
    const rig = await newRig();
    rig.session.user = "u:f@x";
    const { store } = storeOn(rig, { signOutFails: true });
    await store.start();
    await store.idle();
    expect(await store.signOut()).toBe(false);
    const view = store.getView();
    expect(view.auth).toBe("idle");
    expect(view.identity).toBe("session");
    const from = rig.fetch.calls.length;
    await rig.advance(MIN_REPOLL_MS);
    store.onFocus();
    await store.idle();
    expect(getsSince(rig, from)[0]!.headers["x-test-user"]).toBe("u:f@x");
  });
});

describe("GameStore accounts: fix rounds 2 and 3", { timeout: 60_000 }, () => {
  it("1. a foreign 401 on a token from the park keeps it, with no wall (final review I-2)", async () => {
    const dead = "D".repeat(43);
    let foreign = false;
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      if (foreign && url === "/api/world") {
        // A proxy's or an edge's 401: no Guest challenge, not the API's body.
        return new Response("<html>401 Authorization Required</html>", { status: 401 });
      }
      return holder.rig!.fetch(url, init);
    };
    const rig = await newRig();
    holder.rig = rig;
    const tokens = memoryTokenStorage();
    const parked = memoryTokenStorage();
    parked.set(dead);
    rig.session.user = "u:e@x";
    const { store } = storeOn(rig, { tokens, parked, fetch });
    await store.start();
    await store.idle();
    expect(parked.get()).toBe(dead);
    foreign = true;
    const from = rig.fetch.calls.length;
    expect(await store.signOut()).toBe(true);
    await store.idle();
    const view = store.getView();
    expect(tokens.get()).toBe(dead);
    expect(view.notices.map((n) => n.kind)).toContain("client-bug");
    expect(view.notices.map((n) => n.kind)).not.toContain("guest-expired");
    expect(view.status).not.toBe("error");
    expect(worldCalls(rig, from).some((c) => c.url === "/api/guests")).toBe(false);
  });

  it("I-2. a 401 that isn't the API's on a guest request keeps the token, no wall, and retries", async () => {
    // SuperTokens' try-refresh 401, from a stale cookie riding along with a guest request.
    let stray = 0;
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      if (stray > 0 && (url === "/api/world" || url === "/api/actions")) {
        stray -= 1;
        return new Response('{"message":"try refresh token"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return holder.rig!.fetch(url, init);
    };
    const rig = await newRig();
    holder.rig = rig;
    const { store, tokens } = storeOn(rig, { fetch });
    await store.start();
    await store.idle();
    const guestToken = tokens.get()!;

    // A GET: retried on the usual backoff (1 s), the token kept.
    stray = 1;
    const from = rig.fetch.calls.length;
    await rig.advance(MIN_REPOLL_MS);
    store.onFocus();
    await store.idle();
    expect(stray).toBe(0);
    let view = store.getView();
    expect(tokens.get()).toBe(guestToken);
    expect(view.notices.map((n) => n.kind)).toContain("client-bug");
    expect(view.notices.map((n) => n.kind)).not.toContain("guest-expired");
    expect(view.status).not.toBe("error");
    expect(getsSince(rig, from)).toEqual([]);
    await rig.advance(1_000);
    await store.idle();
    expect(getsSince(rig, from)).toHaveLength(1);
    expect(getsSince(rig, from)[0]!.headers.authorization).toBe(`Guest ${guestToken}`);

    // A POST: the same batch resends with its key after 1 s, not dropped.
    stray = 1;
    const at = rig.fetch.calls.length;
    const sent = store.send([reorder(store)], "reorder");
    await store.idle();
    expect(stray).toBe(0);
    expect(store.getView().pending.map((b) => b.label)).toEqual(["reorder"]);
    await rig.advance(1_000);
    await store.idle();
    expect((await sent).kind).toBe("adopt");
    const posts = rig.fetch.calls.slice(at).filter((c) => c.url === "/api/actions");
    expect(posts).toHaveLength(1);
    view = store.getView();
    expect(tokens.get()).toBe(guestToken);
    expect(view.notices.map((n) => n.kind)).not.toContain("guest-expired");
    expect(view.snapshot!.stateVersion).toBe(1);
  });

  it("N-1. a stray 401 on a POST from a world left behind is never resent to the new one", async () => {
    // W-14: the POST is in flight when newFactory() resets to a new guest; its answer is a
    // 401 that isn't the API's. Resending it would carry the old world's batch to the new one.
    let openPost!: () => void;
    const postGate = new Promise<void>((r) => (openPost = r));
    let posts = 0;
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      if (url === "/api/actions") {
        posts += 1;
        if (posts === 1) {
          await postGate;
          return new Response('{"message":"try refresh token"}', {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return holder.rig!.fetch(url, init);
    };
    const rig = await newRig();
    holder.rig = rig;
    const { store, tokens } = storeOn(rig, { fetch });
    await store.start();
    await store.idle();
    const oldToken = tokens.get()!;
    const sent = store.send([reorder(store)], "reorder");
    await until(() => posts === 1);
    const from = rig.fetch.calls.length;
    const fresh = store.newFactory();
    await until(() => tokens.get() !== null && tokens.get() !== oldToken);
    openPost();
    await fresh;
    await store.idle();
    await rig.advance(30_000);
    await store.idle();
    expect(posts).toBe(1);
    expect((await sent).kind).toBe("unauthorized");
    expect(rig.fetch.calls.slice(from).some((c) => c.url === "/api/actions")).toBe(false);
    expect(store.getView().pending).toEqual([]);
    expect(tokens.get()).not.toBe(oldToken);
    expect(store.getView().snapshot!.stateVersion).toBe(0);
  });

  it("N-1. a 5xx on a POST from a world left behind is never resent to the new one", async () => {
    // As above, answered with a 500 (the outbox's own retry): settled, never resent.
    let openPost!: () => void;
    const postGate = new Promise<void>((r) => (openPost = r));
    let posts = 0;
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      if (url === "/api/actions") {
        posts += 1;
        if (posts === 1) {
          await postGate;
          return new Response('{"error":"x"}', { status: 500 });
        }
      }
      return holder.rig!.fetch(url, init);
    };
    const rig = await newRig();
    holder.rig = rig;
    const { store, tokens } = storeOn(rig, { fetch });
    await store.start();
    await store.idle();
    const oldToken = tokens.get()!;
    const sent = store.send([reorder(store)], "reorder");
    await until(() => posts === 1);
    const from = rig.fetch.calls.length;
    const fresh = store.newFactory();
    await until(() => tokens.get() !== null && tokens.get() !== oldToken);
    openPost();
    await fresh;
    await store.idle();
    await rig.advance(30_000);
    await store.idle();
    expect(posts).toBe(1);
    expect((await sent).kind).toBe("unauthorized");
    expect(rig.fetch.calls.slice(from).some((c) => c.url === "/api/actions")).toBe(false);
    expect(store.getView().pending).toEqual([]);
    expect(tokens.get()).not.toBe(oldToken);
    expect(store.getView().snapshot!.stateVersion).toBe(0);
  });

  it("3. a session POST that 401s still ends the session", async () => {
    const rig = await newRig();
    rig.session.user = "u:t@x";
    const { store } = storeOn(rig);
    await store.start();
    await store.idle();
    rig.session.user = null; // the refresh failed: the cookie is gone
    expect((await store.send([reorder(store)], "reorder")).kind).toBe("unauthorized");
    await store.idle();
    const view = store.getView();
    expect(view.identity).toBe("guest");
    expect(view.notices).toContainEqual({ kind: "session-ended", text: SESSION_ENDED });
    expect(view.status).toBe("ready");
  });
});

describe("GameStore OAuth redirect (O-5, O-6)", { timeout: 60_000 }, () => {
  it("1. the drain: the batch in flight and the pending taps go out, then the URL, then navigate", async () => {
    const made = await guestStart();
    const { rig, store } = made;
    await rig.advance(60_000);
    const logFrom = made.log.length;
    const callsFrom = rig.fetch.calls.length;
    const release = rig.fetch.hold("POST", "/api/actions");
    const sent = store.send([reorder(store)], "reorder");
    await until(() => rig.fetch.calls.some((c) => c.url === "/api/actions"));
    for (let i = 0; i < 3; i++) {
      store.pressTap();
      store.releaseTap();
    }
    expect(store.getView().taps.pending).toBe(3);
    rig.clock.settleWith = null; // idle() would wait on the held response
    const begun = store.beginSignIn("discord");
    expect(store.getView().leaving).toBe("discord");
    for (let i = 0; i < 20; i++) await turn();
    expect(made.navigated).toEqual([]);
    release();
    expect(await begun).toEqual({ ok: true });
    expect((await sent).kind).toBe("adopt");
    const order = made.log
      .slice(logFrom)
      .filter((l) => /^(POST \/api\/actions|authorisationURL|navigate)/.test(l));
    expect(order).toEqual([
      "POST /api/actions",
      "POST /api/actions",
      "authorisationURL discord",
      "navigate /fake/authorize?provider=discord&state=s1",
    ]);
    const posts = rig.fetch.calls
      .slice(callsFrom)
      .filter((c) => c.url === "/api/actions")
      .map((c) => c.body as ActionsRequest);
    expect(posts.map((b) => b.actions[0]!.type)).toEqual(["REORDER_PRIORITY", "TAP"]);
    const logged = await rig.db.query<{ k: string }>("select idempotency_key as k from action_log");
    for (const b of posts) expect(logged.map((r) => r.k)).toContain(b.idempotencyKey);
    expect(made.pendingAtNavigate).toEqual([0]);
    expect(store.getView().leaving).toBe("discord");
  });

  it("2. a batch waiting out a 503 pause: unsaved, no navigate, and the batch goes later", async () => {
    let fakes = 0;
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      if (url === "/api/actions" && fakes++ === 0) {
        return new Response('{"error":"x"}', { status: 503, headers: { "retry-after": "30" } });
      }
      return holder.rig!.fetch(url, init);
    };
    const rig = await newRig();
    holder.rig = rig;
    const { store, client, navigated } = storeOn(rig, { fetch });
    await store.start();
    await store.idle();
    const sent = store.send([reorder(store)], "reorder");
    await store.idle();
    expect(fakes).toBe(1);
    expect(await store.beginSignIn("discord")).toEqual({ ok: false, kind: "unsaved" });
    expect(navigated).toEqual([]);
    expect(client.calls).not.toContain("authorisationURL discord");
    expect(store.getView().leaving).toBeNull();
    expect(store.getView().pending.map((b) => b.label)).toEqual(["reorder"]);
    await rig.advance(30_000);
    await store.idle();
    expect((await sent).kind).toBe("adopt");
    expect(store.getView().pending).toEqual([]);
  });

  it("3. a guest token only in memory: storage, and no authorisation URL", async () => {
    const { store, client, navigated } = await guestStart({
      tokens: memoryTokenStorage(),
    });
    expect(await store.beginSignIn("discord")).toEqual({ ok: false, kind: "storage" });
    expect(client.calls).not.toContain("authorisationURL discord");
    expect(navigated).toEqual([]);
    expect(store.getView().leaving).toBeNull();
  });

  it("4. the guards: an unlisted provider, a session, a second call, a refused URL", async () => {
    const made = await guestStart();
    const { store, client } = made;
    expect(await store.beginSignIn("gitlab")).toEqual({ ok: false, kind: "unavailable" });
    expect(await store.beginSignIn("discord")).toEqual({ ok: true });
    expect(await store.beginSignIn("github")).toEqual({ ok: false, kind: "unavailable" });
    expect(client.calls.filter((c) => c.startsWith("authorisationURL"))).toHaveLength(1);

    const rig = await newRig();
    rig.session.user = "u:s";
    const session = storeOn(rig);
    await session.store.start();
    await session.store.idle();
    expect(await session.store.beginSignIn("discord")).toEqual({
      ok: false,
      kind: "unavailable",
    });

    const refused = await guestStart({
      startFails: { ok: false, kind: "not-allowed", reason: "r" },
    });
    expect(await refused.store.beginSignIn("github")).toEqual({
      ok: false,
      kind: "not-allowed",
      reason: "r",
    });
    expect(refused.store.getView().leaving).toBeNull();
    expect(refused.navigated).toEqual([]);
  });

  it("5. leaving clears on a bfcache pageshow, and after LEAVE_TIMEOUT_MS", async () => {
    const { rig, store } = await guestStart();
    expect(await store.beginSignIn("discord")).toEqual({ ok: true });
    store.pageShown(false);
    expect(store.getView().leaving).toBe("discord");
    store.pageShown(true);
    expect(store.getView().leaving).toBeNull();

    expect(await store.beginSignIn("github")).toEqual({ ok: true });
    await rig.advance(LEAVE_TIMEOUT_MS - 1);
    expect(store.getView().leaving).toBe("github");
    await rig.advance(1);
    expect(store.getView().leaving).toBeNull();
  });

  describe("5b. abandoned mid-drain: no navigate", () => {
    it("stop() while the drain waits on the outbox", async () => {
      const made = await guestStart();
      const { rig, store } = made;
      const release = rig.fetch.hold("POST", "/api/actions");
      void store.send([reorder(store)], "reorder");
      await until(() => rig.fetch.calls.some((c) => c.url === "/api/actions"));
      rig.clock.settleWith = null;
      const begun = store.beginSignIn("discord");
      for (let i = 0; i < 5; i++) await turn();
      store.stop();
      release();
      expect(await begun).toEqual({ ok: false, kind: "unavailable" });
      expect(made.client.calls).not.toContain("authorisationURL discord");
      expect(made.navigated).toEqual([]);
      expect(store.getView().leaving).toBeNull();
    });

    it("stop() while the authorisation URL is being fetched", async () => {
      const { gate, open } = gated();
      const made = await guestStart({ startGate: gate });
      const begun = made.store.beginSignIn("discord");
      await until(() => made.client.calls.includes("authorisationURL discord"));
      made.store.stop();
      open();
      expect(await begun).toEqual({ ok: false, kind: "unavailable" });
      expect(made.navigated).toEqual([]);
      expect(made.store.getView().leaving).toBeNull();
    });

    it("a bfcache return mid-URL, then another provider: only the second one leaves", async () => {
      const { gate, open } = gated();
      const made = await guestStart({ startGate: gate });
      const first = made.store.beginSignIn("discord");
      await until(() => made.client.calls.includes("authorisationURL discord"));
      made.store.pageShown(true);
      expect(made.store.getView().leaving).toBeNull();
      const second = made.store.beginSignIn("github");
      expect(made.store.getView().leaving).toBe("github");
      await until(() => made.client.calls.includes("authorisationURL github"));
      open();
      expect(await first).toEqual({ ok: false, kind: "unavailable" });
      // The first's refusal leaves the second's `leaving` alone.
      expect(made.store.getView().leaving).toBe("github");
      expect(await second).toEqual({ ok: true });
      expect(made.navigated).toEqual(["/fake/authorize?provider=github&state=s2"]);
    });

    it("the guest token falls back to memory mid-URL: storage", async () => {
      const { gate, open } = gated();
      const inner = browserTokenStorage(stubStorage());
      const tokens: TokenStorage = {
        get: () => inner.get(),
        set: (t) => inner.set(t),
        clear: () => inner.clear(),
        persistent: true,
      };
      const made = await guestStart({ startGate: gate, tokens });
      const begun = made.store.beginSignIn("discord");
      await until(() => made.client.calls.includes("authorisationURL discord"));
      tokens.persistent = false;
      open();
      expect(await begun).toEqual({ ok: false, kind: "storage" });
      expect(made.navigated).toEqual([]);
      expect(made.store.getView().leaving).toBeNull();
    });
  });

  it("6. the callback claims first: the guest's world comes along (O-6)", async () => {
    const made = await guestStart();
    const { rig } = made;
    expect((await made.store.send([reorder(made.store)], "reorder")).kind).toBe("adopt");
    const seed = made.store.getView().snapshot!.state.seed;
    const guestToken = made.tokens.get()!;
    const from = rig.fetch.calls.length;
    const page2 = await redirect(made, "alice");
    const [claim] = worldCalls(rig, from);
    expect(claim).toMatchObject({ method: "POST", url: "/api/auth/claim", body: { guestToken } });
    expect(claim!.headers.authorization).toBeUndefined();
    expect(claim!.headers["x-test-user"]).toBe("u:alice");
    const view = page2.store.getView();
    expect(view.snapshot!.stateVersion).toBe(1);
    expect(view.snapshot!.state.seed).toEqual(seed);
    expect(view.identity).toBe("session");
    expect(view.account).toEqual({ provider: "discord", email: "alice@discord.test" });
    expect(view.auth).toBe("idle");
    expect(page2.tokens.get()).toBeNull();
    expect(page2.done()).toBe(1);
    expect(view.notices).toContainEqual({
      kind: "signed-in",
      text: "Signed in with Discord as alice@discord.test.",
    });
    expect(page2.accountLabel.get()).toBe(
      JSON.stringify({ provider: "discord", email: "alice@discord.test" }),
    );
  });

  it("7. the hold on return: nothing world-shaped before finishSignIn answers, then the claim", async () => {
    const { gate, open } = gated();
    const made = await guestStart();
    const { rig } = made;
    const from = rig.fetch.calls.length;
    const page2 = await redirect(made, "h", { finishGate: gate });
    rig.clock.settleWith = null; // idle() would wait on the gate
    await until(() => page2.client.calls.includes("finishSignIn discord"));
    await rig.advance(PAST_BOUNDARY_MS);
    page2.store.onFocus();
    page2.store.onOnline();
    for (let i = 0; i < 20; i++) await turn();
    expect(worldCalls(rig, from)).toEqual([]);
    expect(page2.store.getView().auth).toBe("held");
    expect(page2.done()).toBe(0);
    open();
    await page2.started;
    await page2.store.idle();
    await rig.advance(PAST_BOUNDARY_MS);
    await page2.store.idle();
    const after = worldCalls(rig, from).map((c) => `${c.method} ${c.url}`);
    expect(after.slice(0, 2)).toEqual(["POST /api/auth/claim", "GET /api/world"]);
    expect(page2.done()).toBe(1);
  });

  it("8. a callback under a live session (a reload after success): ignored, no notice", async () => {
    const page2 = await redirect(await guestStart(), "r8");
    const { rig } = page2;
    page2.store.stop();
    // The same callback URL again, as a reload would bring it.
    let done = 0;
    const search = `?code=r8&state=${page2.tab.consumed!}`;
    const from = rig.fetch.calls.length;
    const page3 = storeOn(rig, {
      tokens: page2.tokens,
      parked: page2.parked,
      accountLabel: page2.accountLabel,
      tab: page2.tab,
      callback: { provider: "discord", search, done: () => void done++ },
    });
    await page3.store.start();
    await page3.store.idle();
    expect(page3.client.calls).not.toContain("finishSignIn discord");
    expect(done).toBe(1);
    expect(kinds(page3.store)).not.toContain("signed-in");
    expect(kinds(page3.store)).not.toContain("sign-in-failed");
    expect(worldCalls(rig, from)[0]).toMatchObject({ method: "GET", url: "/api/world" });
    expect(page3.store.getView().identity).toBe("session");

    // With a guest token present the existing boot claim runs (W-16 erratum).
    const { guestToken } = await guestWorld(rig);
    const tokens = memoryTokenStorage();
    tokens.set(guestToken);
    let done4 = 0;
    const at = rig.fetch.calls.length;
    const page4 = storeOn(rig, {
      tokens,
      tab: page2.tab,
      callback: { provider: "discord", search, done: () => void done4++ },
    });
    await page4.store.start();
    await page4.store.idle();
    expect(page4.client.calls).not.toContain("finishSignIn discord");
    expect(done4).toBe(1);
    expect(worldCalls(rig, at)[0]).toMatchObject({
      method: "POST",
      url: "/api/auth/claim",
      body: { guestToken },
    });
  });

  describe("9. a failed callback: the notice, and the same guest resumes", () => {
    const cases: [keyof typeof FAILED, RedirectOpts][] = [
      ["denied", { search: (state) => `?error=access_denied&state=${state}` }],
      ["stale", { tab: { state: null, consumed: null } }],
      ["no-email", { search: (state) => `?code=no-email&state=${state}` }],
      ["unavailable", { search: (state) => `?code=throw&state=${state}` }],
    ];
    for (const [kind, opts] of cases) {
      it(kind, async () => {
        const made = await guestStart();
        const { rig } = made;
        const guestToken = made.tokens.get()!;
        const from = rig.fetch.calls.length;
        const page2 = await redirect(made, "unused", opts);
        const view = page2.store.getView();
        expect(view.notices).toContainEqual({ kind: "sign-in-failed", text: FAILED[kind] });
        expect(view.identity).toBe("guest");
        expect(view.auth).toBe("idle");
        expect(page2.done()).toBe(1);
        expect(page2.tokens.get()).toBe(guestToken);
        const [next] = worldCalls(rig, from);
        expect(next).toMatchObject({ method: "GET", url: "/api/world" });
        expect(next!.headers.authorization).toBe(`Guest ${guestToken}`);
        expect(rig.session.user).toBeNull();
      });
    }

    it("with a parked token and no session, the parked guest resumes, never a new one", async () => {
      const rig = await newRig();
      const { guestToken } = await guestWorld(rig);
      const parked = memoryTokenStorage();
      parked.set(guestToken);
      const from = rig.fetch.calls.length;
      const { store, tokens } = storeOn(rig, {
        tokens: memoryTokenStorage(),
        parked,
        tab: { state: { provider: "discord", state: "s1" }, consumed: null },
        callback: { provider: "discord", search: "?error=access_denied&state=s1", done: () => {} },
      });
      await store.start();
      await store.idle();
      expect(tokens.get()).toBe(guestToken);
      expect(worldCalls(rig, from).some((c) => c.url === "/api/guests")).toBe(false);
      expect(worldCalls(rig, from)[0]!.headers.authorization).toBe(`Guest ${guestToken}`);
    });

    it("with no guest token, the next call makes one", async () => {
      const rig = await newRig();
      let done = 0;
      const { store } = storeOn(rig, {
        tab: { state: { provider: "discord", state: "s1" }, consumed: null },
        callback: {
          provider: "discord",
          search: "?error=access_denied&state=s1",
          done: () => void done++,
        },
      });
      await store.start();
      await store.idle();
      expect(done).toBe(1);
      expect(store.getView().notices).toContainEqual({
        kind: "sign-in-failed",
        text: FAILED.denied,
      });
      expect(worldCalls(rig)[0]).toMatchObject({ method: "POST", url: "/api/guests" });
      expect(store.getView().identity).toBe("guest");
    });
  });

  it("10. an unknown provider, or accounts off: the notice, done, and a normal guest boot", async () => {
    for (const [sessions, provider, kind] of [
      [true, "gitlab", "unknown-provider"],
      [false, "discord", "unavailable"],
    ] as const) {
      const rig = await newRig(sessions);
      let done = 0;
      const { store, client } = storeOn(rig, {
        tab: { state: { provider, state: "s1" }, consumed: null },
        callback: { provider, search: "?code=x&state=s1", done: () => void done++ },
      });
      await store.start();
      await store.idle();
      expect(done).toBe(1);
      expect(client.calls).not.toContain(`finishSignIn ${provider}`);
      expect(store.getView().notices).toContainEqual({
        kind: "sign-in-failed",
        text: FAILED[kind],
      });
      expect(store.getView().identity).toBe("guest");
      expect(worldCalls(rig)[0]).toMatchObject({ method: "POST", url: "/api/guests" });
      expect(store.getView().status).toBe("ready");
    }
  });

  it("11. stop() and start() mid-callback: nothing while stopped, then one claim", async () => {
    const { gate, open } = gated();
    const made = await guestStart();
    const { rig } = made;
    const from = rig.fetch.calls.length;
    const page2 = await redirect(made, "t", { finishGate: gate });
    rig.clock.settleWith = null;
    await until(() => page2.client.calls.includes("finishSignIn discord"));
    page2.store.stop();
    open();
    await page2.started;
    for (let i = 0; i < 20; i++) await turn();
    expect(worldCalls(rig, from)).toEqual([]);
    expect(page2.done()).toBe(1);
    await page2.store.start();
    await page2.store.idle();
    const claims = worldCalls(rig, from).filter((c) => c.url === "/api/auth/claim");
    expect(claims).toHaveLength(1);
    expect(worldCalls(rig, from)[0]!.url).toBe("/api/auth/claim");
    expect(page2.store.getView().identity).toBe("session");
    expect(page2.store.getView().auth).toBe("idle");
  });

  it("12. the label on reload: read at a session boot, junk is blank, sign-out clears it", async () => {
    const rig = await newRig();
    rig.session.user = "u:b";
    const label = memoryTokenStorage();
    label.set('{"provider":"github","email":"b@x"}');
    const { store } = storeOn(rig, { accountLabel: label });
    await store.start();
    await store.idle();
    expect(store.getView().account).toEqual({ provider: "github", email: "b@x" });
    expect(await store.signOut()).toBe(true);
    await store.idle();
    expect(label.get()).toBeNull();

    rig.session.user = "u:b";
    const junk = memoryTokenStorage();
    junk.set("{not json");
    const other = storeOn(rig, { accountLabel: junk });
    await other.store.start();
    await other.store.idle();
    expect(other.store.getView().account).toEqual({ provider: null, email: null });
  });

  it("13. health's providers (O-3): only well-formed ids, and a missing field is []", async () => {
    for (const [providers, want] of [
      [
        ["discord", "../evil", 5, "GitHub", "github", "discord"],
        ["discord", "github"],
      ],
      [undefined, []],
    ] as const) {
      const rig = await newRig();
      const fetch: FetchLike = async (url, init) => {
        const res = await rig.fetch(url, init);
        if (url !== "/api/health") return res;
        const body = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...body, providers });
      };
      const { store } = storeOn(rig, { fetch });
      await store.start();
      await store.idle();
      expect(store.getView().providers).toEqual(want);
    }
  });
});
