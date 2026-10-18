import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deserializeWorld, serializeWorld, type Action } from "@manufactory/engine";
import { pgliteDb } from "./db/pglite.js";
import { migrate } from "./db/migrate.js";
import type { Db } from "./db/db.js";
import { openContentStore, type ContentStore } from "./content.js";
import { applyActions, createPlayerWithWorld, replayWorld } from "./worlds.js";
import {
  closeIdleSessions,
  compactActionLog,
  deleteStaleGuests,
  pruneIdempotency,
  runCleanup,
} from "./cleanup.js";

const SLICE = fileURLToPath(
  new URL("../../../packages/content/bundles/vertical-slice", import.meta.url),
);

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const BUY_MINER: Action = { type: "BUY_MACHINE", lane: "iron", machineClass: "miner", mark: 1, count: 1 };
const TAP: Action = { type: "TAP", count: 3, clientElapsedMs: 1500 };

let db: Db;
let content: ContentStore;

beforeEach(async () => {
  db = await pgliteDb();
  await migrate(db);
  content = await openContentStore(db, SLICE);
});
afterEach(async () => {
  await db?.close();
});

let keys = 0;
async function act(playerId: string, actions: Action[], at: number): Promise<void> {
  const res = await applyActions(db, content, playerId, actions, `k-${keys++}`, at, ({ world }) => ({
    v: world.stateVersion,
  }));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function guestAt(at: number): Promise<{ playerId: string; worldId: string }> {
  const { playerId, world } = await createPlayerWithWorld(
    db,
    { guestTokenHash: `g-${crypto.randomUUID()}` },
    content,
    at,
  );
  return { playerId, worldId: world.id };
}

async function accountAt(at: number): Promise<{ playerId: string; worldId: string }> {
  const { playerId, world } = await createPlayerWithWorld(
    db,
    { superTokensUserId: `u-${crypto.randomUUID()}` },
    content,
    at,
  );
  return { playerId, worldId: world.id };
}

async function setLastSeen(playerId: string, at: number): Promise<void> {
  await db.query("update players set last_seen_at = to_timestamp($2 / 1000.0) where id = $1", [
    playerId,
    at,
  ]);
}

async function storedWire(worldId: string): Promise<string> {
  const [row] = await db.query<{ state: unknown }>("select state from player_worlds where id = $1", [
    worldId,
  ]);
  return serializeWorld(deserializeWorld(JSON.stringify(row!.state)));
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) q`, params);
  return row!.n;
}

describe("action_log.content_version (R-21)", () => {
  it("every logged batch records the world's pinned version", async () => {
    const { playerId, worldId } = await guestAt(T0);
    await act(playerId, [BUY_MINER], T0 + 10 * MINUTE);
    await act(playerId, [TAP], T0 + 11 * MINUTE);
    const rows = await db.query<{ content_version: string }>(
      "select content_version from action_log where world_id = $1 order by id",
      [worldId],
    );
    expect(rows.map((r) => r.content_version)).toEqual([content.current.version, content.current.version]);
  });
});

describe("step 1: stale guests", () => {
  it("deletes guests unseen for over 30 days, with their worlds, logs, sessions and keys", async () => {
    const stale = await guestAt(T0);
    await act(stale.playerId, [BUY_MINER], T0 + 10 * MINUTE);
    await db.query("insert into sessions (player_id, opened_at) values ($1, to_timestamp($2 / 1000.0))", [
      stale.playerId,
      T0,
    ]);
    const fresh = await guestAt(T0);
    await act(fresh.playerId, [BUY_MINER], T0 + 10 * MINUTE);
    const now = T0 + 10 * MINUTE + 30 * DAY + 1;
    await setLastSeen(fresh.playerId, now - 30 * DAY); // exactly 30 days: kept

    expect(await deleteStaleGuests(db, now)).toBe(1);

    const players = await db.query<{ id: string }>("select id from players");
    expect(players.map((p) => p.id)).toEqual([fresh.playerId]);
    expect(await count("select 1 from player_worlds where player_id = $1", [stale.playerId])).toBe(0);
    expect(await count("select 1 from action_log where player_id = $1", [stale.playerId])).toBe(0);
    expect(await count("select 1 from sessions where player_id = $1", [stale.playerId])).toBe(0);
    expect(await count("select 1 from idempotency where player_id = $1", [stale.playerId])).toBe(0);
    expect(await count("select 1 from action_log where player_id = $1", [fresh.playerId])).toBe(1);
  });

  it("never deletes an account player, however long unseen", async () => {
    const account = await accountAt(T0);
    await act(account.playerId, [BUY_MINER], T0 + 10 * MINUTE);
    const now = T0 + 400 * DAY;
    expect(await deleteStaleGuests(db, now)).toBe(0);
    await runCleanup(db, content, now);
    expect(await count("select 1 from players where id = $1", [account.playerId])).toBe(1);
    expect(await count("select 1 from player_worlds where id = $1", [account.worldId])).toBe(1);
  });
});

describe("step 2: the replay base (R-20)", () => {
  it("replay stays exact after old log rows are deleted, across two cleanups", async () => {
    const { playerId, worldId } = await accountAt(T0);
    await act(playerId, [BUY_MINER], T0 + 10 * MINUTE);
    await act(playerId, [BUY_MINER, TAP], T0 + 17 * MINUTE + 7);
    await act(playerId, [TAP], T0 + 40 * DAY);
    await act(playerId, [BUY_MINER], T0 + 40 * DAY + 5 * MINUTE);
    const stored = await storedWire(worldId);
    expect(serializeWorld(await replayWorld(db, content, worldId))).toBe(stored);

    // Cutoff T0 + 15 days: the first two rows go.
    expect(await compactActionLog(db, content, T0 + 45 * DAY)).toBe(2);
    expect(await count("select 1 from action_log where world_id = $1", [worldId])).toBe(2);
    const [base] = await db.query<{ state: unknown; at_ms: number }>(
      `select replay_base_state as state,
              round(extract(epoch from replay_base_at) * 1000)::float8 as at_ms
         from player_worlds where id = $1`,
      [worldId],
    );
    expect(base!.at_ms).toBe(T0 + 17 * MINUTE + 7);
    expect(deserializeWorld(JSON.stringify(base!.state)).lastResolvedAt).toBe(T0 + 17 * MINUTE + 7);
    expect(serializeWorld(await replayWorld(db, content, worldId))).toBe(stored);

    // A second cleanup builds on the base, not the recorded start.
    expect(await compactActionLog(db, content, T0 + 80 * DAY)).toBe(2);
    expect(await count("select 1 from action_log where world_id = $1", [worldId])).toBe(0);
    expect(serializeWorld(await replayWorld(db, content, worldId))).toBe(stored);
  });

  it("leaves a world with no old rows untouched", async () => {
    const { playerId, worldId } = await accountAt(T0);
    await act(playerId, [BUY_MINER], T0 + 10 * MINUTE);
    expect(await compactActionLog(db, content, T0 + 10 * DAY)).toBe(0);
    const [row] = await db.query<{ s: unknown; a: unknown }>(
      "select replay_base_state as s, replay_base_at as a from player_worlds where id = $1",
      [worldId],
    );
    expect(row).toEqual({ s: null, a: null });
    expect(await count("select 1 from action_log")).toBe(1);
  });

  it("stops at the first row that is not old, so the kept log stays a suffix", async () => {
    const { playerId, worldId } = await accountAt(T0);
    await act(playerId, [BUY_MINER], T0 + 10 * MINUTE);
    await act(playerId, [TAP], T0 + 40 * DAY);
    // A row inserted later with an older time (a clock step back) must not be deleted
    // ahead of the newer row before it.
    await db.query(
      `insert into action_log (player_id, world_id, actions, content_version, created_at)
       values ($1, $2, '[]'::jsonb, $3, to_timestamp($4 / 1000.0))`,
      [playerId, worldId, content.current.version, T0 + 11 * MINUTE],
    );
    expect(await compactActionLog(db, content, T0 + 45 * DAY)).toBe(1);
    expect(await count("select 1 from action_log where world_id = $1", [worldId])).toBe(2);
  });
});

describe("step 3: idempotency", () => {
  it("deletes keys older than 24 hours", async () => {
    const { playerId } = await guestAt(T0);
    await act(playerId, [BUY_MINER], T0 + 10 * MINUTE);
    await act(playerId, [TAP], T0 + 2 * HOUR);
    expect(await pruneIdempotency(db, T0 + 10 * MINUTE + DAY + 1)).toBe(1);
    expect(await count("select 1 from idempotency")).toBe(1);
  });
});

describe("step 4: idle sessions", () => {
  it("closes open sessions whose player has been idle over 30 minutes", async () => {
    const idle = await guestAt(T0);
    const active = await guestAt(T0);
    const closed = await guestAt(T0);
    const open = (p: string, closedAt: number | null) =>
      db.query(
        `insert into sessions (player_id, opened_at, closed_at)
         values ($1, to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0))`,
        [p, T0, closedAt],
      );
    await open(idle.playerId, null);
    await open(active.playerId, null);
    await open(closed.playerId, T0 + MINUTE);
    // Last seen long ago, but the session was opened 5 minutes ago by a GET: not idle.
    const reader = await guestAt(T0);
    await db.query("insert into sessions (player_id, opened_at) values ($1, to_timestamp($2 / 1000.0))", [
      reader.playerId,
      T0 + 35 * MINUTE,
    ]);
    const now = T0 + 40 * MINUTE;
    await setLastSeen(idle.playerId, now - 31 * MINUTE);
    await setLastSeen(active.playerId, now - 29 * MINUTE);
    await setLastSeen(closed.playerId, now - 60 * MINUTE);

    expect(await closeIdleSessions(db, now)).toBe(1);
    const rows = await db.query<{ player_id: string; closed_ms: number | null }>(
      `select player_id, round(extract(epoch from closed_at) * 1000)::float8 as closed_ms from sessions`,
    );
    const by = new Map(rows.map((r) => [r.player_id, r.closed_ms]));
    expect(by.get(idle.playerId)).toBe(now - 31 * MINUTE); // closed when the player was last seen
    expect(by.get(active.playerId)).toBeNull();
    expect(by.get(closed.playerId)).toBe(T0 + MINUTE);
    expect(by.get(reader.playerId)).toBeNull();
  });
});

describe("runCleanup", () => {
  it("runs all four steps and reports their counts", async () => {
    const stale = await guestAt(T0);
    const kept = await accountAt(T0);
    await act(kept.playerId, [BUY_MINER], T0 + 10 * MINUTE);
    await db.query("insert into sessions (player_id, opened_at) values ($1, to_timestamp($2 / 1000.0))", [
      kept.playerId,
      T0,
    ]);
    const stored = await storedWire(kept.worldId);
    const report = await runCleanup(db, content, T0 + 60 * DAY);
    expect(report).toEqual({ guests: 1, logRows: 1, idempotency: 1, sessions: 1 });
    expect(await count("select 1 from players where id = $1", [stale.playerId])).toBe(0);
    expect(serializeWorld(await replayWorld(db, content, kept.worldId))).toBe(stored);
  });
});
