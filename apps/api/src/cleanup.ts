// The retention job (Phase 3c, R-20). Each step is its own transaction and takes `nowMs`, so
// tests are exact; runCleanup runs them in order. Run as a script (`pnpm cleanup`) it reads
// DATABASE_URL and runs once at Date.now(); that glue is untested.
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializeWorld } from "@manufactory/engine";
import type { Db } from "./db/db.js";
import { openContentStore, type ContentStore } from "./content.js";
import { replayWorld } from "./worlds.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const GUEST_RETENTION_MS = 30 * DAY;
export const LOG_RETENTION_MS = 30 * DAY;
export const IDEMPOTENCY_RETENTION_MS = DAY;
export const SESSION_IDLE_MS = 30 * MINUTE;

/**
 * Step 1: deletes guest players whose last_seen_at is more than 30 days before now. Worlds,
 * their logs and sessions go by cascade; idempotency rows have no foreign key, so they are
 * deleted here. An account player is never deleted. The delete re-checks last_seen_at under
 * the row lock, so a guest who acts meanwhile is kept. Returns the number of players deleted.
 */
export async function deleteStaleGuests(db: Db, nowMs: number): Promise<number> {
  return db.transaction(async (tx) => {
    const gone = await tx.query<{ id: string }>(
      `delete from players
        where supertokens_user_id is null and last_seen_at < to_timestamp($1 / 1000.0)
        returning id`,
      [nowMs - GUEST_RETENTION_MS],
    );
    if (gone.length === 0) return 0;
    await tx.query("delete from idempotency where player_id = any($1::uuid[])", [gone.map((g) => g.id)]);
    return gone.length;
  });
}

/**
 * Step 2 (R-20): for each world with log rows older than 30 days, under the world's row lock,
 * replays those rows onto its replay base (or recorded start), stores the result as the new
 * base, and deletes them, all in one transaction. The rows deleted are the longest old prefix
 * of the log in id order, so the kept rows are always a suffix and base + kept log still
 * replays the world exactly. replay_base_at is the last deleted row's created_at, which is also
 * the base state's lastResolvedAt. Returns the number of log rows deleted.
 */
export async function compactActionLog(db: Db, content: ContentStore, nowMs: number): Promise<number> {
  const cutoffMs = nowMs - LOG_RETENTION_MS;
  return db.transaction(async (tx) => {
    const worlds = await tx.query<{ world_id: string }>(
      `select distinct world_id from action_log where created_at < to_timestamp($1 / 1000.0)
        order by world_id`,
      [cutoffMs],
    );
    let deleted = 0;
    for (const { world_id: worldId } of worlds) {
      // The lock applyActions takes, so no batch lands between the replay and the delete.
      await tx.query("select 1 from player_worlds where id = $1 for update", [worldId]);
      const [edge] = await tx.query<{ through: string | null; at_ms: number | null }>(
        `select l.id::text as through, round(extract(epoch from l.created_at) * 1000)::float8 as at_ms
           from action_log l
          where l.world_id = $1 and l.created_at < to_timestamp($2 / 1000.0)
            and l.id < coalesce((select min(m.id) from action_log m
                                  where m.world_id = $1 and m.created_at >= to_timestamp($2 / 1000.0)),
                                9223372036854775807)
          order by l.id desc limit 1`,
        [worldId, cutoffMs],
      );
      if (!edge?.through) continue;
      const base = await replayWorld(tx, content, worldId, { throughLogId: edge.through });
      await tx.query(
        `update player_worlds set replay_base_state = $2::jsonb, replay_base_at = to_timestamp($3 / 1000.0)
          where id = $1`,
        [worldId, serializeWorld(base), edge.at_ms],
      );
      const rows = await tx.query(
        "delete from action_log where world_id = $1 and id <= $2::bigint returning id",
        [worldId, edge.through],
      );
      deleted += rows.length;
    }
    return deleted;
  });
}

/** Step 3: deletes idempotency rows older than 24 hours. Returns the number deleted. */
export async function pruneIdempotency(db: Db, nowMs: number): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      "delete from idempotency where created_at < to_timestamp($1 / 1000.0) returning key",
      [nowMs - IDEMPOTENCY_RETENTION_MS],
    );
    return rows.length;
  });
}

/**
 * Step 4: closes open sessions idle for 30 minutes: the player's last_seen_at is more than
 * 30 minutes before now, and so is the session's own opened_at (a GET opens a session without
 * moving last_seen_at, so a just-opened session is not idle). closed_at is the later of the two,
 * the last sign of the player, not the time the job ran. Returns the number closed.
 */
export async function closeIdleSessions(db: Db, nowMs: number): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `update sessions s set closed_at = greatest(p.last_seen_at, s.opened_at)
         from players p
        where p.id = s.player_id and s.closed_at is null
          and greatest(p.last_seen_at, s.opened_at) < to_timestamp($1 / 1000.0)
        returning s.id`,
      [nowMs - SESSION_IDLE_MS],
    );
    return rows.length;
  });
}

export interface CleanupReport {
  guests: number;
  logRows: number;
  idempotency: number;
  sessions: number;
}

/** Runs the four steps in order, each in its own transaction. */
export async function runCleanup(db: Db, content: ContentStore, nowMs: number): Promise<CleanupReport> {
  const guests = await deleteStaleGuests(db, nowMs);
  const logRows = await compactActionLog(db, content, nowMs);
  const idempotency = await pruneIdempotency(db, nowMs);
  const sessions = await closeIdleSessions(db, nowMs);
  return { guests, logRows, idempotency, sessions };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const { pgDb } = await import("./db/pg.js");
  const { migrate } = await import("./db/migrate.js");
  const contentDir =
    process.env.CONTENT_DIR ??
    fileURLToPath(new URL("../../../packages/content/bundles/vertical-slice", import.meta.url));
  const db = pgDb(databaseUrl);
  try {
    await migrate(db);
    const content = await openContentStore(db, contentDir);
    console.log(JSON.stringify(await runCleanup(db, content, Date.now())));
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error("cleanup failed", err);
    process.exit(1);
  });
}
