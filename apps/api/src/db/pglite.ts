import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.js";

type Queryable = Pick<PGlite, "query" | "exec">;

function wrap(q: Queryable, root: PGlite | null, inTx: boolean): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      // No params -> exec(), which allows multi-statement SQL and returns the last statement's rows.
      if (params === undefined || params.length === 0) {
        const results = await q.exec(sql);
        return (results[results.length - 1]?.rows ?? []) as T[];
      }
      const res = await q.query<T>(sql, params);
      return res.rows;
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (inTx || !root) return fn(wrap(q, root, true));
      // PGlite.transaction serialises against other queries and rolls back on throw.
      return root.transaction((tx) => fn(wrap(tx, root, true)));
    },
    async close() {
      if (root && !inTx) await root.close();
    },
  };
}

/** PGlite database: in memory for tests, or persisted under `dataDir` (the dev server). */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  return wrap(pg, pg, false);
}
