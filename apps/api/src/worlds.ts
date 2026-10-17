// Players and worlds: create a guest, load a world, and spec D.2's action transaction.
// State is stored as JSON.parse(serializeWorld(state)) (R-5). Every timestamp written
// here comes from the injected clock, never now(), so tests and replays are exact (R-6).
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  applyBatch,
  deserializeWorld,
  initialWorld,
  resolve,
  serializeWorld,
  type Action,
  type IndexedContent,
  type ResolveSummary,
  type WorldState,
} from "@manufactory/engine";
import type { Db } from "./db/db.js";
import type { ContentStore } from "./content.js";

export interface World {
  id: string;
  playerId: string;
  /** The pinned content version (a bundle checksum). */
  contentVersion: string;
  stateVersion: number;
  state: WorldState;
}

/** A batch was rejected by the engine; thrown out of the transaction so it rolls back. */
export class ActionRejectedError extends Error {
  constructor(
    readonly index: number,
    readonly action: Action,
    readonly reason: string,
  ) {
    super(`action ${index} rejected: ${reason}`);
    this.name = "ActionRejectedError";
  }
}

export class WorldNotFoundError extends Error {
  constructor(playerId: string) {
    super(`no main world for player ${playerId}`);
    this.name = "WorldNotFoundError";
  }
}

const toWire = (state: WorldState): string => serializeWorld(state);

interface WorldRow {
  id: string;
  player_id: string;
  content_version: string;
  state_version: string;
  state: unknown;
}

function fromRow(row: WorldRow): World {
  return {
    id: row.id,
    playerId: row.player_id,
    contentVersion: row.content_version,
    stateVersion: Number(row.state_version),
    state: deserializeWorld(JSON.stringify(row.state)),
  };
}

/** Only this is stored in players.guest_token: a db leak must not hand out live tokens. */
export function hashGuestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type PlayerKey = { guestTokenHash: string } | { superTokensUserId: string };

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";

/**
 * Inserts a player and its main world on the current content version, in one transaction.
 * Pass the root db (or a tx that has no failed statement): for an account key, a
 * unique-violation on supertokens_user_id (R-17, a lost lazy-creation race) aborts the
 * transaction, so it is caught outside it and the winner's player and world are returned.
 */
export async function createPlayerWithWorld(
  db: Db,
  key: PlayerKey,
  content: ContentStore,
  nowMs: number,
): Promise<{ playerId: string; world: World }> {
  const seed = randomInt(0, 2 ** 31);
  const { version } = content.current;
  const state = initialWorld(content.current.content, seed, nowMs);
  try {
    return await db.transaction(async (tx) => {
      const [player] =
        "guestTokenHash" in key
          ? await tx.query<{ id: string }>(
              `insert into players (guest_token, created_at, last_seen_at)
               values ($1, to_timestamp($2 / 1000.0), to_timestamp($2 / 1000.0)) returning id`,
              [key.guestTokenHash, nowMs],
            )
          : await tx.query<{ id: string }>(
              `insert into players (supertokens_user_id, created_at, last_seen_at)
               values ($1, to_timestamp($2 / 1000.0), to_timestamp($2 / 1000.0)) returning id`,
              [key.superTokensUserId, nowMs],
            );
      const [world] = await tx.query<WorldRow>(
        `insert into player_worlds (player_id, content_version, state, state_version, last_resolved_at,
                                    schema_version, initial_seed, created_at, initial_content_version)
         values ($1, $2, $3::jsonb, 0, to_timestamp($4 / 1000.0), $5, $6, to_timestamp($4 / 1000.0), $2)
         returning id, player_id, content_version, state_version::text as state_version, state`,
        [player!.id, version, toWire(state), nowMs, state.schemaVersion, seed],
      );
      return { playerId: player!.id, world: fromRow(world!) };
    });
  } catch (err) {
    if (!("superTokensUserId" in key) || !isUniqueViolation(err)) throw err;
    const rows = await db.query<{ id: string }>(
      "select id from players where supertokens_user_id = $1",
      [key.superTokensUserId],
    );
    if (rows.length === 0) throw err;
    return { playerId: rows[0]!.id, world: await loadMainWorld(db, rows[0]!.id) };
  }
}

