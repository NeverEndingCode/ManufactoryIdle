# Phase 4a: the web shell, the sync core and the lane view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stranger opens the page, gets a guest factory from the real API, watches it run, and buys from the bottleneck frame (spec decomposition row 4a).

**Architecture:**
- **Task 1:** `scheduleDetail` in the engine (W-8).
- **Task 2:** the API additions: `GET /api/content/:checksum`, `accounts` in health, `persistedAtMs`, the `exports` map, `src/testing.ts`, `src/dev-server.ts` + `src/dev.ts` + a `dev` script (W-5, W-15, W-22, W-23, OQ1).
- **Task 3:** the `apps/web` scaffold, plus the pure sync primitives in `src/sync/` (wire types, content cache, snapshot, server time, interpolation and plateau, re-fetch policy, idempotency keys, the W-11 classifier, the tap accumulator).
- **Task 4:** `GameStore`: the snapshot store, the re-fetch timer, the outbox and guest start (W-6, W-9 to W-11, W-14), tested against real `buildServer` on PGlite through an `inject()`-backed `fetch`.
- **Task 5:** the lane view, tokens and motion subset (W-1 item 1, W-7, W-17, W-18 subset, W-20 subset), on jsdom.
- **Task 6:** Playwright harness, the one 4a spec, the CI `web-e2e` job, and README.

**Tech Stack:** TypeScript ESM, React 18.3 (`react@18.3.1`, as `apps/sim`), Vite (the lockfile already has `vite@8.2.2` via vitest 4; pin the same), `@vitejs/plugin-react`, vitest 4 + jsdom + Testing Library, `@playwright/test` (Chromium), Fastify 5 + PGlite on the API side.

**Spec:** `docs/superpowers/specs/2026-10-17-phase-4-web-client-design.md`: the 4a row, W-1 item 1, W-2 to W-14, W-17, W-18 (subset), W-20 (subset), W-22 to W-24, W-26, and resolved open questions 1 (`persistedAtMs`) and 2 (no away summary).

## Rulings made in this plan

- **P-1. Satisfaction is `min(1, production / consumption)` from the display solve's `itemRates`, not from `Solution.entries`.** For an item with no consumption, the meter shows 1 if production is above 0, and 0 otherwise. This is the MVP's formula (`manufactory-idle-mvp.html`, `renderLane`).
  - *Why:* W-8 says satisfaction comes from `entries`. But every item entry on the slice has `requested: Infinity` (measured on the fresh world and on both tier-8 fixtures), so `allocated / requested` is 0 everywhere.
  - *Cost if wrong:* one function, `satisfaction(solution, itemId)`, and its test.
- **P-2. The engine reports one bottleneck, so there is at most one frame in the whole factory.** "One per lane" (F.1, W-1, W-18) is read as "never more than one in a lane". Which row gets the frame depends on the bottleneck's kind:

  | `bottleneck.kind` | Framed row |
  |---|---|
  | `recipe` | `content.recipes.get(recipeId).primaryOutput`, in that recipe's lane |
  | `power` with a generator | `primaryOutput` of `generatorRecipeId` (on the slice, `biomass` in lane `power`) |
  | `storage` | `itemId` |
  | `reserve` | `itemId` |
  | `power` with `generatorRecipeId: null` | no row; a one-line notice above the lane tabs |

  The lane tab that holds the framed row also gets a text marker, "!" with `aria-label="bottleneck"`.
  - *Cost if wrong:* the selection lives in one function, `bottleneckRow(content, solution)`.
- **P-3. The inline buy is exactly the sim's `bottleneck` policy's purchase** (`apps/sim/src/policies.ts:429-460`), but without the fallback to smaller counts:
  - lane and class: the advised recipe's `lane` and `machineClass`;
  - `mark`: `bestUnlockedMark(content, machineClass, tier)`;
  - `count`: `max(1, machinesToClear)`;
  - `recipeId`: included only while `isLiveRecipe(...)`.

  If `bestUnlockedMark` is null, or the recipe id is null, there is no button. Frames of kind `storage` and `reserve` show their advice text and no button in 4a; their actions arrive with the 4b drawer. The button is disabled until the purchase is affordable, judged from interpolated liquid plus `bound`. While disabled it reads "affordable in 43s", a countdown from the straight line (W-13). An unreachable cost (net ≤ 0 on a short item) reads "not affordable yet".
  - *Why no fallback:* the frame's text says "N more clears it", so the button buys N.
  - *Cost if wrong:* a 4b drawer offers ×1 anyway.
- **P-4. Past the plateau the client stops scheduling boundary fetches.** Let `plateauAtMs = persistedAtMs + content.offlineCapMs`.
  - **Interpolation** stops at `plateauAtMs`: `shown(t)` uses `min(t, plateauAtMs)`.
  - **No boundary timer is set** once a snapshot's `schedule.atMs >= plateauAtMs`, and the notice "Production paused 8 h after your last action. Do anything to resume." is shown. The "8 h" comes from `offlineCapMs`.
  - **Before the plateau**, the boundary timer targets `min(nextBoundaryAtMs, plateauAtMs) + 250`. That is W-9's guard fetch.
  - *Why:* `resolve` skips the *earliest* `elapsed − offlineCapMs` (`resolve/index.ts:386-391`), so a GET past the plateau returns the plateaued stock with the solve's non-zero rates and a fresh `nextBoundaryAtMs`. A client that obeyed that boundary would poll every fill time forever, and an idle tab would no longer cost zero requests (D5).
  - *Missing field:* a response without `persistedAtMs` has `plateauAtMs = Infinity`. A replayed idempotent response stored before this PR has no such field.
  - *Cost if wrong:* a plateaued tab that needs a click to wake up.
- **P-5. `persistedAtMs` is the stored state's `lastResolvedAt`, read before the in-memory resolve. No migration.**
  - The column `player_worlds.last_resolved_at` is written from the same value on every path: create (`nowMs`), `applyActions` (`batch.state.lastResolvedAt`) and `migrateWorld` (`state.lastResolvedAt`).
  - The state's own value is exact. `timestamptz` keeps microseconds, and fixture worlds have fractional `lastResolvedAt`.
  - A test asserts that the value equals the column (to the ms) on GET, POST and guest creation.
- **P-6. Backoff schedule.** These constants live in `src/sync/constants.ts`:
  - `MIN_REPOLL_MS = 5_000`
  - `BOUNDARY_SLACK_MS = 250`
  - `SHORT_BOUNDARY_MS = 1_000`
  - `SHORT_STREAK = 3`
  - `REPOLL_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000]`

  How `streak` moves:
  - It counts consecutive adopted snapshots whose `nextBoundaryAtMs − atMs < SHORT_BOUNDARY_MS`.
  - A longer or null boundary resets it to 0.
  - So does any adopted `POST` response (an action).

  The minimum gap is `REPOLL_STEPS_MS[clamp(streak − SHORT_STREAK + 1, 0, 4)]`. So the third short snapshot in a row gives 10 s, the fourth 20 s, the fifth 40 s, and the sixth and later 60 s.
- **P-7. The network-retry backoff for the outbox.**
  - `RETRY_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]`, then 30 s.
  - An "offline" banner shows after the 2nd consecutive failure (`OFFLINE_AFTER_FAILURES = 2`).
  - `online` retries at once.
  - A `GET` that fails with a network error or 5xx uses the same steps.
- **P-8. Clocks and timers are one injected `ClientClock`.** In tests a `FakeClientClock` advances it, and `TestRig.advance(ms)` moves the server clock by the same amount. This keeps the client and the server in step without patching globals, and without vitest fake timers, which would stall PGlite's and Fastify's own promises.
- **P-9. Tests and e2e wait on store state, never on sleeps.**
  - `GameStore.idle()` resolves when nothing is in flight and the outbox is empty.
  - The app root mirrors the store as `data-sync="loading|ready|offline|error"` and `data-state-version`.
  - Playwright waits on those attributes and on visible text (W-23).
- **P-10. The e2e waits for affordability in real time.** A fresh slice guest's advised buy, `make_iron_plate` → constructor Mk1 ×1, costs 21.31 iron_ingot. Ingot arrives at 0.5/s, so the buy is affordable about 43 s after creation (measured with the engine).
  - The spec waits up to 120 s for the button to enable, and its test timeout is 180 s.
  - *Why not a fast server clock:* the client would interpolate at 1× against a server at k×, and the button would be wrong in both directions.
  - *Cost if wrong:* about 45 s of CI time.
