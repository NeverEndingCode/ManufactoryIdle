// The GameStore against the real API (W-22): buildServer on PGlite through an inject()-backed
// fetch, with the server's clock following the client's FakeClientClock (P-8). Every wait is
// on store state (idle()), never a sleep (P-9).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { deserializeWorld, serializeWorld, type Action } from "@manufactory/engine";
import { dockModel } from "../ui/dock-model.js";
import { MIN_REPOLL_MS, RETRY_STEPS_MS } from "./constants.js";
import { browserTokenStorage, memoryTokenStorage, type TokenStorage } from "./identity.js";
import { isPlateaued } from "./interpolate.js";
import { GameStore } from "./store.js";
import { makeRig, type TestRig } from "./test-rig.js";
import type { ActionsRequest, FetchLike } from "./wire.js";

const FIXTURES = new URL("../../../../packages/engine/src/resolve/fixtures/", import.meta.url);

/** P-3's advised buy on a fresh slice world; affordable about 43 s after creation. */
const BUY_CONSTRUCTOR: Action = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
};
const BUY_TOO_MANY: Action = { ...BUY_CONSTRUCTOR, count: 1000 };

const OFFLINE_CAP_MS = 28_800_000; // the slice's offlineCapMs, 8 h
const HOUR = 3_600_000;

interface Logged {
  method: string;
  url: string;
  at: number;
  body?: ActionsRequest;
  keepalive?: boolean;
}

/** The current test's rig, for the helpers and afterEach. Test bodies use the rig that
 * setup() or freshRig() returned, never this: a body that outlives its test (a timeout) would
 * otherwise drive the next test's clock and database. */
let live: TestRig;
let stores: GameStore[] = [];
let log: Logged[] = [];
/** When set, the next GET /api/world answers 429 with this Retry-After, without the server. */
let fakeGet429: string | null = null;
/** The next n GET /api/world reach the server, then throw TypeError("network"). */
let dropGets = 0;
/** The next n GET /api/world bodies have a state makeSnapshot can't read. */
let corruptGets = 0;
/** Every GET /api/content/* answers 404. */
let failContent = false;
/** When set, GET /api/world reports `to` as its checksum, and /api/content/<to> serves the
 * bundle stored under `from`: a re-pin, as the client sees it. */
let repin: { from: string; to: string } | null = null;
/** When set, the next GET /api/world answers this status with {"error":"x"}, without the server. */
let fakeGetStatus: number | null = null;
/** While set, a POST /api/actions with a non-TAP action reaches the server, then its Response
 * waits for this gate. Unlike rig.fetch.hold it never matches a TAP flush, whichever lands first. */
let gateSpends: Promise<void> | null = null;
/** While set, a GET /api/content/* waits for this gate, after calling `contentEntered`. */
let gateContent: { gate: Promise<void>; entered: () => void } | null = null;

function resetKnobs() {
  log = [];
  fakeGet429 = null;
  dropGets = 0;
  corruptGets = 0;
  failContent = false;
  repin = null;
  fakeGetStatus = null;
  gateSpends = null;
  gateContent = null;
}

afterEach(async () => {
  for (const s of stores) s.stop();
  stores = [];
  await live.close();
});

function storeFor(tokens: TokenStorage): GameStore {
  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const entry: Logged = { method, url, at: live.clock.now(), keepalive: init?.keepalive };
    if (typeof init?.body === "string") entry.body = JSON.parse(init.body) as ActionsRequest;
    log.push(entry);
    if (method === "GET" && url === "/api/world" && fakeGetStatus !== null) {
      const status = fakeGetStatus;
      fakeGetStatus = null;
      return new Response('{"error":"x"}', { status });
    }
    if (method === "POST" && url === "/api/actions" && gateSpends !== null) {
      const gate = gateSpends;
      if (entry.body!.actions.some((a) => a.type !== "TAP")) {
        const res = await live.fetch(url, init);
        await gate;
        return res;
      }
    }
    if (method === "GET" && url === "/api/world" && fakeGet429 !== null) {
      const retryAfter = fakeGet429;
      fakeGet429 = null;
      return new Response('{"error":"rate-limited"}', {
        status: 429,
        headers: { "retry-after": retryAfter },
      });
    }
    if (url.startsWith("/api/content/")) {
      if (gateContent !== null) {
        const { gate, entered } = gateContent;
        gateContent = null;
        entered();
        await gate;
      }
      if (failContent) return new Response('{"error":"unknown content"}', { status: 404 });
      if (repin !== null && url === `/api/content/${repin.to}`) {
        return live.fetch(`/api/content/${repin.from}`, init);
      }
    }
    if (method === "POST" && url === "/api/actions" && repin !== null) {
      const res = await live.fetch(url, init);
      const body = (await res.json()) as Record<string, unknown>;
      body.contentChecksum = repin.to;
      return new Response(JSON.stringify(body), { status: res.status });
    }
    if (method === "GET" && url === "/api/world") {
      if (dropGets > 0) {
        dropGets -= 1;
        await live.fetch(url, init);
        throw new TypeError("network");
      }
      if (corruptGets > 0 || repin !== null) {
        const res = await live.fetch(url, init);
        const body = (await res.json()) as Record<string, unknown>;
        if (corruptGets > 0) {
          corruptGets -= 1;
          body.state = "junk";
        }
        if (repin !== null) body.contentChecksum = repin.to;
        return new Response(JSON.stringify(body), { status: res.status });
      }
    }
    return live.fetch(url, init);
  };
  const store = new GameStore({ fetch, clock: live.clock, tokens });
  stores.push(store);
  live.clock.settleWith = async () => {
    for (const s of stores) await s.idle();
  };
  return store;
}

