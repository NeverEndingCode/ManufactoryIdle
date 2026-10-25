// A PGlite-backed server for local development and the web client's tests: guest-only
// (or fake sessions on request), no real accounts, no admin route, and a guest limit loose enough for reloads (P-11).
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { pgliteDb } from "./db/pglite.js";
import { openContentStore } from "./content.js";
import { buildServer } from "./server.js";
import { identityAuth, noSessions } from "./identity.js";
import { fakeSessions } from "./dev-sessions.js";

export interface DevServerOptions {
  contentDir?: string;
  /** PGlite data directory; omitted: in memory. */
  pgliteDir?: string;
  clock?: () => number;
  logLevel?: string;
  /** A fake SuperTokens front-end interface (dev-sessions.ts) for the web client's account
   * e2e. Never in production: throws when NODE_ENV is "production". */
  fakeSessions?: boolean;
}

export async function devServer(opts: DevServerOptions = {}): Promise<{ app: FastifyInstance; db: Db }> {
  if (opts.fakeSessions && process.env.NODE_ENV === "production") {
    throw new Error("fakeSessions must never run with NODE_ENV=production");
  }
  const fake = opts.fakeSessions ? fakeSessions({ clock: opts.clock ?? Date.now }) : null;
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
    auth: identityAuth({ db, content, clock, verifySession: fake?.verifySession ?? noSessions }),
    ...(fake ? { accounts: fake.accounts, verifySession: fake.verifySession } : {}),
    limits: { guestsPerIp: { capacity: 1000, refillPerSec: 1000 / 3600 } },
    logger: { level: opts.logLevel ?? "warn" },
  });
  return { app, db };
}
