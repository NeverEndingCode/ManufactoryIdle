// Process entry: env → Postgres → migrate → content store → Fastify. Untested glue.
import { fileURLToPath } from "node:url";
import { pgDb } from "./db/pg.js";
import { migrate } from "./db/migrate.js";
import { openContentStore } from "./content.js";
import { buildServer } from "./server.js";
import { identityAuth, noSessions } from "./identity.js";
import { superTokensFromEnv } from "./auth/supertokens.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const contentDir =
  process.env.CONTENT_DIR ??
  fileURLToPath(new URL("../../../packages/content/bundles/vertical-slice", import.meta.url));
const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 0 || port >= 65536) {
  console.error(`PORT must be an integer from 0 to 65535, got ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}
const host = process.env.HOST ?? "127.0.0.1";

const db = pgDb(databaseUrl);
await migrate(db);
const content = await openContentStore(db, contentDir);
// R-16: accounts are optional; without a SuperTokens core the API is guest-only.
const accounts = superTokensFromEnv(process.env);
if (!accounts) console.log("accounts disabled (SUPERTOKENS_CONNECTION_URI unset)");
const app = buildServer({
  db,
  content,
  clock: Date.now,
  auth: identityAuth({
    db,
    content,
    clock: Date.now,
    verifySession: accounts?.verifySession ?? noSessions,
  }),
  ...(accounts ? { accounts, verifySession: accounts.verifySession } : {}),
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  let code = 0;
  try {
    try {
      await app.close();
    } finally {
      // The pool must close even if Fastify's close hooks throw.
      await db.close();
    }
  } catch (err) {
    console.error("shutdown failed", err);
    code = 1;
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ port, host });
