import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pgliteDb } from "./pglite.js";
import { migrate } from "./migrate.js";
import type { Db } from "./db.js";

let db: Db;
beforeEach(async () => {
  db = await pgliteDb();
});
afterEach(async () => {
  await db?.close();
});

const TABLES = [
  "action_log",
  "content_versions",
  "idempotency",
  "player_worlds",
  "players",
  "sessions",
];

describe("migrate", () => {
  it("applies the migrations and creates all six tables", async () => {
    expect(await migrate(db)).toEqual(["001-initial.sql", "002-anticheat.sql"]);
    const rows = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1) order by table_name`,
      [TABLES],
    );
    expect(rows.map((r) => r.table_name)).toEqual(TABLES);
  });

  it("is idempotent: a second run applies nothing", async () => {
    await migrate(db);
    expect(await migrate(db)).toEqual([]);
    const rows = await db.query("select * from schema_migrations");
    expect(rows).toHaveLength(2);
  });

  it("players check requires exactly one identifier", async () => {
    await migrate(db);
    await expect(
      db.query("insert into players (id) values ($1)", [crypto.randomUUID()]),
    ).rejects.toThrow();
    await expect(
      db.query(
        "insert into players (id, supertokens_user_id, guest_token) values ($1, 'a', 'b')",
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow();
    await db.query("insert into players (id, guest_token) values ($1, 'g')", [
      crypto.randomUUID(),
    ]);
  });

  it("player_worlds treats null expedition_id as equal for uniqueness", async () => {
    await migrate(db);
    const pid = crypto.randomUUID();
    await db.query("insert into players (id, guest_token) values ($1, 'g')", [pid]);
    await db.query(
      "insert into content_versions (version, checksum, bundle) values ('v1', 'c', '{}')",
    );
    const ins = () =>
      db.query(
        `insert into player_worlds (id, player_id, content_version, state, last_resolved_at, schema_version,
                                    initial_seed, created_at, initial_content_version)
         values ($1, $2, 'v1', '{}', now(), 1, 0, now(), 'v1')`,
        [crypto.randomUUID(), pid],
      );
    await ins();
    await expect(ins()).rejects.toThrow();
  });
  it("idempotency keys are per player: two players can store the same key", async () => {
    await migrate(db);
    const ins = (pid: string) =>
      db.query("insert into idempotency (player_id, key, response) values ($1, 'k', '{}')", [pid]);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await ins(a);
    await ins(b);
    await expect(ins(a)).rejects.toThrow();
    await expect(
      db.query("insert into idempotency (key, response) values ('k2', '{}')"),
    ).rejects.toThrow();
  });

  it("sessions allows at most one open session per player", async () => {
    await migrate(db);
    const pid = crypto.randomUUID();
    await db.query("insert into players (id, guest_token) values ($1, 'g')", [pid]);
    const open = () => db.query("insert into sessions (player_id) values ($1)", [pid]);
    await open();
    await expect(open()).rejects.toThrow();
    await db.query("update sessions set closed_at = now() where player_id = $1", [pid]);
    await open();
    await db.query("insert into sessions (player_id, closed_at) values ($1, now())", [pid]);
    const rows = await db.query("select 1 from sessions where player_id = $1", [pid]);
    expect(rows).toHaveLength(3);
  });
});

describe("failing migration", () => {
  it("records nothing and leaves no effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    try {
      await copyFile(
        new URL("../../migrations/001-initial.sql", import.meta.url),
        join(dir, "001-initial.sql"),
      );
      await writeFile(
        join(dir, "002-bad.sql"),
        "create table bad_table (id int); select * from no_such_table;",
      );
      await expect(migrate(db, dir)).rejects.toThrow();
      const rows = await db.query<{ version: string }>("select version from schema_migrations");
      expect(rows.map((r) => r.version)).toEqual(["001-initial.sql"]);
      const bad = await db.query(
        "select 1 from information_schema.tables where table_name = 'bad_table'",
      );
      expect(bad).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("002 backfills action_log.content_version", () => {
  it("existing rows take their world's version, and the column is then not null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mig-"));
    try {
      const src = (f: string) => new URL(`../../migrations/${f}`, import.meta.url);
      await copyFile(src("001-initial.sql"), join(dir, "001-initial.sql"));
      await migrate(db, dir);
      const pid = crypto.randomUUID();
      const wid = crypto.randomUUID();
      await db.query("insert into players (id, guest_token) values ($1, 'g')", [pid]);
      await db.query(
        "insert into content_versions (version, checksum, bundle) values ('v1', 'c', '{}'), ('v2', 'c', '{}')",
      );
      await db.query(
        `insert into player_worlds (id, player_id, content_version, state, last_resolved_at, schema_version,
                                    initial_seed, created_at, initial_content_version)
         values ($1, $2, 'v2', '{}', now(), 1, 0, now(), 'v1')`,
        [wid, pid],
      );
      await db.query("insert into action_log (player_id, world_id, actions) values ($1, $2, '[]')", [
        pid,
        wid,
      ]);
      await copyFile(src("002-anticheat.sql"), join(dir, "002-anticheat.sql"));
      expect(await migrate(db, dir)).toEqual(["002-anticheat.sql"]);
      const rows = await db.query<{ content_version: string }>("select content_version from action_log");
      expect(rows).toEqual([{ content_version: "v2" }]);
      await expect(
        db.query("insert into action_log (player_id, world_id, actions) values ($1, $2, '[]')", [pid, wid]),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("transaction", () => {
  it("rolls back on throw", async () => {
    await migrate(db);
    await expect(
      db.transaction(async (tx) => {
        await tx.query("insert into players (id, guest_token) values ($1, 'g')", [
          crypto.randomUUID(),
        ]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("select * from players")).toHaveLength(0);
  });

  it("commits on resolve and nested calls reuse the transaction", async () => {
    await migrate(db);
    await db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.query("insert into players (id, guest_token) values ($1, 'g')", [
          crypto.randomUUID(),
        ]);
      });
    });
    expect(await db.query("select * from players")).toHaveLength(1);
  });
});
