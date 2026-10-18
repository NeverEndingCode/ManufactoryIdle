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
  /** When the world was last stored (the stored state's lastResolvedAt); a GET resolves past it in memory only. */
  persistedAtMs: number;
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
  const state = deserializeWorld(JSON.stringify(row.state));
  return {
    id: row.id,
    playerId: row.player_id,
    contentVersion: row.content_version,
    stateVersion: Number(row.state_version),
    state,
    persistedAtMs: state.lastResolvedAt,
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
              last_tap_flush_at = case when $4 then greatest(last_tap_flush_at, to_timestamp($5 / 1000.0))
                                       else last_tap_flush_at end
        where id = $1
        returning state_version::text as state_version`,
      // greatest() (which skips a null) keeps the flush monotonic: a batch stamped before the
      // last flush, after a clock step back, cannot hand the next batch extra tap budget.
      // R-6: last_resolved_at mirrors the state's own clock. action_log.created_at below is
      // the request time from clock(); the two agree today, but they mean different things.
      [world.id, toWire(batch.state), batch.state.lastResolvedAt, hasTap, nowMs],
    );
    await tx.query(
      `insert into action_log (player_id, world_id, actions, idempotency_key, content_version, created_at)
       values ($1, $2, $3::jsonb, $4, $5, to_timestamp($6 / 1000.0))`,
      // R-21: the version the batch ran on, read under the row lock.
      [playerId, world.id, JSON.stringify(actions), idempotencyKey, world.contentVersion, nowMs],
    );
    await tx.query("update players set last_seen_at = to_timestamp($2 / 1000.0) where id = $1", [
      playerId,
      nowMs,
    ]);
    const body = render({
      world: {
        ...world,
        state: batch.state,
        stateVersion: Number(updated!.state_version),
        persistedAtMs: batch.state.lastResolvedAt,
      },
      content: pinned,
      summary: resolved.summary,
    });
    return store(tx, 200, body);
  });
}

/** Options for replayWorld. */
export interface ReplayOptions {
  /** Replay only log rows whose id is at most this (a bigint as text); default: all of them. */
  throughLogId?: string;
}

/**
 * Spec 16.3 with R-20/R-21: rebuilds a world from its replay base (or, when there is none, its
 * recorded start: initialWorld on initial_content_version, initial_seed, created_at) plus its
 * action_log in id order. Each row resolves to its own created_at, then applies its batch with
 * the state's seed, both on that row's content_version: exactly what applyActions did. A row
 * that would now be rejected throws, since replay can only diverge if the log or base is wrong.
 * Inside a transaction pass its `tx`.
 */
export async function replayWorld(
  db: Db,
  content: ContentStore,
  worldId: string,
  opts: ReplayOptions = {},
): Promise<WorldState> {
  const [start] = await db.query<{
    base: unknown;
    initial_content_version: string;
    initial_seed: number;
    created_at_ms: number;
  }>(
    `select replay_base_state as base, initial_content_version, initial_seed,
            round(extract(epoch from created_at) * 1000)::float8 as created_at_ms
       from player_worlds where id = $1`,
    [worldId],
  );
  if (!start) throw new Error(`no world ${worldId}`);
  let state =
    start.base !== null
      ? deserializeWorld(JSON.stringify(start.base))
      : initialWorld(
          await content.get(start.initial_content_version, db),
          start.initial_seed,
          start.created_at_ms,
        );
  const rows = await db.query<{ id: string; actions: Action[]; content_version: string; at_ms: number }>(
    `select id::text as id, actions, content_version,
            round(extract(epoch from created_at) * 1000)::float8 as at_ms
       from action_log
      where world_id = $1 and ($2::bigint is null or id <= $2::bigint)
      order by id`,
    [worldId, opts.throughLogId ?? null],
  );
  for (const row of rows) {
    const pinned = await content.get(row.content_version, db);
    const resolved = resolve(state, pinned, row.at_ms - state.lastResolvedAt);
    const batch = applyBatch(resolved.state, pinned, row.actions, resolved.state.seed);
    if (batch.rejected) {
      throw new Error(`replay of world ${worldId} rejected at log row ${row.id}: ${batch.reason}`);
    }
    // A re-pin row (admin migrate) moves the state's label to its version's; other rows leave it.
    state = { ...batch.state, contentVersion: pinned.bundle.version };
  }
  return state;
}

/**
 * Why `state` cannot run on `content`, or null if it can. The engine does not check this (a
 * world on foreign content resolves without complaint, to nonsense), so the admin migrate
 * does: every id the state refers to must exist in the target, and its stock must be
 * exactly the target's stock items. A re-pin is for content that changes numbers, not ids.
 */
export function contentMisfit(state: WorldState, content: IndexedContent): string | null {
  const stock = new Set(content.stockItemIds);
  const held = Object.keys(state.stored);
  const missing = content.stockItemIds.filter((id) => !Object.hasOwn(state.stored, id));
  const extra = held.filter((id) => !stock.has(id));
  if (missing.length > 0 || extra.length > 0) {
    return `stock items differ (missing ${missing.join(",") || "none"}; unknown ${extra.join(",") || "none"})`;
  }
  const unknown = (kind: string, ids: Iterable<string>, known: { has(id: string): boolean }) => {
    for (const id of ids) if (!known.has(id)) return `unknown ${kind} ${id}`;
    return null;
  };
  const items = new Set(content.itemIds); // includes POWER_ITEM
  for (const [lane, classes] of Object.entries(state.installed)) {
    if (!content.lanes.has(lane)) return `unknown lane ${lane}`;
    const problem = unknown("machine class", Object.keys(classes), content.machineClasses);
    if (problem) return problem;
  }
  return (
    unknown("lane", Object.keys(state.qsLevel), content.lanes) ??
    unknown("recipe", Object.keys(state.assignment), content.recipes) ??
    unknown("recipe", Object.values(state.activeRecipe), content.recipes) ??
    unknown("item", Object.keys(state.activeRecipe), items) ??
    unknown("item", Object.keys(state.reserve), items) ??
    unknown("item", Object.keys(state.storageLevel), items) ??
    (state.tier > content.maxTier ? `tier ${state.tier} is past the content's ${content.maxTier}` : null)
  );
}

