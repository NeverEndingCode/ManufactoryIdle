import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bundleChecksum, loadBundleDir } from "@manufactory/content";
import {
  applyBatch,
  deserializeWorld,
  indexContent,
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
import { replayWorld, resolvePrefixes } from "./worlds.js";

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
  extra: Partial<ServerDeps> = {},
): Promise<{ app: FastifyInstance; store: ContentStore }> {
  const store = await openContentStore(db, dir);
  const app = buildServer({ db, content: store, clock, auth: guestAuth(db), limits, ...extra });
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
    expect(res.json()).toEqual({ ok: true, contentChecksum: store.current.version, accounts: false });
  });

  it("reports accounts: true when an accounts core is wired", async () => {
    const { app } = await server(SLICE, undefined, {
      accounts: { register() {}, handleError: async () => false },
    });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.json()).toHaveProperty("accounts", true);
  });
});

describe("GET /api/content/:checksum", () => {
  it("serves the current bundle, immutable, with no authorization", async () => {
    const { app, store } = await server();
    const res = await app.inject({ method: "GET", url: `/api/content/${store.current.version}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(() => indexContent(res.json())).not.toThrow();
    expect(bundleChecksum(res.json())).toBe(store.current.version);
  });

  it("serves an older pinned version after the server restarts on newer content", async () => {
    const old = await server(FIXTURE);
    const fresh = await server(SLICE);
    for (const v of [old.store.current.version, fresh.store.current.version]) {
      const res = await fresh.app.inject({ method: "GET", url: `/api/content/${v}` });
      expect(res.statusCode).toBe(200);
      expect(bundleChecksum(res.json())).toBe(v);
    }
  });

  it("memoises the body per checksum, and does not memoise misses (Q-16)", async () => {
    const { app, store } = await server();
    let selects = 0;
    const query = db.query.bind(db);
    db.query = ((sql: string, params?: unknown[]) => {
      if (sql.includes("select bundle from content_versions")) selects += 1;
      return query(sql, params);
    }) as Db["query"];
    const url = `/api/content/${store.current.version}`;
    const a = await app.inject({ method: "GET", url });
    const b = await app.inject({ method: "GET", url });
    expect(selects).toBe(1);
    expect(a.statusCode).toBe(200);
    expect(b.body).toBe(a.body);
    expect(b.headers["cache-control"]).toBe(a.headers["cache-control"]);
    selects = 0;
    for (let i = 0; i < 2; i++) {
      const miss = await app.inject({ method: "GET", url: `/api/content/${"0".repeat(64)}` });
      expect(miss.statusCode).toBe(404);
    }
    expect(selects).toBe(2);
  });

  it("answers 404 for an unknown or malformed checksum", async () => {
    const { app } = await server();
    for (const v of ["0".repeat(64), "not-hex"]) {
      const res = await app.inject({ method: "GET", url: `/api/content/${v}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "unknown content" });
    }
  });
});

describe("persistedAtMs", () => {
  it("is the creation time on POST /api/guests", async () => {
    const { app } = await server();
    const res = await app.inject({ method: "POST", url: "/api/guests" });
    expect((res.json() as { world: { persistedAtMs: number } }).world.persistedAtMs).toBe(T0);
  });

  it("stays at the stored time on GET, and moves with a successful action", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const get = await app.inject({ method: "GET", url: "/api/world", headers: guest(token) });
    const view = get.json() as { persistedAtMs: number; schedule: { atMs: number } };
    expect(view.persistedAtMs).toBe(T0);
    expect(Math.abs(view.schedule.atMs - (T0 + 10 * MINUTE))).toBeLessThan(MINUTE);

    const act = await postActions(app, token, {
      idempotencyKey: "k-p",
      baseVersion: 0,
      actions: [BUY_MINER],
    });
    expect(act.statusCode).toBe(200);
    expect((act.json() as { persistedAtMs: number }).persistedAtMs).toBe(now);
    now = T0 + 20 * MINUTE;
    const again = await app.inject({ method: "GET", url: "/api/world", headers: guest(token) });
    const persisted = (again.json() as { persistedAtMs: number }).persistedAtMs;
    expect(persisted).toBe(T0 + 10 * MINUTE);
    expect(persisted).toBe((await onlyWorld()).last_resolved_at_ms);
  });

  it("survives an idempotent replay byte for byte", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    now = T0 + 10 * MINUTE;
    const body = { idempotencyKey: "k-r", baseVersion: 0, actions: [BUY_MINER] };
    const first = await postActions(app, token, body);
    now = T0 + 15 * MINUTE;
    const replay = await postActions(app, token, body);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { persistedAtMs: number }).persistedAtMs).toBe(T0 + 10 * MINUTE);
    expect(replay.body).toBe(first.body);
  });
});

