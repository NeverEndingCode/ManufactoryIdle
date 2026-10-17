# Phase 3b: accounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in player (SuperTokens) gets their own world, created lazily on first request. A guest can keep their world by claiming it when they sign up, through `POST /api/auth/claim`. Guests keep working exactly as in 3a.

**Architecture:**
- **Task 1:** identity resolution behind an injected `SessionVerifier`, plus lazy account players. Tested with a fake verifier.
- **Task 2:** `POST /api/auth/claim`.
- **Task 3:** real SuperTokens wiring (init, the Fastify plugin, CORS, providers from env), `main.ts`, a gated smoke test, the SuperTokens image pin, and docs.

**Tech Stack:** TypeScript ESM, Fastify 5, `supertokens-node` 24, `@fastify/cors`, PGlite and `pg`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-phase-3-server-design.md`, PR 3b section (rulings R-12, R-13, R-14).

## Rulings made in this plan

- **R-16. Accounts are optional at runtime.** If `SUPERTOKENS_CONNECTION_URI` is unset, the API starts guest-only. It logs one line saying accounts are disabled, registers no SuperTokens routes, and `/api/auth/claim` answers `503 accounts-disabled`. *Why:* dev and CI run without a SuperTokens core, which matches 3a. *Cost if wrong:* a config flag.
- **R-17. A lazy-creation race resolves to one player.** Two concurrent first requests from one SuperTokens user can both try to insert. The `unique(supertokens_user_id)` constraint rejects the second insert, which then re-selects and uses the existing row. *Cost if wrong:* none.
- **R-18. A claimed or unknown token gets `404`.** Claiming nulls the guest token, so a second claim of the same token can't find it. A `404 unknown-guest` doesn't reveal whether the token ever existed.

## Global Constraints

- **Where to work:** `.claude/worktrees/phase-3-api`, branch `phase-3b-auth`, stacked on `phase-3a-api` (PR #18). Never work in the top-level checkout or in `phase-1-engine`.
- **No network in tests.** `buildServer` gains an injected `verifySession: (request) => Promise<string | null>`, which returns the SuperTokens user id or null. Tests pass a fake that reads a test-only header; production passes the SuperTokens verifier.
- **Guest behaviour is unchanged:** every 3a test still passes as written.
- **Dependencies:** add only `supertokens-node` (^24) and `@fastify/cors` to `apps/api`. Run `pnpm install` once, and commit the lockfile.
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

- **Precedence (R-13).** A request carrying both a session and a guest token acts as the session's player, everywhere except `/api/auth/claim`. Covered by Task 1 test 3.
- **Claim atomicity.** A claim either fully moves the guest's player row to the account, or changes nothing. Covered by Task 2's tests.
- **No account world before a claim.** Claiming must work when the account has never made a request. `/api/auth/claim` therefore must not trigger lazy creation first. Covered by Task 2 test 1.

---

### Task 1: identity resolution and lazy account players, test-first

**Files:**
- Modify: `apps/api/src/server.ts` (the auth hook and `ServerDeps`), `apps/api/src/worlds.ts` (factor `createGuest` into a shared `createPlayerWithWorld`)
- Create: `apps/api/src/identity.ts`
- Test: `apps/api/src/identity.test.ts` (new) and the existing `server.test.ts`

**Interfaces:**

```ts
export type SessionVerifier = (request: FastifyRequest) => Promise<string | null>; // SuperTokens user id
/** Resolves the caller: a session (lazily creating the account's player and world) wins over a guest token. */
export function identityAuth(deps: { db: Db; content: ContentStore; clock: () => number; verifySession: SessionVerifier }): Auth;
/** A verifier that never finds a session (guest-only servers and the 3a tests). */
export const noSessions: SessionVerifier;
```

- `ServerDeps.auth` stays an `Auth`, so the 3a tests keep using `guestAuth(db)` unchanged. `main.ts` builds `identityAuth(...)`.
- `createPlayerWithWorld(tx, { guestTokenHash } | { superTokensUserId }, content, clock)` holds the player and world insert that `createGuest` does today, and `createGuest` calls it.

- [ ] **Step 1: Write the failing tests** (`identity.test.ts`). Run on PGlite, with a server built using `identityAuth` and a fake verifier that returns the value of the `x-test-user` header, or null.
  1. **Lazy creation.** A first `GET /api/world` as user `u1` returns `200` and creates exactly one player, with `supertokens_user_id = 'u1'`, a null `guest_token`, and one world equal to `initialWorld(content, initial_seed, now)`. A second GET creates nothing more.
  2. **The race (R-17).** Two concurrent first GETs as `u2` leave exactly one player row. (PGlite serializes them, so also unit-test the conflict path. Call `createPlayerWithWorld` twice for the same user; the second call must return the existing player and must not throw.)
  3. **Precedence (R-13).** A guest is created through `POST /api/guests`. Then a request with both `x-test-user: u3` and the guest's `Authorization` header acts as u3's world (lazily created), and the guest's world is untouched.
  4. **Guests still work.** Guest-only requests still work under `identityAuth`, and with no session and no guest token the response is `401`.
- [ ] **Step 2:** run them; they fail.
- [ ] **Step 3:** implement, keeping guest-only behaviour byte-identical. All 3a tests stay green.
- [ ] **Step 4: Mutation.** Swap the precedence so the guest wins; test 3 must fail. Undo by hand.
- [ ] **Step 5:** run lint and typecheck, then commit: `Accounts: resolve a SuperTokens session to a lazily created player`.

---

### Task 2: `POST /api/auth/claim`, test-first

**Files:**
- Modify: `apps/api/src/server.ts`, `apps/api/src/worlds.ts` (a `claimGuest` function)
- Test: `apps/api/src/identity.test.ts`

**Route:** `POST /api/auth/claim { guestToken: string }`. It requires a session; a guest token alone gets `401`. It does **not** go through lazy creation. In one transaction:
1. If the session user already has a player row, return `409 { error: "already-has-world" }` (R-14).
2. Otherwise find the player by `sha256(guestToken)` with `supertokens_user_id IS NULL`, `FOR UPDATE`. If there's none, return `404 { error: "unknown-guest" }` (R-18).
3. Otherwise set `supertokens_user_id = user` and `guest_token = null`, and return `200` with the world view.

The body schema is `guestToken` matching the 43-character base64url pattern, with `additionalProperties: false`.

- [ ] **Step 1: Write the failing tests.**
  1. **Claim before first use.** A guest plays (one `POST /api/actions`). Then `u5` claims the token *without making any request before it*. The response is `200`, and that player row now has `supertokens_user_id = 'u5'` and a null `guest_token`. Its world, `state_version` and `action_log` are unchanged. `GET /api/world` as u5 serves that same world, and the old guest token now gets `401`.
  2. **Already has a world.** u6 makes one GET, which lazily creates a world, then claims a guest token: `409 already-has-world`, and the guest is untouched.
  3. **Unknown token:** `404`. **Claiming twice:** the second claim (by u7, after u5's) gets `404`.
  4. **No session** (guest auth only) gets `401`; a malformed body gets `400`.
- [ ] **Step 2:** run them; they fail.
- [ ] **Step 3:** implement.
- [ ] **Step 4: Mutation.** Skip the "already has a player" check; test 2 must fail. Undo by hand.
- [ ] **Step 5:** run lint and typecheck, then commit: `Accounts: claim a guest's world on sign-up (no merge)`.

