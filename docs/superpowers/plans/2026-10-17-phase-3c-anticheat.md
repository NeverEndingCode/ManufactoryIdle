# Phase 3c: D.5 implemented — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 3. The goal has three parts.
- **D.5:** implement idempotent replay, the per-player and per-IP rate limits, the server-side tap ceiling, the cleanup job and the admin migrate endpoint (D.6).
- **Real-Postgres proof:** add a CI job that runs the `DATABASE_URL`-gated tests on real Postgres.
- **3a/3b review carry-forwards:** close the ones the spec lists under "Carried from 3a review".

**Architecture:** all the work is in `apps/api`.
- **Task 1:** idempotency.
- **Task 2:** rate limits and the tap ceiling.
- **Task 3:** replay integrity: an action-log content version, a replay base, and cleanup.
- **Task 4:** admin migrate, the advisory-locked migrate, the real-Postgres tests, the CI job and docs.

**Tech Stack:** TypeScript ESM, Fastify 5, `pg`, PGlite, vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-16-phase-3-server-design.md`, the PR 3c section and its "Carried from 3a review" list.

## Rulings made in this plan

- **R-19. The tap ceiling lives on the server.**
  - A new column, `player_worlds.last_tap_flush_at timestamptz` (nullable, null meaning "never"), records the request time of the last batch that held a `TAP`.
  - Before `applyBatch`, the handler gives the batch a budget of `now − last_tap_flush_at`. For a world that has never tapped, the budget is `now − created_at`. The `TAP`s are capped in order, so their `clientElapsedMs` together never exceed the budget.
  - After a successful batch with any `TAP`, the column becomes `now`. The engine's own per-tap clamp then still applies.
  - *Why it's not engine state:* it's a server trust boundary, not game state, and sims and replays don't need it.
  - *Replay:* the capped actions are what get logged, so replay stays exact.
- **R-20. A replay base, so retention doesn't end replayability.** `player_worlds` gains `replay_base_state jsonb` and `replay_base_at timestamptz`, both null until the first cleanup. When the cleanup job deletes `action_log` rows older than 30 days for a world:
  1. it replays those rows onto the base, where the base is `replay_base_state`, or the recorded start (`initial_*`) when that is null;
  2. it stores the result as the new base, in the same transaction as the delete.

  So replay from base plus the remaining log still reproduces the world byte for byte.
- **R-21. Every log row records its content version.** `action_log` gains `content_version text not null`, holding the world's pinned version at the time of the batch, so replay crosses a D.6 re-pin correctly. The admin migrate endpoint also writes an `action_log` row with `actions = []` and the new version, so the re-pin is itself in the log.
- **R-22. One name per meaning.** The API response field `contentVersion` (a checksum) is renamed `contentChecksum`, which is free while there are no clients. `state.contentVersion` stays the bundle's authored label. Update the README, the spec and the tests.
- **R-23. Rate limits are per instance** (spec R-15). A per-player bucket holds 30 tokens and refills 3 per second. A per-IP bucket on `POST /api/guests` allows 5 per hour. Both live in memory and are injected (`limits` in `ServerDeps`) with an injectable clock, so tests are deterministic. Over the limit, the response is `429` with `Retry-After` in whole seconds.

## Global Constraints

- **Where to work:** `.claude/worktrees/phase-3-api`, branch `phase-3c-anticheat`, stacked on `phase-3b-auth`. Never touch `phase-1-engine`.
- **Migrations:** 001 has been released since PR #18 merged, or will be by the time this lands. **Add `002-anticheat.sql`; never edit 001.**
- **The engine doesn't change.**
- **Tests on PGlite by default.** The real-Postgres tests use `describe.skipIf(!process.env.DATABASE_URL)` and run in a new CI job.
- **Commands:**
  - Never run `pnpm format`.
  - Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another in the foreground; never run anything in the background.
  - Never `pkill -f`; no `pgrep -f` loops.
- **Commit trailers:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **Idempotency is atomic with the batch.** The cached response is written in the same transaction as the state. A replayed key returns it verbatim, even when the original was a 409, and never applies twice. Covered by Task 1.
- **The tap budget can't be gamed by splitting batches**, because the budget accumulates server time only. Covered by Task 2.
- **Replay from base plus log stays byte-exact across a cleanup and across a re-pin.** Covered by Tasks 3 and 4.

---

### Task 1: Idempotent `POST /api/actions`, test-first

- **What:** step 4 of D.2. Inside the transaction, after the `FOR UPDATE`:
  - look up `idempotency(player_id, key)`;
  - if the key is found, return the stored response verbatim, with the same status code, and apply nothing;
  - otherwise process the batch, then insert `(player_id, key, response, created_at = clock())` in the same transaction.

  A rejected batch (409) also stores its response, through a separate small transaction after the rollback, since the main transaction is gone. **Ruling:** store it so a retry gets the same 409. Store the status code alongside the body: add a `status int` column in `002-anticheat.sql`.
- **Tests:**
  - the same key twice: the second response is identical, with `state_version` bumped once and one `action_log` row;
  - two players using the same key don't interfere;
  - a replayed 409 returns the same 409;
  - different bodies under the same key return the *stored* response; document that the key wins.
- **Mutation:** apply the batch before the lookup. The double-apply test must fail.

### Task 2: Rate limits and the tap ceiling, test-first

- **Rate limits (R-23):**
  - a `TokenBucket` with an injectable clock, unit-tested;
  - the per-player limit sits on `/api/world` and `/api/actions` after auth;
  - the per-IP limit sits on `POST /api/guests`, keyed on `request.ip` (document `trustProxy` for a proxied deployment);
  - `429` with `Retry-After`;
  - tests drive the fake clock: 30 quick calls pass, the 31st gets 429, and calls pass again after refilling.
- **Tap ceiling (R-19):**
  - add `last_tap_flush_at` in 002;
  - cap the batch's `TAP.clientElapsedMs` in order;
  - log the capped actions, and replay test 8 still passes.
- **Tap tests:**
  1. a TAP claiming 60,000 ms, two seconds after creation, applies at most 40 taps (2,000 ms / 50);
  2. two batches one second apart, each claiming 60,000 ms, add at most about 20 taps each;
  3. a batch without TAP doesn't move the column.
- **Mutation:** use `clientElapsedMs` unclamped. Test 1 must fail.

### Task 3: Replay integrity and cleanup, test-first

- **Schema (002):**
  - `action_log.content_version text` (backfill existing rows with the world's `content_version`, then `not null`; R-21);
  - `player_worlds.replay_base_state jsonb` and `replay_base_at timestamptz` (R-20).
- **Write path:** the action handler writes `content_version` on every log row.
- **A shared `replayWorld(db, worldId)` helper** (in `worlds.ts`):
  - starts from the replay base, or the recorded start;
  - for each log row, `resolve`s to its time on that row's content version, then `applyBatch`;
  - is used by tests and by cleanup.
- **The cleanup CLI** (`apps/api/src/cleanup.ts`, plus a `cleanup` script). Each step is its own transaction, and each takes an injectable `now`:
  1. delete guest players whose `last_seen_at` is older than 30 days, with their worlds, logs and sessions;
  2. per world with log rows older than 30 days, advance the replay base (R-20) and delete those rows;
  3. delete idempotency rows older than 24 hours;
  4. close sessions idle for 30 minutes, meaning the player's `last_seen_at` is more than 30 minutes before `now` and the session is still open.
- **Tests:**
  - each step does what it says on seeded data;
  - after step 2, `replayWorld` still byte-equals the stored state;
  - an account player (non-guest) is never deleted.

### Task 4: Admin migrate, migrate lock, real Postgres, CI, docs

- **`POST /api/admin/migrate-world { playerId, toVersion }`:**
  - requires `Authorization: Admin <ADMIN_TOKEN>`, compared in constant time (`crypto.timingSafeEqual`), and returns 404 if `ADMIN_TOKEN` is unset;
  - checks that `toVersion` exists in `content_versions` and that the world deserializes and resolves under it;
  - re-pins `content_version` (never `initial_content_version`) and writes the R-21 log row.
  - **Tests:** wrong token gets 401, unknown version gets 400, success re-pins, and replay stays exact across it.
- **`migrate` takes `pg_advisory_xact_lock(<constant>)`** inside each migration transaction. On PGlite, check that the function exists. If it doesn't, guard it behind a `Db` capability flag and say so.
- **Real-Postgres tests** (`apps/api/src/pg.integration.test.ts`, `skipIf(!DATABASE_URL)`), each on a fresh schema or with tables truncated:
  - migrations apply on Postgres 16;
  - **two concurrent `POST /api/actions` on one world serialize.** Open two `pg` pools; the second sees the first's `state_version`, ends with `state_version` 2, and has two log rows;
  - the pg adapter destroys a client after a failed COMMIT, if it can be provoked cheaply (otherwise skip that one, and say why);
  - concurrent lazy creation and claim on real Postgres: one player, and a 409.
- **CI:**
  - add an `api-integration` job to `.github/workflows/ci.yml` with a `postgres:16` service (health-checked);
  - set `DATABASE_URL` and run `pnpm --filter @manufactory/api test`;
  - `timeout-minutes: 15`;
  - give it its own comment, in the file's style.
- **The carried tests:**
  - the 4xx allowlist: a non-Fastify 4xx returns a generic message;
  - the logger-instance path;
  - content LRU eviction (open 9+ versions, built from small variants via `indexContent`) and in-flight dedupe of concurrent `get`s.
- **Docs:**
  - `apps/api/README.md`: the guards, cleanup, admin, and the renamed `contentChecksum`;
  - the spec: 3c status, and every "Carried from 3a review" item marked done or deferred, with a reason (the pin-cycle boundary goes to Phase 4, the client);
  - the root README: Phase 3 complete.
