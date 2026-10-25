// Real-Postgres tests (spec R-2): what PGlite, a single connection, cannot show. Skipped unless
// DATABASE_URL is set; CI's `api-integration` job runs them against a postgres:16 service.
// Each test gets a fresh schema (every pool it opens sets search_path to it), dropped after,
// so the tests share nothing and can run against any scratch database.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { serializeWorld, deserializeWorld, type Action } from "@manufactory/engine";
import type { Db } from "./db/db.js";
import { pgDb, type PgDbOptions } from "./db/pg.js";
import { migrate } from "./db/migrate.js";
import { openContentStore, type ContentStore } from "./content.js";
import { buildServer, guestAuth } from "./server.js";
import { identityAuth, type SessionVerifier } from "./identity.js";
import { replayWorld } from "./worlds.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SLICE = fileURLToPath(
  new URL("../../../packages/content/bundles/vertical-slice", import.meta.url),
);
const T0 = 1_760_000_000_000;
const MINUTE = 60_000;
const MIGRATIONS = ["001-initial.sql", "002-anticheat.sql", "003-claim-idempotency.sql"];

// Test-only fake session: whatever the x-test-user header says (as in identity.test.ts).
const verifySession: SessionVerifier = async (request) => {
  const h = request.headers["x-test-user"];
  return typeof h === "string" ? h : null;
};