---

### Task 3: SuperTokens wiring, the smoke test, the image pin, and docs

**Files:**
- Create: `apps/api/src/auth/supertokens.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/package.json`, `infra/docker-compose.yml`, `infra/README.md`, `apps/api/README.md`
- Test: `apps/api/src/auth/supertokens.smoke.test.ts` (skipped unless `SUPERTOKENS_CONNECTION_URI` is set)

- [ ] **Step 1: `supertokens.ts`.**
  - It exports `superTokensFromEnv(env)`, which returns `null` when `SUPERTOKENS_CONNECTION_URI` is unset (R-16). Otherwise it returns `{ register(app), verifySession }`.
  - It initializes `supertokens-node` with `framework: "fastify"`, `appInfo` (`appName: "Manufactory Idle"`, `apiDomain` from `API_DOMAIN`, `websiteDomain` from `WEBSITE_DOMAIN`, `apiBasePath: "/auth"`), and these recipes:
    - EmailPassword;
    - ThirdParty, with Discord and GitHub providers added *only* when their `*_CLIENT_ID` and `*_CLIENT_SECRET` env vars are set (R-12);
    - Session.
  - `register(app)` registers `@fastify/cors` for `WEBSITE_DOMAIN`, with SuperTokens' required headers and credentials, then SuperTokens' Fastify plugin, and chains SuperTokens' error handler ahead of the API's.
  - `verifySession(request)` uses SuperTokens' session lookup with `sessionRequired: false`, and returns the user id or null.

  Read the installed `supertokens-node` package's types and README for the exact Fastify v5 integration API (`supertokens-node/framework/fastify`, `supertokens-node/recipe/session`), and follow what the installed version documents. If its Fastify adapter doesn't support Fastify 5, STOP and report the version facts.
- [ ] **Step 2: `main.ts`.** If `superTokensFromEnv` returns null, log `accounts disabled (SUPERTOKENS_CONNECTION_URI unset)` and use `noSessions`. Otherwise `register(app)` before the routes, and pass its `verifySession` to `identityAuth`. The claim route answers `503 accounts-disabled` when accounts are off (R-16); add a test for that in `identity.test.ts`.
- [ ] **Step 3: the smoke test.** `describe.skipIf(!process.env.SUPERTOKENS_CONNECTION_URI)`: start the real wiring against that core, sign up an EmailPassword user through SuperTokens' `/auth/signup`, use the returned session to `GET /api/world` (lazily created), and claim a guest. Keep it short. It doesn't run in `pnpm test` without the env var.
- [ ] **Step 4: pin the SuperTokens image.** In `infra/docker-compose.yml`, replace `:latest` with a specific version tag of `registry.supertokens.io/supertokens/supertokens-postgresql` that is compatible with the installed `supertokens-node`. Find the compatibility the SDK states: its `coreDriverInterfaceSupported.json` lists CDI versions, and SuperTokens' core release notes map CDI to core versions. If you can't confirm a compatible tag from what's available offline or through the registry, leave `:latest` with a comment saying exactly what blocked it, and report it. Never guess a tag.
- [ ] **Step 5: docs.**
  - **`apps/api/README.md`:** the auth model (session or guest, precedence, claim, the accounts-disabled mode) and the env vars.
  - **`infra/README.md`:** running the API with the compose SuperTokens core, and running the smoke test.
  - **The spec:** a one-line status in the PR 3b section (implemented, with rulings R-16 to R-18).
- [ ] **Step 6:** run `pnpm test` (foreground), then `pnpm lint` and `pnpm typecheck`. Commit: `Accounts: SuperTokens wiring, smoke test, pinned core image, docs`.

The report gives:
- every test count;
- the Fastify 5 integration details used;
- the image tag chosen, and how its compatibility was verified, or why it wasn't.
