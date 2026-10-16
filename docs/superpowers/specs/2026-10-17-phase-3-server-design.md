# Phase 3 — server and authority

**Implements:** engine spec Section D (D.1–D.7) and build order F.2, phase 3: "Action API,
schema, SuperTokens, guests, idempotency, rate limits" — *a game with a backend*.
**Status:** design, 2026-10-17. Written under the user's standing instruction to work
through the milestones; every design call below is recorded as a **Ruling** with its
reason and what it costs if wrong.

---

## What exists

- **The engine is server-ready.** `resolve(state, content, elapsedMs)`, `apply` /
  `applyBatch(state, content, actions, seed)`, `serializeWorld` / `deserializeWorld`,
  `initialWorld(content, seed, nowMs)` and the D.1 action set are pure and tested.
  `TAP` already clamps `count` to `clientElapsedMs / 50` (D.5).
- **The content is checksummed.** `loadBundleDir` + `bundleChecksum` give a validated
  bundle and its version identity.
- **Infra.** `infra/docker-compose.yml` runs Postgres 16 (database `manufactory`) and the
  SuperTokens core (database `supertokens`). The SuperTokens image is `:latest`, which a
  Phase 0 follow-up says must be pinned by Phase 3.
- **Missing.** No `apps/api`, no schema, no migrations, and no public way to ask the
  engine for D.2's `eventSchedule`, because the resolver's next-boundary computation
  (`nextDiscontinuity`) is internal.

## Decomposition (three PRs)

| PR | Scope | Ends in |
|---|---|---|
| **3a** | `apps/api` (Fastify), the schema and migrations, content versions, guest players and worlds, `GET /api/world`, `POST /api/actions` with the full D.2 lifecycle except auth and rate limits; the engine's `schedule()` | A guest can play a real server-side world over HTTP |
| **3b** | SuperTokens (EmailPassword; Discord and GitHub wired but off without credentials), session middleware, lazy player creation, `POST /api/auth/claim` | Accounts, and a guest can keep their world by signing up |
| **3c** | Anti-cheat and hygiene: idempotency, per-player token bucket, guest creation rate limit, the server-side tap ceiling, guest cleanup, `action_log` retention, a CI Postgres job, the SuperTokens image pin, the admin migrate endpoint (D.6) | D.5's table, implemented |

Each PR is its own spec section below, its own plan, and its own subagent-driven run.

---

## Cross-cutting rulings

**R-1. Fastify.** D.7's handler is written against Fastify (`reply.code(409).send`), and
SuperTokens ships a Fastify adapter. *Cost if wrong:* swapping the HTTP layer touches only
`apps/api/src/http/`.

**R-2. A `Db` interface over `pg`, tested on PGlite.** Production uses `pg` (node-postgres)
with a `Pool`. Tests use `@electric-sql/pglite`, which is Postgres compiled to WASM and runs
in-process with no container, so `pnpm test` and CI's `check` job need nothing new. Both sit
behind one small interface:

```ts
interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
```

PGlite is single-connection, so it cannot test that `SELECT … FOR UPDATE` serializes two
concurrent requests. That one property is tested against real Postgres when `DATABASE_URL`
is set (skipped otherwise), and 3c adds a CI job with a `postgres:16` service that sets it.
*Cost if wrong:* a PGlite/Postgres dialect gap would show up as a 3c integration failure;
the SQL here is plain enough (jsonb, uuid, timestamptz, `FOR UPDATE`) that none is expected.

**R-3. Plain SQL migrations with a tiny in-repo runner.** `apps/api/migrations/NNN-name.sql`,
applied in order inside a transaction, recorded in a `schema_migrations(version, applied_at)`
table. No migration framework: the schema is small and D.3 gives it in full. *Cost if wrong:*
adopting a framework later is a mechanical port of a handful of files.

**R-4. Content is loaded from disk at startup and recorded in `content_versions`.** The API
loads the bundle directory named by `CONTENT_DIR` (default: the vertical slice), computes
`bundleChecksum`, and upserts `content_versions(version = checksum, checksum, bundle,
published_at)`. Worlds pin `content_version`. An LRU of indexed bundles by version (D.7)
serves worlds pinned to older versions by reading `bundle` from the row. *Why checksum as the
version:* it's already the bundle's identity, and two deploys of identical content then share
a version instead of forking worlds. *Cost if wrong:* a human-readable version label can be
added as a column later.

**R-5. State is stored with `serializeWorld`, not raw jsonb of the object.** `state jsonb` holds
`JSON.parse(serializeWorld(state))`, read back with `deserializeWorld`. The serializer already
handles Decimals and prototype-safe records. `schema_version` is the serializer's format
version. *Cost if wrong:* none expected; this is the engine's own wire format.

