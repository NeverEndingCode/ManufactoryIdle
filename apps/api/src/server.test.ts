import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bundleChecksum, loadBundleDir } from "@manufactory/content";
import {
  applyBatch,
  deserializeWorld,
  initialWorld,
  resolve,
  schedule,
  serializeWorld,
  type Action,
  type IndexedContent,
  type WorldState,
} from "@manufactory/engine";
import { pgliteDb } from "./db/pglite.js";
import { migrate } from "./db/migrate.js";
import type { Db } from "./db/db.js";
import { openContentStore, type ContentStore } from "./content.js";
import { buildServer, guestAuth, type ServerDeps } from "./server.js";
import { replayWorld } from "./worlds.js";

const SLICE = fileURLToPath(
  new URL("../../../packages/content/bundles/vertical-slice", import.meta.url),
);
const FIXTURE = fileURLToPath(
  new URL("../../../packages/content/bundles/fixture", import.meta.url),
);

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;

// On the slice's starting world every stock is zero, so nothing costs-something is
// affordable at T0. Ten minutes of the starting iron line is enough for one miner
// (checked against the engine: at 10 min BUY_MACHINE miner x1 applies, x1000 does not).
const BUY_MINER: Action = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "miner",
  mark: 1,
  count: 1,
};
const BUY_1000_MINERS: Action = { ...BUY_MINER, count: 1000 };

/** Counts transactions, so a 400 can be shown to open none. */
function countingDb(inner: Db): Db & { transactions: number; afterRollback?: () => Promise<void> } {
  const wrapped: Db & { transactions: number; afterRollback?: () => Promise<void> } = {
    transactions: 0,
    query: inner.query.bind(inner),
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      wrapped.transactions += 1;
      try {
        return await inner.transaction(fn);
      } catch (err) {
        // The gap after a rollback, where the row lock is free: a test can race a retry into it.
        await wrapped.afterRollback?.();
        throw err;
      }
    },
    close: () => inner.close(),
  };
  return wrapped;
}

let db: Db & { transactions: number; afterRollback?: () => Promise<void> };
let now: number;
const clock = () => now;
let apps: FastifyInstance[] = [];

beforeEach(async () => {
  const raw = await pgliteDb();
  await migrate(raw);
  db = countingDb(raw);
  now = T0;
  apps = [];
});
afterEach(async () => {
  for (const app of apps) await app.close();
  await db?.close();
});

async function server(
  dir: string = SLICE,
  limits?: ServerDeps["limits"],
): Promise<{ app: FastifyInstance; store: ContentStore }> {
  const store = await openContentStore(db, dir);
  const app = buildServer({ db, content: store, clock, auth: guestAuth(db), limits });
  apps.push(app);
  return { app, store };
}

async function createGuest(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/guests" });
  expect(res.statusCode).toBe(201);
  return (res.json() as { guestToken: string }).guestToken;
}

const guest = (token: string) => ({ authorization: `Guest ${token}` });

interface WorldRowView {
  state: unknown;
  state_version: string;
  last_resolved_at_ms: number;
  content_version: string;
  schema_version: number;
  initial_seed: number;
  initial_content_version: string;
  created_at_ms: number;
}

async function worldRows(): Promise<WorldRowView[]> {
  return db.query<WorldRowView>(
    `select state, state_version::text as state_version, content_version, schema_version,
            round(extract(epoch from last_resolved_at) * 1000)::float8 as last_resolved_at_ms,
            initial_seed, initial_content_version,
            round(extract(epoch from created_at) * 1000)::float8 as created_at_ms
       from player_worlds`,
  );
}

