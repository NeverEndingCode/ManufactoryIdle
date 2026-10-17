import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

const DEFAULT_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Applies pending NNN-*.sql files in name order, each in its own transaction. Returns the applied names. */
export async function migrate(db: Db, dir: string = DEFAULT_DIR): Promise<string[]> {
  await db.query(
    `create table if not exists schema_migrations (
       version text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const done = new Set(
    (await db.query<{ version: string }>("select version from schema_migrations")).map(
      (r) => r.version,
    ),
  );
  const files = (await readdir(dir)).filter((f) => /^\d+-.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(`${dir}/${file}`, "utf8");
    await db.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query("insert into schema_migrations (version) values ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}
