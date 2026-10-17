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
 * R-19: spends `budgetMs` across the batch's TAPs in order, so their clientElapsedMs
 * together never exceed it. Other actions pass through; a negative budget counts as zero.
 */
export function capTaps(actions: Action[], budgetMs: number): { actions: Action[]; hasTap: boolean } {
  let left = Math.max(0, budgetMs);
  let hasTap = false;
  const capped = actions.map((a) => {
    if (a.type !== "TAP") return a;
    hasTap = true;
    const clientElapsedMs = Math.min(a.clientElapsedMs, left);
    left -= clientElapsedMs;
    return { ...a, clientElapsedMs };
  });
  return { actions: capped, hasTap };
}

/** What a client is told about a batch: the status and the exact JSON body. */
export interface ActionsResponse {
  status: number;
  body: unknown;
}

/**
 * Spec D.2, steps 2-9: lock the row, look up the idempotency key (a seen key returns the
 * stored response and applies nothing; the key wins over the body), resolve on the pinned
 * content, apply the batch with the world's own seed (R-7), persist, log, store the response.
 * A rejection changes nothing, so its 409 is stored and committed in the same transaction,
 * under the same lock: a retry, even after the state has moved on, gets the same 409.
 * R-19: the TAPs' clientElapsedMs are capped to the time since the last TAP batch (or since
 * the world was created) before anything else; the capped batch is what is applied, logged and
 * stored, so replay stays exact. The column moves only when a batch holding a TAP succeeds.
 * Stored bodies are the jsonb round-trip of what was built, and the first answer is read back from the insert, so a replay is byte-for-byte equal.
 */
export async function applyActions(
  db: Db,
  content: ContentStore,
  playerId: string,
  requested: Action[],
  idempotencyKey: string,
  nowMs: number,
  render: (result: { world: World; content: IndexedContent; summary: ResolveSummary }) => unknown,
): Promise<ActionsResponse> {
  const store = async (tx: Db, status: number, body: unknown): Promise<ActionsResponse> => {
    const [row] = await tx.query<{ response: unknown; status: number }>(
      `insert into idempotency (player_id, key, response, status, created_at)
       values ($1, $2, $3::jsonb, $4, to_timestamp($5 / 1000.0))
       on conflict (player_id, key) do update set key = idempotency.key
       returning response, status`,
      [playerId, idempotencyKey, JSON.stringify(body), status, nowMs],
    );
    return { status: row!.status, body: row!.response };
  };
  return db.transaction(async (tx) => {
    const world = await loadMainWorld(tx, playerId, true);
    const seen = await tx.query<{ response: unknown; status: number }>(
      "select response, status from idempotency where player_id = $1 and key = $2",
      [playerId, idempotencyKey],
    );
    if (seen.length > 0) return { status: seen[0]!.status, body: seen[0]!.response };
    const [clock] = await tx.query<{ since_ms: number }>(
      `select round(extract(epoch from coalesce(last_tap_flush_at, created_at)) * 1000)::float8 as since_ms
         from player_worlds where id = $1`,
      [world.id],
    );
    const { actions, hasTap } = capTaps(requested, nowMs - clock!.since_ms);
    // Under the lock, through tx: the locked row's version is the one that counts.
    const pinned = await content.get(world.contentVersion, tx);
    const resolved = resolve(world.state, pinned, nowMs - world.state.lastResolvedAt);
    const batch = applyBatch(resolved.state, pinned, actions, resolved.state.seed);
    if (batch.rejected) {
      // A rejection wrote nothing to the world, so commit just the stored 409, still under the
      // row lock: no retry can take the lock between the rejection and its record.
      return store(tx, 409, {
        failedAction: actions[batch.failedIndex]!,
        index: batch.failedIndex,
        reason: batch.reason,
      });
    }
    const [updated] = await tx.query<{ state_version: string }>(
      `update player_worlds
          set state = $2::jsonb, state_version = state_version + 1,
              last_resolved_at = to_timestamp($3 / 1000.0),
              last_tap_flush_at = case when $4 then to_timestamp($5 / 1000.0) else last_tap_flush_at end
        where id = $1
        returning state_version::text as state_version`,
      // R-6: last_resolved_at mirrors the state's own clock. action_log.created_at below is
      // the request time from clock(); the two agree today, but they mean different things.
      [world.id, toWire(batch.state), batch.state.lastResolvedAt, hasTap, nowMs],
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
    const body = render({
      world: { ...world, state: batch.state, stateVersion: Number(updated!.state_version) },
      content: pinned,
      summary: resolved.summary,
    });
    return store(tx, 200, body);
  });
}

/**
 * Spec 3b R-14/R-18: attach a guest's player (and so its world) to an account, in one
 * transaction. No merge: an account that already has a player is refused, and the guest row
 * is locked so two claimers cannot both take it. The account's own player is not created here.
 */
export async function claimGuest(
  db: Db,
  guestToken: string,
  superTokensUserId: string,
): Promise<{ claimed: true; playerId: string } | { claimed: false; reason: "already-has-world" | "unknown-guest" }> {
  try {
    return await db.transaction(async (tx) => {
      const own = await tx.query("select 1 from players where supertokens_user_id = $1", [
        superTokensUserId,
      ]);
      if (own.length > 0) return { claimed: false, reason: "already-has-world" } as const;
      const guest = await tx.query<{ id: string }>(
        `select id from players where guest_token = $1 and supertokens_user_id is null for update`,
        [hashGuestToken(guestToken)],
      );
      if (guest.length === 0) return { claimed: false, reason: "unknown-guest" } as const;
      await tx.query("update players set supertokens_user_id = $2, guest_token = null where id = $1", [
        guest[0]!.id,
        superTokensUserId,
      ]);
      return { claimed: true, playerId: guest[0]!.id } as const;
    });
  } catch (err) {
    // A concurrent lazy creation for this account won between the check and the update.
    if (isUniqueViolation(err)) return { claimed: false, reason: "already-has-world" };
    throw err;
  }
}