async function onlyWorld(): Promise<WorldRowView> {
  const rows = await worldRows();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function storedState(): Promise<WorldState> {
  return deserializeWorld(JSON.stringify((await onlyWorld()).state));
}

interface LogRow {
  actions: Action[];
  idempotency_key: string | null;
  created_at_ms: number;
}

async function logRows(): Promise<LogRow[]> {
  return db.query<LogRow>(
    `select actions, idempotency_key,
            round(extract(epoch from created_at) * 1000)::float8 as created_at_ms
       from action_log order by id`,
  );
}

async function lastSeenMs(): Promise<number[]> {
  const rows = await db.query<{ ms: number }>(
    "select round(extract(epoch from last_seen_at) * 1000)::float8 as ms from players",
  );
  return rows.map((r) => r.ms);
}

const wire = (state: WorldState): unknown => JSON.parse(serializeWorld(state));

function postActions(app: FastifyInstance, token: string, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/actions",
    headers: guest(token),
    payload: body as object,
  });
}

describe("GET /api/health", () => {
  it("reports the current content version", async () => {
    const { app, store } = await server();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, contentVersion: store.current.version });
  });
});

describe("POST /api/guests", () => {
  it("1. creates one player and one initialWorld at the clock's now", async () => {
    const { app, store } = await server();
    const res = await app.inject({ method: "POST", url: "/api/guests" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      guestToken: string;
      world: { state: unknown; schedule: unknown; stateVersion: number; contentVersion: string };
    };
    expect(body.guestToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url

    const content = store.current.content;
    const row = await onlyWorld();
    expect(Number.isInteger(row.initial_seed)).toBe(true);
    expect(row.initial_seed).toBeGreaterThanOrEqual(0);
    expect(row.initial_seed).toBeLessThan(2 ** 31);
    const expected = initialWorld(content, row.initial_seed, T0);
    expect(row.state).toEqual(wire(expected));
    expect(body.world.state).toEqual(wire(expected));
    expect(body.world.schedule).toEqual(schedule(expected, content));
    expect(body.world.stateVersion).toBe(0);
    expect(body.world.contentVersion).toBe(store.current.version);
    expect(row.state_version).toBe("0");
    expect(row.content_version).toBe(store.current.version);
    expect(row.last_resolved_at_ms).toBe(T0);
    expect(row.schema_version).toBe(expected.schemaVersion);
    expect(row.created_at_ms).toBe(T0);
    expect(row.initial_content_version).toBe(store.current.version);

    // Only the token's sha256 is stored; the raw token is returned once and never kept.
    const players = await db.query<{ guest_token: string }>("select guest_token from players");
    expect(players).toHaveLength(1);
    expect(players[0]!.guest_token).not.toBe(body.guestToken);
    expect(players[0]!.guest_token).not.toContain(body.guestToken);
    expect(players[0]!.guest_token).toBe(
      createHash("sha256").update(body.guestToken).digest("hex"),
    );

    // A second guest gets its own seed (a fresh random draw, not a constant).
    await createGuest(app);
    const rows = await worldRows();
    expect(rows[0]!.initial_seed).not.toBe(rows[1]!.initial_seed);
    expect((rows[0]!.state as { seed: unknown }).seed).not.toEqual(
      (rows[1]!.state as { seed: unknown }).seed,
    );
  });
});

describe("GET /api/world", () => {
  it("2. resolves to now in memory and writes nothing", async () => {
    const { app, store } = await server();
    const token = await createGuest(app);
    const before = await onlyWorld();
    const initial = deserializeWorld(JSON.stringify(before.state));

    now = T0 + 10 * MINUTE;
    const res = await app.inject({ method: "GET", url: "/api/world", headers: guest(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: unknown; schedule: unknown; stateVersion: number };
    const resolved = resolve(initial, store.current.content, 600_000).state;
    expect(body.state).toEqual(wire(resolved));
    expect((body.state as { stored: unknown }).stored).not.toEqual(
      (wire(initial) as { stored: unknown }).stored,
    );
    expect(body.schedule).toEqual(schedule(resolved, store.current.content));
    expect(body.stateVersion).toBe(0);

    expect(await onlyWorld()).toEqual(before);
    expect(await lastSeenMs()).toEqual([T0]);
  });

  it("2b. opens one session per player, recording the user agent, and nothing else", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    const sessions = () =>
      db.query<{ player_id: string; opened_ms: number; closed_at: unknown; client: string }>(
        `select player_id, round(extract(epoch from opened_at) * 1000)::float8 as opened_ms,
                closed_at, client from sessions`,
      );
    expect(await sessions()).toHaveLength(0);
    const before = await onlyWorld();

    now = T0 + 5 * MINUTE;
    const headers = { ...guest(token), "user-agent": "x".repeat(300) };
    await app.inject({ method: "GET", url: "/api/world", headers });
    const first = await sessions();
    expect(first).toHaveLength(1);
    expect(first[0]!.opened_ms).toBe(T0 + 5 * MINUTE);
    expect(first[0]!.closed_at).toBeNull();
    expect(first[0]!.client).toBe("x".repeat(200));

    now = T0 + 6 * MINUTE;
    await app.inject({ method: "GET", url: "/api/world", headers });
    expect(await sessions()).toEqual(first);

    expect(await onlyWorld()).toEqual(before);
    expect(await lastSeenMs()).toEqual([T0]);
  });

  it("2c. two GETs racing still leave exactly one open session", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 5 * MINUTE;
    const get = () => app.inject({ method: "GET", url: "/api/world", headers: guest(token) });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    await get();
    const open = await db.query("select 1 from sessions where closed_at is null");
    expect(open).toHaveLength(1);
  });
});

describe("POST /api/actions", () => {
  it("3. applies an affordable action, bumps state_version and logs it", async () => {
    const { app, store } = await server();
    const token = await createGuest(app);
    const initial = await storedState();
    const content = store.current.content;

    now = T0 + 10 * MINUTE;
    const res = await postActions(app, token, {
      idempotencyKey: "k-1",
      baseVersion: 0,
      actions: [BUY_MINER],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: unknown; stateVersion: number; summary: unknown };

    const resolved = resolve(initial, content, 10 * MINUTE);
    const batch = applyBatch(resolved.state, content, [BUY_MINER], resolved.state.seed);
    if (batch.rejected) throw new Error(`fixture action rejected: ${batch.reason}`);
    expect(batch.state.installed.iron!.miner![0]).toBe(initial.installed.iron!.miner![0]! + 1);
    expect(body.state).toEqual(wire(batch.state));
    expect(body.stateVersion).toBe(1);
    expect(body.summary).toEqual(resolved.summary);

    const row = await onlyWorld();
    expect(row.state).toEqual(wire(batch.state));
    expect(row.state_version).toBe("1");
    expect(row.last_resolved_at_ms).toBe(now);
    expect(row.last_resolved_at_ms).toBe(batch.state.lastResolvedAt);

    expect(await logRows()).toEqual([
      { actions: [BUY_MINER], idempotency_key: "k-1", created_at_ms: now },
    ]);
    expect(await lastSeenMs()).toEqual([now]);
  });

  it("4. a batch with a rejected second action is a 409 and persists nothing", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const before = await onlyWorld();

    const res = await postActions(app, token, {
      idempotencyKey: "k-atomic",
      baseVersion: 0,
      actions: [BUY_MINER, BUY_1000_MINERS],
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { failedAction: unknown; index: number; reason: string };
    expect(body.index).toBe(1);
    expect(body.failedAction).toEqual(BUY_1000_MINERS);
    expect(body.reason).toBe("cannot afford this purchase");

    expect(await onlyWorld()).toEqual(before);
    expect(await logRows()).toEqual([]);
    expect(await lastSeenMs()).toEqual([T0]);
  });

  it("5. malformed bodies are a 400, open no transaction and change nothing", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const before = await onlyWorld();
    const txBefore = db.transactions;

    const ok = { idempotencyKey: "k", baseVersion: 0 };
    const { count: _omit, ...missingCount } = BUY_MINER as Extract<Action, { type: "BUY_MACHINE" }>;
    const bodies: unknown[] = [
      { ...ok, actions: [{ type: "SELL_EVERYTHING", count: 1 }] },
      { ...ok, actions: [missingCount] },
      { ...ok, actions: [{ ...BUY_MINER, free: true }] },
      { ...ok, actions: [] },
      { ...ok, actions: [{ ...BUY_MINER, count: "1" }] },
      { ...ok, actions: [BUY_MINER], extra: 1 },
      { idempotencyKey: "", baseVersion: 0, actions: [BUY_MINER] },
    ];
    for (const body of bodies) {
      const res = await postActions(app, token, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }

    expect(db.transactions).toBe(txBefore);
    expect(await onlyWorld()).toEqual(before);
    expect(await logRows()).toEqual([]);
  });

  it("5b. an over-long id, or an over-long priority list, is a 400", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    const txBefore = db.transactions;
    const ok = { idempotencyKey: "k", baseVersion: 0 };
    const long = "x".repeat(65);
    const bodies: unknown[] = [
      { ...ok, actions: [{ ...BUY_MINER, lane: long }] },
      { ...ok, actions: [{ ...BUY_MINER, recipeId: long }] },
      { ...ok, actions: [{ type: "SET_RESERVE", itemId: long, percent: 1 }] },
      { ...ok, actions: [{ type: "REORDER_PRIORITY", entries: [long] }] },
      { ...ok, actions: [{ type: "REORDER_PRIORITY", entries: Array(257).fill("power") }] },
    ];
    for (const body of bodies) {
      const res = await postActions(app, token, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 120)).toBe(400);
    }
    // 64 is still allowed through to the engine (which rejects the unknown lane: a 409).
    const at64 = await postActions(app, token, {
      ...ok,
      actions: [{ ...BUY_MINER, lane: "x".repeat(64) }],
    });
    expect(at64.statusCode).toBe(409);
    // A rejection stores its 409 inside the one locked transaction.
    expect(db.transactions).toBe(txBefore + 1);
  });
});

describe("POST /api/actions idempotency", () => {
  const body = (key: string, actions: Action[] = [BUY_MINER]) => ({
    idempotencyKey: key,
    baseVersion: 0,
    actions,
  });

  it("the same key twice replays the stored response and applies once", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const first = await postActions(app, token, body("k-dup"));
    expect(first.statusCode).toBe(200);
    now = T0 + 20 * MINUTE;
    const second = await postActions(app, token, body("k-dup"));
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect((await onlyWorld()).state_version).toBe("1");
    expect(await logRows()).toHaveLength(1);
    expect(await lastSeenMs()).toEqual([T0 + 10 * MINUTE]);
  });

  it("two players using the same key do not interfere", async () => {
    const { app } = await server();
    const a = await createGuest(app);
    const b = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const ra = await postActions(app, a, body("shared"));
    const rb = await postActions(app, b, body("shared"));
    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    expect(await logRows()).toHaveLength(2);
    const versions = await db.query<{ state_version: string }>(
      "select state_version::text as state_version from player_worlds",
    );
    expect(versions.map((v) => v.state_version)).toEqual(["1", "1"]);
  });

  it("a replayed 409 is the same 409 and persists nothing", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const first = await postActions(app, token, body("k-409", [BUY_MINER, BUY_1000_MINERS]));
    expect(first.statusCode).toBe(409);
    const second = await postActions(app, token, body("k-409", [BUY_MINER, BUY_1000_MINERS]));
    expect(second.statusCode).toBe(409);
    expect(second.body).toBe(first.body);
    expect(await logRows()).toEqual([]);
    expect((await onlyWorld()).state_version).toBe("0");
  });

  it("a retry racing a rejection cannot turn its 409 into an applied 200", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    const rejected = body("k-race", [BUY_MINER, BUY_1000_MINERS]);
    now = T0 + 10 * MINUTE;
    // If the rejection rolled back and stored its 409 afterwards, this retry would take the
    // lock in between, with more time accrued, and apply. Stored under the lock, it cannot.
    let raced: { statusCode: number } | undefined;
    db.afterRollback = async () => {
      db.afterRollback = undefined;
      now = T0 + 10_000 * MINUTE;
      raced = await postActions(app, token, rejected);
    };
    const first = await postActions(app, token, rejected);
    expect(first.statusCode).toBe(409);
    expect(raced).toBeUndefined();
    now = T0 + 10_000 * MINUTE;
    const retry = await postActions(app, token, rejected);
    expect(retry.statusCode).toBe(409);
    expect(retry.body).toBe(first.body);
    expect(await logRows()).toEqual([]);
    expect((await onlyWorld()).state_version).toBe("0");
  });

  it("the key wins: a different body under a seen key gets the stored response", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const first = await postActions(app, token, body("k-win"));
    const second = await postActions(app, token, body("k-win", [BUY_1000_MINERS]));
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(await logRows()).toHaveLength(1);
  });
});

