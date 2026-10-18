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

export interface PgDbOptions {
  /** Pool size. Default 10. */
  max?: number;
  /** Sets every connection's search_path to this one schema (the integration tests use a
   * fresh schema per test). A plain identifier; anything else throws. Default: the server's. */
  schema?: string;
}

/** Production adapter over a pg.Pool. */
export function pgDb(connectionString: string, opts: PgDbOptions = {}): Db {
  if (opts.schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) {
    throw new Error(`pgDb: schema must be a lowercase identifier, got ${JSON.stringify(opts.schema)}`);
  }
  const pool = new pg.Pool({
    connectionString,
    ...(opts.schema !== undefined ? { options: `-c search_path=${opts.schema}` } : {}),
    // Bounded, so a burst of requests queues here instead of exhausting Postgres's
    // max_connections; a request that cannot get a connection fails after 10 s rather
    // than hanging, and idle connections are returned after 30 s.
    max: opts.max ?? 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Server-side per-statement cap: a runaway query (or one stuck behind a lock)
    // is cancelled by Postgres after 15 s instead of pinning a pool slot forever.
    statement_timeout: 15_000,
  });
  // An idle client erroring (e.g. a Postgres restart) must not crash the process.
  pool.on("error", (err) => console.error("pg pool idle client error", err));
  return wrap(pool, pool);
}