/** A new rig, with the knobs reset, that afterEach closes. */
async function freshRig(opts: Parameters<typeof makeRig>[0] = {}): Promise<TestRig> {
  live = await makeRig(opts);
  resetKnobs();
  return live;
}

async function setup(opts: Parameters<typeof makeRig>[0] = {}) {
  const rig = await freshRig(opts);
  const tokens = memoryTokenStorage();
  const store = storeFor(tokens);
  await store.start();
  await store.idle();
  return { store, tokens, rig };
}

const gets = () => log.filter((c) => c.method === "GET" && c.url === "/api/world");
const posts = () => log.filter((c) => c.method === "POST" && c.url === "/api/actions");
const version = (s: GameStore) => s.getView().snapshot!.stateVersion;

/** The reinforced-full fixture (tier 8, on the EPSILON cycle) into the guest's row, rebased to
 * the server's clock, then one GET to adopt it. */
async function loadEpsilonFixture(rig: TestRig, store: GameStore) {
  const state = deserializeWorld(
    readFileSync(new URL("slice-tier-8-reinforced-full.world.json", FIXTURES), "utf8"),
  );
  const delta = rig.serverNow() - state.lastResolvedAt;
  const rebased = {
    ...state,
    lastResolvedAt: state.lastResolvedAt + delta,
    timers: state.timers.map((t) => ({ ...t, fireAt: t.fireAt + delta })),
  };
  await rig.db.query(
    "update player_worlds set state = $1::jsonb, last_resolved_at = to_timestamp($2 / 1000.0)",
    [serializeWorld(rebased), rebased.lastResolvedAt],
  );
  await rig.advance(MIN_REPOLL_MS);
  store.onFocus();
  await store.idle();
  expect(store.getView().snapshot!.state.tier).toBe(8);
}

/** The gaps between the GETs from index `from` on. */
function gapsSince(from: number): number[] {
  const at = gets()
    .slice(from)
    .map((g) => g.at);
  return at.slice(1).map((t, i) => t - at[i]!);
}

async function dbRow() {
  const [w] = await live.db.query<{ state_version: string }>(
    "select state_version::text from player_worlds",
  );
  const [l] = await live.db.query<{ n: string }>("select count(*)::text as n from action_log");
  return { stateVersion: Number(w!.state_version), logRows: Number(l!.n) };
}

