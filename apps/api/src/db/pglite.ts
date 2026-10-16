import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.js";

type Queryable = Pick<PGlite, "query" | "exec">;

function wrap(q: Queryable, root: PGlite | null, inTx: boolean): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      // Parameterless SQL goes through exec so migrations may hold several statements.
      if (params === undefined) {
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

/** In-memory PGlite database, for tests. */
export async function pgliteDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;
  return wrap(pg, pg, false);
}
