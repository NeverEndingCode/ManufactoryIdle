// Accounts in the store (W-14 to W-16, S-3 to S-7): the real buildServer on PGlite with the
// API's header-based test verifier (x-test-user, the simulated cookie) and rigAccounts in
// place of the SDK. Every test makes its own rig; every wait is on store state (P-9).
import { afterEach, describe, expect, it } from "vitest";
import type { Action } from "@manufactory/engine";
import type { AccountClient } from "../auth/accounts.js";
import { MIN_REPOLL_MS, PARKED_GUEST_TOKEN_KEY } from "./constants.js";
import { browserTokenStorage, memoryTokenStorage, type TokenStorage } from "./identity.js";
import { GameStore } from "./store.js";
import { guestWorld, makeRig, rigAccounts, type TestRig } from "./test-rig.js";
import type { FetchLike } from "./wire.js";

const ACCOUNT_HAS_FACTORY =
  "This account already has a factory. Your guest factory is kept on this device: sign out to return to it.";
const SIGNED_OUT = "Signed out. Sign in to return to your saved factory.";
const SESSION_ENDED = "Your session ended. Sign in to return to your saved factory.";
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
  client: AccountClient & { calls: string[] };
}

interface StoreOpts {
  tokens?: TokenStorage;
  parked?: TokenStorage;
  gate?: Promise<void>;
  signOutFails?: boolean;
  /** Wraps rig.fetch, to fake a response the server wouldn't give. */
  fetch?: FetchLike;
}

function storeOn(rig: TestRig, opts: StoreOpts = {}): Made {
  const tokens = opts.tokens ?? memoryTokenStorage();
  const parked = opts.parked ?? memoryTokenStorage();
  const client = rigAccounts(rig, {
    ...(opts.gate ? { gate: opts.gate } : {}),
    ...(opts.signOutFails ? { signOutFails: true } : {}),
  });
  const store = new GameStore({
    fetch: opts.fetch ?? rig.fetch,
    clock: rig.clock,
    tokens,
    parked,
    accounts: client,
  });
  stores.push(store);
  rig.clock.settleWith = async () => {
    for (const s of stores) await s.idle();
  };
  return { store, tokens, parked, client };
}

