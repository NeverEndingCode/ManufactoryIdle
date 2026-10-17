export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn in one transaction; commits on resolve, rolls back on throw. Nested calls reuse the outer transaction.
   * Use the `tx` passed to `fn`; calling the root `db` inside it can deadlock on PGlite and runs outside the transaction on `pg`. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