describe.skipIf(!DATABASE_URL)("on real Postgres", () => {
  let schema: string;
  let root: Db; // no search_path: creates and drops the schema, and watches pg_stat_activity
  let pools: Db[];
  let apps: FastifyInstance[];
  let now: number;
  const clock = () => now;

  beforeEach(async () => {
    schema = `t_${randomBytes(6).toString("hex")}`;
    root = pgDb(DATABASE_URL!, { max: 2 });
    await root.query(`create schema ${schema}`);
    pools = [];
    apps = [];
    now = T0;
  });
  afterEach(async () => {
    for (const app of apps) await app.close();
    for (const pool of pools) await pool.close();
    await root.query(`drop schema if exists ${schema} cascade`);
    await root.close();
  });

  /** A new pool on this test's schema. */
  function pool(opts: PgDbOptions = {}): Db {
    const db = pgDb(DATABASE_URL!, { schema, ...opts });
    pools.push(db);
    return db;
  }

  async function serverOn(
    db: Db,
    accounts = false,
  ): Promise<{ app: FastifyInstance; store: ContentStore }> {
    const store = await openContentStore(db, SLICE);
    const app = buildServer({
      db,
      content: store,
      clock,
      auth: accounts ? identityAuth({ db, content: store, clock, verifySession }) : guestAuth(db),
      ...(accounts ? { verifySession } : {}),
    });
    apps.push(app);
    return { app, store };
  }

  /** Polls until `n` backends in this database are waiting on a lock (10 s at most). */
  async function lockWaiters(n: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await root.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (row!.n >= n) return;
      if (Date.now() > deadline) throw new Error(`expected ${n} lock waiters, saw ${row!.n}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** A promise and the function that settles it. */
  function signal(): { promise: Promise<void>; fire: () => void } {
    let fire!: () => void;
    const promise = new Promise<void>((r) => (fire = r));
    return { promise, fire };
  }

  it("migrations apply on Postgres 16+, and two pools migrating at once apply each file once", async () => {
    const a = pool();
    const b = pool();
    const [version] = await a.query<{ server_version_num: string }>("show server_version_num");
    expect(Number(version!.server_version_num)).toBeGreaterThanOrEqual(160_000);

    // The advisory lock serializes them; the loser re-checks under it and skips.
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    expect([...ra, ...rb].sort()).toEqual(MIGRATIONS);
    expect(await migrate(a)).toEqual([]);
    const tables = await a.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = $1 order by table_name`,
      [schema],
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      "action_log",
      "content_versions",
      "idempotency",
      "player_worlds",
      "players",
      "schema_migrations",
      "sessions",
    ]);
  });

  it("two concurrent POST /api/actions on one world serialize: the second sees the first", async () => {
    await migrate(pool());
    const a = await serverOn(pool());
    const b = await serverOn(pool());
    const created = await a.app.inject({ method: "POST", url: "/api/guests" });
    const token = (created.json() as { guestToken: string }).guestToken;
    now = T0 + 10 * MINUTE;

    // Hold the world's row lock from a third connection, so both requests are certainly
    // in flight together, blocked on the FOR UPDATE, before either can run.
    const holder = pool({ max: 1 });
    const locked = signal();
    const release = signal();
    const holding = holder.transaction(async (tx) => {
      await tx.query("select 1 from player_worlds for update");
      locked.fire();
      await release.promise;
    });
    await locked.promise;

    const tap = (ms: number): Action => ({ type: "TAP", count: 3, clientElapsedMs: ms });
    const post = (app: FastifyInstance, key: string) =>
      app.inject({
        method: "POST",
        url: "/api/actions",
        headers: { authorization: `Guest ${token}` },
        payload: { idempotencyKey: key, baseVersion: 0, actions: [tap(1500)] },
      });
    let responses: Awaited<ReturnType<typeof post>>[];
    try {
      const pending = Promise.all([post(a.app, "from-a"), post(b.app, "from-b")]);
      await lockWaiters(2);
      release.fire();
      await holding;
      responses = await pending;
    } finally {
      release.fire(); // a failed wait must not leave the holder blocking pool.end()
    }

    for (const res of responses) expect(res.statusCode, res.body).toBe(200);
    const bodies = responses.map((r) => r.json() as { stateVersion: number; state: unknown });
    expect(bodies.map((x) => x.stateVersion).sort()).toEqual([1, 2]);
    const [row] = await root.query<{ state: unknown; state_version: string; id: string }>(
      `select id, state, state_version::text as state_version from ${schema}.player_worlds`,
    );
    expect(row!.state_version).toBe("2");
    const log = await root.query(`select 1 from ${schema}.action_log`);
    expect(log).toHaveLength(2);
    // The second applied on top of the first: its answer is the stored state, and the log
    // (both batches, in order) replays to it exactly.
    const second = bodies.find((x) => x.stateVersion === 2)!;
    expect(second.state).toEqual(row!.state);
    const replayed = await replayWorld(pool(), a.store, row!.id);
    expect(serializeWorld(replayed)).toBe(serializeWorld(deserializeWorld(JSON.stringify(row!.state))));
  });

  it("the pg adapter destroys a client whose COMMIT failed", async () => {
    // Provoked cheaply with a deferred foreign key, which is checked only at COMMIT.
    const db = pool({ max: 1 }); // one client, so a kept client would be the same backend
    await db.query(
      `create table deferred_fk (
         id int primary key,
         ref int references deferred_fk (id) deferrable initially deferred
       )`,
    );
    const backend = async () =>
      (await db.query<{ pid: number }>("select pg_backend_pid() as pid"))[0]!.pid;
    const first = await backend();
    await db.transaction(async (tx) => {
      await tx.query("insert into deferred_fk values (1, 1)");
    });
    expect(await backend()).toBe(first); // a good COMMIT keeps the client

    await expect(
      db.transaction(async (tx) => {
        await tx.query("insert into deferred_fk values (2, 99)");
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await backend()).not.toBe(first); // destroyed, so the pool opened a new one
    expect(await db.query("select id from deferred_fk order by id")).toEqual([{ id: 1 }]);
  });

  it("concurrent first requests for one account, across two pools, make one player (R-17)", async () => {
    await migrate(pool());
    const a = await serverOn(pool(), true);
    const b = await serverOn(pool(), true);
    const get = (app: FastifyInstance) =>
      app.inject({ method: "GET", url: "/api/world", headers: { "x-test-user": "u-lazy" } });
    const responses = await Promise.all([get(a.app), get(b.app), get(a.app), get(b.app)]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    const players = await root.query(
      `select 1 from ${schema}.players where supertokens_user_id = 'u-lazy'`,
    );
    expect(players).toHaveLength(1);
    expect(await root.query(`select 1 from ${schema}.player_worlds`)).toHaveLength(1);
  });

  it("a claim racing the account's lazy creation gets 409 and leaves one player", async () => {
    await migrate(pool());
    // The lazy-creation server's next transaction pauses before COMMIT, holding its
    // uncommitted player row, until released.
    const inner = pool();
    let hold: { reached: () => void; released: Promise<void> } | null = null;
    const gated: Db = {
      query: (sql, params) => inner.query(sql, params),
      transaction: (fn) =>
        inner.transaction(async (tx) => {
          const result = await fn(tx);
          if (hold) {
            const h = hold;
            hold = null;
            h.reached();
            await h.released;
          }
          return result;
        }),
      close: () => inner.close(),
    };
    const lazyServer = await serverOn(gated, true);
    const claimServer = await serverOn(pool(), true);
    const created = await claimServer.app.inject({ method: "POST", url: "/api/guests" });
    const token = (created.json() as { guestToken: string }).guestToken;

    const reached = signal();
    const released = signal();
    hold = { reached: reached.fire, released: released.promise };
    const lazy = lazyServer.app.inject({
      method: "GET",
      url: "/api/world",
      headers: { "x-test-user": "u-race" },
    });
    await reached.promise; // the account's player is inserted, not yet committed

    // The claim sees no account player yet, locks the guest, and its update then waits on
    // the uncommitted insert's unique key. Once that commits, the update fails: a 409.
    const claim = claimServer.app.inject({
      method: "POST",
      url: "/api/auth/claim",
      headers: { "x-test-user": "u-race" },
      payload: { guestToken: token },
    });
    await lockWaiters(1);
    released.fire();
    const [lazyRes, claimRes] = await Promise.all([lazy, claim]);

    expect(lazyRes.statusCode, lazyRes.body).toBe(200);
    expect(claimRes.statusCode, claimRes.body).toBe(409);
    expect(claimRes.json()).toEqual({ error: "already-has-world" });
    const accounts = await root.query(
      `select 1 from ${schema}.players where supertokens_user_id = 'u-race'`,
    );
    expect(accounts).toHaveLength(1);
    const guests = await root.query(
      `select 1 from ${schema}.players where guest_token is not null and supertokens_user_id is null`,
    );
    expect(guests).toHaveLength(1);
    const guestWorld = await claimServer.app.inject({
      method: "GET",
      url: "/api/world",
      headers: { authorization: `Guest ${token}` },
    });
    expect(guestWorld.statusCode).toBe(200);
  });
});