describe("auth", () => {
  it("6. a missing or unknown guest token is a 401", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    const body = { idempotencyKey: "k", baseVersion: 0, actions: [BUY_MINER] };

    const headerSets: (Record<string, string> | undefined)[] = [
      undefined,
      guest("not-a-real-token"),
      guest("A".repeat(43)), // well-formed, but no such guest
      { authorization: `Bearer ${token}` },
      { authorization: `Guest ${token}x` },
    ];
    for (const headers of headerSets) {
      for (const req of [
        { method: "GET" as const, url: "/api/world" },
        { method: "POST" as const, url: "/api/actions", payload: body },
      ]) {
        const res = await app.inject({ ...req, ...(headers ? { headers } : {}) });
        expect(res.statusCode, `${req.method} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.headers["www-authenticate"]).toBe("Guest");
      }
    }
    expect((await onlyWorld()).state_version).toBe("0");

    // The scheme is case-insensitive, and the real token is accepted.
    const ok = await app.inject({
      method: "GET",
      url: "/api/world",
      headers: { authorization: `guest  ${token}` },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("content versions", () => {
  it("7. a world pinned to an older version is served with that version's bundle", async () => {
    const old = await server(FIXTURE);
    const token = await createGuest(old.app);
    const fixture: IndexedContent = old.store.current.content;
    const initial = await storedState();

    const fresh = await server(SLICE);
    expect(fresh.store.current.version).not.toBe(old.store.current.version);
    now = T0 + 10 * MINUTE;
    const res = await fresh.app.inject({ method: "GET", url: "/api/world", headers: guest(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      state: { stored: Record<string, string> };
      schedule: { items: Record<string, unknown> };
      contentVersion: string;
    };
    expect(body.contentVersion).toBe(bundleChecksum(loadBundleDir(FIXTURE)));
    expect(Object.keys(body.state.stored).sort()).toEqual([...fixture.stockItemIds].sort());
    expect(Object.keys(body.schedule.items).sort()).toEqual([...fixture.stockItemIds].sort());
    const resolved = resolve(initial, fixture, 10 * MINUTE).state;
    expect(body.state).toEqual(wire(resolved));
    expect(body.schedule).toEqual(schedule(resolved, fixture));

    // The action path is pinned too: a TAP (free, so valid on either bundle) on the
    // fixture world resolves and applies against the fixture, not the slice.
    const tap: Action = { type: "TAP", count: 2, clientElapsedMs: 1000 };
    now = T0 + 12 * MINUTE;
    const act = await postActions(fresh.app, token, {
      idempotencyKey: "k-pin",
      baseVersion: 0,
      actions: [tap],
    });
    expect(act.statusCode, act.body).toBe(200);
    const r = resolve(initial, fixture, 12 * MINUTE);
    const batch = applyBatch(r.state, fixture, [tap], r.state.seed);
    if (batch.rejected) throw new Error(batch.reason);
    expect((act.json() as { state: unknown }).state).toEqual(wire(batch.state));
    expect((await onlyWorld()).content_version).toBe(old.store.current.version);
  });
});

describe("replay", () => {
  it("8. the recorded start plus action_log reproduces the stored state", async () => {
    const { app, store } = await server();
    const token = await createGuest(app);

    const steps: [number, Action[]][] = [
      [10 * MINUTE, [BUY_MINER]],
      [17 * MINUTE, [BUY_MINER, { type: "TAP", count: 3, clientElapsedMs: 1500 }]],
      [
        31 * MINUTE + 123,
        [{ type: "BUY_MACHINE", lane: "iron", machineClass: "smelter", mark: 1, count: 1 }],
      ],
    ];
    for (const [i, [at, actions]] of steps.entries()) {
      now = T0 + at;
      const res = await postActions(app, token, {
        idempotencyKey: `k-${i}`,
        baseVersion: i,
        actions,
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    // replayWorld rebuilds the start from the recorded columns only, never from a stored state.
    const row = await onlyWorld();
    const content = await store.get(row.initial_content_version);
    const initial = initialWorld(content, row.initial_seed, row.created_at_ms);

    const log = await logRows();
    expect(log.map((r) => r.created_at_ms)).toEqual(steps.map(([at]) => T0 + at));
    const [world] = await db.query<{ id: string }>("select id from player_worlds");
    const state = await replayWorld(db, store, world!.id);
    expect(row.state_version).toBe("3");
    expect(serializeWorld(state)).toBe(serializeWorld(deserializeWorld(JSON.stringify(row.state))));
    expect(serializeWorld(state)).not.toBe(serializeWorld(initial));
  });
});

describe("rate limits", () => {
  const getWorld = (app: FastifyInstance, token: string) =>
    app.inject({ method: "GET", url: "/api/world", headers: guest(token) });

  it("30 quick calls pass, the 31st is 429 with Retry-After, and it refills with the clock", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    for (let i = 0; i < 30; i++) expect((await getWorld(app, token)).statusCode).toBe(200);
    const limited = await getWorld(app, token);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate-limited" });
    expect(limited.headers["retry-after"]).toBe("1");
    now += 334; // 3 per second: one token back after 1/3 s
    expect((await getWorld(app, token)).statusCode).toBe(200);
    expect((await getWorld(app, token)).statusCode).toBe(429);
  });

  it("/api/actions shares the player's bucket, and a replayed key still counts", async () => {
    const { app } = await server(SLICE, { player: { capacity: 2, refillPerSec: 1 } });
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const body = { idempotencyKey: "k", baseVersion: 0, actions: [BUY_MINER] };
    expect((await postActions(app, token, body)).statusCode).toBe(200);
    expect((await postActions(app, token, body)).statusCode).toBe(200);
    expect((await postActions(app, token, body)).statusCode).toBe(429);
    expect((await getWorld(app, token)).statusCode).toBe(429);
  });

  it("buckets are per player", async () => {
    const { app } = await server(SLICE, { player: { capacity: 1, refillPerSec: 1 } });
    const a = await createGuest(app);
    const b = await createGuest(app);
    expect((await getWorld(app, a)).statusCode).toBe(200);
    expect((await getWorld(app, a)).statusCode).toBe(429);
    expect((await getWorld(app, b)).statusCode).toBe(200);
  });

  it("an unauthenticated call is 401, not 429, and takes no token", async () => {
    const { app } = await server(SLICE, { player: { capacity: 1, refillPerSec: 1 } });
    const token = await createGuest(app);
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: "GET", url: "/api/world" })).statusCode).toBe(401);
    }
    expect((await getWorld(app, token)).statusCode).toBe(200);
  });

  it("POST /api/guests allows 5 per hour per IP by default", async () => {
    const { app } = await server();
    for (let i = 0; i < 5; i++) await createGuest(app);
    const limited = await app.inject({ method: "POST", url: "/api/guests" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate-limited" });
    expect(limited.headers["retry-after"]).toBe("720");
    now += 720_000;
    expect((await app.inject({ method: "POST", url: "/api/guests" })).statusCode).toBe(201);
  });

  it("the guest limit is keyed on the client IP", async () => {
    const { app } = await server(SLICE, { guestsPerIp: { capacity: 1, refillPerSec: 0.001 } });
    const from = (remoteAddress: string) =>
      app.inject({ method: "POST", url: "/api/guests", remoteAddress });
    expect((await from("10.0.0.1")).statusCode).toBe(201);
    expect((await from("10.0.0.1")).statusCode).toBe(429);
    expect((await from("10.0.0.2")).statusCode).toBe(201);
  });
});

describe("the server-side tap ceiling", () => {
  const tap = (clientElapsedMs: number, count = 10_000): Action => ({
    type: "TAP",
    count,
    clientElapsedMs,
  });
  const stacksOf = async (): Promise<number> =>
    deserializeWorld(JSON.stringify((await onlyWorld()).state)).tapStacks;
  const flushMs = async (): Promise<number | null> =>
    (
      await db.query<{ ms: number | null }>(
        "select round(extract(epoch from last_tap_flush_at) * 1000)::float8 as ms from player_worlds",
      )
    )[0]!.ms;
  const maxStacks = (store: ContentStore) => store.current.content.bundle.tap.maxStacks;

  it("1. a TAP claiming 60,000 ms two seconds after creation applies at most 40 taps and logs 2,000 ms", async () => {
    const { app, store } = await server();
    const token = await createGuest(app);
    now = T0 + 2_000;
    const res = await postActions(app, token, {
      idempotencyKey: "t1",
      baseVersion: 0,
      actions: [tap(60_000)],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stacksOf()).toBe(Math.min(40, maxStacks(store)));
    expect((await logRows())[0]!.actions).toEqual([tap(2_000)]);
    expect(await flushMs()).toBe(now);
  });

  it("2. later batches get only the time since the last flush", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    const logged: Action[][] = [];
    for (const [i, at] of [2_000, 3_000, 4_000].entries()) {
      now = T0 + at;
      const res = await postActions(app, token, {
        idempotencyKey: `t${i}`,
        baseVersion: i,
        actions: [tap(60_000)],
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    for (const row of await logRows()) logged.push(row.actions);
    expect(logged).toEqual([[tap(2_000)], [tap(1_000)], [tap(1_000)]]);
  });

  it("the budget is spent in order across a batch's TAPs, and never goes negative", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 1_000;
    const res = await postActions(app, token, {
      idempotencyKey: "multi",
      baseVersion: 0,
      actions: [tap(600), tap(600), tap(600)],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await logRows())[0]!.actions).toEqual([tap(600), tap(400), tap(0)]);
  });

  it("3. a batch without a TAP leaves the column alone", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const res = await postActions(app, token, {
      idempotencyKey: "n",
      baseVersion: 0,
      actions: [BUY_MINER],
    });
    expect(res.statusCode).toBe(200);
    expect(await flushMs()).toBeNull();
  });

  it("a rejected batch leaves the column alone, and a replayed key does not move it", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 5_000;
    const rejected = await postActions(app, token, {
      idempotencyKey: "r",
      baseVersion: 0,
      actions: [tap(100), BUY_1000_MINERS],
    });
    expect(rejected.statusCode).toBe(409);
    expect(await flushMs()).toBeNull();
    const ok = { idempotencyKey: "ok", baseVersion: 0, actions: [tap(100)] };
    await postActions(app, token, ok);
    const first = await flushMs();
    now += 10_000;
    await postActions(app, token, ok);
    expect(await flushMs()).toBe(first);
  });
});
