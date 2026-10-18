// A PGlite-backed server for local development and the web client's tests: guest-only,
// no accounts, no admin route, and a guest limit loose enough for reloads (P-11).
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { pgliteDb } from "./db/pglite.js";
import { openContentStore } from "./content.js";
import { buildServer } from "./server.js";
import { identityAuth, noSessions } from "./identity.js";

export interface DevServerOptions {
  contentDir?: string;
  /** PGlite data directory; omitted: in memory. */
  pgliteDir?: string;
  clock?: () => number;
  logLevel?: string;
}

export async function devServer(opts: DevServerOptions = {}): Promise<{ app: FastifyInstance; db: Db }> {
  const contentDir =
    opts.contentDir ??
    fileURLToPath(new URL("../../../packages/content/bundles/vertical-slice", import.meta.url));
  const clock = opts.clock ?? Date.now;
  const db = await pgliteDb(opts.pgliteDir);
  await migrate(db);
  const content = await openContentStore(db, contentDir);
  const app = buildServer({
    db,
    content,
    clock,
    auth: identityAuth({ db, content, clock, verifySession: noSessions }),
    limits: { guestsPerIp: { capacity: 1000, refillPerSec: 1000 / 3600 } },
    logger: { level: opts.logLevel ?? "warn" },
  });
  return { app, db };
}