describe("GameStore (W-6, W-9 to W-11, W-14)", () => {
  it("1. guest start: health, guests, then content; a second store reuses the token", async () => {
    const { store, tokens } = await setup();
    const calls = log.map((c) => `${c.method} ${c.url.replace(/[0-9a-f]{64}$/, "<sum>")}`);
    expect([...calls].sort()).toEqual(
      ["GET /api/content/<sum>", "GET /api/health", "POST /api/guests"].sort(),
    );
    const content = calls.indexOf("GET /api/content/<sum>");
    expect(calls.indexOf("GET /api/health")).toBeLessThan(content);
    expect(calls.indexOf("POST /api/guests")).toBeLessThan(content);
    expect(tokens.get()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const view = store.getView();
    expect(view.status).toBe("ready");
    expect(view.snapshot!.stateVersion).toBe(0);
    expect(store.getView()).toBe(view); // referentially stable between changes
    expect(view.notices.map((n) => n.kind)).toEqual(["ephemeral-token"]);

    log = [];
    const second = storeFor(tokens);
    await second.start();
    await second.idle();
    expect(log.some((c) => c.url === "/api/guests")).toBe(false);
    expect(gets()).toHaveLength(1);
    expect(second.getView().snapshot!.state.seed).toEqual(view.snapshot!.state.seed);
  });

  it("2a. refetches at the boundary + 250 ms, not before", async () => {
    const { store, rig } = await setup();
    const s = store.getView().snapshot!;
    expect(s.schedule.nextBoundaryAtMs! - s.schedule.atMs).toBe(4_000_000);
    await rig.advance(3_999_000);
    await store.idle();
    expect(gets()).toHaveLength(0);
    await rig.advance(1_300);
    await store.idle();
    expect(gets()).toHaveLength(1);
    expect(gets()[0]!.at).toBe(s.receivedAt + 4_000_250);
  });

  it("2b. a null boundary costs zero requests, apart from the plateau guard", async () => {
    const { store, rig } = await setup();
    store.setVisible(false);
    await rig.advance(4 * HOUR);
    store.setVisible(true);
    await store.idle();
    expect(gets()).toHaveLength(1);
    const s = store.getView().snapshot!;
    expect(s.schedule.nextBoundaryAtMs).toBeNull();
    await rig.advance(3 * HOUR);
    await store.idle();
    expect(gets()).toHaveLength(1);
    await rig.advance(s.persistedAtMs! + OFFLINE_CAP_MS + 250 - rig.serverNow());
    await store.idle();
    expect(gets()).toHaveLength(2); // W-9's guard
    await rig.advance(HOUR);
    await store.idle();
    expect(gets()).toHaveLength(2);
  });

  it("3. a GET that lands after a POST is not adopted", async () => {
    const { store, rig } = await setup();
    await rig.advance(10 * 60_000);
    const release = rig.fetch.hold("GET", "/api/world");
    store.onFocus();
    expect(gets()).toHaveLength(1);
    const outcome = await store.send([BUY_CONSTRUCTOR], "buy");
    expect(outcome.kind).toBe("adopt");
    expect(version(store)).toBe(1);
    release();
    await store.idle();
    expect(version(store)).toBe(1);
  });

  // Two tests, not one, each with a 60 s budget: every GET here re-resolves the tier-8
  // fixture through the EPSILON cycle from its persisted point (real engine work, about 0.6 s
  // on a fast machine and four times that on a loaded CI runner). One test making all twelve
  // GETs took 32 s in CI and timed out at 30 s.
  it("4a. backs off on the EPSILON cycle, 5 s doubling to 40 s", async () => {
    const { store, rig } = await setup();
    await loadEpsilonFixture(rig, store);
    const first = gets().length - 1;
    for (let i = 0; i < 1_800; i++) await rig.advance(100);
    await store.idle();
    const gaps = gapsSince(first);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_REPOLL_MS);
    // Measured: one 34 s boundary, then five pin/unpin snapshots (boundary 0 ms ahead) before
    // an 88 s boundary ends the cycle. The streak's gaps double from the third: 5, 5, 10, 20,
    // 40 s. The cycle ends before a sixth short snapshot, so the 60 s cap (pinned in
    // refetch.test.ts) isn't reached here.
    expect(gaps.slice(1, 6)).toEqual([5_000, 5_000, 10_000, 20_000, 40_000]);
  }, 60_000);

  it("4b. an action resets the EPSILON-cycle backoff to 5 s", async () => {
    const { store, rig } = await setup();
    // Build the streak until a 10 s gap (the next would be 20 s), then act.
    await loadEpsilonFixture(rig, store);
    const first = gets().length - 1;
    while (!gapsSince(first).includes(10_000)) await rig.advance(100);
    const sentAt = rig.clock.now();
    const entries = store.getView().snapshot!.state.priority.map((e) => e.id);
    expect((await store.send([{ type: "REORDER_PRIORITY", entries }], "reorder")).kind).toBe(
      "adopt",
    );
    const before = gets().length;
    for (let i = 0; i < 60; i++) await rig.advance(100);
    await store.idle();
    expect(gets().length).toBe(before + 1);
    expect(gets()[before]!.at - sentAt).toBe(5_000);
  }, 60_000);

  it("5. a lost response is retried with the same key and replayed", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    rig.fetch.dropNextResponse = true;
    const sent = store.send([BUY_CONSTRUCTOR], "buy");
    await store.idle();
    expect(posts()).toHaveLength(1);
    expect(store.getView().status).toBe("ready");
    expect(store.getView().failures).toBe(1);
    await rig.advance(1_000);
    expect((await sent).kind).toBe("adopt");
    await store.idle();
    const [first, retry] = posts();
    expect(retry!.body!.idempotencyKey).toBe(first!.body!.idempotencyKey);
    expect(await dbRow()).toEqual({ stateVersion: 1, logRows: 1 });
    expect(version(store)).toBe(1);
    expect(store.getView().failures).toBe(0);

    // Two drops in a row (a GET this time) show "offline"; the next success clears it.
    await rig.advance(MIN_REPOLL_MS);
    rig.fetch.dropNextResponse = true;
    store.onFocus();
    await store.idle();
    expect(store.getView().status).toBe("ready");
    rig.fetch.dropNextResponse = true;
    await rig.advance(1_000);
    await store.idle();
    expect(store.getView().status).toBe("offline");
    expect(store.getView().failures).toBe(2);
    await rig.advance(2_000);
    await store.idle();
    expect(store.getView().status).toBe("ready");
    expect(gets()).toHaveLength(3);
  });

  it("6. a 429 pauses the outbox and polling, then the same key succeeds", async () => {
    const { store, tokens, rig } = await setup({
      limits: { player: { capacity: 2, refillPerSec: 0.5 } },
    });
    await rig.advance(10 * 60_000);
    const auth = { authorization: `Guest ${tokens.get()!}` };
    for (let i = 0; i < 2; i++) {
      expect((await rig.fetch("/api/world", { headers: auth })).status).toBe(200);
    }
    const sent = store.send([BUY_CONSTRUCTOR], "buy");
    await store.idle();
    expect(posts()).toHaveLength(1);
    const before = rig.fetch.calls.length;
    store.onFocus(); // the snapshot is 10 min old, but polling shares the pause
    await rig.advance(1_999);
    await store.idle();
    expect(rig.fetch.calls.length).toBe(before);
    await rig.advance(1);
    expect((await sent).kind).toBe("adopt");
    await store.idle();
    const [first, retry] = posts();
    expect(retry!.body!.idempotencyKey).toBe(first!.body!.idempotencyKey);
    expect(retry!.at - first!.at).toBe(2_000);
    expect(version(store)).toBe(1);
  });

  it("6b. a Retry-After: 0 on a GET still waits 1 s", async () => {
    const { store, rig } = await setup();
    await rig.advance(MIN_REPOLL_MS);
    fakeGet429 = "0";
    store.onFocus();
    await store.idle();
    expect(gets()).toHaveLength(1);
    await rig.advance(999);
    await store.idle();
    expect(gets()).toHaveLength(1);
    await rig.advance(1);
    await store.idle();
    expect(gets()).toHaveLength(2);
    expect(gets()[1]!.at - gets()[0]!.at).toBe(1_000);
  });

  it("7. a 409 drops its batch, shows the reason, re-syncs once; the next batch still sends", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    const tooMany = store.send([BUY_TOO_MANY], "buy 1000");
    const one = store.send([BUY_CONSTRUCTOR], "buy 1");
    const rejected = await tooMany;
    expect(rejected.kind).toBe("rejected");
    const reason = rejected.kind === "rejected" ? rejected.body.reason : "";
    expect(reason.length).toBeGreaterThan(0);
    expect((await one).kind).toBe("adopt");
    await store.idle();
    const notice = store.getView().notices.find((n) => n.kind === "rejected");
    expect(notice?.text).toContain(reason);
    expect(gets()).toHaveLength(1);
    const [a, b] = posts();
    expect(posts()).toHaveLength(2);
    expect(a!.body!.actions).toEqual([BUY_TOO_MANY]);
    expect(b!.body!.actions).toEqual([BUY_CONSTRUCTOR]);
    expect(a!.body!.idempotencyKey).not.toBe(b!.body!.idempotencyKey);
    expect(version(store)).toBe(1);
  });

  it("8. a 401 on a guest token: guest-expired, polling stops, newFactory recovers", async () => {
    const { store, tokens, rig } = await setup();
    const oldToken = tokens.get();
    await rig.db.query("delete from idempotency");
    await rig.db.query("delete from players"); // worlds, logs and sessions cascade
    await rig.advance(MIN_REPOLL_MS + 1);
    store.onFocus();
    await store.idle();
    expect(store.getView().notices.some((n) => n.kind === "guest-expired")).toBe(true);
    expect(store.getView().status).toBe("error");
    await rig.advance(5 * 4_000_000);
    await store.idle();
    expect(gets()).toHaveLength(1);

    await store.newFactory();
    await store.idle();
    expect(tokens.get()).not.toBe(oldToken);
    expect(tokens.get()).not.toBeNull();
    expect(store.getView().status).toBe("ready");
    expect(version(store)).toBe(0);
    expect(store.getView().notices.some((n) => n.kind === "guest-expired")).toBe(false);
  });

  it("9. past the plateau: one GET, a notice, no more polling; an action resumes", async () => {
    const { store, rig } = await setup();
    const persisted = store.getView().snapshot!.persistedAtMs!;
    store.setVisible(false);
    await rig.advance(persisted + OFFLINE_CAP_MS + 1_000 - rig.serverNow());
    store.setVisible(true);
    await store.idle();
    expect(gets()).toHaveLength(1);
    const s = store.getView().snapshot!;
    expect(isPlateaued(s)).toBe(true);
    const plateau = store.getView().notices.find((n) => n.kind === "plateau");
    expect(plateau?.text).toBe(
      "Production paused 8 h after your last action. Do anything to resume.",
    );
    await rig.advance(HOUR);
    await store.idle();
    expect(gets()).toHaveLength(1);

    expect((await store.send([BUY_CONSTRUCTOR], "buy")).kind).toBe("adopt");
    await store.idle();
    const after = store.getView().snapshot!;
    expect(after.persistedAtMs).toBeGreaterThan(persisted);
    expect(isPlateaued(after)).toBe(false);
    expect(store.getView().notices.some((n) => n.kind === "plateau")).toBe(false);
  });

  it("10. a hidden tab crosses a boundary without a GET; visible again, one GET", async () => {
    const { store, rig } = await setup();
    store.setVisible(false);
    await rig.advance(4_001_000);
    await store.idle();
    expect(gets()).toHaveLength(0);
    store.setVisible(true);
    await store.idle();
    expect(gets()).toHaveLength(1);
    store.setVisible(true); // the snapshot is fresh now
    await store.idle();
    expect(gets()).toHaveLength(1);
  });

  it("11. a failed boundary GET backs off 1 s, then 2 s; it never re-fires from the past boundary", async () => {
    const { store, rig } = await setup();
    await rig.advance(3_999_000);
    dropGets = 2;
    await rig.advance(10_000);
    await store.idle();
    const at = gets().map((g) => g.at);
    expect(at).toHaveLength(3);
    expect(at.slice(1).map((t, i) => t - at[i]!)).toEqual([RETRY_STEPS_MS[0], RETRY_STEPS_MS[1]]);
    expect(store.getView().status).toBe("ready");
  });

  it("12. stop() with requests in flight leaves no timers; start() resumes and send() works", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);

    // A GET in flight at stop(): its response lands and is ignored.
    const release = rig.fetch.hold("GET", "/api/world");
    store.onFocus();
    store.stop();
    release();
    await store.idle();
    expect(rig.clock.pendingTimers).toBe(0);
    expect(version(store)).toBe(0);

    // A POST in flight at stop() whose response is lost: no retry timer, no failure counted.
    await store.start();
    rig.fetch.dropNextResponse = true;
    const sent = store.send([BUY_CONSTRUCTOR], "buy");
    store.stop();
    await store.idle();
    expect(rig.clock.pendingTimers).toBe(0);
    expect(store.getView().failures).toBe(0);
    await rig.advance(60_000);
    expect(posts()).toHaveLength(1);

    // start() restarts the outbox: the batch resends with its key and replays.
    await store.start();
    expect((await sent).kind).toBe("adopt");
    const [first, retry] = posts();
    expect(retry!.body!.idempotencyKey).toBe(first!.body!.idempotencyKey);
    expect(await dbRow()).toEqual({ stateVersion: 1, logRows: 1 });
    const tap: Action = { type: "TAP", count: 1, clientElapsedMs: 1_000 };
    expect((await store.send([tap], "tap")).kind).toBe("adopt");
    expect(version(store)).toBe(2);
  });

  it("13. two start() calls make one guest", async () => {
    await freshRig();
    const store = storeFor(memoryTokenStorage());
    await Promise.all([store.start(), store.start()]);
    await store.idle();
    expect(log.filter((c) => c.url === "/api/guests")).toHaveLength(1);
    expect(store.getView().status).toBe("ready");
  });

  it("14. a content load that keeps failing backs off 1, 2, 4 s and shows offline", async () => {
    const rig = await freshRig();
    failContent = true;
    const store = storeFor(memoryTokenStorage());
    await store.start();
    const created = log.find((c) => c.url === "/api/guests")!.at;
    expect(store.getView().status).toBe("loading");
    expect(store.getView().failures).toBe(1);
    await rig.advance(1_000);
    expect(store.getView().status).toBe("offline");
    await rig.advance(6_500);
    expect(gets().map((g) => g.at - created)).toEqual([1_000, 3_000, 7_000]);
    failContent = false;
    await rig.advance(8_000);
    await store.idle();
    expect(gets().map((g) => g.at - created)).toEqual([1_000, 3_000, 7_000, 15_000]);
    expect(store.getView().status).toBe("ready");
    expect(store.getView().failures).toBe(0);
  });

  it("15. a successful POST cancels a pending GET retry", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    dropGets = 1;
    store.onFocus();
    await store.idle();
    expect(store.getView().failures).toBe(1);
    expect((await store.send([BUY_CONSTRUCTOR], "buy")).kind).toBe("adopt");
    await rig.advance(5_000);
    await store.idle();
    expect(gets()).toHaveLength(1);
    expect(store.getView().failures).toBe(0);
  });

  it("16. storage that fails mid-session raises the ephemeral-token banner", async () => {
    const rig = await freshRig();
    let writes = 0;
    const map = new Map<string, string>();
    const flaky = {
      length: 0,
      key: () => null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        // The constructor's probe works; the token write after guest creation throws.
        if (++writes > 1) throw new DOMException("quota", "QuotaExceededError");
        map.set(k, v);
      },
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    } satisfies Storage;
    const tokens = browserTokenStorage(flaky);
    expect(tokens.persistent).toBe(true);
    const store = storeFor(tokens);
    await store.start();
    expect(tokens.persistent).toBe(false);
    expect(tokens.get()).not.toBeNull();
    expect(store.getView().notices.map((n) => n.kind)).toEqual(["ephemeral-token"]);
    store.dismiss("ephemeral-token");
    await rig.advance(MIN_REPOLL_MS);
    store.onFocus();
    await store.idle();
    expect(store.getView().notices).toEqual([]);
  });

  it("17. guest-expired drops the queued batches: they never reach a new world", async () => {
    const { store, rig } = await setup();
    await rig.db.query("delete from idempotency");
    await rig.db.query("delete from players");
    const tap: Action = { type: "TAP", count: 1, clientElapsedMs: 1_000 };
    const a = store.send([tap], "a");
    const b = store.send([tap], "b");
    expect((await a).kind).toBe("unauthorized");
    expect((await b).kind).toBe("unauthorized");
    expect(posts()).toHaveLength(1);
    expect(store.getView().pending).toEqual([]);
    await store.newFactory();
    await rig.advance(10_000);
    expect(posts()).toHaveLength(1);
  });

  it("18. a body makeSnapshot can't read defers a retry", async () => {
    const { store, rig } = await setup();
    await rig.advance(MIN_REPOLL_MS);
    corruptGets = 1;
    store.onFocus();
    await store.idle();
    expect(store.getView().failures).toBe(1);
    await rig.advance(1_000);
    await store.idle();
    expect(gets()).toHaveLength(2);
    expect(gets()[1]!.at - gets()[0]!.at).toBe(1_000);
    expect(store.getView().failures).toBe(0);
  });

  it("19. a checksum change mid-session loads the new bundle before adopting (W-5)", async () => {
    const { store, rig } = await setup();
    const before = store.getView().snapshot!;
    const to = before.contentChecksum.replace(/^./, (c) => (c === "f" ? "e" : "f"));
    repin = { from: before.contentChecksum, to };
    await rig.advance(MIN_REPOLL_MS);
    store.onFocus();
    await store.idle();
    const fetched = log.findIndex((c) => c.url === `/api/content/${to}`);
    expect(fetched).toBeGreaterThan(log.indexOf(gets()[0]!));
    const after = store.getView().snapshot!;
    expect(after.contentChecksum).toBe(to);
    expect(after.content).not.toBe(before.content);
  });

  it("20. rig.advance fails fast while a hold is active, instead of hanging", async () => {
    const { store, rig } = await setup();
    await rig.advance(MIN_REPOLL_MS);
    const release = rig.fetch.hold("GET", "/api/world");
    store.onFocus();
    await expect(rig.advance(1)).rejects.toThrow(/active rig.fetch.hold/);
    release();
    await store.idle();
    expect(gets()).toHaveLength(1);
  });

  it("21. a closed rig refuses to advance, so a timed-out test can't drive the next test's", async () => {
    const { rig } = await setup();
    await rig.close();
    await expect(rig.advance(1)).rejects.toThrow(/after rig.close/);
  });
});