describe("POST /api/guests", () => {
  it("1. creates one player and one initialWorld at the clock's now", async () => {
    const { app, store } = await server();
    const res = await app.inject({ method: "POST", url: "/api/guests" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      guestToken: string;
      world: { state: unknown; schedule: unknown; stateVersion: number; contentChecksum: string };
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
    expect(body.world.contentChecksum).toBe(store.current.version);
    expect(body.world).not.toHaveProperty("contentVersion"); // R-22: renamed, not duplicated
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

describe("GET /api/world on a tier-8 world (PL-2)", () => {
  // The reinforced-full world trips the MAX_EVENTS guard on any window past ~27 µs, so every
  // GET from its stored state used to pay ~0.3 s. The first GET keeps its fine-step prefix;
  // the rest resume from it. Every answer must still be a cold resolve's, byte for byte.
  const fixture = readFileSync(
    fileURLToPath(
      new URL("../../../packages/engine/src/resolve/fixtures/slice-tier-8-reinforced-full.world.json", import.meta.url),
    ),
    "utf8",
  );
  const start = () => deserializeWorld(fixture);

  it("resumes a kept prefix, and every GET and POST still matches a cold resolve", { timeout: 60_000 }, async () => {
    const t = start().lastResolvedAt;
    now = t;
    const { app, store } = await server();
    const token = await createGuest(app);
    await db.query("update player_worlds set state = $1::jsonb, last_resolved_at = to_timestamp($2 / 1000.0)", [
      fixture,
      t,
    ]);
    const [row] = await db.query<{ id: string; content_version: string }>(
      "select id, content_version from player_worlds",
    );
    const key = `${row!.id}:0:${row!.content_version}`;
    const content = store.current.content;
    expect(resolvePrefixes.get(key)).toBeUndefined();

    for (const gap of [60_000, 61_000, 3_600_000]) {
      now = t + gap;
      const res = await app.inject({ method: "GET", url: "/api/world", headers: guest(token) });
      expect(res.statusCode).toBe(200);
      const cold = resolve(start(), content, gap);
      expect(cold.summary.guardTripped).toBe(true);
      const body = res.json() as { state: unknown; schedule: unknown };
      expect(JSON.stringify(body.state)).toBe(JSON.stringify(wire(cold.state)));
      expect(body.schedule).toEqual(schedule(cold.state, content));
      expect(resolvePrefixes.get(key)).toBeDefined();
    }

    // A batch resolves from the same stored state, so it resumes too, and stores what a cold
    // resolve would have; the next GET is keyed on the new state version.
    now = t + 120_000;
    const tap: Action = { type: "TAP", count: 1, clientElapsedMs: 1_000 };
    const res = await postActions(app, token, { idempotencyKey: "k", baseVersion: 0, actions: [tap] });
    expect(res.statusCode, res.body).toBe(200);
    const resolved = resolve(start(), content, 120_000);
    const batch = applyBatch(resolved.state, content, [tap], resolved.state.seed);
    if (batch.rejected) throw new Error(batch.reason);
    expect(serializeWorld(await storedState())).toBe(serializeWorld(batch.state));
    expect((res.json() as { summary: unknown }).summary).toEqual(resolved.summary);

    now = t + 180_000;
    const after = await app.inject({ method: "GET", url: "/api/world", headers: guest(token) });
    const cold = resolve(batch.state, content, 60_000);
    expect(JSON.stringify((after.json() as { state: unknown }).state)).toBe(JSON.stringify(wire(cold.state)));
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
    // A regression tripwire, not a live race: afterRollback fires only when a transaction
    // throws, and today the rejection commits its 409, so the hook never runs and `raced`
    // stays undefined. It fires again only if someone moves the 409 back out of the lock.
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
      contentChecksum: string;
    };
    expect(body.contentChecksum).toBe(bundleChecksum(loadBundleDir(FIXTURE)));
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

describe("the tap flush is monotonic", () => {
  it("a batch stamped earlier than the last flush (a clock step back) never moves it back", async () => {
    const { app } = await server();
    const token = await createGuest(app);
    const flushMs = async () =>
      (
        await db.query<{ ms: number }>(
          "select round(extract(epoch from last_tap_flush_at) * 1000)::float8 as ms from player_worlds",
        )
      )[0]!.ms;
    const tap: Action = { type: "TAP", count: 1, clientElapsedMs: 50 };
    now = T0 + 5_000;
    expect((await postActions(app, token, { idempotencyKey: "a", baseVersion: 0, actions: [tap] })).statusCode).toBe(200);
    now = T0 + 3_000;
    const back = await postActions(app, token, { idempotencyKey: "b", baseVersion: 1, actions: [tap] });
    expect(back.statusCode, back.body).toBe(200);
    expect(await flushMs()).toBe(T0 + 5_000);
  });
});

describe("trustProxy", () => {
  const fromProxy = (app: FastifyInstance, client: string) =>
    app.inject({
      method: "POST",
      url: "/api/guests",
      remoteAddress: "10.9.9.9",
      headers: { "x-forwarded-for": client },
    });
  const oneGuestPerIp = { guestsPerIp: { capacity: 1, refillPerSec: 0.001 } };

  it("unset: every guest behind a proxy shares the proxy's bucket", async () => {
    const { app } = await server(SLICE, oneGuestPerIp);
    expect((await fromProxy(app, "1.1.1.1")).statusCode).toBe(201);
    expect((await fromProxy(app, "2.2.2.2")).statusCode).toBe(429);
  });

  it("set: the guest limit keys on the forwarded client address", async () => {
    const { app } = await server(SLICE, oneGuestPerIp, { trustProxy: "10.9.9.9" });
    expect((await fromProxy(app, "1.1.1.1")).statusCode).toBe(201);
    expect((await fromProxy(app, "2.2.2.2")).statusCode).toBe(201);
    expect((await fromProxy(app, "1.1.1.1")).statusCode).toBe(429);
  });
});

describe("POST /api/admin/migrate-world (D.6)", () => {
  const ADMIN = "correct horse battery staple";
  const admin = (token = ADMIN) => ({ authorization: `Admin ${token}` });
  const migrateWorld = (app: FastifyInstance, headers: Record<string, string>, payload: object) =>
    app.inject({ method: "POST", url: "/api/admin/migrate-world", headers, payload });

  /** A copy of the slice with the iron miner's output changed: the same ids, other numbers. */
  async function publishVariant(rate: string): Promise<{ version: string; content: IndexedContent }> {
    const bundle = structuredClone(loadBundleDir(SLICE));
    const miner = bundle.recipes.find((r) => r.id === "mine_iron_ore")!;
    miner.outputs[0]!.rate = rate;
    // A new label too: the engine's expansion cache keys on the label, so changed numbers
    // under an old label are refused (see the relabel test below).
    bundle.version = `${bundle.version}-rate-${rate}`;
    const version = bundleChecksum(bundle);
    await db.query(
      "insert into content_versions (version, checksum, bundle) values ($1, $1, $2::jsonb)",
      [version, JSON.stringify(bundle)],
    );
    return { version, content: indexContent(bundle) };
  }

  async function playerId(): Promise<string> {
    return (await db.query<{ id: string }>("select id from players"))[0]!.id;
  }

  it("refuses a target with the world's bundle label but another checksum, and sets state.contentVersion on a real re-pin", async () => {
    const { app } = await server(SLICE, undefined, { adminToken: ADMIN });
    await createGuest(app);
    const pid = await playerId();
    // Same label, other numbers: published directly, as only a rogue writer could.
    const bundle = structuredClone(loadBundleDir(SLICE));
    bundle.recipes.find((r) => r.id === "mine_iron_ore")!.outputs[0]!.rate = "77";
    const same = bundleChecksum(bundle);
    await db.query("insert into content_versions (version, checksum, bundle) values ($1, $1, $2::jsonb)", [
      same,
      JSON.stringify(bundle),
    ]);
    const before = await onlyWorld();
    const res = await migrateWorld(app, admin(), { playerId: pid, toVersion: same });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; detail: string };
    expect(body.error).toBe("incompatible-version");
    expect(body.detail).toMatch(/label/);
    expect(await onlyWorld()).toEqual(before);
    expect(await logRows()).toEqual([]);

    const variant = await publishVariant("90");
    now = T0 + 5 * MINUTE;
    expect((await migrateWorld(app, admin(), { playerId: pid, toVersion: variant.version })).statusCode).toBe(200);
    expect((await storedState()).contentVersion).toBe(variant.content.bundle.version);
  });

  it("404s when ADMIN_TOKEN is unset, so the route is not advertised", async () => {
    const { app } = await server();
    await createGuest(app);
    const res = await migrateWorld(app, admin(), { playerId: await playerId(), toVersion: "x" });
    expect(res.statusCode).toBe(404);
    const empty = await server(SLICE, undefined, { adminToken: "" });
    expect((await migrateWorld(empty.app, admin(""), { playerId: await playerId(), toVersion: "x" })).statusCode).toBe(404);
  });

  it("401s on a missing, wrong, prefixed or differently-schemed token, and changes nothing", async () => {
    const { app, store } = await server(SLICE, undefined, { adminToken: ADMIN });
    await createGuest(app);
    const { version } = await publishVariant("90");
    const before = await onlyWorld();
    const body = { playerId: await playerId(), toVersion: version };
    for (const headers of [
      {},
      admin("wrong"),
      admin(ADMIN.slice(0, -1)),
      admin(ADMIN + "x"),
      { authorization: `Guest ${ADMIN}` },
      { authorization: ADMIN },
    ]) {
      const res = await migrateWorld(app, headers, body);
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(res.json()).toEqual({ error: "unauthorized" });
    }
    // A bad token is a 401 even with a malformed body: auth runs before validation.
    expect((await migrateWorld(app, admin("wrong"), {})).statusCode).toBe(401);
    expect(await onlyWorld()).toEqual(before);
    expect(before.content_version).toBe(store.current.version);
  });

  it("400s on an unknown version, a malformed body, or content the world does not fit", async () => {
    const { app } = await server(SLICE, undefined, { adminToken: ADMIN });
    await createGuest(app);
    const fixture = await openContentStore(db, FIXTURE); // published, but other ids entirely
    const before = await onlyWorld();
    const pid = await playerId();

    const unknown = await migrateWorld(app, admin(), { playerId: pid, toVersion: "nope" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "unknown-version" });

    for (const body of [{}, { playerId: pid }, { playerId: "not-a-uuid", toVersion: "v" }, { playerId: pid, toVersion: "v", x: 1 }]) {
      expect((await migrateWorld(app, admin(), body)).statusCode, JSON.stringify(body)).toBe(400);
    }

    const misfit = await migrateWorld(app, admin(), { playerId: pid, toVersion: fixture.current.version });
    expect(misfit.statusCode).toBe(400);
    expect((misfit.json() as { error: string }).error).toBe("incompatible-version");

    expect(await onlyWorld()).toEqual(before);
    expect(await logRows()).toEqual([]);
  });

  it("404s for a player with no world", async () => {
    const { app, store } = await server(SLICE, undefined, { adminToken: ADMIN });
    const res = await migrateWorld(app, admin(), {
      playerId: crypto.randomUUID(),
      toVersion: store.current.version,
    });
    expect(res.statusCode).toBe(404);
  });

  it("re-pins content_version (never initial_content_version), logs the re-pin, and replay stays exact across it", async () => {
    const { app, store } = await server(SLICE, undefined, { adminToken: ADMIN });
    const token = await createGuest(app);
    const variant = await publishVariant("120");
    const slice = store.current;

    now = T0 + 10 * MINUTE;
    expect((await postActions(app, token, { idempotencyKey: "a", baseVersion: 0, actions: [BUY_MINER] })).statusCode).toBe(200);
    const at10 = await storedState();

    // The variant really is different content: resolving the same span on it diverges, so a
    // replay that used the wrong version for any span would not match.
    expect(serializeWorld(resolve(at10, variant.content, 5 * MINUTE).state)).not.toBe(
      serializeWorld(resolve(at10, slice.content, 5 * MINUTE).state),
    );

    now = T0 + 15 * MINUTE;
    const pid = await playerId();
    const res = await migrateWorld(app, admin(), { playerId: pid, toVersion: variant.version });
    expect(res.statusCode, res.body).toBe(200);
    const [world] = await db.query<{ id: string }>("select id from player_worlds");
    expect(res.json()).toEqual({
      playerId: pid,
      worldId: world!.id,
      fromVersion: slice.version,
      toVersion: variant.version,
      stateVersion: 2,
    });

    const row = await onlyWorld();
    expect(row.content_version).toBe(variant.version);
    expect(row.initial_content_version).toBe(slice.version);
    expect(row.state_version).toBe("2");
    // The re-pin is a batch of no actions on the new version: resolved to now, on it.
    const r = resolve(at10, variant.content, 5 * MINUTE);
    expect(row.state).toEqual(wire({ ...r.state, contentVersion: variant.content.bundle.version }));
    expect(row.last_resolved_at_ms).toBe(now);

    now = T0 + 20 * MINUTE;
    const tap: Action = { type: "TAP", count: 3, clientElapsedMs: 1500 };
    const after = await postActions(app, token, { idempotencyKey: "b", baseVersion: 2, actions: [tap] });
    expect(after.statusCode, after.body).toBe(200);
    expect((after.json() as { contentChecksum: string }).contentChecksum).toBe(variant.version);

    const log = await db.query<{ actions: Action[]; content_version: string; idempotency_key: string | null }>(
      "select actions, content_version, idempotency_key from action_log order by id",
    );
    expect(log).toEqual([
      { actions: [BUY_MINER], content_version: slice.version, idempotency_key: "a" },
      { actions: [], content_version: variant.version, idempotency_key: null },
      { actions: [tap], content_version: variant.version, idempotency_key: "b" },
    ]);
    const replayed = await replayWorld(db, store, world!.id);
    expect(serializeWorld(replayed)).toBe(serializeWorld(await storedState()));
  });
});

describe("the error handler", () => {
  class Teapot extends Error {
    statusCode = 418;
  }
  function withRoutes(extra: Partial<ServerDeps> = {}) {
    return server(SLICE, undefined, {
      accounts: {
        register(instance) {
          instance.get("/x/teapot", async () => {
            throw new Teapot("internal detail: table players, row 7");
          });
          instance.get("/x/boom", async () => {
            throw new Error("kaboom");
          });
        },
        handleError: async () => false,
      },
      ...extra,
    });
  }

  it("a 4xx that isn't Fastify's own gets a generic message, never the error's", async () => {
    const { app } = await withRoutes();
    const res = await app.inject({ method: "GET", url: "/x/teapot" });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: "request failed" });
    // Fastify's own 4xx messages are written for clients and pass through.
    const bad = await app.inject({
      method: "POST",
      url: "/api/actions",
      headers: { ...guest(await createGuest(app)), "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).not.toBe("request failed");
  });

  it("uses a ready-made logger instance (loggerInstance), and logs a 500 to it", async () => {
    const lines: { level: string; args: unknown[] }[] = [];
    const logger = {
      level: "info",
      child() {
        return logger;
      },
      ...Object.fromEntries(
        ["trace", "debug", "info", "warn", "error", "fatal", "silent"].map((level) => [
          level,
          (...args: unknown[]) => void lines.push({ level, args }),
        ]),
      ),
    } as unknown as NonNullable<ServerDeps["logger"]>;
    const { app } = await withRoutes({ logger });
    expect(app.log).toBe(logger);
    const res = await app.inject({ method: "GET", url: "/x/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
    const logged = lines.filter((l) => l.level === "error").flatMap((l) => l.args);
    expect(logged.some((a) => a instanceof Error && a.message === "kaboom")).toBe(true);
  });
});

describe("resolve cost (spec 3c, Resolve-cost DoS)", () => {
  it("a world idle for a year resolves within the offline cap, in bounded time", async () => {
    const { app, store } = await server();
    const token = await createGuest(app);
    const initial = await storedState();
    now = T0 + 365 * 24 * 60 * MINUTE;
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/api/world", headers: guest(token) });
    const tookMs = Date.now() - started;
    expect(res.statusCode).toBe(200);
    // A budget against a runaway resolve (MAX_EVENTS), not a performance target.
    expect(tookMs).toBeLessThan(10_000);
    // The year counts only up to the offline cap: the same as resolving exactly the cap.
    const capMs = store.current.content.offlineCapMs;
    expect(capMs).toBeLessThan(365 * 24 * 60 * MINUTE);
    const capped = resolve(initial, store.current.content, capMs).state;
    expect((res.json() as { state: { stored: unknown } }).state.stored).toEqual(
      (wire(capped) as { stored: unknown }).stored,
    );
  });
});