/** A started guest store on a sessions rig, optionally with a gated rigAccounts. */
async function guestStart(gate?: Promise<void>, opts: Omit<StoreOpts, "gate"> = {}) {
  const rig = await newRig();
  const made = storeOn(rig, { ...opts, ...(gate ? { gate } : {}) });
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

describe("GameStore accounts (W-14 to W-16)", () => {
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
    expect(view.account).toEqual({ email: null });
    expect(tokens.get()).toBeNull();
    const players = await rig.db.query<{ n: string }>("select count(*)::text as n from players");
    expect(players[0]!.n).toBe("1");
    expect(view.snapshot!.state.seed).toEqual((await accountWorld(rig, "u:s@x"))!.seed);
  });

  it("4. a session at boot with a guest token parks it, never claims (S-6)", async () => {
    const rig = await newRig();
    const { guestToken } = await guestWorld(rig);
    const tokens = memoryTokenStorage();
    tokens.set(guestToken);
    rig.session.user = "u:b@x";
    const { store, parked } = storeOn(rig, { tokens });
    await store.start();
    await store.idle();
    expect(rig.fetch.calls.some((c) => c.url === "/api/auth/claim")).toBe(false);
    expect(parked.get()).toBe(guestToken);
    expect(tokens.get()).toBeNull();
    expect(store.getView().identity).toBe("session");
    expect(store.getView().notices).toContainEqual({
      kind: "account-has-factory",
      text: ACCOUNT_HAS_FACTORY,
    });
    for (const g of getsSince(rig, 2)) expect(g.headers.authorization).toBeUndefined();
  });

  it("5. sign-up claims before any session read (W-16, S-5 200)", async () => {
    const { rig, store, tokens, parked } = await guestStart();
    expect((await store.send([reorder(store)], "reorder")).kind).toBe("adopt");
    expect(store.getView().snapshot!.stateVersion).toBe(1);
    const seed = store.getView().snapshot!.state.seed;
    const guestToken = tokens.get()!;
    const from = rig.fetch.calls.length;

    expect(await store.signUp("a@x", "hunter2hunter2")).toEqual({ ok: true, email: "a@x" });
    await store.idle();
    const [claim] = worldCalls(rig, from);
    expect(claim).toMatchObject({ method: "POST", url: "/api/auth/claim", body: { guestToken } });
    expect(claim!.headers.authorization).toBeUndefined();
    expect(tokens.get()).toBeNull();
    expect(parked.get()).toBeNull();
    const view = store.getView();
    expect(view.snapshot!.stateVersion).toBe(1);
    expect(view.snapshot!.state.seed).toEqual(seed);
    expect(view.identity).toBe("session");
    expect(view.account).toEqual({ email: "a@x" });
    expect(view.auth).toBe("idle");

    const before = rig.fetch.calls.length;
    await rig.advance(MIN_REPOLL_MS);
    store.onFocus();
    await store.idle();
    const [get] = getsSince(rig, before);
    expect(get!.headers["x-test-user"]).toBe("u:a@x");
    expect(get!.headers.authorization).toBeUndefined();
  });

  it("6. the hold: nothing reaches the world until the claim, then the held batches (S-4)", async () => {
    const { gate, open } = gated();
    const { rig, store, tokens } = await guestStart(gate);
    const from = rig.fetch.calls.length;

    const signing = store.signUp("h@x", "hunter2hunter2");
    expect(store.getView().auth).toBe("held");
    await rig.advance(PAST_BOUNDARY_MS);
    store.onFocus();
    const sent = store.send([reorder(store)], "reorder");
    for (let i = 0; i < 3; i++) {
      store.pressTap();
      store.releaseTap();
    }
    await rig.advance(2_000);
    expect(worldCalls(rig, from)).toEqual([]);
    expect(store.getView().auth).toBe("held");
    const held = store.getView().pending.map((b) => ({ key: b.key, label: b.label }));
    expect(held.map((b) => b.label)).toEqual(["reorder", "tap"]);
    expect(tokens.get()).not.toBeNull();

    open();
    expect((await signing).ok).toBe(true);
    await store.idle();
    expect((await sent).kind).toBe("adopt");
    const after = worldCalls(rig, from);
    expect(after[0]!.url).toBe("/api/auth/claim");
    const posts = after.slice(1, 3);
    expect(posts.map((c) => c.url)).toEqual(["/api/actions", "/api/actions"]);
    expect(posts.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey)).toEqual(
      held.map((b) => b.key),
    );
    const player = await accountWorld(rig, "u:h@x");
    expect(await logRows(rig, player!.id)).toEqual(held.map((b) => b.key));
  });

  /** Test 7's setup: u:a@x already has a world; a guest with a held batch signs in. */
  async function conflicted() {
    const { gate, open } = gated();
    const made = await guestStart(gate);
    const { rig, store, tokens } = made;
    rig.session.user = "u:a@x";
    expect((await rig.fetch("/api/world")).status).toBe(200);
    rig.session.user = null;
    const account = (await accountWorld(rig, "u:a@x"))!;
    const guestToken = tokens.get()!;
    const guestSeed = store.getView().snapshot!.state.seed;
    const from = rig.fetch.calls.length;
    const signing = store.signIn("a@x", "hunter2hunter2");
    const sent = store.send([reorder(store)], "reorder");
    open();
    expect(await signing).toEqual({ ok: true, email: "a@x" });
    await store.idle();
    return { ...made, account, guestToken, guestSeed, from, sent };
  }

  it("7. a 409 parks the guest token and drops the held batch (S-5, S-6)", async () => {
    const { rig, store, tokens, parked, account, guestToken, from, sent } = await conflicted();
    const claim = worldCalls(rig, from)[0]!;
    expect(claim.url).toBe("/api/auth/claim");
    expect(parked.get()).toBe(guestToken);
    expect(tokens.get()).toBeNull();
    expect(store.getView().snapshot!.state.seed).toEqual(account.seed);
    expect((await sent).kind).toBe("unauthorized");
    expect(await logRows(rig, account.id)).toEqual([]);
    expect(store.getView().notices).toContainEqual({
      kind: "account-has-factory",
      text: ACCOUNT_HAS_FACTORY,
    });
    expect(store.getView().identity).toBe("session");
  });

  it("8. a 404 drops the token and loads the account's world (S-5)", async () => {
    const { rig, store, tokens, parked } = await guestStart();
    await rig.db.query("delete from players where guest_token is not null");
    const from = rig.fetch.calls.length;
    expect((await store.signUp("n@x", "hunter2hunter2")).ok).toBe(true);
    await store.idle();
    expect(worldCalls(rig, from)[0]!.url).toBe("/api/auth/claim");
    expect(tokens.get()).toBeNull();
    expect(parked.get()).toBeNull();
    const account = await accountWorld(rig, "u:n@x");
    expect(account).not.toBeNull();
    expect(store.getView().snapshot!.state.seed).toEqual(account!.seed);
    expect(getsSince(rig, from)[0]!.headers["x-test-user"]).toBe("u:n@x");
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
  });

  it("9b. sign-out with nothing parked makes one new guest (S-7)", async () => {
    const { rig, store, tokens } = await guestStart();
    expect((await store.signUp("c@x", "hunter2hunter2")).ok).toBe(true);
    await store.idle();
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
    tokens.set(guestToken);
    rig.session.user = "u:l@x";
    const { store, parked } = storeOn(rig, { tokens });
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

  it("11. a failed sign-in releases the hold", async () => {
    const { rig, store, tokens } = await guestStart();
    expect(await store.signIn("a@x", "wrong")).toEqual({ ok: false, kind: "wrong-credentials" });
    expect(store.getView().auth).toBe("idle");
    expect(store.getView().identity).toBe("guest");
    const from = rig.fetch.calls.length;
    await rig.advance(PAST_BOUNDARY_MS);
    await store.idle();
    const gets = getsSince(rig, from);
    expect(gets).toHaveLength(1);
    expect(gets[0]!.headers.authorization).toBe(`Guest ${tokens.get()}`);
  });

  it("12. a lost claim response retries the same claim after 1 s, still held", async () => {
    const { rig, store, tokens, parked } = await guestStart();
    const from = rig.fetch.calls.length;
    rig.fetch.dropNextResponse = true;
    expect((await store.signUp("r@x", "hunter2hunter2")).ok).toBe(true);
    await store.idle();
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

describe("GameStore accounts: never lose a guest token (fix round 1)", () => {
  it("B. an occupied park is never overwritten, and sign-out never overwrites a token", async () => {
    const rig = await newRig();
    const g0 = await guestWorld(rig);
    const g1 = await guestWorld(rig);
    const tokens = memoryTokenStorage();
    const parked = memoryTokenStorage();
    tokens.set(g1.guestToken);
    parked.set(g0.guestToken);
    rig.session.user = "u:o@x";
    const { store } = storeOn(rig, { tokens, parked });
    await store.start();
    await store.idle();
    expect(store.getView().identity).toBe("session");
    expect(tokens.get()).toBe(g1.guestToken);
    expect(parked.get()).toBe(g0.guestToken);
    for (const g of getsSince(rig, 4)) expect(g.headers.authorization).toBeUndefined();

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
    const { gate, open } = gated();
    const ls = stubStorage(PARKED_GUEST_TOKEN_KEY);
    const tokens = browserTokenStorage(ls);
    const parked = browserTokenStorage(ls, PARKED_GUEST_TOKEN_KEY);
    const { rig, store } = await guestStart(gate, { tokens, parked });
    rig.session.user = "u:a@x";
    expect((await rig.fetch("/api/world")).status).toBe(200);
    rig.session.user = null;
    const guestToken = tokens.get()!;
    const signing = store.signIn("a@x", "hunter2hunter2");
    open();
    expect((await signing).ok).toBe(true);
    await store.idle();
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
    let fakes = 0;
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      if (url === "/api/auth/claim" && fakes++ === 0) {
        return new Response('{"error":"not found"}', { status: 404 });
      }
      return holder.rig!.fetch(url, init);
    };
    const rig = await newRig();
    holder.rig = rig;
    const { store, tokens, parked } = storeOn(rig, { fetch });
    await store.start();
    await store.idle();
    const guestToken = tokens.get()!;
    expect((await store.signUp("p@x", "hunter2hunter2")).ok).toBe(true);
    await store.idle();
    expect(parked.get()).toBe(guestToken);
    expect(tokens.get()).toBeNull();
    expect(store.getView().notices.map((n) => n.kind)).toContain("client-bug");
    expect(store.getView().identity).toBe("session");
    expect(store.getView().snapshot!.state.seed).toEqual((await accountWorld(rig, "u:p@x"))!.seed);
  });

  it("D. a guest-creation retry that falls due mid-sign-in sends nothing", async () => {
    let guestAttempts = 0;
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      if (url === "/api/guests" && guestAttempts++ === 0) throw new TypeError("network");
      return holder.rig!.fetch(url, init);
    };
    const { gate, open } = gated();
    const rig = await newRig();
    holder.rig = rig;
    const { store, tokens } = storeOn(rig, { fetch, gate });
    await store.start();
    await store.idle();
    expect(guestAttempts).toBe(1);
    expect(store.getView().identity).toBe("guest");
    const signing = store.signUp("g@x", "hunter2hunter2");
    await rig.advance(10_000);
    expect(guestAttempts).toBe(1);
    open();
    expect((await signing).ok).toBe(true);
    await store.idle();
    await rig.advance(10_000);
    expect(guestAttempts).toBe(1);
    expect(tokens.get()).toBeNull();
    expect(rig.fetch.calls.some((c) => c.url === "/api/auth/claim")).toBe(false);
    expect(store.getView().identity).toBe("session");
    expect(store.getView().snapshot!.state.seed).toEqual((await accountWorld(rig, "u:g@x"))!.seed);
  });

  it("D. a keepalive response that lands after a reset is ignored (the epoch)", async () => {
    const { rig, store } = await guestStart();
    rig.session.user = "u:k@x";
    expect((await rig.fetch("/api/world")).status).toBe(200);
    rig.session.user = null;
    const account = (await accountWorld(rig, "u:k@x"))!;
    await rig.advance(60_000);
    store.pressTap();
    store.releaseTap();
    const release = rig.fetch.hold("POST", "/api/actions");
    store.flushTaps({ keepalive: true });
    await until(() => rig.fetch.calls.some((c) => c.url === "/api/actions"));
    rig.clock.settleWith = null;

    expect((await store.signIn("k@x", "hunter2hunter2")).ok).toBe(true);
    await until(() => {
      const seed = store.getView().snapshot?.state.seed;
      return seed !== undefined && JSON.stringify(seed) === JSON.stringify(account.seed);
    });
    expect(store.getView().snapshot!.stateVersion).toBe(0);
    release();
    await store.idle();
    // The guest world's v1 (the tap) is not adopted over the account's v0.
    expect(store.getView().snapshot!.state.seed).toEqual(account.seed);
    expect(store.getView().snapshot!.stateVersion).toBe(0);
    expect(store.getView().identity).toBe("session");
  });

  it("E. a dead parked token restored at sign-out quietly becomes a new guest", async () => {
    const rig = await newRig();
    const dead = "D".repeat(43);
    const tokens = memoryTokenStorage();
    tokens.set(dead);
    rig.session.user = "u:d@x";
    const { store, parked } = storeOn(rig, { tokens });
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
    let fakes = 0;
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      if (url === "/api/auth/claim" && fakes++ === 0) {
        return new Response('{"error":"x"}', { status: 503, headers: { "retry-after": "1" } });
      }
      return holder.rig!.fetch(url, init);
    };
    const rig = await newRig();
    holder.rig = rig;
    const { store, tokens } = storeOn(rig, { fetch });
    await store.start();
    await store.idle();
    const from = rig.fetch.calls.length;
    expect((await store.signUp("q@x", "hunter2hunter2")).ok).toBe(true);
    await store.idle();
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

  it("F. a 401 claim releases: the held batch goes out as the guest, with client-bug", async () => {
    const { gate, open } = gated();
    const holder: { rig?: TestRig } = {};
    const fetch: FetchLike = async (url, init) => {
      // The cookie didn't stick.
      if (url === "/api/auth/claim") holder.rig!.session.user = null;
      return holder.rig!.fetch(url, init);
    };
    const rig = await newRig();
    holder.rig = rig;
    const { store, tokens } = storeOn(rig, { fetch, gate });
    await store.start();
    await store.idle();
    const guestToken = tokens.get()!;
    const from = rig.fetch.calls.length;
    const signing = store.signUp("z@x", "hunter2hunter2");
    const sent = store.send([reorder(store)], "reorder");
    open();
    expect((await signing).ok).toBe(true);
    await store.idle();
    expect((await sent).kind).toBe("adopt");
    const after = worldCalls(rig, from);
    expect(after[0]!.url).toBe("/api/auth/claim");
    const post = after.find((c) => c.url === "/api/actions")!;
    expect(post.headers.authorization).toBe(`Guest ${guestToken}`);
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
    const { rig, store, tokens } = await guestStart(gate);
    const from = rig.fetch.calls.length;
    const signing = store.signUp("s@x", "hunter2hunter2");
    const sent = store.send([reorder(store)], "reorder");
    store.stop();
    open();
    expect((await signing).ok).toBe(true);
    await store.idle();
    expect(worldCalls(rig, from)).toEqual([]);
    expect(rig.clock.pendingTimers).toBe(0);
    await store.start();
    await store.idle();
    expect((await sent).kind).toBe("adopt");
    expect(worldCalls(rig, from).map((c) => c.url)).toEqual(["/api/auth/claim", "/api/actions"]);
    expect(tokens.get()).toBeNull();
    expect(store.getView().identity).toBe("session");
  });

  it("F. stop() and start() mid-claim: the repeat claim is idempotent", async () => {
    const { rig, store, tokens, parked } = await guestStart();
    const seed = store.getView().snapshot!.state.seed;
    rig.fetch.dropNextResponse = true;
    expect((await store.signUp("m@x", "hunter2hunter2")).ok).toBe(true);
    await store.idle();
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