- **P-11. `dev-server.ts` raises the per-IP guest limit to 1000 per hour.** Every e2e run, retry and local rerun makes a guest from 127.0.0.1, and the default of 5 per hour would make the third local rerun fail. The default stays in `buildServer`; only the dev entry overrides it, and its comment says why.
- **P-12. Ports.**
  - API dev: `8787`.
  - Vite dev: `5173`.
  - `vite preview`, used by e2e: `4173`.

  Both the Vite `server.proxy` and `preview.proxy` forward `/api` and `/auth` to `http://127.0.0.1:${API_PORT ?? 8787}` (W-2).
- **P-13. Two tsconfigs in `apps/web`.**
  - `tsconfig.json` covers app code: `src/**/*.{ts,tsx}` minus tests. It has the DOM libs, `types: ["vite/client"]` and `jsx: "react-jsx"`.
  - `tsconfig.node.json` covers the tests, `e2e/`, `vite.config.ts` and `playwright.config.ts`, with `types: ["node"]`.
  - `typecheck` and `build` run both.
  - *Why:* app code must not see Node types, while the sync tests import `@manufactory/api`. ESLint also bans `node:*` and `@manufactory/api` in non-test `src` files.
- **P-14. `GET /api/content/:checksum` reads `content_versions` directly.**
  - It runs `select bundle from content_versions where version = $1`.
  - The param must match `^[0-9a-f]{64}$`: `bundleChecksum` is sha256 hex. Anything else is a 404, never a 400, so the route reveals nothing.
  - There's no rate limit: the response is immutable and cacheable, and a 29 KB row read is cheaper than a bucket lookup's 429 path is to reason about.
  - *Cost if wrong:* adding the IP bucket is one line.
- **P-15. `pgliteDb(dataDir?: string)`** passes `dataDir` to `new PGlite(dataDir)`, so `PGLITE_DIR` works (W-23). Today the function takes no argument.
- **P-16. The tap accumulator is built and tested in 4a; nothing renders it.** The holdable tap UI is 4b (W-1 item 4).

## Global Constraints

- **Where to work:** `.claude/worktrees/phase-4-web` only, on branch `phase-4-web` (cut from `main` at 8994558, with the spec commit 17248b0 on top). Never work in the top-level checkout.
- **Commands:**
  - Never run `pnpm format`. It rewrites the whole repo.
  - Verify with `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, one after another in the foreground. Never run anything in the background: turbo builds race.
  - Never `pkill -f`. No `pgrep -f` loops.
  - No containers: no Docker, no compose. The dev server and e2e use PGlite.
- **Migrations:** add a new numbered file only; never edit `001`/`002`. 4a needs **no** migration (P-5).
- **The engine stays pure** (lint-enforced). `schedule`'s output stays byte-identical (Task 1).
- **Browser code never imports `@manufactory/content`, `@manufactory/api` or `node:*`** (W-4, P-13). That is lint-enforced in Task 3.
- **No network in unit tests.** Sync tests run `buildServer` on PGlite through `app.inject()`. Nothing listens on a port except Playwright's `webServer`.
- **Dependencies:**
  - `apps/web` gets `react`, `react-dom` (`^18.3.1`) and, as devDependencies: `vite` (match the lockfile's `8.2.2`), `@vitejs/plugin-react`, `@types/react` (`^18.3.0`), `@types/react-dom` (`^18.3.0`), `@testing-library/react`, `@testing-library/user-event`, `@testing-library/dom`, `jsdom`, `@playwright/test`, `eslint-plugin-react-hooks` (at the root), `typescript`, `vitest`, `@types/node`, and `@manufactory/api` + `@manufactory/engine` (`workspace:*`).
  - `supertokens-web-js` is **not** added in 4a (accounts are 4c).
  - For any version not already in the lockfile, pin the version that pnpm resolves, recorded in the lockfile. If the network allows, check it with `pnpm view <pkg> version` first, and confirm that `@vitejs/plugin-react`'s peer range includes vite 8. If it doesn't, pin the newest plugin whose peer range does, and record that in the commit message.
  - Run `pnpm install` once per `package.json` change and commit the lockfile.
- **Commit trailers, exactly:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **Ordering and identity of snapshots.** A response is adopted only if `(stateVersion, schedule.atMs)` is not older than the current snapshot's. A `GET` racing a `POST` can't roll the screen back. Covered by Task 4 test 3.
- **One key per batch, for life.** Every retry of a batch reuses its key and gets the stored replay. Batches are never merged, and taps never ride with spends. Covered by Task 4 tests 5–6 and Task 3 test 8.
- **An idle tab costs zero requests.** That holds for a null boundary, for the EPSILON cycle (it backs off to 60 s), and past the plateau (P-4). Covered by Task 4 tests 2, 4 and 9.
- **The display never re-derives server rates.** Rates and the boundary come from the server's `schedule`; only the solution comes from `scheduleDetail`. `schedule` stays byte-identical. Covered by Task 1 and Task 3 test 4.
- **Browser purity.** No `@manufactory/content`, `@manufactory/api` or `node:` in `apps/web/src` app code, and only `transform`/`opacity` animate. Covered by the Task 3 lint mutation and Task 5 test 7.

---

### Task 1: `scheduleDetail` in the engine, test-first

**Files:**
- Modify: `packages/engine/src/resolve/index.ts`
- Test: `packages/engine/src/resolve/schedule.test.ts`

**Interfaces:**
- Consumes: `solve(state, content): Solution` (`solve/solve.ts:45`), and the existing `schedule` loop (`resolve/index.ts:276-306`).
- Produces, exported from `@manufactory/engine`:

```ts
export interface ScheduleDetail {
  schedule: Schedule;
  /** The state schedule() advanced past internal unpins; its lastResolvedAt === schedule.atMs. */
  state: WorldState;
  /** solve(state, content) of that advanced state: the rates schedule.items came from. */
  solution: Solution;
}
export function scheduleDetail(state: WorldState, content: IndexedContent): ScheduleDetail;
export function schedule(state: WorldState, content: IndexedContent): Schedule; // = scheduleDetail(...).schedule
```

- [ ] **Step 1: Write the failing tests** in `schedule.test.ts`. Use the existing `content`/`slice` setup, and the two fixtures in `resolve/fixtures/`, read with `deserializeWorld(readFileSync(...))`.
  1. **Byte-identical.** For each of these worlds, `JSON.stringify(scheduleDetail(s, c).schedule) === JSON.stringify(schedule(s, c))`:
     - `initialWorld(content, 1, 0)`;
     - `initialWorld(slice, 1, 0)`;
     - `slice-tier-8.world.json`;
     - `slice-tier-8-reinforced-full.world.json`.

     Add a golden check as well: before the refactor, run the current `schedule` on `initialWorld(slice, 1, 0)` and paste its JSON into a const in the test, `GOLDEN_FRESH_SLICE`. The refactor must still produce it.
  2. **The advanced state.** On a fresh slice world:
     - `detail.state.lastResolvedAt === detail.schedule.atMs`;
     - `detail.state` deep-equals `resolve(initial, slice, EPSILON_MS).state`, which is the unpin step the existing test already uses.
  3. **The solution matches the rates.** For every stock item, `detail.solution.itemRates.get(id)?.net ?? 0 === detail.schedule.items[id].netPerSecond`. Check this on all four worlds.
  4. **No unpin needed.** On `slice-tier-8.world.json`, `detail.state` is the input object, or deep-equals it.
- [ ] **Step 2:** run `npx vitest run src/resolve/schedule.test.ts` in `packages/engine`. Expect a failure: `scheduleDetail` isn't exported.
- [ ] **Step 3: Implement.** Move the body of `schedule` into `scheduleDetail`, return `{ schedule: {atMs, items, nextBoundaryAtMs}, state: current, solution }`, and make `schedule` return `scheduleDetail(state, content).schedule`. Keep the doc comment on `schedule`, and add one line saying it delegates. Export `ScheduleDetail`.
- [ ] **Step 4:** run the whole engine suite.
- [ ] **Step 5: Mutation check.** Return the *input* state and `solve(input)` from `scheduleDetail` while keeping `schedule` correct. Tests 2 and 3 must fail on the fresh slice world, where iron_ore is 0.98 pinned and 1.0 unpinned. Undo the mutation by hand.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck` in sequence. Commit: `Engine: scheduleDetail, the advanced state and its solve behind schedule (W-8)`.

---

### Task 2: the API additions, test-first

