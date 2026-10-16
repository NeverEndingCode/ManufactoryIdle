// Process entry: env → Postgres → migrate → content store → Fastify. Untested glue.
import { fileURLToPath } from "node:url";
import { pgDb } from "./db/pg.js";
import { migrate } from "./db/migrate.js";
import { openContentStore } from "./content.js";
import { buildServer, guestAuth } from "./server.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const contentDir =
  process.env.CONTENT_DIR ??
  fileURLToPath(new URL("../../../packages/content/bundles/vertical-slice", import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

const db = pgDb(databaseUrl);
await migrate(db);
const content = await openContentStore(db, contentDir);
const app = buildServer({
  db,
  content,
  clock: Date.now,
  auth: guestAuth(db),
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ port, host });
