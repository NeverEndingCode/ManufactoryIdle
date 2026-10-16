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
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client, null));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The original error matters more than a failed rollback.
        }
        throw err;
      } finally {
        client.release();
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
  return wrap(pool, pool);
}