**R-6. World time is the server's wall clock in ms.** `resolve(state, content,
now − state.lastResolvedAt)`. `last_resolved_at` mirrors `state.lastResolvedAt` as a
timestamptz for queries and cleanup. The client never supplies time, apart from
`clientElapsedMs` for taps (3c clamps it).

**R-7. The seed.** `apply` takes a PRNG seed. Each world's state already carries `seed`; the
handler passes `state.seed`, so a request's outcome is a pure function of (stored state,
content, now, actions), and replays are exact. *Cost if wrong:* none; this is what the
simulator does.

---

## PR 3a — the API, the schema, and guest play

### Engine addition: `schedule`

```ts
export interface Schedule {
  /** World time (ms) the schedule was computed at. */
  atMs: number;
  /** Per stock item: liquid stock now and its net rate per second. */
  items: Record<ItemId, { stock: string; netPerSecond: number }>;
  /** The next world time a rate changes (an item fills or drains, a timer fires), or null. */
  nextBoundaryAtMs: number | null;
}
export function schedule(state: WorldState, content: IndexedContent): Schedule;
```

It is `nextDiscontinuity` over one `solve`, exported. The client draws each item as a straight
line `stock + net × (t − atMs)` until `nextBoundaryAtMs`, then asks again (D2's "the client draws
straight lines and never solves"). Tests: the boundary equals the time `resolve` would fire its
next event for the same state, and `null` when nothing will change.

### Schema (migration 001)

D.3 verbatim, with these rulings:

- **`players`.** As D.3, plus a check constraint that exactly one of `supertokens_user_id` and
  `guest_token` is non-null. `current_rank`, `lifetime_tickets` and `leaderboard_score` are
  created with defaults 0 and are written by nothing yet (D.5 says they must exist from the
  start).
- **`player_worlds`.** As D.3. `world_type` is `'main'` for now; `expedition_id` is null.
  Spec 3 adds expeditions.
- **`action_log`.** As D.3, with an index on `(world_id, created_at)`. **Ruling R-8:** not
  partitioned yet. Monthly partitions plus 30-day retention land in 3c as a nightly
  `DELETE … WHERE created_at < now() − 30 days`; real partitioning waits until the table is big
  enough to need it. *Cost if wrong:* converting to a partitioned table later is a one-time
  migration.
- **`idempotency`.** **Ruling R-9:** it stores the full response (`response jsonb`), not only
  `response_hash`, because D.5 says "cached response returned verbatim", and a hash can't be
  returned. The table is created in 3a and used in 3c.
- **`sessions`.** As D.3; 3a creates the table, and a session row is written on world load
  (`client` from the `User-Agent`), closed after 30 minutes idle by 3c's cleanup.

### Endpoints

| Method | Path | 3a behaviour |
|---|---|---|
| `POST` | `/api/guests` | Create a guest player with a server-generated 256-bit token and a fresh world on the current content version. Returns `{ guestToken, world }`. |
| `GET` | `/api/world` | Resolve the caller's world to now **without persisting**, and return `{ state, schedule, stateVersion, contentVersion }`. |
| `POST` | `/api/actions` | D.2 lifecycle: `{ idempotencyKey, baseVersion, actions }` → `{ state, schedule, summary, stateVersion }`, or `409 { failedAction, index, reason }`. |
| `GET` | `/api/health` | `{ ok: true, contentVersion }`. |

**Ruling R-10: the guest token is server-generated.** D.3 says "client-generated,
localStorage". A server-generated token is no less private and can't be chosen by an attacker
to collide with another guest's. The client still stores it in localStorage and sends it as
`Authorization: Guest <token>`. *Cost if wrong:* none; the client never needs to choose it.

**Ruling R-11: `GET /api/world` does not write.** Resolving is deterministic, so a read can
compute "now" without persisting, and only `POST /api/actions` moves `last_resolved_at`. That
keeps reads cheap and idempotent. *Cost if wrong:* a long-idle world re-resolves a capped
offline window on every read until the next action. `resolve` caps at `offlineCapMs`, so that
is bounded.

**The `POST /api/actions` transaction** (3a implements steps 2–9; auth in 3a is the guest
header, SuperTokens in 3b; idempotency and rate limits in 3c):

```
BEGIN
SELECT … FROM player_worlds WHERE player_id = $1 AND world_type = 'main' FOR UPDATE
resolve(state, content(pinned), now − state.lastResolvedAt)
applyBatch(resolved, content, actions, resolved.seed)   -- 409 on the first rejection, ROLLBACK
UPDATE player_worlds SET state, state_version = state_version + 1, last_resolved_at = now
INSERT INTO action_log (player_id, world_id, actions, idempotency_key, created_at)
COMMIT
```

The request body is validated with a schema per action type: unknown types, missing fields
and wrong types are a `400` before the transaction opens. The engine still validates
semantics: affordability, liveness, counts.

### Layout

```
apps/api/
  src/
    server.ts          # buildServer({ db, content, clock, auth }) → FastifyInstance
    main.ts            # process entry: env → pg Pool → migrate → listen
    db/                # Db interface, pg + PGlite adapters, migrate()
    content.ts         # load + upsert content_versions + LRU by version
    worlds.ts          # load/create/persist; the D.2 transaction
    http/              # routes, body schemas, error mapping
  migrations/001-initial.sql