**Files:**
- Modify: `apps/api/src/server.ts`, `apps/api/src/worlds.ts`, `apps/api/src/db/pglite.ts`, `apps/api/package.json`, `apps/api/README.md`
- Create: `apps/api/src/testing.ts`, `apps/api/src/dev-server.ts`, `apps/api/src/dev.ts`
- Test: `apps/api/src/server.test.ts` (extend), `apps/api/src/dev-server.test.ts` (new)

**Interfaces:**
- Consumes: `buildServer`, `ServerDeps`, `World`, `fromRow`, `createGuest`, `viewWorld`, `applyActions`, `claimGuest` (`server.ts`, `worlds.ts`), and `identityAuth`, `noSessions` (`identity.ts`).
- Produces:

```ts
// worlds.ts
export interface World { /* existing fields */ persistedAtMs: number } // stored state's lastResolvedAt (P-5)

// server.ts: response shapes
// GET /api/health → 200 { ok: true, contentChecksum: string, accounts: boolean }   // accounts = deps.accounts !== undefined
// GET /api/content/:checksum → 200 <ContentBundle JSON>, header cache-control: public, max-age=31536000, immutable
//                            → 404 { error: "unknown content" }  (unknown, or not /^[0-9a-f]{64}$/)
// World responses (POST /api/guests .world, GET /api/world, POST /api/actions 200, POST /api/auth/claim 200):
//   { state, schedule, stateVersion, contentChecksum, persistedAtMs: number } (+ summary on POST /api/actions)

// db/pglite.ts
export async function pgliteDb(dataDir?: string): Promise<Db>;

// testing.ts: re-exports only
export { pgliteDb } from "./db/pglite.js";
export { migrate } from "./db/migrate.js";
export { openContentStore, type ContentStore } from "./content.js";
export { guestAuth } from "./server.js";
export { identityAuth, noSessions } from "./identity.js";
export type { Db } from "./db/db.js";

// dev-server.ts
export interface DevServerOptions { contentDir?: string; pgliteDir?: string; clock?: () => number; logLevel?: string }
export async function devServer(opts?: DevServerOptions): Promise<{ app: FastifyInstance; db: Db }>;
```

- `package.json`:
  - drop `"main"`;
  - add `"exports": { "./server": "./src/server.ts", "./testing": "./src/testing.ts" }`;
  - add the script `"dev": "tsx src/dev.ts"`.

  A bare `import "@manufactory/api"` then fails to resolve. That is the point: `main.ts` starts a process (W-22).
- `dev.ts` is untested glue, like `main.ts`. It reads `PORT` (default `8787`), `HOST` (default `127.0.0.1`), `PGLITE_DIR`, `CONTENT_DIR` and `LOG_LEVEL` (default `warn`). It calls `devServer`, listens, and closes the app, then the db, on SIGINT/SIGTERM, mirroring `main.ts`'s `shutdown`.
- `devServer`:
  - `migrate(await pgliteDb(pgliteDir))`;
  - `openContentStore` with the default slice dir (the same expression as `main.ts`);
  - `buildServer` with `auth: identityAuth({ db, content, clock, verifySession: noSessions })`, no `accounts`, no `verifySession`, no `adminToken`;
  - `limits: { guestsPerIp: { capacity: 1000, refillPerSec: 1000 / 3600 } }` (P-11).

