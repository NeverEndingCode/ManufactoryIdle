import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

const DEFAULT_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** The advisory lock key every migrate takes: an arbitrary constant, the same in every instance. */
export const MIGRATE_LOCK_KEY = 7_413_302_001;

/**
 * Applies pending NNN-*.sql files in name order, each in its own transaction. Returns the
 * applied names. Every transaction first takes pg_advisory_xact_lock(MIGRATE_LOCK_KEY), and
 * re-checks schema_migrations under it, so two instances booting at once apply each file
 * once: the second waits, then finds it recorded and skips it. PGlite has the function too
 * (a no-op on its single connection), so no Db capability flag is needed.
 */
export async function migrate(db: Db, dir: string = DEFAULT_DIR): Promise<string[]> {
  const lock = (tx: Db) => tx.query("select pg_advisory_xact_lock($1)", [MIGRATE_LOCK_KEY]);
  await db.transaction(async (tx) => {
    await lock(tx);
    await tx.query(
      `create table if not exists schema_migrations (
         version text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
  });
  const files = (await readdir(dir)).filter((f) => /^\d+-.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(`${dir}/${file}`, "utf8");
    const ran = await db.transaction(async (tx) => {
      await lock(tx);
      const done = await tx.query("select 1 from schema_migrations where version = $1", [file]);
      if (done.length > 0) return false;
      await tx.query(sql);
      await tx.query("insert into schema_migrations (version) values ($1)", [file]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}
