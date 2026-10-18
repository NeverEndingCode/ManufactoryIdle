// The GameStore against the real API (W-22): buildServer on PGlite through an inject()-backed
// fetch, with the server's clock following the client's FakeClientClock (P-8). Every wait is
// on store state (idle()), never a sleep (P-9).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { deserializeWorld, serializeWorld, type Action } from "@manufactory/engine";
import { MIN_REPOLL_MS } from "./constants.js";
import { memoryTokenStorage, type TokenStorage } from "./identity.js";
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
}

let rig: TestRig;
let stores: GameStore[] = [];
let log: Logged[] = [];
/** When set, the next GET /api/world answers 429 with this Retry-After, without the server. */
let fakeGet429: string | null = null;

afterEach(async () => {
  for (const s of stores) s.stop();
  stores = [];
  await rig.close();
});

function storeFor(tokens: TokenStorage): GameStore {
  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const entry: Logged = { method, url, at: rig.clock.now() };
    if (typeof init?.body === "string") entry.body = JSON.parse(init.body) as ActionsRequest;
    log.push(entry);
    if (method === "GET" && url === "/api/world" && fakeGet429 !== null) {
      const retryAfter = fakeGet429;
      fakeGet429 = null;
      return new Response('{"error":"rate-limited"}', {
        status: 429,
        headers: { "retry-after": retryAfter },
      });
    }
    return rig.fetch(url, init);
  };
  const store = new GameStore({ fetch, clock: rig.clock, tokens });
  stores.push(store);
  rig.clock.settleWith = async () => {
    for (const s of stores) await s.idle();
  };
  return store;
}

async function setup(opts: Parameters<typeof makeRig>[0] = {}) {
  rig = await makeRig(opts);
  log = [];
  fakeGet429 = null;
  const tokens = memoryTokenStorage();
  const store = storeFor(tokens);
  await store.start();
  await store.idle();
  return { store, tokens };
}

const gets = () => log.filter((c) => c.method === "GET" && c.url === "/api/world");
const posts = () => log.filter((c) => c.method === "POST" && c.url === "/api/actions");
const version = (s: GameStore) => s.getView().snapshot!.stateVersion;

async function dbRow() {
  const [w] = await rig.db.query<{ state_version: string }>(
    "select state_version::text from player_worlds",
  );
  const [l] = await rig.db.query<{ n: string }>("select count(*)::text as n from action_log");
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
    const { store } = await setup();
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
    const { store } = await setup();
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
    const { store } = await setup();
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

  it("4. backs off on the EPSILON cycle, 5 s doubling to 40 s, and an action resets it", async () => {
    const { store } = await setup();
    /** The reinforced-full fixture into the guest's row, rebased to the server's clock. */
    const loadFixture = async () => {
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
    };
    const gapsSince = (from: number) => {
      const at = gets()
        .slice(from)
        .map((g) => g.at);
      return at.slice(1).map((t, i) => t - at[i]!);
    };

    await loadFixture();
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

    // A fresh cycle: build the streak to a 20 s gap, then act.
    await loadFixture();
    const second = gets().length - 1;
    while (!gapsSince(second).includes(10_000)) await rig.advance(100);
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
  });

  it("5. a lost response is retried with the same key and replayed", async () => {
    const { store } = await setup();
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
    const { store, tokens } = await setup({
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
    const { store } = await setup();
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
    const { store } = await setup();
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
    const { store, tokens } = await setup();
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
    const { store } = await setup();
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
    const { store } = await setup();
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
});