```

`buildServer` takes its dependencies (db, content, a clock function, an auth resolver), so
tests build a server on PGlite with a fake clock and inject requests with Fastify's
`inject()`. There's no network in tests.

### Acceptance (3a)

- **Engine:** `schedule` unit tests (the boundary matches `resolve`'s next event; null when
  nothing will change).
- **API, on PGlite, through `inject()`:**
  1. `POST /api/guests` creates a player and a world; the world is `initialWorld` at the
     fake clock's now.
  2. `GET /api/world` after the clock advances returns resolved stock that matches
     `resolve` directly, and writes nothing (`state_version` unchanged).
  3. `POST /api/actions` with an affordable `BUY_MACHINE` returns the new state, bumps
     `state_version`, appends one `action_log` row, and moves `last_resolved_at`.
  4. A batch whose second action is rejected returns `409` with index 1 and the engine's
     reason, and persists nothing (`state_version` and `action_log` unchanged).
  5. A malformed body is a `400` and opens no transaction.
  6. An unknown or missing guest token is a `401`.
  7. A world pinned to an older content version is served with that version's bundle.
  8. Replaying the `action_log` through `applyBatch` reproduces the stored state, which is
     §16.3's "a real player's session file is directly replayable".
- **The suite, lint, typecheck and content check all pass.** The pacing gate is unaffected.

---

## PR 3b — accounts

- **The SuperTokens core:** EmailPassword, plus Discord and GitHub third-party providers.
  The providers are configured only when their client id and secret env vars are set
  (**Ruling R-12:** no credentials in the repo, so dev and CI run EmailPassword only).
- **Session middleware** on every `/api` route except `/api/health`, `/api/guests` and
  SuperTokens' own `/auth/*`. A request is authenticated by a SuperTokens session *or* a
  guest token, never both. **Ruling R-13:** if both are present, the session wins and the
  guest token is ignored, except on `/api/auth/claim`.
- **Lazy player creation (D.4).** On the first authenticated request with no `players` row
  for the SuperTokens user, create one along with a fresh world.
- **`POST /api/auth/claim { guestToken }`.** In one transaction:
  - if the token's row exists and `supertokens_user_id IS NULL`, attach the session's user
    id and null the guest token;
  - if that user already has a player row, `409 already-has-world`. **Ruling R-14:** there
    is no merge; D.4's ordering (claim before world creation) is what avoids merges, so a
    user who already played on their account must keep one world. The client offers the
    claim on first sign-in, before the first authenticated `GET /api/world`.
- **Tests.** The auth resolver is injected, so the API's tests use a fake session resolver.
  SuperTokens' own verification is exercised by one smoke test, behind
  `SUPERTOKENS_CONNECTION_URI`, that is skipped without it.

## PR 3c — D.5, implemented

| Guard | Implementation |
|---|---|
| Replay | `idempotency(key, player_id, response, created_at)`. Step 4 of D.2: inside the transaction, after the row lock, a seen key returns the stored response verbatim. 24-hour TTL via cleanup. |
| Action rate | A per-player token bucket, 30 tokens, refilling 3/s, in process memory, returning `429` with `Retry-After`. **Ruling R-15:** per-instance memory. D.7 says instances are stateless apart from the content LRU; a shared limiter (Postgres or Redis) is deferred until there's more than one instance. |
| Guest creation | A per-IP bucket, 5 per hour, on `POST /api/guests`. |
| Tap ceiling | The handler caps every `TAP.clientElapsedMs` at the server's elapsed time since the world's last tap flush (stored in state), before `applyBatch`. The engine's own clamp then applies. |
| Elapsed time | Already server-only (R-6). |
| Double-resolve | Already covered: the row lock in 3a. Proved here against real Postgres: two concurrent `POST /api/actions` on one world serialize, and the second sees the first's state. |
| Illegal actions | Already covered: validated against the pinned version in 3a. |
| Resolve-cost DoS | Already covered: the engine's `MAX_EVENTS` / `EPSILON_MS`. A test pins that a world idle for a year resolves within the offline cap in bounded time. |

**Hygiene and the cleanup job** (`pnpm --filter @manufactory/api cleanup`, a CLI suitable
for a nightly cron):
- delete guest players with `last_seen_at` older than 30 days, along with their worlds;
- delete `action_log` rows older than 30 days and idempotency rows older than 24 hours;
- close sessions idle for 30 minutes.

**Also in 3c:**
- **Pin the SuperTokens image** to a specific version tag in `infra/docker-compose.yml`
  (the Phase 0 carry-forward).
- **The admin migrate endpoint (D.6):** `POST /api/admin/migrate-world { playerId,
  toVersion }`, guarded by an `ADMIN_TOKEN` env var. It re-pins a world's
  `content_version`, keeps its state, and is validated by the engine loading it.
- **A CI `api-integration` job** with a `postgres:16` service, running the
  `DATABASE_URL`-gated tests: the concurrency serialization test and a migrations-on-real-
  Postgres check.

## What Phase 3 does not do

- No web client (Phase 4) and no production deployment.
- No leaderboards or statistics (Specs 3–4), though their columns and tables exist.
- No rank-based content migration (Spec 2).
