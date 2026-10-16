import pg from "pg";
import type { Db } from "./db.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

function wrap(q: Queryable, pool: pg.Pool | null): Db {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const res = await q.query(sql, params);
      return res.rows as T[];
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // Already on a checked-out client: reuse the outer transaction.
      if (!pool) return fn(wrap(q, null));
      const client = await pool.connect();
      let destroy = false;
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client, null));
        try {
          await client.query("COMMIT");
        } catch (err) {
          destroy = true;
          throw err;
        }
        return result;
      } catch (err) {
        if (!destroy) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The original error matters more than a failed rollback.
            destroy = true;
          }
        }
        throw err;
      } finally {
        // release(true) makes the pool destroy a client that may be stuck mid-transaction.
        client.release(destroy);
      }
    },
    async close() {
      if (pool) await pool.end();
    },
  };
}

/** Production adapter over a pg.Pool. */
export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  // An idle client erroring (e.g. a Postgres restart) must not crash the process.
  pool.on("error", (err) => console.error("pg pool idle client error", err));
  return wrap(pool, pool);
}
