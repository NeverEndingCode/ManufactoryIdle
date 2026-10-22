# Phase 4c: accounts, the handbook, motion, the 320 px pass and the deploy example — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Other people can play, sign up, and keep their factory (spec decomposition row 4c).

**Architecture:**
- **Task 1:** the carried sync and spend minors, all small: the keepalive flush during a 429/503 pause, `start()` re-arming pending taps, the one-emit in-flight tap overcount, the same-item-refund preview residue, the affordability countdown from `creditFor`, the W-4 builtin ban that shadows npm names, and the scripted player's N² rebuild.
- **Task 2:** the API side of accounts: `appInfo.websiteBasePath: "/account"` (W-26's last row), and a fake SuperTokens front-end interface in the dev server behind `DEV_FAKE_SESSIONS=1` (W-23). `infra/README.md` gets one-origin domains.
- **Task 3:** identity in the store: `src/auth/` (an `AccountClient` interface and its `supertokens-web-js` implementation), a late-bound `fetch`, health-first boot, the sign-in hold, claim before the first session read (W-16), the parked guest token, sign-out and session end. Tested against the real API in process.
- **Task 4:** the shell around the game: the three-path router (W-3), the settings sheet (notation, theme, account; W-1), the sign-up/in forms, the "save your factory" chip, and the reset-password page.
- **Task 5:** the handbook (W-1 item 5, §13.4): a pure model over `computeExpansion` and the recipe index, search, made from, traces back to, used in, a glossary, context-aware entry points, and its place in the W-19 layout.
- **Task 6:** motion and accessibility: the production sweep, number tweens and the conveyor (W-18), the bottleneck-change announcement (W-20), a static motion test over the CSS, and the carried UI minors (drag under scroll, the frame's `SpendButton` on `Guarded`, "Move" vs pending steppers, `--dock-h`, the notices margin, the PowerDock test guard, the one-live-region test).
- **Task 7:** deployment and the 4c e2e: `infra/Caddyfile`, the GPL source link at the built commit, public source maps (W-25), and three Playwright specs: 320 px on every view, reduced motion, and accounts (sign-up, claim, park, sign-out, reset) on `DEV_FAKE_SESSIONS`. README.

**Tech Stack:** as 4b, plus exactly one runtime dependency, `supertokens-web-js` (exact pin, S-1). TypeScript ESM, React 18.3.1, Vite 8.2.2, vitest 4 + jsdom + Testing Library, `@playwright/test` 1.64.1 (Chromium), Fastify 5 + PGlite, `supertokens-node` 24.0.3 (resolved in the lockfile). No animation library, no router library.

**Spec:** `docs/superpowers/specs/2026-10-17-phase-4-web-client-design.md`: the 4c row; W-1 item 5 and its "Also" (sign-up/sign-in with claim, settings sheet); W-2; W-3's routes; W-14 to W-20; W-23's 4c specs; W-25; W-26's last row; the errata. The 4a rulings P-1 to P-16 and the 4b rulings Q-1 to Q-18 stand unless an S-ruling below says otherwise. Original spec §13.4 (handbook) and §13.6 (motion).

## Rulings made in this plan

Verified against `phase-4b-play` at 6ecc193, and measured with `npx tsx` probes against the real engine and slice (`/home/nec/.claude/jobs/56686703/tmp/phase4/probe4c-*.mts`).

### Accounts

- **S-1. `supertokens-web-js`, exact-pinned to the newest release whose FDI list meets `supertokens-node` 24.0.3's; cookie mode; same origin; imported statically.**
  - **What node 24.0.3 speaks.** Its npm tarball ships no `frontendDriverInterfaceSupported.json` (checked: `node_modules/.pnpm/supertokens-node@24.0.3/…` has none, and `lib/build/version.js` lists only `cdiSupported: ["5.4"]`). Its CHANGELOG says: 21.0.0 "Added support for FDIs: 3.1 and 4.0. Required by: auth-react >=0.48.0 and web-js>=0.14.0"; a later release "Updated FDI support to `4.1`"; 23.0.1 "Updated FDI support to 4.2"; nothing removes one since. So the working list is **`NODE_FDI = ["3.1", "4.0", "4.1", "4.2"]`**, recorded with that provenance in `apps/api/src/dev-sessions.ts` (Task 2).
  - **The version can't be resolved offline**: there is no `supertokens-web-js` in the pnpm store or the metadata cache on this machine. Task 3 Step 0 tells the implementer how to resolve and verify it, and the dev fake (S-8) rejects at run time any `fdi-version` header that shares nothing with `NODE_FDI`, so drift fails the e2e. Expect a version `>= 0.14.0`.
  - **Cookie mode** (`Session.init({ tokenTransferMethod: "cookie" })`): the SDK then sends `st-auth-mode: cookie`, and node's `createNewSession` honours it (`recipe/session/sessionRequestFunctions.js:321-330`; without the header it would default to **header** mode). The `Authorization` header stays free for `Guest …`, and node's header-mode reader ignores anything that isn't `Bearer ` (`cookieAndHeaders.js:88-92`), so a guest header never reads as a session.
  - **Same origin** (W-2): `appInfo.apiDomain = window.location.origin`, `apiBasePath: "/auth"`. On one origin node picks `SameSite=Lax` and anti-CSRF `NONE` (`recipe/session/utils.js:99-136`), as W-2 says.
  - **Static import.** Q-17 bans `import()` in browser code, so the SDK is in the bundle even on a guest-only server. It is initialised only when `/api/health` says `accounts: true` (W-15).
  - *Cost if wrong:* the SDK sits behind `AccountClient` (`src/auth/`); a swap touches one file.
- **S-2. The store's `fetch` is late-bound.** `main.tsx` passes `window.fetch.bind(window)` today, which captures the native `fetch` before the SDK's `init()` patches `window.fetch`, so refresh-on-401 would never run for game requests. 4c passes `browserFetch = (input, init) => window.fetch(input, init)` (`src/sync/fetch.ts`). *Cost if wrong:* none; it is one indirection.
- **S-3. Boot is health first, then identity.** Today `start()` runs health in parallel with the guest GET or `POST /api/guests`. With accounts that is wrong twice: a signed-in player with no guest token would get a stray guest, and requests would carry a `Guest` header beside the session (W-14 says omit it). So:
  1. `GET /api/health` (warming the content cache as now);
  2. if `accounts: true`: `client.init()`, then `client.hasSession()`;
  3. session → GET with no `Authorization`; else token → GET; else `POST /api/guests`.
  - A failed health (network, 5xx, non-JSON) retries on `RETRY_STEPS_MS` and counts toward "offline", like a GET. Nothing world-shaped is sent before it answers.
  - *Cost:* one extra round trip on first load (the health response is tiny). *Cost if wrong:* revert to parallel for the guest-only case only.
- **S-4. A sign-in holds the world's traffic until the claim is decided.** W-16 says claim "before any `GET /api/world` under the session", but session cookies exist from the moment `signUp`/`signIn` returns. A boundary GET, a focus GET, an outbox retry or a keepalive tap in that window would carry the cookie, lazily create an account world (R-14), and turn the claim into a 409. The spec doesn't cover the window. So `signUp`/`signIn` first **hold**:
  - release the tap hold and flush pending taps into the outbox (not keepalive);
  - stop arming the boundary timer, and ignore GET triggers (`#wantGet` returns while held);
  - wait for the request in flight, if any (`outbox.idle()`), then `outbox.stop()`;
  - a keepalive flush while held goes into the outbox instead of `fetch`.
  - On a failed sign-in the hold is released and everything resumes as a guest. On success the claim (S-5) decides what the held batches do.
  - *Cost if wrong:* a player who taps during the second of sign-in loses at most that second of taps.
- **S-5. The claim, and what happens to the held world.** With a stored guest token, `POST /api/auth/claim { guestToken }` (no `Authorization`; the cookie is the identity):
  - **200**: the claimed world is the **same player** (`claimGuest` moves `supertokens_user_id` onto the guest row, `worlds.ts:444-471`), so idempotency keys still match. Clear the token, adopt the body, `outbox.start()`: held batches go out under the session to the same world.
  - **404 `unknown-guest`**: clear the token, drop the held batches (`outbox.clear({ kind: "unauthorized" })`, as 4a's `#expire`), reset the snapshot, GET.
  - **409 `already-has-world`**: move the token to `mi.parkedGuestToken` (S-6), drop the held batches, reset the snapshot (a different world: `isAdoptable` must not compare it with the guest's version), notice `account-has-factory` (W-16's text), GET.
  - **network, 5xx, 503**: retry the same claim on `RETRY_STEPS_MS` **while still held**. No GET happens under the session until a claim answer arrives.
  - **401** (the cookie didn't stick): treat as a failed sign-in. Release the hold, stay a guest, toast `client-bug`.
  - Without a guest token: drop held batches (there are none for a world the account owns), reset, GET.
  - *Cost if wrong:* the outcomes are one switch in `#enterSession`.
- **S-6. At most one guest token exists on a device, across both keys.** `mi.parkedGuestToken` is non-empty only while signed in, and sign-out always moves it back (S-7). So a second 409 can never overwrite a parked token.
  - **A boot that finds a session and a guest token** (a sign-up whose claim was interrupted by a tab close) **parks the token** and shows the `account-has-factory` notice. It never claims (W-16: "a boot that finds an existing session never claims") and never deletes (§16.6). This refines W-16, which doesn't consider the case.
  - *Cost if wrong:* a parked token nobody returns to is cleaned up after 30 days (W-16's own cost).
- **S-7. Sign-out and a lost session both return to a guest, never to a wall (D7).**
  - `signOut()` calls the SDK, then: parked token → move it to `mi.guestToken` and GET; no parked token → `POST /api/guests`. Notice `signed-out`: "Signed out. Sign in to return to your saved factory."
  - A 401 under a session (refresh failed; the SDK has already cleared its state) does the same, with notice `session-ended`: "Your session ended. Sign in to return to your saved factory."
  - A failed `signOut()` (unreachable) keeps the session and reports `false`; the sheet says "Couldn't sign out. Try again."
  - *Cost if wrong:* a halt screen instead is one branch.
- **S-8. `DEV_FAKE_SESSIONS` is a fake front-end interface, not only a fake verifier.** W-23 calls it "a fake verifier", but `supertokens-web-js` only believes a session exists after FDI-shaped responses: a `front-token` header, cookies, and `/auth/signout` and `/auth/session/refresh` behaving. So `apps/api/src/dev-sessions.ts` serves, in memory:
  - `POST /auth/signup`, `/auth/signin`, `/auth/signout`, `/auth/session/refresh`, `/auth/user/password/reset/token`, `/auth/user/password/reset`, with SuperTokens' status bodies (`OK`, `FIELD_ERROR`, `WRONG_CREDENTIALS_ERROR`, `RESET_PASSWORD_INVALID_TOKEN_ERROR`);
  - `GET /auth/dev/reset-link?email=` (dev and e2e only), returning the path-only link `/account/reset-password?token=…&tenantId=public`.
  - A session is an `sAccessToken=dev.<sessionId>` cookie (`HttpOnly; SameSite=Lax; Path=/`) plus `front-token: base64(JSON {uid, ate: now + 24 h, up: {}})`. The fake keeps a `Map<sessionId, userId>`; sign-out deletes the entry, sends `front-token: remove` and expires the cookie. The verifier maps the cookie through that map.
  - Every `/auth/*` request whose `fdi-version` header shares no version with `NODE_FDI` gets `400 {"message":"fdi-version mismatch"}`. That is S-1's run-time pin.
  - `DEV_FAKE_SESSIONS` must be exactly `"1"` (anything else non-empty exits with an error, like 4b's strict `WEB_PLAY_TIER`). `devServer({ fakeSessions: true })` throws when `NODE_ENV === "production"`, and `main.ts` never imports it.
  - **All e2e run with it on** (Playwright's API `webServer` sets it), so the 4a/4b specs also run with the SDK initialised, which is the production configuration.
  - *Cost if wrong:* the fake can drift from SuperTokens. The real path stays the API's smoke test (Task 2 adds a cookie-mode check to it), and if the e2e shows the SDK wanting more, the fake follows the SDK, never the client.
- **S-9. `websiteBasePath: "/account"` through a tested `appInfoFor`.** `superTokensFromEnv` builds its `appInfo` with a new exported `appInfoFor(apiDomain, websiteDomain)`, which `supertokens.test.ts` pins. Verified: node builds the reset link as `origin + websiteBasePath + "/reset-password?token=" + token + "&tenantId=" + tenantId` (`recipe/emailpassword/utils.js:191-203`). So the link lands on W-3's `/account/reset-password`, and `websiteBasePath` must not end in `/reset-password` itself.

### The shell

- **S-10. Routing is a `pathname` switch over three paths, with `pushState` and `popstate`.** `/` (the game), `/handbook` and `/handbook/:itemId`, and `/account/reset-password`. Anything else is replaced with `/`. An unknown handbook item shows the index. Vite's preview server already falls back to `index.html` (SPA mode), and the Caddyfile uses `try_files {path} /index.html` (S-17). Panes and sheets stay state (W-3).
- **S-11. The settings sheet is a modal dialog with three sections.**
  - **Notation:** the engine's six `NotationMode`s, `"hybrid"` by default, kept in `localStorage` as `mi.notation`.
    - Today `"hybrid"` is a literal in 14 `format(` calls across 7 UI modules, some inside per-snapshot memos.
    - 4c routes every call through `fmt(value)` from `ui/notation.ts`, which reads a small external store. The memos (`laneRows`, `drawerModel`, `previewLines`) gain the notation as a dependency.
    - A source-scan test fails on any `format(…, "<mode>")` literal outside `notation.ts`.
  - **Theme:** System / Dark / Light, as `data-theme` on `<html>` (`tokens.css` already keys on it), kept as `mi.theme`. `main.tsx` applies it before the first render.
  - **Account:** sign-up / sign-in / forgot password, or "Signed in" (with the email when this tab signed in; there is no user-info route, and adding one is API scope) and Sign out. With accounts off: "Accounts aren't enabled on this server."
  - The sheet is `role="dialog" aria-modal="true"`: a bottom sheet below 600 px and a centred panel above. Escape closes it and focus returns to the opener. The background gets `inert` (set through a ref, since React 18 has no prop for it).
  - Every stored value is a per-viewer convenience wrapped in try/catch, like Q-9's `mi.priorityView`.
- **S-12. The nudge is a chip; sign-up is always in settings.** The "Save your factory" chip shows in the header when accounts are on, the player is a guest, and `state.tier >= 1` (D.4/W-16: after the first milestone, never a modal). It opens the settings sheet at Account, in sign-up mode. Tier 1 takes 1.5 h of game time (4b Q-14's measurement), so the e2e signs up through the settings sheet.

### The handbook

- **S-13. The handbook covers the whole graph, computed live.**
  - **Items:** all 32 bundle items, in authored order. An item above the player's tier is listed dimmed, with "unlocks at tier N".
  - **Search:** a case-insensitive substring match on name and id.
  - **Entry (§13.4):**
    - **Identity:** name, lane, tier, and current storage cap (`liquidCap`).
    - **Made from:** the active recipe (`display.state.activeRecipe`, else the default) as inputs → outputs per minute, the machine class, and the best unlocked mark's `powerDraw` (`getMark(content, class, bestUnlockedMark(content, class, tier))`; `bestUnlockedMark` returns a number, verified), or a generator's `powerOutput`.
    - **Alternates:** the other producers, dimmed when `def.unlockTier > state.tier`, with "unlocks at tier N".
    - **Traces back to:** `computeExpansion(content, tier, activeRecipe).rawCost.get(itemId)`, as "0.25 Iron Ore per Screw".
    - **The chain** (`ore → ingot → rod → screw`): from the item, step to the input of its active recipe with the largest raw total (the sum of that input's `rawCost`), with ties going to authored input order. It stops at an extraction recipe (no inputs), a repeat, or 12 steps.
    - **Used in:** `content.consumersOf.get(itemId)` as chips, each opening its recipe's `primaryOutput` entry, dimmed when locked.
  - **Measured** (`probe4c-handbook.mts`, `probe4c-chain.mts`, `probe4c-lock.mts`):
    - `rawCost` exists only for items whose active recipe is live (on a fresh world `screw` has none). An item above the player's tier is therefore traced at `max(state.tier, item.tier)` with the bundle's default recipes, and labelled "at tier N, default recipes".
    - `heavy_oil_residue` never traces: it is a byproduct of `refine_plastic`, `refine_rubber` and `refine_polymer_resin`, none of which has it as `primaryOutput`. Its entry says "a byproduct of …".
    - `cable` has no consumers in the slice ("Not used in any recipe yet").
    - Tier-8 chains: screw "Iron Ore → Iron Ingot → Iron Rod → Screw"; modular frame "Iron Ore → Iron Ingot → Iron Plate → Reinforced Iron Plate → Modular Frame" (24 iron ore). A cold `computeExpansion` costs 0.2–0.5 ms, and it is cached.
  - **The glossary** is hand-written in `ui/glossary.ts`: bottleneck, QS, BOUND, storage tier, mark, ladder, priority, guaranteed/share, reserve, tap/kick, power, plateau. §13.4 wants it "readable as documentation".
  - **Where it renders (W-19):**
    - below 600 px it is the third tab-bar view, "Handbook";
    - at two and three panes it replaces the drawer in the detail pane (opening a drawer goes back to `/`).
    - A header "Handbook" button opens the index, or, while a drawer is open, that item's entry. The drawer also gets "Handbook entry". Together these are §13.4's context-aware icon.
  - *Cost if wrong:* the model is one pure function, `handbookEntry`.

### Motion and accessibility

- **S-14. Motion, by formula and by the CSS itself.**
  - **Sweep (W-18):** `sweepPeriodS(production) = clamp(0.8, 6 − 1.2 × log10(1 + production), 6)`. `production` is `display.solution.itemRates.get(id).production`, items/s. It is set per row as `--sweep-period`, as a `::after` `translateX` on the satisfaction meter, only when production > 0 and the entry isn't paused.
  - **Conveyor (W-18, §13.6):** one `aria-hidden` strip in the visible lane panel. `sum` is the summed `production` of the lane's shown rows.
    - Blocks: `sum <= 0 ? 0 : clamp(1 + floor(2 × log10(1 + sum)), 1, 12)`.
    - Period: `clamp(4, 20 − 4 × log10(1 + sum), 20)` s.
    - Opacity 0.07, behind the rows. Its container has `overflow: hidden`, or its `translateX` would widen the page at 320 px.
    - §13.6's "direction indicates flow toward the selected priority target" has no meaning for one strip per lane, so it always runs left to right. That departs from §13.6.
  - **Number tweens (W-7, W-18):** only the rows' stock amounts (the counters). When a new snapshot's interpolated value differs from the old snapshot's at the same moment by more than 1%:
    - for `TWEEN_MS = 300`, a `requestAnimationFrame` loop writes the span's `textContent` through a ref, in log10(1 + x) space with an ease-out;
    - React re-renders nothing at 60 Hz, and the 4 Hz tick stays the steady path;
    - nothing tweens under reduced motion, and `rAF` doesn't run in a hidden tab.
  - **A static test reads every CSS file.** Every `animation`/`transition` declaration and every `@keyframes` use is inside `@media (prefers-reduced-motion: no-preference)`, and keyframes and transitions name only `transform` and `opacity`. ItemRow's JS-set storage-bar transition is already skipped under reduce (verified, `ItemRow.tsx:104-138`).
  - *Cost if wrong:* the constants are in `ui/motion.ts`.
- **S-15. The live region announces bottleneck changes and tier-ups; still one region.**
  - **Tier-up is already done:** Q-13's `tier-up` notice renders inside the `role="status"` region (`Notices.tsx`).
  - **The bottleneck change is not done:** only P-2's frameless-bottleneck line is in the region. 4c announces "Bottleneck: <advice text>" when the framed item changes between adopted snapshots, and "No bottleneck" when it clears, never on first load. It goes through the 4b announcer (`announce.ts`).
  - The one-region test grows from the idle state to offline, tier-up, a rejection, a frameless bottleneck and an announcement (carried minor).
- **S-16. The 320 px gate measures elements, not just the page.**
  - `base.css` sets `body { overflow-x: hidden }`. That clips any overflow from the player's view, and `scrollWidth` can't see overflow clipped inside a row's own `overflow: hidden`. So W-19's `scrollWidth <= clientWidth` alone can pass with numbers cut off.
  - The e2e therefore also asserts, on every view, that every visible `button`, `a`, `input`, `select`, `.num` and `[role=meter]` lies within `[0, innerWidth]`, and that every visible `button`/`a`/`input`/`select` is at least 44 × 44 px (W-20).
  - The `overflow-x: hidden` safety net stays.

### Deployment

- **S-17. The deploy example: a Caddyfile and the built commit, no compose profile.**
  - **`infra/Caddyfile`:** `/api/*` and `/auth/*` go to `{$API_UPSTREAM:127.0.0.1:8080}`, and everything else is `apps/web/dist` with `try_files {path} /index.html`. `/assets/*` is `public, max-age=31536000, immutable`, everything else `no-cache`, plus `encode zstd gzip`.
    - The API runs with `API_DOMAIN = WEBSITE_DOMAIN =` the site's origin (W-2) and `TRUST_PROXY=127.0.0.1`, so the guest bucket sees client IPs.
    - W-25's "optional compose profile" is skipped: there is no API image to compose, and this plan runs no containers.
  - **The commit:** `apps/web/scripts/build-info.ts` (Node, imported by `vite.config.ts`) takes the first of `SOURCE_COMMIT`, `GITHUB_SHA`, `git rev-parse HEAD` that is 40 lowercase hex. `dirty` is true when the commit came from git and `git status --porcelain --untracked-files=no` is non-empty.
    - `SOURCE_REPO` defaults to `https://github.com/NeverEndingCode/ManufactoryIdle` (this repo's `origin`).
    - Vite `define`s `__BUILD_INFO__`. The footer links `${repo}/tree/${commit}` ("Source, abc1234"; "modified from abc1234" when dirty) and `${repo}/blob/${commit}/LICENSE`. With no commit, it links the repo root.
    - Tests read it through `typeof __BUILD_INFO__ === "undefined" ? FALLBACK : __BUILD_INFO__`, because vitest has no `define`.
  - **Source maps:** `build.sourcemap: true` is already set (verified, `vite.config.ts`). The Caddyfile serves `*.map` like any asset, and the e2e fetches the entry chunk's `.map`.
  - *Cost if wrong:* none to the code (W-25).

### Carried minors

- **S-18. How each carried minor is fixed.**
  - **Keepalive during a pause:** when `#pausedUntil > now`, `#flushKeepalive` enqueues with its fresh key instead of fetching.
  - **`start()` re-arms pending taps:** after `stop()`/`start()` with taps pending, the flush is armed at `max(now, lastFlushAt + TAP_FLUSH_EVERY_MS)`.
  - **The adopt overcount:** while `onOutcome` adopts a POST, the view leaves out the outbox head that is being settled (a `#settlingId`), so the tapped stacks and the in-flight TAP are never counted in the same emit.
  - **The residue:** after `applyBatch`, `preview` snaps to 0 any credited item left at `0 < liquid ≤ cost × SPEND_RESIDUAL_TOLERANCE` (`stored` and `quantum` to zero), so a same-item-refund preview drains to EMPTY.
  - **The countdown:** `affordability` derives both the verdict and `inMs` from `creditFor(stockAt(s, serverMs), q)`. `stockAt` is the display state with `stored` set to `shownStock` and `quantum` to 0, which the 4b ledger showed equal by construction.
  - **The lint ban:** `builtinModules` minus the names in `apps/web/package.json`'s `dependencies` and `devDependencies`, so a future npm package named `events` or `url` isn't shadowed.
  - **The player:** one `drawerModel` per lane-class per decision, not one per section per section.
  - **The UI minors** are in Task 6 with their tests.

## Spec-versus-code findings

Each is a spec claim that the code contradicts or that the spec leaves open; the ruling that handles it is in brackets.
1. **W-15:** `main.tsx` binds `window.fetch` before the SDK could patch it, so the "refresh for free" claim fails as wired [S-2].
2. **W-14/W-16:** boot runs health in parallel with identity. With accounts on, a signed-in player with no token would get a stray guest, and requests would mix identities [S-3]. The store also gates every GET on a guest token (`#wantGet`: `tokens.get() === null → return`), and `#expire()` is guest-only, so a session identity doesn't exist yet [Task 3].
3. **W-16:** the window between sign-in success and the claim is unguarded. Any GET or retry in it creates the account world and forces a 409 [S-4]. A session found at boot alongside a guest token isn't covered either [S-6].
4. **W-23:** "a fake verifier" is not enough for `supertokens-web-js`, which needs FDI-shaped responses [S-8].
5. **W-15:** node 24.0.3 ships no FDI list in its npm package, and `supertokens-web-js` can't be resolved offline [S-1].
6. **W-2 vs `infra/README.md`:** the README runs accounts with `API_DOMAIN=http://localhost:8080 WEBSITE_DOMAIN=http://localhost:5173`, two origins [Task 2].
7. **W-20:** the bottleneck-change announcement was never built; the tier-up one was [S-15].
8. **§13.4:** the "traces back to" vector doesn't exist for items above the player's tier or for byproduct-only items (`heavy_oil_residue`) [S-13].
9. **§13.6:** the conveyor's direction "toward the selected priority target" has no meaning for one strip per lane [S-14].
10. **W-19/W-23:** `body { overflow-x: hidden }` clips overflow from the player and from part of the scrollWidth check [S-16].
11. **W-17:** the notation setting has nothing to set: `"hybrid"` is a literal in 14 calls [S-11].
12. **W-25:** the "optional compose profile" has no API image to compose [S-17].

## Global Constraints

- **Where to work:** a new worktree **`.claude/worktrees/phase-4c`**, on a new branch **`phase-4c-finish`**, stacked on `phase-4b-play` at 6ecc193 (PR 4b, #24). The user creates it. Never work in the top-level checkout, which is stale, or in another phase's worktree.
- **Commands:**
  - Never run `pnpm format`. It rewrites the whole repo.
  - Verify with `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, one at a time in the foreground. Never run lint or typecheck while a test run is going, and never run any of them in the background: turbo builds race.
  - Never `pkill -f`. No `pgrep -f` loops.
  - No containers: no Docker, no compose. The dev server and e2e use PGlite and `DEV_FAKE_SESSIONS`.
- **Dependencies:** exactly one new one, `supertokens-web-js`, in `apps/web` `dependencies`, at an exact version (S-1). Nothing else. No migrations, no schema change, no action change, no engine code. The API changes only `appInfoFor` (S-9) and the dev-only fake (S-8).
- **Browser code** never imports `@manufactory/content`, `@manufactory/api`, `@manufactory/sim` or a Node builtin, and never uses `import()` (W-4, P-13, Q-17; lint-enforced). `supertokens-web-js` is imported only under `apps/web/src/auth/`.
- **Rates on screen come from the server's `schedule`.** The engine runs for the per-snapshot display solve, previews, and (4c) the handbook's cached `computeExpansion`, and never at 4 Hz.
- **Motion:** only `transform` and `opacity` animate, all inside `prefers-reduced-motion: no-preference` (Task 6's static test enforces it from then on). State colours only under `.state-*` or `.frame` selectors (4a test 8a).
- **Identity:** no world request (GET, POST actions, keepalive) goes out between a sign-in's success and its claim's answer (S-4).
- **Commit trailers, exactly:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **Never lose a guest world (S-4 to S-7):** claim is the first world request after sign-in, nothing is sent while held, a 409 parks and never deletes, sign-out restores the park, and held batches reach only the same player. Task 3 tests 4–11 and the accounts e2e's request-order assertion.
- **The fake stays honest (S-1, S-8):** its bodies match SuperTokens' statuses, it rejects an FDI mismatch, and nothing outside `dev.ts` can turn it on. Task 2 tests.
- **The handbook is computed, not authored (S-13):** traces come from `computeExpansion` on the live recipes, and locked or byproduct items are labelled rather than faked. Task 5 tests 1–4.
- **Motion is enforceable (S-14):** the static CSS test, reduced motion leaving zero running animations in the browser, and the conveyor clipped at 320 px. Task 6 test 1 and the Task 7 e2e.

---

### Task 1: the carried sync and spend minors, test-first

**Files:**
- Modify: `apps/web/src/sync/store.ts`, `apps/web/src/ui/quote.ts`, `apps/web/src/ui/preview.ts`, `apps/web/src/ui/play.test.ts`, `eslint.config.js`
- Test: `apps/web/src/sync/store.test.ts`, `apps/web/src/ui/quote.test.ts`, `apps/web/src/ui/preview.test.ts`

**Interfaces:**
- Consumes, verified at 6ecc193:
  - `GameStore.flushTaps`, `#flushKeepalive`, `#pausedUntil`, `start()`/`stop()`, `#adopt` and `#makeView` (`store.ts`);
  - `Outbox.enqueue(actions, label, { key })` and `.inFlight` (`outbox.ts`);
  - `dockModel(s, taps, clientNow, pending)` (`dock-model.ts:25`);
  - `creditFor`, `creditedState` and `affordability(s, action, serverMs)` (`quote.ts:137,173,206`);
  - `shownStock(s, itemId, serverMs)` (`interpolate.ts:14`);
  - `preview(s, actions)` (`preview.ts:97`);
  - the rig's `fakeGetStatus` knob and `FakeClientClock`.
- Produces:

```ts
// quote.ts (S-18)
/** display.state with stored = shownStock at serverMs and quantum = 0: what affordability reads. */
export function stockAt(s: Snapshot, serverMs: number): WorldState;
// affordability's signature is unchanged; its body is creditFor(stockAt(s, serverMs), quote(...)).
// store.ts: no new public API. Private: #settlingId: number | null.
```

- [ ] **Step 1: Write the failing tests.**
  1. **`store.test.ts` 29, keepalive during a pause.** Set `limits.player` small and exhaust it so a GET gets `429` with `Retry-After: 3`. Then press, hold 300 ms, release, and `flushTaps({ keepalive: true })`. No `POST /api/actions` is logged until the pause ends. Then exactly one is logged, with the key the keepalive made (read through `pending[0].key` before the advance).
  2. **`store.test.ts` 30, `start()` re-arms pending taps.** Press, release (taps pending, flush due at +300 ms), then `stop()` and `start()`. Advance 1,000 ms: exactly one TAP batch was posted, with the pending count.
  3. **`store.test.ts` 31, no overcount on adopt.** Subscribe a listener that, at every emit, computes `dockModel(view.snapshot, view.taps, now, view.pending).stacks`. Tap 3 times and let the flush be adopted. No emitted value exceeds 3.
  4. **`quote.test.ts`, the countdown from `creditFor`.** On `slice-tier-8.world.json`, for every machine-section `BUY_MACHINE ×10` and every `UPGRADE_MARK`, at `serverMs` in `atMs + {0, 1 s, 60 s, 600 s}`:
     - `affordability(...).affordable === (creditFor(stockAt(s, ms), quote(...)).size === 0)`;
     - when unaffordable with a finite `inMs`, `inMs` equals `max over short items of short / net × 1000` within 1 ms.
  5. **`preview.test.ts`, the same-item residue.** Find, by scanning the tier-8 machine sections, an `UPGRADE_MARK` whose cost and refund share an item. Reduce that item's `stored` until the upgrade is short. The preview's `detailState` tags that item `EMPTY`, and `liquid` is exactly 0.
  6. **`play.test.ts`, an equality pin.** Before touching the player, record `run.actions` and `run.tierAtH[6]` at tier 6 as constants. After the change they must be identical.
- [ ] **Step 2:** run `pnpm --filter @manufactory/web test`. Tests 1, 2, 3 and 5 fail. Test 4 passes (it pins existing behaviour), and so does test 6.
- [ ] **Step 3: Implement S-18.**
  - **The store:**
    - in `#flushKeepalive`, before `fetch`: `if (this.#pausedUntil > this.#clock.now()) { void this.#outbox.enqueue([action], TAP_LABEL, { key }); return; }`;
    - in `start()`: `if (this.#taps.pending > 0 && !this.#holding) this.#armFlush(Math.max(this.#clock.now(), this.#lastFlushAt + TAP_FLUSH_EVERY_MS))`;
    - **the overcount:** set `#settlingId = batch.id` in `onOutcome` before `#handle`, and clear it in the outbox's `onChange` once the head changes. `#makeView` filters `pending` by `b.id !== this.#settlingId`.
  - **`stockAt`, and `affordability` over it.**
  - **The snap in `preview`**, after `applyBatch`, per credited item.
  - **`play.test.ts`:** `sectionFor(s, lane, machineClass)` replaces the inner `sections(s).find(...)`.
  - **`eslint.config.js`:** read `apps/web/package.json` with `readFileSync(new URL("./apps/web/package.json", import.meta.url))`. Then use `paths: builtinModules.filter((n) => !webDeps.has(n)).map(...)`.
- [ ] **Step 4:** run the web tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - Drop the pause check in `#flushKeepalive`: test 1 fails.
  - Drop the `start()` re-arm: test 2 fails.
  - Drop the `#settlingId` filter: test 3 sees 6.
  - In `affordability`, use `shownStock` without the refund: test 4 fails on `UPGRADE_MARK`.
  - Drop the snap: test 5 sees `FLOWING`.
  - **Lint:** add `"url": "0.11.4"` to `apps/web/package.json` `devDependencies` (no install). `import "url"` in `main.tsx` now lints clean, and without the entry it fails with the W-4 message. Undo both.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: keepalive honours a pause, start() re-arms taps, no adopt overcount, exact same-item drain, countdown from creditFor, lint ban spares npm names`.

---

### Task 2: `websiteBasePath`, and a fake front-end interface for dev and e2e

**Files:**
- Create: `apps/api/src/dev-sessions.ts`, `apps/api/src/dev-sessions.test.ts`
- Modify: `apps/api/src/auth/supertokens.ts`, `apps/api/src/auth/supertokens.test.ts`, `apps/api/src/auth/supertokens.smoke.test.ts`, `apps/api/src/dev-server.ts`, `apps/api/src/dev-server.test.ts`, `apps/api/src/dev.ts`, `apps/api/README.md`, `infra/README.md`

**Interfaces:**
- Consumes, verified:
  - `buildServer(deps: ServerDeps)`, with `accounts?: { register(app); handleError(...) }`, `verifySession?`, and health's `accounts: accounts !== undefined` (`server.ts:44-71,177-181`);
  - `identityAuth({ db, content, clock, verifySession })` and `SessionVerifier` (`identity.ts`);
  - `POST /api/auth/claim` (`server.ts:256-290`: 503 `accounts-disabled` without a verifier, 401 without a session, 404/409 from `claimGuest`);
  - `devServer(opts)` (`dev-server.ts`).
- Produces:

```ts
// auth/supertokens.ts (S-9)
export function appInfoFor(apiDomain: string, websiteDomain: string): {
  appName: "Manufactory Idle"; apiDomain: string; websiteDomain: string; apiBasePath: "/auth"; websiteBasePath: "/account";
};

// dev-sessions.ts (S-8)
/** supertokens-node 24.0.3's FDIs, from its CHANGELOG (21.0.0: 3.1, 4.0; 4.1; 23.0.1: 4.2). Re-check
 *  against the repo's frontendDriverInterfaceSupported.json at tag v24.0.3 when bumping. */
export const NODE_FDI: readonly string[];
export interface FakeSessions {
  accounts: NonNullable<ServerDeps["accounts"]>;   // register() adds the /auth/* routes; handleError → false
  verifySession: SessionVerifier;                  // reads the sAccessToken cookie
}
export function fakeSessions(opts?: { clock?: () => number }): FakeSessions;

// dev-server.ts
export interface DevServerOptions { /* as now */ fakeSessions?: boolean }   // throws when NODE_ENV === "production"
```

The fake's routes and bodies, all `content-type: application/json`:

| Route | Body in | 200 body |
|---|---|---|
| `POST /auth/signup` | `{ formFields: [{id:"email"},{id:"password"}] }` | `{status:"OK", user:{id, emails:[email], timeJoined, tenantIds:["public"], isPrimaryUser:false, phoneNumbers:[], thirdParty:[], loginMethods:[…]}}` + session; `{status:"FIELD_ERROR", formFields:[{id, error}]}` for "Email is invalid", "This email already exists. Please sign in instead." and "Password must contain at least 8 characters, including a number" |
| `POST /auth/signin` | same | `OK` + session, or `{status:"WRONG_CREDENTIALS_ERROR"}` |
| `POST /auth/signout` | — | `{status:"OK"}`, `front-token: remove`, `sAccessToken` expired |
| `POST /auth/session/refresh` | — | with a valid cookie: 200 + a fresh `front-token`; else 401 `{message:"unauthorised"}` + `front-token: remove` |
| `POST /auth/user/password/reset/token` | `{ formFields:[{id:"email"}] }` | `{status:"OK"}` always (no account enumeration); remembers a token for a known email |
| `POST /auth/user/password/reset` | `{ formFields:[{id:"password"}], token }` | `OK`, or `{status:"RESET_PASSWORD_INVALID_TOKEN_ERROR"}` |
| `GET /auth/dev/reset-link?email=` | — | `{ link: "/account/reset-password?token=…&tenantId=public" }` or 404 |

- [ ] **Step 1: Write the failing tests.**
  1. **`supertokens.test.ts`:** `appInfoFor("https://x.example", "https://x.example")` deep-equals the record above.
  2. **`dev-sessions.test.ts`**, on `devServer({ fakeSessions: true })` through `app.inject`:
     1. health says `accounts: true`, and `devServer()` without the flag still says `false` (the existing test).
     2. Sign-up gives `OK`, a `set-cookie` with `sAccessToken=dev.`, `HttpOnly`, `SameSite=Lax` and `Path=/`, and a `front-token` whose base64 JSON has `uid` equal to `user.id`, `ate > now` and `up: {}`.
     3. The three field errors: a duplicate email, a bad email, `"short1"`.
     4. Sign-in with a wrong password gives `WRONG_CREDENTIALS_ERROR`, and with the right one `OK` plus the cookie.
     5. With the cookie and no `Authorization`, `GET /api/world` is 200 (a lazily created account world). On a second user, `POST /api/auth/claim { guestToken }` for a fresh guest is 200, and the guest token then gets 401.
     6. Sign-out sends `front-token: remove` and an expired cookie, and revokes the session: a GET replaying the old cookie value is 401, as is one with no cookie.
     7. An `fdi-version: 1.17` header gets 400 `fdi-version mismatch`. `fdi-version: 4.2,4.1` and no header both pass.
     8. Reset: `reset/token` for a known email is OK, `dev/reset-link` returns a path starting `/account/reset-password?token=`, `reset` with that token is OK, the new password signs in, and the old one doesn't. A made-up token gives `RESET_PASSWORD_INVALID_TOKEN_ERROR`.
     9. Refresh with the cookie gives 200 plus `front-token`, and without it 401 plus `front-token: remove`.
     10. `NODE_ENV=production` (set and restored in the test) with `fakeSessions: true` throws.
  3. **`supertokens.smoke.test.ts`** (skipped without a core, as now): a cookie-mode sign-up (`st-auth-mode: cookie`) sets `sAccessToken` with `SameSite=Lax`, and its response has no `anti-csrf` header (W-2's claim). Run it only where a core exists. Never start one in this plan.
- [ ] **Step 2:** run `npx vitest run src/auth/supertokens.test.ts src/dev-sessions.test.ts src/dev-server.test.ts` in `apps/api`. They fail: the modules and the option don't exist.
- [ ] **Step 3: Implement.**
  - `appInfoFor`, used by `superTokensFromEnv`.
  - `fakeSessions`: in-memory `Map<email, { userId, password }>`, `Map<sessionId, userId>` and reset-token maps, and a hand-parsed `cookie` header (no new dependency). The fdi check runs in a preHandler on `/auth/*`.
  - `devServer`: `const fake = opts.fakeSessions ? fakeSessions({ clock }) : null`. Then `auth: identityAuth({ …, verifySession: fake?.verifySession ?? noSessions })`, and `...(fake ? { accounts: fake.accounts, verifySession: fake.verifySession } : {})`.
  - `dev.ts`: `DEV_FAKE_SESSIONS` must be unset, empty or exactly `"1"`, otherwise `console.error` and exit 1.
  - **Docs:**
    - in `apps/api/README.md`: the flag, "never in production", and that the real path is the smoke test;
    - in `infra/README.md`'s "Running the API with accounts": `API_DOMAIN=WEBSITE_DOMAIN=http://localhost:5173`, because Vite proxies `/api` and `/auth` (W-2), and the client is opened at :5173.
- [ ] **Step 4:** run the API tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - Drop `websiteBasePath` from `appInfoFor`: test 1 fails.
  - Make the fdi check pass everything: 2.7 fails.
  - Make `verifySession` ignore the cookie: 2.5 fails.
  - Drop the production guard: 2.10 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `API: websiteBasePath /account (W-26); a fake front-end interface behind DEV_FAKE_SESSIONS for dev and e2e (W-23)`.

---

### Task 3: identity in the store: the SDK, health-first boot, the hold, the claim, the park, sign-out

**Files:**
- Create: `apps/web/src/auth/accounts.ts`, `apps/web/src/auth/supertokens.ts`, `apps/web/src/sync/fetch.ts`, `apps/web/src/sync/fetch.test.ts`, `apps/web/src/sync/accounts.test.ts`
- Modify: `apps/web/package.json` (`supertokens-web-js`), `pnpm-lock.yaml`, `apps/web/src/sync/store.ts`, `apps/web/src/sync/identity.ts`, `apps/web/src/sync/constants.ts`, `apps/web/src/sync/test-rig.ts`, `apps/web/src/main.tsx`, `apps/web/src/ui/test-fixtures.ts` (`fakeStore` gains the new view fields, with the defaults Task 4 lists, and `vi.fn` mocks for the five new methods), `eslint.config.js` (`supertokens-web-js` only under `src/auth/`)

**Interfaces:**
- Consumes, verified:
  - `TokenStorage` and `browserTokenStorage(arg?)` (`identity.ts`);
  - `GUEST_TOKEN_KEY` (`constants.ts:28`);
  - `GameStore`'s `#wantGet`, `#arm`, `#expire`, `#adopt`, `#createGuest`, `#loadHealth`, `newFactory` and `#authHeader`;
  - `Outbox.idle()`, `.stop()`, `.start()` and `.clear(outcome)` (`outbox.ts:91-118`; `stop()` keeps the head for a same-key resend);
  - `classify` (`errors.ts`);
  - `HealthResponse.accounts` (`wire.ts`);
  - `makeRig`, `injectFetch` (`test-rig.ts`), and the API's header-based test verifier pattern (`identity.test.ts:24-28`).
- Produces:

```ts
// auth/accounts.ts: the only interface the store sees (W-15: "behind src/auth/")
export type AuthField = "email" | "password";
export type AuthResult =
  | { ok: true; email: string }
  | { ok: false; kind: "field"; fields: { id: AuthField; error: string }[] }
  | { ok: false; kind: "wrong-credentials" }
  | { ok: false; kind: "not-allowed"; reason: string }
  | { ok: false; kind: "unavailable" };
export type ResetResult =
  | { ok: true }
  | { ok: false; kind: "field"; fields: { id: AuthField; error: string }[] }
  | { ok: false; kind: "invalid-token" }
  | { ok: false; kind: "unavailable" };
export interface AccountClient {
  /** Idempotent; the store calls it once health says accounts: true. */
  init(): void;
  hasSession(): Promise<boolean>;
  signUp(email: string, password: string): Promise<AuthResult>;
  signIn(email: string, password: string): Promise<AuthResult>;
  /** False when the server couldn't be reached; the session is then kept. */
  signOut(): Promise<boolean>;
  sendReset(email: string): Promise<ResetResult>;
  /** The token comes from the page URL (/account/reset-password?token=…). */
  submitNewPassword(password: string): Promise<ResetResult>;
}

// auth/supertokens.ts (S-1): SuperTokens.init({ appInfo: { appName: "Manufactory Idle", apiDomain: origin,
// apiBasePath: "/auth" }, recipeList: [Session.init({ tokenTransferMethod: "cookie" }), EmailPassword.init()] })
export function superTokensClient(origin: string): AccountClient;

// sync/fetch.ts (S-2)
export const browserFetch: FetchLike; // (input, init) => window.fetch(input, init)

// constants.ts
export const PARKED_GUEST_TOKEN_KEY = "mi.parkedGuestToken";
// identity.ts
export function browserTokenStorage(arg?: Storage, key?: string /* = GUEST_TOKEN_KEY */): TokenStorage;

// store.ts
export type Identity = "unknown" | "guest" | "session";
export interface StoreView {
  /* 4b fields unchanged */
  accounts: "unknown" | "off" | "on";
  identity: Identity;
  /** Signed in: the email when this tab signed in, else null. */
  account: { email: string | null } | null;
  /** "held": a sign-in is in progress (S-4); "claiming": the claim is retrying (S-5). */
  auth: "idle" | "held" | "claiming";
}
Notice["kind"] += "account-has-factory" | "signed-out" | "session-ended";
export interface GameStoreDeps { /* 4b */ parked?: TokenStorage /* default memory */; accounts?: AccountClient }
// GameStore
signUp(email: string, password: string): Promise<AuthResult>;
signIn(email: string, password: string): Promise<AuthResult>;
signOut(): Promise<boolean>;
sendReset(email: string): Promise<ResetResult>;          // { ok:false, kind:"unavailable" } when accounts are off
submitNewPassword(password: string): Promise<ResetResult>;

// test-rig.ts
makeRig(opts: { /* 4b */ sessions?: boolean }): Promise<TestRig & { session: { user: string | null } }>;
// sessions: buildServer gets accounts { register(){}, handleError: async () => false }, and
// verifySession / identityAuth read x-test-user. injectFetch adds x-test-user: session.user to every
// request while it is non-null: the cookie, simulated.
export function rigAccounts(rig, opts?: { gate?: Promise<void> }): AccountClient & { calls: string[] };
// signUp/signIn: await gate, then session.user = `u:${email}`; signOut: session.user = null;
// a "wrong" password gives wrong-credentials.
```

The texts:
- `account-has-factory`: "This account already has a factory. Your guest factory is kept on this device: sign out to return to it."
- `signed-out` and `session-ended`: as in S-7.

- [ ] **Step 0: Resolve and verify the SDK version (S-1).** This is the one step that needs the network (the registry). If it isn't available, stop and report; don't guess a version.
  1. `pnpm view supertokens-web-js versions time --json`; pick the newest release more than two weeks old.
  2. In a new empty scratch directory, `pnpm pack supertokens-web-js@<v>` and unpack it. Read its `frontendDriverInterfaceSupported.json`, or failing that its `lib/build/version.js` `supported_fdi`. It must share a version with `NODE_FDI` (Task 2).
  3. If the network is available, cross-check `https://raw.githubusercontent.com/supertokens/supertokens-node/v24.0.3/frontendDriverInterfaceSupported.json` against `NODE_FDI`, and fix `NODE_FDI` if it differs.
  4. Add it with `pnpm --filter @manufactory/web add supertokens-web-js@<v> --save-exact`.
  5. Read the installed `.d.ts` files for the exact `signUp`, `signIn`, `signOut`, `doesSessionExist`, `sendPasswordResetEmail` and `submitNewPassword` signatures and status unions. `superTokensClient` maps those statuses onto `AuthResult`/`ResetResult`; a network throw maps to `unavailable`.
  6. Record the version, the FDI list it declares and the file it came from in the commit message. If any of this can't be done, stop and report rather than guess.
- [ ] **Step 1: Write the failing tests** (`sync/accounts.test.ts`, the rig with `sessions: true` and `rigAccounts`; the log is `rig.fetch.calls`).
  1. **Accounts off.** On a rig without `sessions`, `client.init` is never called, the guest start is as 4a's test 1, and `view.accounts === "off"`.
  2. **Health first.** On a fresh boot the first call is `GET /api/health`, and no `/api/world` or `/api/guests` call starts before its response. Assert it with `rig.fetch.hold("GET", "/api/health")`.
  3. **A session at boot, no guest token.** There is no `POST /api/guests`, every GET has no `authorization` header, `identity === "session"`, and the world is the account's.
  4. **A session at boot with a guest token (S-6).** No claim is made. The token is now in `parked`, `tokens.get()` is null, and an `account-has-factory` notice is up.
  5. **Sign-up claims first (W-16, S-5 200).** Start a guest and send one free `REORDER_PRIORITY` (stateVersion 1). `signUp` gives `{ ok: true }`. The first world request after the sign-up is `POST /api/auth/claim` with `{ guestToken }` and no `authorization`. Then `tokens.get()` is null, `stateVersion` is 1, the seed is the guest's, and the next GET carries `x-test-user` and no `authorization`.
  6. **The hold (S-4).** With `rigAccounts(rig, { gate })` and the gate unresolved:
     - call `signUp`;
     - advance past the boundary and fire `onFocus()`;
     - `send` a free action and tap 3 times.
     Then:
     - no `/api/world` and no `/api/actions` is logged while the gate is held, and `view.auth === "held"`;
     - when the gate resolves, the order is the claim, then the held batches in the order they were queued, each with its original key;
     - the claimed world's `action_log` has both.
  7. **A 409 parks (S-5, S-6).**
     - Make `u:a@x`'s world first: `rig.fetch("/api/world")` with `session.user = "u:a@x"`, then reset `user` to null.
     - Then, as a guest with a queued batch held, `signIn("a@x", …)`.
     - The claim is 409. `parked.get()` is the old token, `tokens.get()` is null, and the snapshot's seed is the account world's.
     - The held batch settled `unauthorized`, and the account player's `action_log` is unchanged.
     - The notice is up.
  8. **A 404 (S-5).** Delete the guest's player row first. After sign-up, `tokens.get()` is null and a GET made the account world.
  9. **Sign-out (S-7).**
     - Repeating test 7's setup, `signOut()` gives `true`. Parked is now empty, `tokens.get()` is the old guest token, the next GET has `Authorization: Guest <token>` and no `x-test-user`, the seed is the guest's, and the notice is `signed-out`.
     - Repeating test 5's setup (nothing parked), `signOut()` makes one `POST /api/guests`.
  10. **A lost session (S-7).** In session mode, set `session.user = null` and fire a boundary GET (401). Then `session-ended`, the parked token (if any) is restored, and no request carries `x-test-user`.
  11. **A failed sign-in releases the hold.** `signIn` with the wrong password gives `wrong-credentials`. `view.auth` goes back to `"idle"`, and an advance past the boundary makes one guest GET.
  12. **A claim retry stays held.** `rig.fetch.dropNextResponse = true` on the claim. The claim is retried after 1 s with the same body, and no `/api/world` happens in between.
  13. **`browserFetch` is late-bound** (`sync/fetch.test.ts`, node): assign `globalThis.window = { fetch: f1 }`, call it, swap in `f2`, and call it again. Each call reached the then-current `fetch`.
- [ ] **Step 2:** run `pnpm --filter @manufactory/web test`. The new tests fail, and 4a/4b's store tests still pass.
- [ ] **Step 3: Implement.**
  - **`#identity`:**
    - `"session"` makes `#authHeader()` return null;
    - `#wantGet` requires `tokens.get() !== null || identity === "session"`, and returns while `#held`;
    - `#arm` doesn't arm while held;
    - `#flushKeepalive` enqueues while held.
  - **Boot:** `start()` awaits `#boot()`: health (retried on `RETRY_STEPS_MS`), then `accounts?.init()` and `hasSession()`, then identity as S-3, then S-6's park.
  - **`#hold()` / `#release()` / `#enterSession(email)`** as S-4 and S-5. `#resetWorld()` is factored out of `newFactory` (snapshot, repoll, notFound, timers, world notices).
  - **`#expire()`** branches: a guest token is 4a's `guest-expired`; a session is S-7's `session-ended`.
  - **`main.tsx`:**
    - `fetch: browserFetch`;
    - `parked: browserTokenStorage(undefined, PARKED_GUEST_TOKEN_KEY)`;
    - `accounts: superTokensClient(location.origin)`.
  - **ESLint:** in the browser block, a `paths` entry bans `supertokens-web-js` everywhere except `src/auth/**` (a second block for `apps/web/src/auth/**` turns it off).
- [ ] **Step 4:** run the web tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - Drop the `#held` check in `#wantGet`: test 6 logs a GET before the claim.
  - Clear instead of park on 409: test 7 fails.
  - `outbox.start()` instead of `clear` on 409: test 7 sees the batch in the account's log.
  - Keep health in parallel: test 2 fails.
  - Pass `window.fetch.bind(window)` in `browserFetch`: test 13 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: accounts in the store: health-first boot, the sign-in hold, claim before the first session read, the parked guest token, sign-out (W-14 to W-16)`.

---

### Task 4: routes, the settings sheet, the account forms, the chip and the reset page

**Files:**
- Create: `apps/web/src/ui/route.ts`, `apps/web/src/ui/notation.ts`, `apps/web/src/ui/theme.ts`, `apps/web/src/ui/Settings.tsx`, `apps/web/src/ui/Settings.module.css`, `apps/web/src/ui/AccountForms.tsx`, `apps/web/src/ui/ResetPassword.tsx`, `apps/web/src/ui/Settings.test.tsx`, `apps/web/src/ui/route.test.ts`, `apps/web/src/ui/notation.test.ts`
- Modify: `apps/web/src/ui/App.tsx`, `apps/web/src/main.tsx`, every UI module with a `format(…, "hybrid")` (`ItemRow`, `PowerDock`, `Drawer`, `TierReadout`, `derive`, `machines`, `preview`), `apps/web/src/ui/LaneView.tsx` and `Drawer.tsx` (memo dependencies), `apps/web/src/styles/base.css`

**Interfaces:**
- Consumes:
  - `format(value, mode)` and `NotationMode` (`engine numbers/format.ts:7,98`);
  - the `data-theme` rules in `tokens.css`;
  - Task 3's `StoreView.accounts/identity/account/auth` and `GameStore.signUp/signIn/signOut/sendReset/submitNewPassword`;
  - `AuthResult` and `ResetResult`.
- Produces:

```ts
// route.ts (S-10)
export type Route = { kind: "game" } | { kind: "handbook"; itemId: ItemId | null } | { kind: "reset-password" };
export function parseRoute(pathname: string): Route;      // trailing slash ok; decodeURIComponent; unknown → game
export function routePath(r: Route): string;
export function useRoute(): [Route, (next: Route) => void]; // pushState + popstate; replaces an unknown path with "/"

// notation.ts (S-11)
export const NOTATION_KEY = "mi.notation";
export function fmt(value: Dec): string;                  // format(value, current())
export function useNotation(): [NotationMode, (m: NotationMode) => void];
// theme.ts
export type ThemeChoice = "system" | "dark" | "light";
export const THEME_KEY = "mi.theme";
export function applyTheme(choice: ThemeChoice, root?: HTMLElement): void; // system removes data-theme
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void];

// Settings.tsx
export function Settings(p: { store: Pick<GameStore, "signUp" | "signIn" | "signOut" | "sendReset">; view: StoreView;
  section?: "account"; mode?: "sign-up" | "sign-in"; onClose(): void }): JSX.Element;
// ResetPassword.tsx
export function ResetPassword(p: { store: Pick<GameStore, "submitNewPassword">; onDone(): void }): JSX.Element;
```

**UI rules:**
- **The header** gets three 44 px buttons: "Handbook" (Task 5 wires it), "Settings" (opens the sheet), and, per S-12, the chip "Save your factory", which opens the sheet at `account`/`sign-up`. Below 600 px the title shortens to its initials ("MI") with the full name kept in `aria-label`, so the header fits at 320.
- **Forms:**
  - `<form>` with real labelled `<input type="email" autocomplete="email">` and `<input type="password" autocomplete="new-password|current-password">`;
  - each field error is `aria-describedby` from its input, and a form-level error is `role="alert"`;
  - submit is a `Guarded` button busy while `view.auth !== "idle"` or the promise is unsettled.
- **Sign-in** has "Forgot password?", which shows the email field and "Send reset link". It always answers "If that email has an account, a reset link is on its way."
- **`/account/reset-password`** renders `ResetPassword` instead of the panes, with the header and footer kept. On success it reads "Password changed." with a "Sign in" button that navigates to `/` and opens the sheet in sign-in mode. `invalid-token` reads "This link has expired or was already used. Ask for a new one."
- **Signed in:** "Signed in as <email>" or "Signed in", and a Sign out button. A parked token adds the line "A guest factory is kept on this device; signing out returns to it."

- [ ] **Step 1: Write the failing tests.**
  1. **`route.test.ts`:**
     - `parseRoute` over `/`, `/handbook`, `/handbook/`, `/handbook/iron_plate`, `/handbook/iron%5Fplate`, `/account/reset-password` and `/nope`;
     - `routePath(parseRoute(p))` round-trips the canonical ones.
  2. **`notation.test.ts`:**
     - `fmt` follows `useNotation`'s setter;
     - `mi.notation` persists, and a throwing `localStorage` falls back to `"hybrid"`;
     - **the source scan:** no `apps/web/src/**/*.{ts,tsx}` other than `notation.ts` and tests matches `/format\([^)]*,\s*"(sci|eng|names|short|doubled|hybrid)"\)/`.
  3. **`Settings.test.tsx`** (jsdom, `fakeStore` with the Task 3 fields):
     1. Settings opens as a `dialog` named "Settings", focus moves inside, Escape closes it, and focus returns to the Settings button.
     2. Choosing "Scientific" changes a lane row's `[data-stock]` text to `fmt` in `"sci"` without a new snapshot.
     3. "Light" sets `data-theme="light"` on `<html>` and stores it, and "System" removes the attribute.
     4. With `accounts: "off"` the Account section reads "Accounts aren't enabled on this server" and has no form.
     5. Sign-up calls `store.signUp("a@x.example", "password1")` once. A `field` result renders each error tied to its input by `aria-describedby`. `wrong-credentials` on sign-in renders a `role="alert"`. Submit is `aria-disabled` while pending.
     6. Signed in with `account.email` shows "Signed in as …", and Sign out calls `signOut`.
     7. **The chip** shows only for `accounts: "on"`, `identity: "guest"` and `state.tier >= 1`. It is absent on a fresh world, with a session, and with accounts off. Clicking it opens the sheet on the sign-up form.
     8. Forgot password calls `sendReset` and shows the generic text whatever the result.
     9. At `/account/reset-password?token=t`, `ResetPassword` submits `submitNewPassword("password2")`. `invalid-token` shows its text. `ok` shows "Password changed." and the Sign in button.
- [ ] **Step 2:** run the web tests. The new ones fail.
- [ ] **Step 3: Implement.**
  - Route `format` through `fmt`, and add the notation to the `laneRows`, `drawerModel` and `previewLines` memo keys.
  - `main.tsx` calls `applyTheme(stored)` before `createRoot`.
  - `App` switches on `useRoute()`.
  - `fakeStore` already has (from Task 3) `signUp`, `signIn`, `signOut`, `sendReset` and `submitNewPassword` mocks and the new view fields, defaulting to `accounts: "off"`, `identity: "guest"`, `account: null`, `auth: "idle"`; tests `set()` them.
- [ ] **Step 4:** run the web tests until they pass. The 4a/4b UI tests pass unchanged in substance.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - Leave one `format(x, "hybrid")` in `TierReadout`: the scan fails.
  - Drop the notation from `laneRows`' memo: test 3.2 fails.
  - Show the chip at tier 0: test 3.7 fails.
  - Don't return focus on close: test 3.1 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: routes, the settings sheet (notation, theme, account), sign-up and sign-in, the save-your-factory chip, password reset (W-1, W-3, W-16, W-17)`.

---

### Task 5: the handbook

**Files:**
- Create: `apps/web/src/ui/handbook.ts`, `apps/web/src/ui/glossary.ts`, `apps/web/src/ui/Handbook.tsx`, `apps/web/src/ui/Handbook.module.css`, `apps/web/src/ui/handbook.test.ts`, `apps/web/src/ui/Handbook.test.tsx`
- Modify: `apps/web/src/ui/App.tsx` (the third view, the detail pane, the header button), `apps/web/src/ui/Drawer.tsx` (the "Handbook entry" link)

**Interfaces:**
- Consumes, verified:
  - `computeExpansion(content, tier, activeRecipe)` with `.rawCost: Map<ItemId, Map<ItemId, number>>` (`engine graph/expand.ts:23-59`, exported through `graph/index.ts`);
  - `content.producersOf`, `.consumersOf`, `.recipes` (`IndexedRecipe.def`, `.machineClass`, `.inputPerSecond`, `.outputPerSecond`, `.primaryOutput`), `.defaultActiveRecipe` and `.lanes` (`graph/index-content.ts:20-59`);
  - `bestUnlockedMark(content, class, tier): number` (`economy/capacity.ts:61`);
  - `getMark` (`index-content.ts:65`);
  - `liquidCap(content, state, itemId)` (`economy/storage.ts:80`);
  - `RecipeDef.powerOutput` and `.unlockTier`, and `MarkDef.powerDraw` (`content/types.ts`);
  - Task 4's `useRoute` and `fmt`.
- Produces:

```ts
// handbook.ts (S-13)
export interface RecipeLine {
  recipeId: RecipeId; name: string; machine: string;
  inputs: { itemId: ItemId; name: string; perMin: string }[];
  outputs: { itemId: ItemId; name: string; perMin: string; byproduct: boolean }[];
  power: { kind: "draw"; mw: number; mark: string } | { kind: "output"; mw: number } | null;
  locked: boolean; unlockTier: number;
}
export interface HandbookEntry {
  itemId: ItemId; name: string; laneName: string; tier: number; locked: boolean; capText: string;
  madeFrom: RecipeLine | null;
  alternates: RecipeLine[];
  /** Recipes that make it only as a byproduct (heavy_oil_residue). */
  byproductOf: { recipeId: RecipeId; name: string }[];
  tracesBack: { itemId: ItemId; name: string; amountText: string }[];
  /** Names, raw first: ["Iron Ore", "Iron Ingot", "Iron Rod", "Screw"]. */
  chain: string[];
  /** Non-null when traced at the item's own tier with default recipes (a locked item). */
  tracedAt: { tier: number } | null;
  usedIn: { recipeId: RecipeId; name: string; outputItemId: ItemId; locked: boolean }[];
}
export function handbookEntry(content: IndexedContent, state: WorldState, itemId: ItemId): HandbookEntry | null;
export function searchItems(content: IndexedContent, state: WorldState, query: string):
  { itemId: ItemId; name: string; laneName: string; locked: boolean }[];
// glossary.ts
export const GLOSSARY: readonly { term: string; text: string }[];
// Handbook.tsx
export function Handbook(p: { snapshot: Snapshot; itemId: ItemId | null; onOpen(itemId: ItemId | null): void }): JSX.Element;
```

`state` is `snapshot.display.state` (the recipes in effect after unpins). Entries are memoised per snapshot, item and notation.

**UI rules:**
- **The index:** a `<input type="search" aria-label="Search the handbook">`, the item list (lane, then name; locked items dimmed with "tier N"), then the glossary as a `<dl>`.
- **An entry:** `<article aria-labelledby>` with `h2` name, an identity line, then "Made from", "Alternates", "Traces back to" (the chain as text, then the amounts), "Used in" (chip buttons) and "Back to the handbook".
- **Names ellipsize at 320**, and numbers sit in their own `.num` spans that never shrink.
- **Panes:** at one pane, "Handbook" is the third tab of the tab bar. At two and three panes the handbook renders in the detail pane in place of the drawer. Opening a row's drawer navigates to `/`.
- **The header's "Handbook" button** goes to `/handbook/<openItem>` while a drawer is open, else `/handbook`. The drawer's "Handbook entry" goes to its item.

- [ ] **Step 1: Write the failing tests.**
  1. **`handbookEntry` on `slice-tier-8.world.json`, `screw`:**
     - `madeFrom.recipeId === "make_screw"`, with input Iron Rod at `perMin === fmt(D(10))`, output Screw at `fmt(D(40))` (the authored per-minute rates), and machine "Constructor";
     - `power.kind === "draw"`, with the mark at `bestUnlockedMark` (3);
     - `alternates` has `alt_cast_screw` with `locked` and `unlockTier` 9;
     - `tracesBack` is `[Iron Ore, fmt(0.25)]`;
     - `chain` is `["Iron Ore", "Iron Ingot", "Iron Rod", "Screw"]`;
     - `usedIn` has 4 entries, with `alt_bolted_frame` locked;
     - `modular_frame` traces to 24 Iron Ore through a 5-name chain.
  2. **Locked and byproduct items:**
     - on a fresh world (`initialWorld(content, 1, 0)`, tier 0), `screw` has `tracedAt.tier === screw.tier` and a non-empty `tracesBack`;
     - `heavy_oil_residue` has `madeFrom === null`, `byproductOf` with the three refinery recipes, and an empty `tracesBack`;
     - `cable` has an empty `usedIn`;
     - an unknown id gives `null`.
  3. **The chain follows the player's recipes.** On tier 8 with `activeRecipe.screw = "alt_cast_screw"` (forced in a hand-built state with tier set to 9), `madeFrom.recipeId` is the alternate, and the chain and `tracesBack` change to its inputs.
  4. **`searchItems`:** "" gives all 32 in lane order; "iron" gives only names or ids containing "iron"; "IRON" is the same; locked flags follow `state.tier`.
  5. **`Handbook.test.tsx`** (jsdom, `App` over `fakeStore`, with a `window.history` spy):
     1. At one pane the tab bar has Factory, Priority and Handbook; selecting Handbook pushes `/handbook`, and the search filters the list.
     2. Clicking "Screw" pushes `/handbook/screw` and renders the entry. A "Used in" chip opens its output's entry, and `popstate` back returns to Screw.
     3. With the iron plate drawer open at three panes, the header's Handbook button opens `/handbook/iron_plate` in the detail pane.
     4. The glossary has a `<dt>` for each of "Bottleneck", "QS" and "BOUND".
- [ ] **Step 2:** run the web tests. The new ones fail.
- [ ] **Step 3: Implement** to the interfaces. The chain rule is S-13's, in one function.
- [ ] **Step 4:** run the web tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - Use `content.defaultActiveRecipe` instead of the state's: test 3 fails.
  - Pick the chain's first input instead of the largest raw total: modular frame's chain changes (test 1).
  - Drop the locked fallback: test 2's screw `tracesBack` is empty.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: the handbook: search, made from, traces back to, used in, glossary, context-aware entry (W-1 item 5, §13.4)`.

---

### Task 6: motion, announcements, and the carried UI minors

**Files:**
- Create: `apps/web/src/ui/motion.ts`, `apps/web/src/ui/motion.test.ts`, `apps/web/src/ui/Conveyor.tsx`, `apps/web/src/ui/use-tween.ts`, `apps/web/src/styles/motion.test.ts`
- Modify:
  - `ItemRow.tsx` / `.module.css` (sweep, tween);
  - `LaneView.tsx` / `.module.css` (conveyor);
  - `App.tsx` (bottleneck announcement, the dock ResizeObserver);
  - `Notices.tsx` and `base.css` (margin);
  - `BottleneckFrame.tsx` (`Guarded`);
  - `Drawer.tsx` (Move vs pending);
  - `use-pending.ts` (`held`);
  - `PriorityList.tsx` (scroll-safe midpoints);
  - `Layout.module.css` (`--dock-h`);
  - `PowerDock.test.tsx`, `LaneView.test.tsx` (the one-region test), `PriorityList.test.tsx`, `Drawer.test.tsx`

**Interfaces:**
- Consumes:
  - `display.solution.itemRates` (`production`);
  - `bottleneckRow(s)` (`derive.ts:254`);
  - `useAnnounce` (`announce.ts`);
  - `PendingRegistry` and `usePendingMap` (`use-pending.ts`);
  - `dropIndex` (`priority-model.ts:110`);
  - `Guarded` (`Guarded.tsx`).
- Produces:

```ts
// motion.ts (S-14)
export const TWEEN_MS = 300;
export const TWEEN_MIN_CHANGE = 0.01;
export function sweepPeriodS(productionPerSecond: number): number;          // clamp(0.8, 6 − 1.2·log10(1+p), 6)
export function conveyor(laneProductionPerSecond: number): { blocks: number; periodS: number };
/** log10(1 + x) space, f in [0, 1]; exact at both ends. */
export function tweenDec(from: Dec, to: Dec, f: number): Dec;
export function shouldTween(from: Dec, to: Dec): boolean;                   // |to/from − 1| > TWEEN_MIN_CHANGE, false for 0→0
// use-pending.ts
export interface PendingMap<V> { /* 4b */ held(key: string): boolean }
// PriorityList: DragStart.mids are document coordinates (rect.top + rect.height/2 + window.scrollY);
// dropIndex is called with e.clientY + window.scrollY.
```

- [ ] **Step 1: Write the failing tests.**
  1. **`styles/motion.test.ts`, the static motion rule (S-14).** For every `src/**/*.css`:
     - every `animation`, `animation-name`, `transition` and `transition-property` declaration sits inside `@media (prefers-reduced-motion: no-preference)`;
     - every `@keyframes` body names only `transform` and `opacity`;
     - no `transition` lists anything but `transform` and `opacity`.
     Parse the CSS with a small brace-depth scanner in the test; no dependency.
  2. **`motion.test.ts`:**
     - `sweepPeriodS(0) === 6`, `sweepPeriodS(9) ≈ 4.8`, `sweepPeriodS(1e9) === 0.8`;
     - `conveyor(0)` gives `{ blocks: 0 }`, `conveyor(1e12).blocks === 12`, and the period is monotone non-increasing in the sum;
     - `tweenDec(D(1e12), D(1e14), 0.5)` is within 1% of 1e13 (log space, not the linear 5.05e13), and `f = 0` / `f = 1` are exact;
     - `shouldTween(D(100), D(100.5))` is false.
  3. **Sweep and conveyor (jsdom).**
     - On tier 8, a producing, unpaused row's satisfaction meter has `style --sweep-period` equal to `sweepPeriodS(production)` and `data-sweep`. A paused row has neither.
     - The lane panel has exactly one `[data-conveyor][aria-hidden="true"]` with `data-blocks` ≤ 12, and its wrapper has `overflow: hidden` in the module CSS.
  4. **The tween (jsdom, a fake `requestAnimationFrame` and `performance.now`).**
     - Replace the snapshot with one whose iron plate stock is 100× the shown value.
     - At 150 ms the `[data-stock]` text is `fmt` of a value strictly between, near the log midpoint. At 300 ms it is the new value. No React render happened in between: count renders with a `Profiler`.
     - Under a reduce `matchMedia` stub it snaps at once.
  5. **Announcements (S-15).**
     - Render `App` on snapshot A (framed iron plate). The region says nothing.
     - `set` snapshot B, whose bottleneck is another item: the region's announcement is "Bottleneck: <B's text>" once.
     - `set` B again: nothing new is said.
     - A snapshot with no bottleneck says "No bottleneck".
  6. **One region, every state** (carried; widens LaneView 213). In each state there is exactly one `[aria-live]` in the document other than `aria-live="off"`, and every notice's text is inside it. The states:
     - idle;
     - offline (`status: "offline"`);
     - a tier-up toast;
     - a rejection;
     - a frameless bottleneck (`laneId: null`);
     - after a priority move's announcement.
  7. **The UI minors.**
     1. **`PriorityList`:** start a drag with stubbed rects, then set `window.scrollY = 200` and fire `scroll`. A `pointermove` at a `clientY` that is over row 3 in document coordinates drops at 3.
     2. **`BottleneckFrame`:** the spend button is `aria-disabled="true"` and not `disabled` while unaffordable. Focused while busy, it keeps focus, and a click while off doesn't call `send`.
     3. **`Drawer` Assign:** while a stepper's hold is pending, the "Move N idle …" button is `aria-disabled` and a click sends nothing.
     4. **The dock:** with a stub `ResizeObserver` reporting a dock height of 130, the `.layout` element's `--dock-h` is `130px`. Without `ResizeObserver` the CSS fallback is `6rem` (`Layout.module.css` test via the file text).
     5. **`Notices`:** no element under the region has an inline `style` except the visually hidden announcement.
     6. **`PowerDock` test 4:** the bottleneck mark must exist (`getByRole`, not `queryByRole` with an `if`), and `[data-frame]` must be present before the count.
- [ ] **Step 2:** run the web tests. The new ones fail. Test 1 may already pass, which is fine: it guards the new CSS.
- [ ] **Step 3: Implement.**
  - **The sweep:** `--sweep-period` on the meter, and `.sat[data-sweep]::after` with `@keyframes sweep { from { transform: translateX(-100%) } to { transform: translateX(100%) } }`, inside the media query.
  - **The conveyor:** `Conveyor` renders `blocks` spans in a strip twice the panel's width, animated `translateX(0 → -50%)` over `periodS`.
  - **The tween:** `useTween(spanRef, snapshot, itemId, now)` keeps the previous snapshot in a ref.
  - **The announcement:** an effect on the framed item's id, with a "first snapshot seen" ref.
  - **The dock:** `--dock-h: 6rem` in CSS, and a `ResizeObserver` in `App` on `[data-dock-slot]` sets `layoutEl.style.setProperty("--dock-h", h + "px")`.
  - **`Notices`:** the toasts go in a `.notice-list` child (`:empty { display: none }`, margin on it), and the inline style goes.
  - **`SpendButton`:** on `Guarded` with `off={busy || !a.affordable}` and `aria-busy`.
  - **Assign:** `off={sec.assign.some((r) => pend.held(keyOf(r.recipeId)))}`.
  - **The drag:** scroll-safe midpoints.
  - Update `LaneView.test.tsx` and the 4a e2e only where they asserted the native `disabled` (`toBeEnabled` already honours `aria-disabled` in Playwright).
- [ ] **Step 4:** run the web tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - Add `width` to the `sweep` keyframes: test 1 fails.
  - Move the conveyor's `animation` outside the media query: test 1 fails.
  - Interpolate linearly in `tweenDec`: test 2 fails.
  - Announce on first load: test 5 fails.
  - Restore client-coordinate midpoints: test 7.1 fails.
  - Native `disabled` on `SpendButton`: test 7.2 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: production sweep, number tweens, the conveyor, bottleneck announcements, a static motion rule, and the carried UI minors (W-18, W-20)`.

---

### Task 7: the deploy example, the source link, and the 4c e2e

**Files:**
- Create: `infra/Caddyfile`, `apps/web/scripts/build-info.ts`, `apps/web/scripts/build-info.test.ts`, `apps/web/src/build-info.d.ts`, `apps/web/src/ui/Footer.tsx`, `apps/web/src/ui/source-link.ts`, `apps/web/src/ui/source-link.test.ts`, `apps/web/e2e/layout-320.spec.ts`, `apps/web/e2e/reduced-motion.spec.ts`, `apps/web/e2e/accounts.spec.ts`
- Modify: `apps/web/vite.config.ts` (`define`), `apps/web/vitest.config.ts` (include `scripts/**/*.test.ts`), `apps/web/tsconfig.node.json` (include `scripts/**/*.ts`), `apps/web/playwright.config.ts` (`DEV_FAKE_SESSIONS: "1"`), `apps/web/e2e/helpers.ts`, `apps/web/src/ui/App.tsx` (the footer), `README.md`, `infra/README.md`

**Interfaces:**
- Consumes:
  - Vite's `define` and `build.sourcemap` (`vite.config.ts`, already `true`);
  - Playwright's `page.emulateMedia({ reducedMotion })`, `page.route`, `request.get`, `page.on("request")`, and `test.use({ viewport })`;
  - Task 2's `GET /auth/dev/reset-link`.
- Produces:

```ts
// scripts/build-info.ts (Node only; imported by vite.config.ts)
export interface BuildInfo { commit: string | null; dirty: boolean; repo: string }
export function buildInfo(env?: Record<string, string | undefined>, git?: (args: string[]) => string | null): BuildInfo;
// src/build-info.d.ts
declare const __BUILD_INFO__: { commit: string | null; dirty: boolean; repo: string };
// ui/source-link.ts
export function sourceLinks(info: BuildInfo | undefined): { source: { href: string; text: string }; license: { href: string } };
// e2e/helpers.ts
export async function expectNoOverflow(page: Page, label: string): Promise<void>; // S-16's two checks + 44 px targets
export async function signUpThroughSettings(page: Page, email: string, password: string): Promise<void>;
```

- [ ] **Step 1: Write the unit tests.**
  1. **`build-info.test.ts`:**
     - `SOURCE_COMMIT` wins over `GITHUB_SHA`, which wins over git;
     - a non-40-hex value is skipped;
     - `dirty` is true only for a git-derived commit with porcelain output;
     - git failing (null) gives `commit: null`;
     - `SOURCE_REPO` overrides the default.
  2. **`source-link.test.ts`:**
     - with a commit: `${repo}/tree/<sha>` reading "Source, <sha7>" ("modified from <sha7>" when dirty), and the license at `${repo}/blob/<sha>/LICENSE`;
     - with `undefined` or a null commit: the repo root, and `${repo}/blob/main/LICENSE`.
- [ ] **Step 2:** run them. They fail. Then implement `build-info.ts`, `source-link.ts` and `Footer` (`<footer>`: "Free software under the GPL-3.0 · <a>Source, abc1234</a> · <a>License</a>", above the dock reservation, wrapping at 320). Wire `define: { __BUILD_INFO__: JSON.stringify(buildInfo()) }`. Run until green.
- [ ] **Step 3: Write `infra/Caddyfile`** (S-17), with a header comment that it is an example, not hosting:

```caddyfile
{$SITE_ADDRESS:localhost:8443} {
	encode zstd gzip

	@backend path /api/* /auth/*
	handle @backend {
		reverse_proxy {$API_UPSTREAM:127.0.0.1:8080}
	}

	handle {
		root * {$WEB_ROOT:/srv/manufactory/web}
		@hashed path /assets/*
		header @hashed Cache-Control "public, max-age=31536000, immutable"
		@pages not path /assets/*
		header @pages Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}
```

  `infra/README.md` gains a "Deploying (example)" section:
  - build with `SOURCE_COMMIT=$(git rev-parse HEAD) pnpm --filter @manufactory/web build`, and copy `apps/web/dist` to `WEB_ROOT`;
  - run the API with `HOST=127.0.0.1 PORT=8080 TRUST_PROXY=127.0.0.1 API_DOMAIN=WEBSITE_DOMAIN=https://<site>`, plus the account variables;
  - check the file with `caddy validate --config infra/Caddyfile --adapter caddyfile` where Caddy is installed (not part of CI).
- [ ] **Step 4: Write the specs.** Each test is a fresh context (a fresh guest). `playwright.config.ts`'s API `webServer` gets `env: { PORT: "8787", DEV_FAKE_SESSIONS: "1" }`.
  1. **`layout-320.spec.ts`**, `test.use({ viewport: { width: 320, height: 640 } })`. `expectNoOverflow` on each of these:
     - Factory on each unlocked lane tab (iron, power);
     - the iron plate drawer sheet open;
     - Priority in Simple, then in Advanced;
     - the handbook index;
     - the "Encased Industrial Beam" entry (the longest name, found by `probe4c-handbook.mts`);
     - the settings sheet;
     - the sign-up form with a field error (submit `"x"` as the email);
     - `/account/reset-password?token=bogus`;
     - a rejection toast (a `page.route` that fulfils one `POST /api/actions` with 409, then a priority Alt+↓).

     Then:
     - the footer's source link `href` matches `/\/tree\/[0-9a-f]{40}$/`;
     - **source maps:** read the entry script's `src` from the page, then `request.get(src + ".map")` is 200 with a JSON `sources` array.
  2. **`reduced-motion.spec.ts`:**
     - with `page.emulateMedia({ reducedMotion: "reduce" })` before `goto`: after ready, `document.getAnimations().filter((a) => a.playState === "running").length === 0`, the frame's "bottleneck" label is visible, and `[data-conveyor]` is present but has no running animation;
     - then in a new page without the emulation: the running count is > 0, and among them is the pulse (`animationName === "pulse"`, for a `CSSAnimation`).
  3. **`accounts.spec.ts`:**
     - **Guard:** `GET /api/health` has `accounts: true`, else fail with "start the API with DEV_FAKE_SESSIONS=1 (reuseExistingServer)".
     - **Guest with progress:** start, Alt+↓ on a priority item, and wait for `data-state-version="1"`. Record the token.
     - **Sign up, claim first:** log every request. `signUpThroughSettings(page, "e2e-<ts>@example.com", "password1")`.
       - The first request after the `/auth/signup` response whose path starts `/api/world`, `/api/actions` or `/api/auth/claim` is `POST /api/auth/claim`.
       - The `/auth/signup` request carried an `fdi-version` header (S-1's pin ran).
       - `localStorage["mi.guestToken"]` is gone, `data-state-version` is still "1", and later `/api/world` requests have no `authorization`.
     - **Reload stays signed in:** no `POST /api/guests`, the same state version, and the sheet says "Signed in".
     - **Sign out → a new guest:** one `POST /api/guests`, `data-state-version="0"`, and a new token.
     - **Sign in again → 409 parks:** `mi.parkedGuestToken` equals the new guest's token, the account's world loads (version "1"), and `[data-notice="account-has-factory"]` is shown.
     - **Sign out → back to the parked guest:** `mi.guestToken` is that token again, parked is empty, and the version is "0".
     - **Reset:**
       - "Forgot password?", then send;
       - `request.get("/auth/dev/reset-link?email=…")`, `page.goto(link)`, set "password2";
       - "Password changed.";
       - sign in with "password2" succeeds, and with "password1" shows the wrong-credentials alert.
- [ ] **Step 5: Run the e2e.** `pnpm --filter @manufactory/web exec playwright install chromium`, then `pnpm --filter @manufactory/web e2e`, in the foreground. All specs, 4a's and 4b's included, must pass.
  - A local API already running without the flag is reused (`reuseExistingServer`): stop it by its own terminal, never with `pkill -f`.
  - If Chromium can't be installed here, say so in the report, and the CI `web-e2e` job is the proof.
- [ ] **Step 6: Mutation checks, if the specs ran.** Each is undone by hand.
  - Drop the `#held` check (Task 3): the accounts spec's order assertion fails, or the claim is 409.
  - Remove `overflow: hidden` from the conveyor wrapper: the 320 spec fails on the lane view.
  - Move the pulse's `animation` out of its media query: the reduced-motion spec sees a running animation.
- [ ] **Step 7: README.** In the root `README.md`:
  - accounts in local play (`DEV_FAKE_SESSIONS=1 pnpm --filter @manufactory/api dev`, "never in production");
  - the handbook, the settings and the GPL footer;
  - a pointer to `infra/README.md`'s deploy example;
  - the Phase 4 status line becomes "Phase 4 complete" only if every spec passed in Step 5, else "in review".
- [ ] **Step 8:** run `pnpm test`, `pnpm lint` and `pnpm typecheck` in the foreground, in that order. Commit: `Web: the Caddyfile example, the GPL source link at the built commit, public source maps; e2e for 320 px, reduced motion and accounts (W-19, W-23, W-25)`.
