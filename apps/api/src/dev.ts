// Dev entry: PGlite + the slice content, guest-only. Untested glue, like main.ts.
import { devServer } from "./dev-server.js";

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port >= 65536) {
  console.error(`PORT must be an integer from 0 to 65535, got ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}
const host = process.env.HOST ?? "127.0.0.1";
const { app, db } = await devServer({
  ...(process.env.PGLITE_DIR ? { pgliteDir: process.env.PGLITE_DIR } : {}),
  ...(process.env.CONTENT_DIR ? { contentDir: process.env.CONTENT_DIR } : {}),
  logLevel: process.env.LOG_LEVEL ?? "warn",
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
console.log(`dev API on http://${host}:${port}`);
