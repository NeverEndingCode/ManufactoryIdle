import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pgliteDb } from "./pglite.js";
import { migrate } from "./migrate.js";
import type { Db } from "./db.js";

let db: Db;
beforeEach(async () => {
  db = await pgliteDb();
});
afterEach(async () => {
  await db.close();
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
  it("applies 001-initial.sql and creates all six tables", async () => {
    expect(await migrate(db)).toEqual(["001-initial.sql"]);
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
    expect(rows).toHaveLength(1);
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
        `insert into player_worlds (id, player_id, content_version, state, last_resolved_at, schema_version)
         values ($1, $2, 'v1', '{}', now(), 1)`,
        [crypto.randomUUID(), pid],
      );
    await ins();
    await expect(ins()).rejects.toThrow();
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