export type MigrateWorldResult =
  | { migrated: true; worldId: string; fromVersion: string; toVersion: string; stateVersion: number }
  | { migrated: false; reason: "unknown-version" }
  | { migrated: false; reason: "incompatible-version"; detail: string };

/**
 * Spec D.6, the admin re-pin, in one transaction under the world's row lock. `toVersion` must
 * be in content_versions, and the world must fit it (contentMisfit) and resolve on it. The
 * re-pin is then a batch of no actions on the new version, exactly as replayWorld will replay
 * it (R-21): the state is resolved to now on `toVersion`, stored with state_version bumped,
 * and logged as an `actions = []` row carrying `toVersion`. Only content_version moves;
 * initial_content_version never does. last_seen_at is not touched: an admin is not the player.
 */
export async function migrateWorld(
  db: Db,
  content: ContentStore,
  playerId: string,
  toVersion: string,
  nowMs: number,
): Promise<MigrateWorldResult> {
  return db.transaction(async (tx) => {
    const world = await loadMainWorld(tx, playerId, true);
    const known = await tx.query("select 1 from content_versions where version = $1", [toVersion]);
    if (known.length === 0) return { migrated: false, reason: "unknown-version" } as const;
    const target = await content.get(toVersion, tx);
    const incompatible = (detail: string) =>
      ({ migrated: false, reason: "incompatible-version", detail }) as const;
    // The engine's expansion cache keys on the authored label, so two bundles sharing a label
    // would share cached rates; a cold process could then resolve differently from this one.
    if (world.state.contentVersion === target.bundle.version && world.contentVersion !== toVersion) {
      return incompatible(
        `the target has the world's bundle label "${target.bundle.version}" but a different checksum; bump the label`,
      );
    }
    const misfit = contentMisfit(world.state, target);
    if (misfit) return incompatible(misfit);
    let state: WorldState;
    try {
      const resolved = resolve(world.state, target, nowMs - world.state.lastResolvedAt);
      const batch = applyBatch(resolved.state, target, [], resolved.state.seed);
      if (batch.rejected) return incompatible(batch.reason);
      // What is stored must load again. The state carries the target's label from here on.
      state = deserializeWorld(toWire({ ...batch.state, contentVersion: target.bundle.version }));
    } catch (err) {
      return incompatible(err instanceof Error ? err.message : String(err));
    }
    const [updated] = await tx.query<{ state_version: string }>(
      `update player_worlds
          set content_version = $2, state = $3::jsonb, state_version = state_version + 1,
              last_resolved_at = to_timestamp($4 / 1000.0)
        where id = $1
        returning state_version::text as state_version`,
      [world.id, toVersion, toWire(state), state.lastResolvedAt],
    );
    await tx.query(
      `insert into action_log (player_id, world_id, actions, idempotency_key, content_version, created_at)
       values ($1, $2, '[]'::jsonb, null, $3, to_timestamp($4 / 1000.0))`,
      [playerId, world.id, toVersion, nowMs],
    );
    return {
      migrated: true,
      worldId: world.id,
      fromVersion: world.contentVersion,
      toVersion,
      stateVersion: Number(updated!.state_version),
    } as const;
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