/** Creates a guest player and its main world on the current content version, in one transaction. */
export async function createGuest(
  db: Db,
  content: ContentStore,
  nowMs: number,
): Promise<{ guestToken: string; world: World }> {
  const guestToken = randomBytes(32).toString("base64url");
  const { world } = await createPlayerWithWorld(
    db,
    { guestTokenHash: hashGuestToken(guestToken) },
    content,
    nowMs,
  );
  return { guestToken, world };
}

const SELECT_MAIN = `select id, player_id, content_version, state_version::text as state_version, state
                       from player_worlds where player_id = $1 and world_type = 'main'`;

/** Loads the player's main world; throws WorldNotFoundError if there is none. */
export async function loadMainWorld(db: Db, playerId: string, forUpdate = false): Promise<World> {
  const rows = await db.query<WorldRow>(SELECT_MAIN + (forUpdate ? " for update" : ""), [playerId]);
  if (rows.length === 0) throw new WorldNotFoundError(playerId);
  return fromRow(rows[0]!);
}

/** R-11: resolves the world to now in memory only; nothing is written. */
export async function viewWorld(
  db: Db,
  content: ContentStore,
  playerId: string,
  nowMs: number,
): Promise<{ world: World; content: IndexedContent }> {
  const world = await loadMainWorld(db, playerId);
  const pinned = await content.get(world.contentVersion);
  const resolved = resolve(world.state, pinned, nowMs - world.state.lastResolvedAt);
  return { world: { ...world, state: resolved.state }, content: pinned };
}

/**
 * Spec D.2, steps 2-9: lock the row, resolve on the pinned content, apply the batch with
 * the world's own seed (R-7), persist, log. A rejection throws ActionRejectedError, which
 * rolls the whole transaction back.
 */
export async function applyActions(
  db: Db,
  content: ContentStore,
  playerId: string,
  actions: Action[],
  idempotencyKey: string,
  nowMs: number,
): Promise<{ world: World; content: IndexedContent; summary: ResolveSummary }> {
  return db.transaction(async (tx) => {
    const world = await loadMainWorld(tx, playerId, true);
    // Under the lock, through tx: the locked row's version is the one that counts.
    const pinned = await content.get(world.contentVersion, tx);
    const resolved = resolve(world.state, pinned, nowMs - world.state.lastResolvedAt);
    const batch = applyBatch(resolved.state, pinned, actions, resolved.state.seed);
    if (batch.rejected) {
      throw new ActionRejectedError(batch.failedIndex, actions[batch.failedIndex]!, batch.reason);
    }
    const [updated] = await tx.query<{ state_version: string }>(
      `update player_worlds
          set state = $2::jsonb, state_version = state_version + 1,
              last_resolved_at = to_timestamp($3 / 1000.0)
        where id = $1
        returning state_version::text as state_version`,
      // R-6: last_resolved_at mirrors the state's own clock. action_log.created_at below is
      // the request time from clock(); the two agree today, but they mean different things.
      [world.id, toWire(batch.state), batch.state.lastResolvedAt],
    );
    await tx.query(
      `insert into action_log (player_id, world_id, actions, idempotency_key, created_at)
       values ($1, $2, $3::jsonb, $4, to_timestamp($5 / 1000.0))`,
      [playerId, world.id, JSON.stringify(actions), idempotencyKey, nowMs],
    );
    await tx.query("update players set last_seen_at = to_timestamp($2 / 1000.0) where id = $1", [
      playerId,
      nowMs,
    ]);
    return {
      world: { ...world, state: batch.state, stateVersion: Number(updated!.state_version) },
      content: pinned,
      summary: resolved.summary,
    };
  });
}