- [ ] **Step 1: Write the failing tests** in `server.test.ts`.
  1. **Health:** update the existing test to `toEqual({ ok: true, contentChecksum, accounts: false })`. Add a case built with a stub `accounts: { register() {}, handleError: async () => false }` that gets `accounts: true`.
  2. **Content route, served:** `GET /api/content/${store.current.version}`:
     - returns 200;
     - has `cache-control` equal to `public, max-age=31536000, immutable`;
     - `indexContent(res.json())` succeeds;
     - `bundleChecksum(res.json())` equals the checksum;
     - needs no `authorization` header.
  3. **Content route, older version:** a world pinned to FIXTURE, after the server restarts on SLICE (reuse test 7's setup). Both checksums are served.
  4. **Content route, misses:** a well-formed unknown checksum (`"0".repeat(64)`) and `"not-hex"` are both 404 `{ error: "unknown content" }`.
  5. **`persistedAtMs` on guest creation:** `POST /api/guests` gives `world.persistedAtMs === T0`.
  6. **`persistedAtMs` on GET:** after `now += 10 * MINUTE`, a GET still reports `T0`, and `schedule.atMs` is about `T0 + 10 min`. After a successful `POST /api/actions` at `now`, the response's `persistedAtMs === now`. A later GET reports that same `now`, which equals the `last_resolved_at_ms` column from `onlyWorld()`.
  7. **`persistedAtMs` survives replay:** a replayed idempotent POST returns the same `persistedAtMs`, because the stored body is replayed byte for byte.
  8. **`persistedAtMs` on claim:** extend the claim-200 test in `apps/api/src/identity.test.ts` (`describe("POST /api/auth/claim")`, line 146) to check that `persistedAtMs` is present and equals the guest's last action time.
- [ ] **Step 2: Write the failing tests** in `dev-server.test.ts`, through `app.inject()`:
  - health returns `accounts: false`;
  - `POST /api/guests` ×6 gives six 201s (the default limit would 429 the 6th);
  - `/auth/signin` is 404;
  - `/api/admin/migrate-world` is 404;
  - with `pgliteDir` set to a fresh temp dir (`mkdtempSync(join(tmpdir(), "mi-pglite-"))`), a guest created in one `devServer` is found by a second `devServer` on the same dir after the first closes. Clean the dir up in `afterEach`.
- [ ] **Step 3:** run `npx vitest run src/server.test.ts src/dev-server.test.ts` in `apps/api`. The new tests fail.
- [ ] **Step 4: Implement.**
  - `World.persistedAtMs`: in `fromRow`, take the deserialized state's `lastResolvedAt`.
  - `viewWorld` keeps it, because it spreads `world`.
  - In `applyActions`' `render` call, pass `{ ...world, state: batch.state, stateVersion, persistedAtMs: batch.state.lastResolvedAt }`.
  - `worldView` emits `persistedAtMs: world.persistedAtMs`.
  - Add the content route before `/api/world`, using P-14's SQL. 404 means the param fails `/^[0-9a-f]{64}$/` or no row comes back.
  - `pgliteDb(dataDir)` calls `new PGlite(dataDir)`. When `dataDir` is undefined, PGlite is in memory.
  - `apps/api/README.md`: document the content route, `accounts`, `persistedAtMs` ("the time the world was last stored; production simulated past `persistedAtMs + offlineCapMs` is not credited until the next action"), the `dev` script and its env, and the exports map.
- [ ] **Step 5:** run the API suite: `pnpm --filter @manufactory/api test`.
- [ ] **Step 6: Mutation checks, both undone by hand.**
  - Emit `persistedAtMs: world.state.lastResolvedAt` from `worldView`, which is the *resolved* state: test 6 must fail.
  - Answer a malformed checksum with 400 instead of 404: test 4 must fail.
- [ ] **Step 7:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `API: content by checksum, accounts in health, persistedAtMs, exports map and a PGlite dev server (W-5, W-15, W-22, W-23)`.

---

### Task 3: the `apps/web` scaffold and the pure sync primitives, test-first

**Files:**
- Create:
  - `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/tsconfig.node.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx` (renders "Manufactory Idle" only, until Task 5)
  - `apps/web/src/sync/{constants,wire,content-cache,snapshot,interpolate,refetch,ids,errors,taps}.ts`
  - `apps/web/src/sync/test-rig.ts`: test-only, holding `injectFetch`, `FakeClientClock` and `TestRig`
- Modify: `eslint.config.js`, `turbo.json`, the root `package.json` (`eslint-plugin-react-hooks` dev dependency)
- Test: `apps/web/src/sync/{content-cache,snapshot,interpolate,refetch,ids,errors,taps}.test.ts`

**Scaffold values:**
- **`package.json`:** name `@manufactory/web`, `private`, `"type": "module"`. Scripts:
  - `build`: `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit && vite build`
  - `typecheck`: `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit`
  - `test`: `vitest run`
  - `dev`: `vite`
  - `preview`: `vite preview --port 4173 --strictPort`
  - `e2e`: `playwright test` (the config arrives in Task 6)
- **`vite.config.ts`:**
  - `plugins: [react()]`;
  - `build: { target: "es2022", sourcemap: true }`;
  - `server: { port: 5173, proxy }` and `preview: { port: 4173, proxy }`, where `proxy = { "/api": api, "/auth": api }` and `api = \`http://127.0.0.1:${process.env.API_PORT ?? 8787}\``.
- **`vitest.config.ts`:**
  - `environment: "node"` by default;
  - component tests opt in with a `// @vitest-environment jsdom` docblock;
  - `hookTimeout: 60_000` and `testTimeout: 30_000`, the API's PGlite budgets;
  - `include: ["src/**/*.test.{ts,tsx}"]`, so `e2e/` is excluded.
- **`tsconfig.json`** (P-13):
  - extends `../../tsconfig.base.json`;
  - `lib: ["ES2022", "DOM", "DOM.Iterable"]`, `jsx: "react-jsx"`, `types: ["vite/client"]`, `noEmit: true`;
  - `include: ["src/**/*.ts", "src/**/*.tsx"]`;
  - `exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/sync/test-rig.ts"]`.
- **`tsconfig.node.json`:** the same base, with `types: ["node"]`. It includes the excluded test files, `src/**/*` (tests import app code), `e2e/**/*.ts`, `vite.config.ts`, `vitest.config.ts` and `playwright.config.ts`.
- **`turbo.json`:** add `"@manufactory/web#build": { "dependsOn": ["^build"], "outputs": ["dist/**"] }`, and leave the generic tasks alone (W-24).
- **`eslint.config.js`:** add a block for `files: ["apps/web/**/*.{ts,tsx}"]`:
  - `languageOptions.globals: { ...globals.browser }`, plus `parserOptions.ecmaFeatures.jsx: true`;
  - `plugins: { "react-hooks": reactHooks }` with `rules-of-hooks: error` and `exhaustive-deps: error`.

  Then add a second block for `files: ["apps/web/src/**/*.{ts,tsx}"]`, with `ignores: ["apps/web/src/**/*.test.{ts,tsx}", "apps/web/src/sync/test-rig.ts"]`. It sets `@typescript-eslint/no-restricted-imports` with these patterns:
  - `group: ["@manufactory/content", "@manufactory/content/*"]`, message "W-4: browser code never imports @manufactory/content (node:fs, node:crypto); content comes from GET /api/content/:checksum";
  - `group: ["@manufactory/api", "@manufactory/api/*"]`, message "P-13: the API is a test dependency only";
  - `regex: "^node:"`, message "browser code".

  Also widen the top-level `ignores` with `"**/playwright-report/**"` and `"**/test-results/**"`.

**Interfaces** (all in `apps/web/src/sync/`):

```ts
// constants.ts (P-6, P-7, W-12)
export const MIN_REPOLL_MS = 5_000, BOUNDARY_SLACK_MS = 250, SHORT_BOUNDARY_MS = 1_000, SHORT_STREAK = 3;
export const REPOLL_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const RETRY_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
export const OFFLINE_AFTER_FAILURES = 2, TEXT_TICK_MS = 250 /* 4 Hz */, TAP_REPEAT_MS = 100 /* 10 Hz */;
export const TAP_FLUSH_EVERY_MS = 1_000, TAP_FLUSH_AFTER_RELEASE_MS = 300;
export const GUEST_TOKEN_KEY = "mi.guestToken";

// wire.ts
import type { Action, Schedule } from "@manufactory/engine";
export interface WorldResponse { state: unknown; schedule: Schedule; stateVersion: number;
  contentChecksum: string; persistedAtMs?: number /* P-4: absent on pre-4a replays */; summary?: unknown }
export interface HealthResponse { ok: true; contentChecksum: string; accounts: boolean }
export interface GuestResponse { guestToken: string; world: WorldResponse }
export interface RejectionBody { failedAction: Action; index: number; reason: string }
export interface ActionsRequest { idempotencyKey: string; baseVersion: number; actions: Action[] }
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// content-cache.ts: in memory, by checksum, in-flight deduped; a failed load is dropped so a later get retries
export class ContentCache {
  constructor(fetch: FetchLike);
  get(checksum: string): Promise<IndexedContent>;   // GET /api/content/:checksum → indexContent(json)
  prefetch(checksum: string): void;                  // get() with its rejection swallowed
}

// snapshot.ts (W-6, W-8)
export interface Snapshot {
  state: WorldState;            // deserializeWorld(JSON.stringify(resp.state)): the response's state, as truth
  schedule: Schedule;           // the SERVER's schedule: rates and boundary come only from here
  stateVersion: number;
  contentChecksum: string;
  content: IndexedContent;
  persistedAtMs: number | null;
  receivedAt: number;           // ClientClock.now() when the response landed
  display: { state: WorldState; solution: Solution }; // scheduleDetail(state, content), once per snapshot
}
export function makeSnapshot(resp: WorldResponse, content: IndexedContent, receivedAt: number): Snapshot;
/** True if `next` may replace `current`: no current, or (stateVersion, schedule.atMs) not lexicographically older. */
export function isAdoptable(current: Snapshot | null, next: Pick<Snapshot, "stateVersion" | "schedule">): boolean;
export function serverNow(s: Snapshot, clientNow: number): number;  // s.schedule.atMs + (clientNow − s.receivedAt)
export function localTimeOf(s: Snapshot, serverMs: number): number; // s.receivedAt + (serverMs − s.schedule.atMs)
export function plateauAtMs(s: Snapshot): number;                   // persistedAtMs + content.offlineCapMs, or Infinity

// interpolate.ts (W-7, P-4); Dec from the engine; no solve, no BigInt
export function shownStock(s: Snapshot, itemId: ItemId, serverMs: number): Dec;
//   = clamp(fromCanonical(stock) + net × (min(serverMs, plateau) − atMs)⁺ / 1000, 0, liquidCap(content, s.state, itemId))
export function storageFraction(s: Snapshot, itemId: ItemId, serverMs: number): number; // shown / liquidCap, in [0, 1]
export interface BarTransition { from: number; to: number; durationMs: number }
/** One CSS transition per snapshot: from the fraction now to the fraction at min(full/empty, nextBoundary, plateau). */
export function storageTransition(s: Snapshot, itemId: ItemId, serverMs: number): BarTransition;
export function isPlateaued(s: Snapshot): boolean;  // s.schedule.atMs >= plateauAtMs(s)

// refetch.ts (W-9, P-4, P-6): pure
export interface RepollState { streak: number }
export function nextRepoll(prev: RepollState, s: Snapshot, cause: "get" | "post"): RepollState;
export function minGapMs(r: RepollState): number;
/** Local (ClientClock) time to GET next, or null for no timer. */
export function nextFetchAt(s: Snapshot, r: RepollState): number | null;
//   null if isPlateaued(s), or if both the boundary and the plateau are infinite/null;
//   else max(localTimeOf(s, min(boundary ?? ∞, plateau) + BOUNDARY_SLACK_MS), s.receivedAt + minGapMs(r))

// ids.ts (W-10)
export function newIdempotencyKey(c?: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>): string;
//   c.randomUUID() when present, else a v4 UUID built from getRandomValues(16 bytes)

// errors.ts (W-11): one classifier, used for both GET and POST
export type Outcome =
  | { kind: "adopt"; body: WorldResponse }
  | { kind: "rejected"; body: RejectionBody }                    // 409: drop batch, toast reason, GET
  | { kind: "paused"; retryAfterMs: number; banner: "accounts-unavailable" | null } // 429 / 503
  | { kind: "retry" }                                            // network error (status 0) or 5xx: same key
  | { kind: "client-bug"; status: 400; body: unknown }            // drop, log, re-sync, generic toast
  | { kind: "unauthorized" }                                     // 401
  | { kind: "no-world" };                                        // 404
export async function classify(res: Response | null /* null = fetch threw */): Promise<Outcome>;
//   Retry-After is whole seconds; a missing or bad header counts as 1 s; a 503 without one counts as 5 s

// taps.ts (W-12, P-16)
export class TapAccumulator {
  constructor(now: () => number, loadedAt: number);
  tap(): void;                                   // pending += 1
  /** null when pending is 0 (never a count:0 TAP); else the action, and resets pending and the elapsed origin. */
  take(): { type: "TAP"; count: number; clientElapsedMs: number } | null;
  get pending(): number;
  optimistic(stacks: number, maxStacks: number): number; // min(maxStacks, stacks + pending)
}

// test-rig.ts (test-only): inject-backed fetch and the paired clocks (P-8)
export function injectFetch(app: FastifyInstance): FetchLike;
//   maps (url, init) → app.inject({ method, url, headers, payload: init.body }) → new Response(body, { status, headers });
//   a test may set `rig.dropNextResponse = true`: the request reaches the server, then the fetch throws TypeError("network")
export class FakeClientClock implements ClientClock { now(): number; setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void; advance(ms: number): Promise<void> /* fires due timers in order, awaiting microtasks between */ }
export interface TestRig { app: FastifyInstance; db: Db; clock: FakeClientClock; serverNow(): number;
  fetch: FetchLike & { dropNextResponse: boolean; calls: { method: string; url: string; body?: unknown }[];
    /** The next matching request reaches the server, but its Response is withheld until release() is called. */
    hold(method: string, url: string): () => void };
  advance(ms: number): Promise<void> /* server clock += ms, then clock.advance(ms) */; close(): Promise<void> }
export async function makeRig(opts?: { limits?: ServerDeps["limits"]; contentDir?: string }): Promise<TestRig>;
//   pgliteDb → migrate → openContentStore(slice) → buildServer({ db, content, clock: () => serverMs, auth: guestAuth(db), limits })
```

`ClientClock` is declared in `snapshot.ts`, `export interface ClientClock { now(): number; setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number): void }`, and Task 4 uses it.

- [ ] **Step 1: Scaffold.**
  - Write the package, the configs, `index.html` (with `<div id="root">`) and the placeholder `main.tsx`.
  - Add the eslint blocks and the turbo entry.
  - Run `pnpm install`.
  - Check that `pnpm --filter @manufactory/web build` emits `apps/web/dist/index.html`, and that a scratch import of `@manufactory/engine` in `main.tsx` (`format(D(1234), "hybrid")`) bundles. That proves W-4's source export works under Vite. If Vite trips, stop and report: W-4's fallback is a turbo change, not something this task decides.
- [ ] **Step 2: Write the failing tests.** `makeRig` is used where a test needs the API.
  1. **`content-cache`:**
     - two concurrent `get`s of the current checksum make one request (`rig.fetch.calls`);
     - the returned content has `stockItemIds.length === 32`;
     - an unknown checksum rejects, and the next `get` makes a new request.
  2. **`snapshot.isAdoptable`:**
     - an equal version with a later `atMs` is adoptable;
     - an equal version with an earlier `atMs` is not;
     - a higher version with an earlier `atMs` is adoptable (a POST's `atMs` can trail a GET's by the round trip);
     - a lower version is never adoptable.
  3. **`serverNow` / `localTimeOf`:** they are inverses. `serverNow` ignores `Date.now` entirely (spy on it and expect zero calls).
  4. **`makeSnapshot` on a real GET** from the rig, on a fresh guest:
     - `display.state.lastResolvedAt === schedule.atMs`;
     - `display.solution.itemRates.get("iron_ore").net` equals `schedule.items.iron_ore.netPerSecond`.

     The point is that the server's schedule and the client's own copy agree here. The view only *reads* `schedule` for rates.
  5. **`interpolate`:**
     - `shownStock` at `atMs + 10_000` is stock + 10·net;
     - it clamps to `liquidCap` and to 0 (use a negative-net item from `slice-tier-8-reinforced-full.world.json`, wrapped in a hand-built `WorldResponse` whose `schedule` is `schedule(state, slice)`);
     - with `persistedAtMs` set so that `plateau = atMs + 5_000`, `shownStock(atMs + 60_000) === shownStock(atMs + 5_000)`;
     - `isPlateaued` is true when `atMs >= plateau`;
     - `storageTransition`'s `durationMs` is the time to full when that comes before the boundary, and the boundary otherwise; `to` is `1` when it fills.
  6. **`refetch`:**
     - a boundary 37 s ahead with no streak gives `localTimeOf(boundary + 250)`;
     - a boundary 100 ms ahead gives `receivedAt + 5_000`;
     - the streak sequence of short snapshots gives gaps 5, 5, 10, 20, 40, 60, 60 s;
     - a `"post"` cause resets the streak to 0;
     - a null boundary with `persistedAtMs: null` gives null;
     - a null boundary with a plateau 1 h ahead gives `localTimeOf(plateau + 250)`;
     - a plateaued snapshot gives null even with a boundary (P-4).
  7. **`errors.classify`**, one case per W-11 row, with hand-built `Response`s: 200, 409 (body passed through), 429 with `Retry-After: 3` (3,000 ms, banner null), 503 `accounts-unavailable` (5,000 ms, banner set), `null` (retry), 500 (retry), 400, 401 and 404.
  8. **`taps`:**
     - three `tap()`s, then `take()` → `{ count: 3, clientElapsedMs: now − loadedAt }`;
     - a second `take()` with nothing pending is null;
     - after more taps, `clientElapsedMs` is measured from the previous take;
     - `optimistic(9, 10)` with 5 pending is 10.
  9. **`ids`:**
     - with `randomUUID` absent, the key matches `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`;
     - 1,000 keys are distinct;
     - with `randomUUID` present, that function is used.
- [ ] **Step 3:** run `pnpm --filter @manufactory/web test`. It fails: the modules don't exist yet.
- [ ] **Step 4: Implement** the modules to the interfaces. `shownStock` uses `fromCanonical`, `D` and `liquidCap` from the engine. It does arithmetic on `Dec` only at 4 Hz call sites, never per frame.
- [ ] **Step 5:** run the web tests until they pass.
- [ ] **Step 6: Mutation checks, each undone by hand.**
  - `nextFetchAt` ignores `minGapMs`: test 6 (the 100 ms case) must fail.
  - `shownStock` ignores the plateau: test 5 must fail.
  - `TapAccumulator.take` returns `{ count: 0 }` instead of null: test 8 must fail.
  - **Lint mutation:** add `import { loadBundleDir } from "@manufactory/content"` to `src/main.tsx`. `pnpm lint` must fail with the W-4 message. Undo it.
- [ ] **Step 7:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: apps/web scaffold and the pure sync core (W-3, W-4, W-6 to W-12, W-24)`.

---

### Task 4: `GameStore`, the outbox and guest start, against the real API

**Files:**
- Create: `apps/web/src/sync/store.ts`, `apps/web/src/sync/outbox.ts`, `apps/web/src/sync/identity.ts`, `apps/web/src/sync/use-game.ts` (the hook)
- Test: `apps/web/src/sync/store.test.ts`, `apps/web/src/sync/outbox.test.ts`, `apps/web/src/sync/identity.test.ts`

**Interfaces:**
- Consumes: everything from Task 3, plus `makeRig`.
- Produces:

```ts
// identity.ts (W-14)
export interface TokenStorage { get(): string | null; set(token: string): void; clear(): void; persistent: boolean }
/** localStorage under GUEST_TOKEN_KEY; if any access throws, an in-memory store with persistent: false. */
export function browserTokenStorage(ls?: Storage): TokenStorage;
export function memoryTokenStorage(): TokenStorage;

// outbox.ts (W-10, W-11)
export interface Batch { id: number; key: string; actions: Action[]; label: string }
export interface OutboxDeps { fetch: FetchLike; clock: ClientClock; authHeader: () => string | null;
  baseVersion: () => number; onOutcome: (b: Batch, o: Outcome) => void; isPaused: () => number /* local ms until resume, 0 if not */ }
export class Outbox {
  constructor(d: OutboxDeps);
  /** Queues one batch (FIFO), its key made NOW (W-10); resolves when the batch is settled (adopt/rejected/client-bug/unauthorized/no-world). */
  enqueue(actions: Action[], label: string): Promise<Outcome>;
  get inFlight(): Batch | null; get queued(): readonly Batch[];
  /** Retry now (an `online` event). */ kick(): void;
  idle(): Promise<void>;
}

// store.ts (W-6, W-9, W-11, W-14)
export type SyncStatus = "loading" | "ready" | "offline" | "error";
export interface Notice { kind: "rejected" | "client-bug" | "guest-expired" | "guest-rate-limited" | "accounts-unavailable"
  | "ephemeral-token" | "plateau"; text: string; retryAt?: number }
export interface StoreView { status: SyncStatus; snapshot: Snapshot | null; pending: readonly Batch[];
  notices: readonly Notice[]; failures: number }
export interface GameStoreDeps { fetch: FetchLike; clock: ClientClock; tokens: TokenStorage;
  random?: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">> }
export class GameStore {
  constructor(d: GameStoreDeps);
  subscribe(fn: () => void): () => void;  getView(): StoreView;   // useSyncExternalStore; getView is referentially stable between changes
  /** First load: health ║ (token ? GET : POST /api/guests) → content(checksum) → snapshot (W-5, W-14). */
  start(): Promise<void>;
  stop(): void;                                 // clears every timer
  setVisible(visible: boolean): void;           // hidden: stop boundary timer + text tick; visible: GET if snapshot older than MIN_REPOLL_MS
  onFocus(): void; onOnline(): void;            // GET if older than MIN_REPOLL_MS; online also kicks the outbox
  send(actions: Action[], label: string): Promise<Outcome>;  // via the outbox; spends are pessimistic (W-13)
  newFactory(): Promise<void>;                  // after guest-expired: clear the token, POST /api/guests
  idle(): Promise<void>;                        // nothing in flight, the outbox empty, no pending content load (P-9)
}
// use-game.ts
export function useGame(store: GameStore): StoreView;   // useSyncExternalStore(store.subscribe, store.getView)
```

**Behaviours the tests pin**, with W-n in brackets:
- **Adoption:** every 200 body goes through `ContentCache.get(contentChecksum)` *before* `makeSnapshot`, so a re-pin loads the new bundle first (W-5). Then comes `isAdoptable`. A dropped response changes nothing.
- **First load:** `health` and the world request run in parallel. When health lands first, `ContentCache.prefetch(health.contentChecksum)` runs. The snapshot always uses the *world's* `contentChecksum` (W-5).
- **One GET in flight.** A trigger while one is in flight is coalesced into it.
- **Pauses:** a 429 or 503 sets `pausedUntil = now + retryAfterMs`. Both polling and the outbox wait for it, because they share one bucket. Then they resend with the same key [W-11].
- **409:** the batch is dropped, a `rejected` notice is shown with `reason`, and one GET follows. A **404** re-syncs once; a second 404 in a row is treated as a 401. A **401** on a guest token gives the `guest-expired` notice and stops polling; `newFactory()` recovers. A **429 on `POST /api/guests`** gives `guest-rate-limited` with `retryAt`.
- **Auth header:** `Authorization: Guest <token>` whenever a token exists. 4a has no session path.

Test constants (`store.test.ts`): `BUY_CONSTRUCTOR = { type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1, recipeId: "make_iron_plate" }`, the P-3 action on a fresh slice world, affordable after about 43 s. `BUY_TOO_MANY` is the same action with `count: 1000`.

- [ ] **Step 1: Write the failing tests** (`store.test.ts`). Each test does `makeRig` → `new GameStore({ fetch: rig.fetch, clock: rig.clock, tokens: memoryTokenStorage() })` → `await store.start(); await store.idle()`.
  1. **Guest start:**
     - with no token, the calls are `GET /api/health`, `POST /api/guests` and `GET /api/content/<checksum>`, in any order that has health and guests before content;
     - the token is stored;
     - `status === "ready"`;
     - `snapshot.stateVersion === 0`.

     A second store with the same tokens makes **no** `POST /api/guests` call, and loads the same world (the same `state.seed`).
  2. **The boundary refetch, and an idle tab.**
     - Fresh slice: the boundary is 4,000 s out. After `rig.advance(3_999_000)` there is no GET; after `rig.advance(1_300)` there is exactly one.
     - **Null boundary.** A fresh slice world reaches `nextBoundaryAtMs: null` within 4 h, once everything is FULL (measured: the boundary is 400 s out at 1 h, 300 s at 2 h, and null at 4 h).
       - Call `setVisible(false)` and `rig.advance(4 * 3_600_000)`, then `setVisible(true)`. That gives exactly one GET, and its snapshot has a null boundary.
       - `rig.advance(3 * 3_600_000)` (still before the plateau at 8 h) makes **zero** GETs.
       - Advancing to `persistedAtMs + offlineCapMs + 250` makes exactly one GET, the W-9 guard.
       - After that, `advance(3_600_000)` makes zero GETs.
  3. **Ordering:** start a GET, then while it is in flight `send([BUY_CONSTRUCTOR])`, with the server clock advanced 10 min so the buy is affordable. Make the GET's response land after the POST's: use `const release = rig.fetch.hold("GET", "/api/world")`, then `release()` after the POST settles. The final `snapshot.stateVersion` is 1, and the GET's version-0 body was not adopted.
  4. **EPSILON backoff:**
     - Load `slice-tier-8-reinforced-full.world.json` into the guest's row with a test-only write through `rig.db`.
       - First rebase it to the rig's clock: `delta = rig.serverNow() − state.lastResolvedAt`; set `lastResolvedAt += delta` and shift every timer's absolute fire time by `delta`.
       - Then `update player_worlds set state = $1::jsonb, last_resolved_at = to_timestamp($2 / 1000.0)`, with `serializeWorld(rebased)` and the rebased time.
       - Without the rebase, the GET would resolve from 1970 and hit the offline cap.
     - Walk 3 minutes in 100 ms steps (`rig.advance`).
     - The gaps between GETs never drop below 5 s, and reach 60 s once the streak builds.
     - A `send` resets the gap to 5 s.
  5. **Lost response, same key:**
     - after `rig.advance(60_000)`, set `rig.fetch.dropNextResponse = true`, then `send([BUY_CONSTRUCTOR])`;
     - after `advance(1_000)` the retry carries the same `idempotencyKey` (`rig.fetch.calls`);
     - `state_version` is 1 in the db, `action_log` has one row, and the store adopts version 1;
     - after the 2nd consecutive drop, `status === "offline"`.
  6. **429:**
     - with `limits.player = { capacity: 2, refillPerSec: 0.5 }`, a third request gets 429 with `Retry-After: 2`;
     - the outbox and polling make no calls for 2,000 ms of `advance`;
     - then they resend with the same key, and it succeeds.
  7. **409:**
     - after `advance(60_000)`, enqueue `send([BUY_TOO_MANY])` and then `send([BUY_CONSTRUCTOR])`. The first gives a `rejected` notice whose text includes the server's reason;
     - one GET follows;
     - the queued batch behind it still sends with its own key (FIFO, no merging).
  8. **401:** delete the guest's player row (with world and logs, as cleanup does), then trigger `onFocus()` past `MIN_REPOLL_MS`. The result is the `guest-expired` notice. `newFactory()` gives a new token and `stateVersion: 0`.
  9. **Plateau:**
     - set `rig.advance` past `persistedAtMs + offlineCapMs` (28,800,000 ms on the slice) with the tab "hidden" (`setVisible(false)`);
     - then `setVisible(true)`: exactly one GET;
     - the snapshot is plateaued, and a `plateau` notice is present;
     - `advance(3_600_000)` makes zero further GETs (P-4);
     - a `send` adopts a new `persistedAtMs`, and the notice clears.
  10. **Hidden:** while `setVisible(false)`, crossing a boundary makes no GET. On visible there is one GET (the snapshot is older than 5 s).
- [ ] **Step 2: Write the failing tests** (`outbox.test.ts`, with a scripted `fetch` that needs no server):
  - FIFO order, with one in flight at a time;
  - keys are made at enqueue, and each batch's key differs;
  - the retry delays follow `RETRY_STEPS_MS` (1, 2, 4 s …, capped at 30 s);
  - `kick()` retries at once.
- [ ] **Step 3: Write the failing tests** (`identity.test.ts`):
  - `browserTokenStorage` over a `Storage` whose methods throw gives `persistent: false` and still round-trips a token;
  - over a working jsdom-free stub, it uses the key `mi.guestToken`.
- [ ] **Step 4:** run the web tests. The new ones fail.
- [ ] **Step 5: Implement** `identity.ts`, `outbox.ts`, `store.ts` and `use-game.ts` to the interfaces. `store.ts` owns the one boundary timer, from `nextFetchAt`. It re-arms on every adoption and on visibility changes.
- [ ] **Step 6:** run the web tests until they pass.
- [ ] **Step 7: Mutation checks, each undone by hand.**
  - The outbox makes a new key on retry: test 5 must fail, with two log rows or a key mismatch.
  - `isAdoptable` always returns true: test 3 must fail.
  - The store ignores `pausedUntil` for polling: test 6 must fail.
  - `nextFetchAt` ignores `isPlateaued`: test 9 must fail.
- [ ] **Step 8:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: GameStore, the outbox and guest start, tested against the real API (W-6, W-9 to W-11, W-14, W-22)`.

---

### Task 5: the lane view, tokens and the motion subset

**Files:**
- Create:
  - `apps/web/src/styles/tokens.css`, `apps/web/src/styles/base.css`
  - `apps/web/src/ui/App.tsx`, `apps/web/src/ui/LaneView.tsx` + `LaneView.module.css`, `apps/web/src/ui/ItemRow.tsx` + `ItemRow.module.css`, `apps/web/src/ui/BottleneckFrame.tsx` + `.module.css`, `apps/web/src/ui/Notices.tsx`
  - `apps/web/src/ui/derive.ts`, which holds the pure display derivations
  - `apps/web/src/ui/use-tick.ts`, the shared 4 Hz interval
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/src/ui/derive.test.ts`, `apps/web/src/ui/LaneView.test.tsx` (jsdom), `apps/web/src/styles/tokens.test.ts`

**Interfaces:**
- Consumes: `GameStore`, `useGame`, `Snapshot`, `shownStock`, `storageFraction`, `storageTransition` and `serverNow`; and from the engine `format`, `liquidCap`, `bestUnlockedMark`, `isLiveRecipe`, `machineCostRange` (with `owned = state.installed[lane]?.[machineClass]?.[mark - 1] ?? 0`, as in P-3), `itemStateTag`, `D` and `fromCanonical`.
- Produces:

```ts
// derive.ts: pure, unit-tested; called once per snapshot except affordability (4 Hz)
export interface RowModel { itemId: ItemId; name: string; netPerSecond: number /* from snapshot.schedule */;
  satisfaction: number /* P-1 */; tag: ItemStateTag; capText: string;
  quantum: Dec | null /* null when zero → no QS chip */; bound: Dec | null /* null when zero → no BOUND chip */;
  split: { entryId: string; label: string; share: number }[] | null /* ≥ 2 entries above 1% share of the primary producer's allocations, else null */ }
export function laneRows(s: Snapshot, laneId: LaneId): RowModel[];          // content.bundle.items in order, item.lane === laneId, item.tier <= state.tier
export function unlockedLanes(s: Snapshot): LaneDef[];                     // by order, unlockTier <= state.tier
export function satisfaction(solution: Solution, itemId: ItemId): number;  // P-1
export interface BottleneckModel { laneId: LaneId | null; itemId: ItemId | null; text: string;
  buy: Extract<Action, { type: "BUY_MACHINE" }> | null /* P-3 */ }
export function bottleneckRow(s: Snapshot): BottleneckModel | null;        // P-2
export type Affordability = { affordable: true } | { affordable: false; inMs: number | null /* null = not reachable on current rates */ };
export function affordability(s: Snapshot, action: Extract<Action, { type: "BUY_MACHINE" }>, serverMs: number): Affordability;
//   costs = machineCostRange(content, class, mark, owned, count); have = shownStock + bound; inMs = max over short items of (need − have)/net·1000
```

**UI rules:**
- **Layout:** `App` renders the header (the title only in 4a), `Notices`, the lane tabs (`role="tablist"`; one `<button role="tab">` per unlocked lane; the bottleneck lane's tab carries a "!" with `aria-label="bottleneck"`), and the visible lane's rows. Only the visible lane renders (W-19). The root `<div>` carries `data-sync` and `data-state-version` (P-9).
- **Row** (F.1's three-line row):
  - **Line 1:** the name, and the net rate as `format(D(net), "hybrid") + "/s"` with a leading `+` when it's positive.
  - **Line 2:** the storage bar, plus `shown / cap` text. The bar is `role="meter"` with `aria-valuemin=0` and `aria-valuemax=1`; its `aria-valuenow` is the fraction at snapshot time, which changes only per snapshot (W-20).
  - **Line 3:** `QS <format>` and `BOUND <format>` chips, each only when non-zero.
  - **Satisfaction meter:** a second thin `role="meter"`, coloured by state class: `fed` when ≥ 0.98, `throttled` below that, `paused` for a paused entry. When `split` is non-null, a split bar replaces it, with `NN% <item name>` labels, as in the MVP's `splitOrBar`.
- **Storage bar motion (W-7):** the fill is `transform: scaleX(var(--from))`. On each new snapshot, set `--from` with `transition: none`, force a reflow (`el.getBoundingClientRect()`), then set `scaleX(to)` with `transition: transform <durationMs>ms linear`. `transform-origin: left`. Nothing in JavaScript runs per frame.
- **Text at 4 Hz:** one `setInterval(TEXT_TICK_MS)` in `use-tick.ts`, shared through a context. It is stopped while the document is hidden (the store's `setVisible`). Only the visible lane's numbers subscribe to it.
- **Bottleneck frame:** the framed row is wrapped in `BottleneckFrame`, which has:
  - the label "bottleneck" in text;
  - the advice sentence, e.g. "Limiting iron plate. 1 more Constructor clears it.", with names from content;
  - for `buy !== null`, a `<button>` reading "Buy N <class name>" when affordable, or "affordable in 43s" (disabled) otherwise.

  The button is `aria-busy` and disabled while its batch is pending, because spends are pessimistic (W-13). Clicking calls `store.send([buy], "bottleneck buy")`.
- **Notices:** `rejected`, `plateau`, `guest-expired` (with a "Start a new factory" button that calls `newFactory`), `guest-rate-limited` (with a countdown), `ephemeral-token` ("this factory will be lost when the tab closes") and `offline`. All of them go into one polite live region (W-20). Ticking numbers are not live.
- **`tokens.css`** (W-17), seeded from the MVP's `:root`:
  - surfaces `--bg #14181d`, `--s1 #1a1f26`, `--s2 #212832`, `--s3 #2a323d`;
  - `--line #2c343f` and `--line2 #3a444f`;
  - text `--t1 #e4e9ef`, `--t2 #98a3b0`, `--t3 #69737f`;
  - `--accent #f59042`;
  - the four state colours `--state-fed #57b96a`, `--state-throttled #dda12e`, `--state-bottleneck #e0594a`, `--state-paused #69737f`;
  - sizes `--fs-1 15px`, `--fs-2 13px`, `--fs-3 12px`, weights `--fw-regular 400`, `--fw-strong 600`, `--mono`, `--hairline 0.5px`;
  - `--pulse-cycle 2.6s` (W-18).

  It also has a light set under `@media (prefers-color-scheme: light)` and `:root[data-theme="light"]`. The settings toggle is 4c, so 4a reads no stored theme.
  `.num { font-family: var(--mono); font-variant-numeric: tabular-nums }`.
- **Motion subset (W-18):**
  - only `transform` and `opacity` animate or transition;
  - the bottleneck pulse is `@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }` over `var(--pulse-cycle)`;
  - every animation and transition sits in `@media (prefers-reduced-motion: no-preference)`;
  - `:root.hidden-tab *` sets `animation-play-state: paused` (W-9).

  The frame's colour and its "bottleneck" label stay in reduced motion. Sweeps, tweens and the conveyor are 4c.

- [ ] **Step 1: Write the failing tests** (`derive.test.ts`). Build snapshots with `makeSnapshot` from a `WorldResponse` hand-built from a fixture state and `schedule(state, slice)`. That is the real `worldView` shape: `JSON.parse(serializeWorld(state))`.
  1. **`laneRows`** for iron on a fresh world: iron_ore, iron_ingot, iron_plate and iron_rod (tier-0 items only), in bundle order. The rates come from `schedule.items`.
  2. **`satisfaction`** (P-1): an item with consumption greater than production is below 1. A producer-only item is 1. An item with neither is 0.
  3. **QS chip:** on `slice-tier-8.world.json`, an iron item whose `quantum` is non-zero gets `quantum !== null` (there are 25 non-zero there). On a fresh world every row has `quantum === null` and `bound === null`.
  4. **Split bar:** on `slice-tier-8-reinforced-full.world.json`, `screw`'s row has a `split` of two entries (reinforced_iron_plate ≈ 79%, rotor ≈ 21%, from `make_screw`'s allocations). On a fresh world no row has one.
  5. **`bottleneckRow`:**
     - on a fresh world it is lane `iron`, item `iron_plate`, with buy `{ type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1, recipeId: "make_iron_plate" }`;
     - on `slice-tier-8.world.json`, the power kind gives lane `power`, item `biomass`, `count: 10`, `recipeId: "collect_biomass"`;
     - a stub `storage` bottleneck has `buy: null`.
  6. **`affordability`** on a fresh world: at `atMs` it is not affordable, with `inMs` ≈ 42,600 (±1,000; 21.31 ingot at 0.5/s, minus what is there). At `atMs + 60_000` it is affordable.
- [ ] **Step 2: Write the failing tests** (`LaneView.test.tsx`, `// @vitest-environment jsdom`). Use a fake store, an object that satisfies `useGame`'s needs, fed fixture snapshots.
  1. **Fresh world:**
     - exactly one element has the text "bottleneck" as a frame label;
     - the iron tab has the "!" marker;
     - no QS or BOUND chip exists (`queryByText(/^QS /)` is null).
  2. **The tier-8 fixture:**
     - QS chips render on iron rows;
     - switching to the `power` tab shows the frame on biomass;
     - switching to the `copper` tab shows no frame;
     - exactly one frame exists across the rendered lane.
  3. **The meters:** both meters have `role="meter"` and `aria-valuenow`. A 4 Hz tick (advance a fake interval) changes the stock text but not `aria-valuenow`.
  4. **The buy:** clicking the enabled buy button (snapshot at `atMs + 60 s` affordability) calls `send` once with the P-3 action. While `pending` holds that batch, the button is disabled with `aria-busy="true"`.
  5. **The storage bar:** its inline style after a snapshot is `transform: scaleX(<to>)`, with `transition` `transform <d>ms linear`. Its `width` is never set.
  6. **The plateau notice:** it renders when `isPlateaued(snapshot)`.
- [ ] **Step 3: Write the failing tests** (`tokens.test.ts`, node). Read every `src/**/*.css` file as text.
  7. **Animated properties:** every `transition`/`transition-property`/`@keyframes` body names only `transform` or `opacity` (W-18). Every `animation` and `transition` declaration sits inside a `prefers-reduced-motion: no-preference` block.
  8. **State colours:** the four `--state-*` custom properties are referenced only inside rules whose selector contains `.state-` or `.frame` (W-17). `tokens.css` defines all the W-17 tokens listed above.
- [ ] **Step 4:** run the web tests. The new ones fail.
- [ ] **Step 5: Implement** `derive.ts`, the components, the CSS and `main.tsx`. `main.tsx`:
  - builds `GameStore({ fetch: window.fetch.bind(window), clock: browserClock, tokens: browserTokenStorage(), random: crypto })`, where `browserClock` uses `performance.now` and `window.setTimeout`;
  - wires `visibilitychange` to `setVisible` and toggles `hidden-tab` on `<html>`, `focus` to `onFocus` and `online` to `onOnline`;
  - calls `start()` and renders `<App store={store} />`.
- [ ] **Step 6:** run the web tests until they pass. Check by hand with `pnpm --filter @manufactory/api dev` and `pnpm --filter @manufactory/web dev` if you can run them in the foreground of separate terminals. If you can't, rely on Task 6's e2e and say so.
- [ ] **Step 7: Mutation checks, each undone by hand.**
  - Frame every row whose tag is EMPTY: test 1 (exactly one frame) must fail.
  - Animate `width` in `ItemRow.module.css`: test 7 must fail.
  - Render the QS chip when `quantum` is zero: test 1 (no QS chip on a fresh world) must fail.
- [ ] **Step 8:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: the lane view, bottleneck frame and inline buy, tokens and the motion subset (W-1, W-7, W-17, W-18)`.

---

### Task 6: Playwright, the 4a e2e spec, the CI job and the README

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/guest-buy.spec.ts`
- Modify: `apps/web/.gitignore` (or the root `.gitignore`: `apps/web/dist`, `apps/web/playwright-report`, `apps/web/test-results`), `.github/workflows/ci.yml`, `README.md`, `apps/web/package.json` (the `e2e` script already exists)

**Interfaces:**
- Consumes: the API `dev` script (Task 2), `vite preview` with the proxy (Task 3), and the `data-sync` / `data-state-version` attributes and the button texts (Task 5).
- Produces:
  - **`playwright.config.ts`:**
    - `testDir: "e2e"`, `timeout: 180_000`, `expect.timeout: 10_000`;
    - `retries: process.env.CI ? 1 : 0`, `workers: 1`;
    - `use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" }`;
    - `projects: [{ name: "chromium", use: devices["Desktop Chrome"] }]`;
    - `reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list"`.

    It has two `webServer` entries:
    - `{ command: "pnpm --filter @manufactory/api dev", url: "http://127.0.0.1:8787/api/health", env: { PORT: "8787" }, reuseExistingServer: !process.env.CI, timeout: 60_000 }`;
    - `{ command: "pnpm run build && pnpm run preview", url: "http://127.0.0.1:4173/", reuseExistingServer: !process.env.CI, timeout: 120_000 }`.
  - **The CI job**, alongside `check`, `pacing` and `api-integration`:

```yaml
  # Spec W-23: the one browser job. Chromium only; WebKit is a manual pre-release check.
  # Playwright's webServer starts the API's PGlite dev server (no Docker) and `vite preview`
  # behind the W-2 proxy. Specs wait on store state, never on sleeps (P-9); the 4a spec waits
  # ~45 s of real time for the first buy to become affordable (P-10).
  web-e2e:
    runs-on: ubuntu-latest
    # A hang guard, not a budget.
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @manufactory/web exec playwright install --with-deps chromium
      - run: pnpm --filter @manufactory/web e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: apps/web/playwright-report
```

- [ ] **Step 1: Write the spec** `e2e/guest-buy.spec.ts`. It is one test, in four steps:
  1. **Guest start.** `page.goto("/")`. Then:
     - `expect(page.locator("[data-sync]")).toHaveAttribute("data-sync", "ready")`;
     - `page.evaluate(() => localStorage.getItem("mi.guestToken"))` matches `/^[A-Za-z0-9_-]{43}$/`.
  2. **The lane renders.**
     - The `iron` tab is selected.
     - A row named "Iron Plate" is visible. Use the bundle's display name: read `name` for `iron_plate` from `packages/content/bundles/vertical-slice` when writing the selector; don't guess the case.
     - Exactly one element with the frame label "bottleneck" exists, and it is inside the iron plate row.
     - `scrollWidth <= clientWidth` on `document.documentElement` at the default viewport. That is a cheap guard; the 320 px pass is 4c.
  3. **The bottleneck buy succeeds.**
     - `const buy = page.getByRole("button", { name: /^Buy 1 / })`, then `await expect(buy).toBeEnabled({ timeout: 120_000 })` (P-10). Then click it.
     - `expect(root).toHaveAttribute("data-state-version", "1")`.
     - No `rejected` notice is shown.
  4. **A reload keeps the world.**
     - Note the token, then `page.reload()`. `data-sync` is `ready`.
     - `data-state-version` is still `"1"`: the world is the same, not a new guest.
     - The token is unchanged.
     - The network log (`page.on("request")`) shows no `POST /api/guests` after the reload.
- [ ] **Step 2: Try to run it locally.** Run `pnpm --filter @manufactory/web exec playwright install chromium`, then `pnpm --filter @manufactory/web e2e`, in the foreground.
  - If the browser download is unavailable (no network, or no system deps), do **not** fake a pass, and do not skip the spec in CI. Re-read the spec line by line against Task 5's DOM (texts, roles, attributes). Run `pnpm --filter @manufactory/web exec playwright test --list` to show that the config and spec parse. Then state in the commit message and the hand-off: "e2e spec written and listed, unrun locally (Chromium unavailable); first run is CI's `web-e2e`."
  - If it runs, record the wall time in the CI job comment.
- [ ] **Step 3: Mutation check, if the spec ran.** Make `main.tsx` use `memoryTokenStorage()`. Step 4's state-version assertion must fail after the reload. Undo it. If the spec couldn't run, say that the mutation is unrun.
- [ ] **Step 4: README.** The build-order table already marks phases 0–3 **done** (checked against `main`). Change only phase 4's "Ends in" cell to `A game other people can play — **in progress** (4a: web shell and lane view)`. Then rewrite the Status paragraph's first sentence: "**Phases 0 to 3 complete; Phase 4, the web client, in progress.**"
  - Keep the Phase 3 sentence.
  - Add `apps/web` to the list of packages.
  - Add one sentence: `pnpm --filter @manufactory/api dev` and `pnpm --filter @manufactory/web dev` run the game locally on PGlite with no Docker.
  - Leave the no-test-count note as it is.
- [ ] **Step 5:** run `pnpm test`, `pnpm lint` and `pnpm typecheck` in the foreground, in that order. Commit: `Web: Playwright harness, the 4a guest-buy spec, the web-e2e CI job, README (W-23)`.

---

## Deferred to 4b/4c (do not build here)

- **4b:**
  - the buy drawer: projection, ladder progress, `UPGRADE_MARK`, dismantle, storage/QS, recipe select and assign, and its W-13 preview with the `bound` credit test;
  - the storage and reserve buttons in the frame;
  - the priority list (W-21);
  - the power dock and the holdable tap UI. The accumulator itself is in 4a.
- **4c:**
  - the handbook, accounts, `supertokens-web-js`, claim and `websiteBasePath`;
  - settings: notation and theme toggle;
  - the header tier readout;
  - sweeps, number tweens and the conveyor;
  - the contrast check, the 320 px e2e pass and reduced-motion e2e;
  - `DEV_FAKE_SESSIONS`;
  - `infra/Caddyfile` and the footer source link.
- **Later:** the "while you were away" summary (resolved open question 2).
