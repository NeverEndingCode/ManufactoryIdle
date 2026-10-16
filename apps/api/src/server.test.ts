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
import { buildServer, guestAuth } from "./server.js";

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
function countingDb(inner: Db): Db & { transactions: number } {
  const wrapped = {
    transactions: 0,
    query: inner.query.bind(inner),
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      wrapped.transactions += 1;
      return inner.transaction(fn);
    },
    close: () => inner.close(),
  };
  return wrapped;
}

let db: Db & { transactions: number };
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
  await db.close();
});

async function server(dir: string = SLICE): Promise<{ app: FastifyInstance; store: ContentStore }> {
  const store = await openContentStore(db, dir);
  const app = buildServer({ db, content: store, clock, auth: guestAuth(db) });
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
}

async function worldRows(): Promise<WorldRowView[]> {
  return db.query<WorldRowView>(
    `select state, state_version::text as state_version, content_version, schema_version,
            round(extract(epoch from last_resolved_at) * 1000)::float8 as last_resolved_at_ms
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
    const stored = deserializeWorld(JSON.stringify(row.state));
    // The integer seed is not recoverable from the PRNG state, so the stored seed is
    // substituted into an otherwise-independent initialWorld; every other field must match.
    const expected: WorldState = { ...initialWorld(content, 0, T0), seed: stored.seed };
    expect(row.state).toEqual(wire(expected));
    expect(body.world.state).toEqual(wire(expected));
    expect(body.world.schedule).toEqual(schedule(expected, content));
    expect(body.world.stateVersion).toBe(0);
    expect(body.world.contentVersion).toBe(store.current.version);
    expect(row.state_version).toBe("0");
    expect(row.content_version).toBe(store.current.version);
    expect(row.last_resolved_at_ms).toBe(T0);
    expect(row.schema_version).toBe(expected.schemaVersion);

    const players = await db.query<{ guest_token: string }>("select guest_token from players");
    expect(players).toEqual([{ guest_token: body.guestToken }]);

    // A second guest gets its own seed (a fresh random draw, not a constant).
    await createGuest(app);
    const seeds = (await worldRows()).map((r) => (r.state as { seed: unknown }).seed);
    expect(seeds[0]).not.toEqual(seeds[1]);
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

    expect(await logRows()).toEqual([
      { actions: [BUY_MINER], idempotency_key: "k-1", created_at_ms: now },
    ]);
    const players = await db.query<{ ms: number }>(
      "select round(extract(epoch from last_seen_at) * 1000)::float8 as ms from players",
    );
    expect(players).toEqual([{ ms: now }]);
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
});

describe("auth", () => {
  it("6. a missing or unknown guest token is a 401", async () => {
    const { app } = await server();
    await createGuest(app);
    const body = { idempotencyKey: "k", baseVersion: 0, actions: [BUY_MINER] };

    expect((await app.inject({ method: "GET", url: "/api/world" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/actions", payload: body })).statusCode,
    ).toBe(401);

    const unknown = guest("not-a-real-token");
    expect(
      (await app.inject({ method: "GET", url: "/api/world", headers: unknown })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/actions", headers: unknown, payload: body }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/world",
          headers: { authorization: "Bearer x" },
        })
      ).statusCode,
    ).toBe(401);
    expect((await onlyWorld()).state_version).toBe("0");
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
  it("8. replaying action_log from the initial state reproduces the stored state", async () => {
    const { app, store } = await server();
    const token = await createGuest(app);
    const initial = await storedState();
    const content = store.current.content;

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

    const log = await logRows();
    expect(log.map((r) => r.created_at_ms)).toEqual(steps.map(([at]) => T0 + at));
    let state = initial;
    for (const row of log) {
      const resolved = resolve(state, content, row.created_at_ms - state.lastResolvedAt);
      const batch = applyBatch(resolved.state, content, row.actions, resolved.state.seed);
      if (batch.rejected) throw new Error(`replay rejected: ${batch.reason}`);
      state = batch.state;
    }
    const row = await onlyWorld();
    expect(row.state_version).toBe("3");
    expect(serializeWorld(state)).toBe(serializeWorld(deserializeWorld(JSON.stringify(row.state))));
    expect(serializeWorld(state)).not.toBe(serializeWorld(initial));
  });
});