describe("GameStore taps, polling and tiers (Q-11, Q-13, Q-18)", () => {
  type Tap = Extract<Action, { type: "TAP" }>;
  const tapPosts = () => posts().filter((p) => p.body!.actions.some((a) => a.type === "TAP"));
  const tapOf = (p: Logged) => p.body!.actions[0] as Tap;
  const gaps = (at: number[]) => at.slice(1).map((t, i) => t - at[i]!);

  it("22. a hold flushes once a second, then once after release, each its own batch", async () => {
    const { store, rig } = await setup();
    await rig.advance(10_000);
    const t0 = rig.clock.now();
    store.pressTap();
    expect(store.getView().taps).toEqual({ pending: 1, lastTapAt: t0, holding: true });
    for (let i = 0; i < 35; i++) {
      await rig.advance(100);
      if (i === 10) expect(store.getView().snapshot!.state.tapStacks).toBe(10);
    }
    store.releaseTap();
    expect(store.getView().taps.holding).toBe(false);
    for (let i = 0; i < 20; i++) await rig.advance(100);
    await store.idle();
    const sent = tapPosts();
    expect(sent.map((p) => p.at - t0)).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(Math.min(...gaps(sent.map((p) => p.at)))).toBeGreaterThanOrEqual(1_000);
    for (const p of sent) {
      expect(p.body!.actions).toHaveLength(1);
      expect(tapOf(p)).toEqual({
        type: "TAP",
        count: expect.any(Number) as number,
        clientElapsedMs: expect.any(Number) as number,
      });
      expect(tapOf(p).count).toBeGreaterThan(0);
    }
    expect(sent.reduce((n, p) => n + tapOf(p).count, 0)).toBe(36);
    expect(store.getView().taps.pending).toBe(0);
    expect(store.getView().snapshot!.state.tapStacks).toBe(10);
  });

  it("23. tap-release bursts can't beat one flush a second", async () => {
    const { store, rig } = await setup();
    await rig.advance(10_000);
    let lastRelease = 0;
    for (let i = 0; i < 6; i++) {
      store.pressTap();
      store.releaseTap();
      lastRelease = rig.clock.now();
      await rig.advance(400);
    }
    await rig.advance(2_000);
    await store.idle();
    const sent = tapPosts();
    expect(sent.length).toBeGreaterThan(1);
    expect(Math.min(...gaps(sent.map((p) => p.at)))).toBeGreaterThanOrEqual(1_000);
    expect(sent.every((p) => tapOf(p).count > 0)).toBe(true);
    expect(sent.reduce((n, p) => n + tapOf(p).count, 0)).toBe(6);
    expect(sent.at(-1)!.at - lastRelease).toBeLessThanOrEqual(1_000);
  });

  it("24. a tap flush is never merged into a spend's batch", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    const release = rig.fetch.hold("POST", "/api/actions");
    const spend = store.send([BUY_CONSTRUCTOR], "buy");
    store.pressTap();
    store.releaseTap();
    store.flushTaps(); // nothing flushed yet, so the floor allows it now
    const [head, queued] = store.getView().pending;
    expect(head!.actions).toEqual([BUY_CONSTRUCTOR]);
    expect(queued!.label).toBe("tap");
    expect(queued!.actions).toHaveLength(1);
    expect(queued!.actions[0]!.type).toBe("TAP");
    expect(queued!.key).not.toBe(head!.key);
    release();
    expect((await spend).kind).toBe("adopt");
    await store.idle();
    const [a, b] = posts();
    expect(posts()).toHaveLength(2);
    expect(a!.body!.actions).toEqual([BUY_CONSTRUCTOR]);
    expect(b!.body!.actions.map((x) => x.type)).toEqual(["TAP"]);
    expect(b!.body!.idempotencyKey).not.toBe(a!.body!.idempotencyKey);
  });

  it("25a. the keepalive flush sends at once, past a batch in flight", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    for (let i = 0; i < 4; i++) {
      store.pressTap();
      store.releaseTap();
      await rig.advance(50);
    }
    expect(tapPosts()).toHaveLength(0); // the release flush (about +300 ms) hasn't fired
    let open!: () => void;
    gateSpends = new Promise<void>((r) => (open = r));
    let spendDone = false;
    const spend = store.send([BUY_CONSTRUCTOR], "buy").finally(() => (spendDone = true));
    store.flushTaps({ keepalive: true });
    const [tap] = tapPosts();
    expect(tapOf(tap!).count).toBe(4);
    expect(tap!.keepalive).toBe(true);
    expect(store.getView().pending.map((b) => b.label)).toEqual(["buy"]);
    expect(store.getView().taps.pending).toBe(0);
    expect(spendDone).toBe(false);
    open();
    await spend;
    await store.idle();
    expect(store.getView().snapshot!.state.tapStacks).toBeGreaterThan(0);
    expect(tapPosts()).toHaveLength(1);
    await rig.advance(2_000);
    expect(tapPosts()).toHaveLength(1);
  });

  it("25b. a lost keepalive flush is retried through the outbox with the same key", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    store.pressTap();
    store.releaseTap();
    const before = (await dbRow()).logRows;
    rig.fetch.dropNextResponse = true;
    store.flushTaps({ keepalive: true });
    await store.idle();
    const [first, retry] = tapPosts();
    expect(tapPosts()).toHaveLength(2);
    expect(first!.keepalive).toBe(true);
    expect(retry!.keepalive).not.toBe(true);
    expect(retry!.body!.idempotencyKey).toBe(first!.body!.idempotencyKey);
    expect((await dbRow()).logRows).toBe(before + 1);
    expect(store.getView().snapshot!.state.tapStacks).toBe(1);
  });

  it("26. a GET 4xx stops polling until focus (Q-18)", async () => {
    const { store, rig } = await setup();
    expect(store.getView().polling).toBe(true);
    await rig.advance(MIN_REPOLL_MS);
    fakeGetStatus = 418;
    store.onFocus();
    await store.idle();
    expect(store.getView().notices.some((n) => n.kind === "client-bug")).toBe(true);
    expect(store.getView().polling).toBe(false);
    const n = gets().length;
    await rig.advance(4_100_000);
    await store.idle();
    expect(gets()).toHaveLength(n);
    const old = store.getView().snapshot!.receivedAt;
    store.onFocus();
    await store.idle();
    expect(gets()).toHaveLength(n + 1);
    expect(store.getView().snapshot!.receivedAt).toBeGreaterThan(old);
    expect(store.getView().polling).toBe(true);
  });

  it("27. adopting a higher tier raises one tier-up toast", async () => {
    const { store, rig } = await setup();
    expect(store.getView().snapshot!.state.tier).toBe(0);
    const [row] = await rig.db.query<{ state: Record<string, unknown> }>(
      "select state from player_worlds",
    );
    await rig.db.query("update player_worlds set state = $1::jsonb", [
      JSON.stringify({ ...row!.state, tier: 1 }),
    ]);
    await rig.advance(MIN_REPOLL_MS);
    store.onFocus();
    await store.idle();
    expect(store.getView().snapshot!.state.tier).toBe(1);
    await rig.advance(MIN_REPOLL_MS);
    store.onFocus();
    await store.idle();
    const ups = store.getView().notices.filter((x) => x.kind === "tier-up");
    expect(ups).toEqual([{ kind: "tier-up", text: "Tier 1 reached." }]);
  });

  it("28. stop() clears the tap's timers", async () => {
    const { store, rig } = await setup();
    store.stop();
    expect(rig.clock.pendingTimers).toBe(0);
    await store.start();
    store.pressTap();
    expect(rig.clock.pendingTimers).toBeGreaterThan(0);
    store.stop();
    expect(rig.clock.pendingTimers).toBe(0);
    expect(store.getView().taps.holding).toBe(false);
  });

  it("29. a keepalive flush during a pause waits for it, under the key it made", async () => {
    const { store, rig } = await setup();
    await rig.advance(MIN_REPOLL_MS);
    fakeGet429 = "3";
    store.onFocus();
    await store.idle();
    const before = posts().length;
    store.pressTap();
    await rig.advance(300);
    store.releaseTap();
    store.flushTaps({ keepalive: true });
    expect(posts()).toHaveLength(before); // no keepalive POST goes out into the pause
    const key = store.getView().pending[0]!.key;
    await rig.advance(1_000);
    expect(posts()).toHaveLength(before);
    await rig.advance(2_000);
    await store.idle();
    expect(tapPosts()).toHaveLength(1);
    expect(tapPosts()[0]!.body!.idempotencyKey).toBe(key);
    expect(tapPosts()[0]!.keepalive).not.toBe(true);
  });

  it("30. start() re-arms the flush of taps that were pending across stop()", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    store.pressTap();
    store.releaseTap();
    const pending = store.getView().taps.pending;
    expect(pending).toBeGreaterThan(0);
    store.stop();
    await store.start();
    await rig.advance(1_000);
    await store.idle();
    expect(tapPosts()).toHaveLength(1);
    expect(tapOf(tapPosts()[0]!).count).toBe(pending);
  });

  it("31. adopting a tap flush never shows more stacks than were tapped", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    let max = 0;
    store.subscribe(() => {
      const v = store.getView();
      if (v.snapshot === null) return;
      max = Math.max(max, dockModel(v.snapshot, v.taps, store.now(), v.pending).stacks);
    });
    for (let i = 0; i < 3; i++) {
      store.pressTap();
      store.releaseTap();
    }
    await rig.advance(1_000);
    await store.idle();
    expect(tapPosts()).toHaveLength(1);
    expect(store.getView().snapshot!.state.tapStacks).toBe(3);
    expect(max).toBe(3);
  });

  it("32. taps in flight stay counted while the response's new bundle loads", async () => {
    const { store, rig } = await setup();
    await rig.advance(60_000);
    const before = store.getView().snapshot!;
    repin = {
      from: before.contentChecksum,
      to: before.contentChecksum.replace(/^./, (c) => (c === "f" ? "e" : "f")),
    };
    let open!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    gateContent = { gate: new Promise<void>((r) => (open = r)), entered };
    const stacks = () => {
      const v = store.getView();
      return dockModel(v.snapshot!, v.taps, store.now(), v.pending).stacks;
    };
    for (let i = 0; i < 3; i++) {
      store.pressTap();
      store.releaseTap();
    }
    const advancing = rig.advance(1_000); // the flush fires; its response waits on the bundle
    await reached;
    expect(store.getView().snapshot).toBe(before); // not adopted yet
    expect(stacks()).toBe(3);
    store.pressTap(); // any emit: the old snapshot doesn't have the 3 yet
    expect(stacks()).toBe(4);
    store.releaseTap();
    open();
    await advancing;
    await store.idle();
    expect(store.getView().snapshot!.contentChecksum).toBe(repin.to);
    // The 3 are in the snapshot now and no longer pending: never counted twice.
    expect(stacks()).toBe(4);
  });
});
