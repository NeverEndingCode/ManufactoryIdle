# Phase 4 — the web client

**Implements:** engine spec Section F (F.1's five surfaces) and build order F.2, phase 4: "Web
client against the real API from its first render" — *a game other people can play*.
**Builds on:** `main` at 8994558 (Phase 3a–3c merged, `apps/api`).
**Status:** design, 2026-10-17. Written under the user's standing instruction to work through
the milestones; every design call is a **Ruling** (W-n) with its reason and what it costs if
wrong. The engine spec supersedes the original spec where they disagree; where this spec departs
from either, the ruling says so.

---

## What exists, and what it means for a browser

Citations are to `main` at 8994558.

- **The API** (`apps/api/src/server.ts`): `GET /api/health` (:176), `POST /api/guests` (:178),
  `GET /api/world` (:184), `POST /api/actions` (:203), `POST /api/auth/claim` (:229), and the
  admin route. A world comes back as `{ state, schedule, stateVersion, contentChecksum }`
  (`worldView`, :83), plus `summary` from `POST /api/actions`. `state` is
  `JSON.parse(serializeWorld(state))`, so the client reads it back with `deserializeWorld`.
- **No content route.** Nothing serves the bundle. Worlds pin a checksum (R-4) and keep it
  until an admin re-pin, so after any content deploy, existing worlds run on older content than
  a client built with the new bundle.
- **`@manufactory/content` cannot load in a browser.** Its barrel re-exports `loadBundleDir`
  (`node:fs`, `load.ts:2`) and `bundleChecksum` (`node:crypto`, `checksum.ts:5`). The engine
  doesn't need it: it declares its own `ContentBundle` (`engine/src/content/types.ts:3`), and
  `indexContent(bundle)` takes plain JSON. The engine and `rational` import nothing from `node:`
  outside tests. `rational` uses BigInt.
- **The schedule** (`engine/src/resolve/index.ts:250-306`) carries **only** liquid stock and net
  rate per stock item, plus `nextBoundaryAtMs`. Split bars (`Solution.allocations`), the
  bottleneck, power (`Solution.power`), satisfaction (`Solution.entries`) and storage tiers are
  not in it. `schedule` builds them from a state it advanced past internal unpins (:280), but
  it neither returns that state nor its `solve`.
- **The deferred EPSILON boundary is real.** Measured on
  `engine/src/resolve/fixtures/slice-tier-8-reinforced-full.world.json`: walking the schedule
  for 39 s gives 200 boundaries, 199 of them under 100 ms and the smallest 1e-6 ms. On
  `slice-tier-8.world.json` the median gap is 37 s. A client that re-fetches at every boundary
  would hammer the API.
- **Display costs are small** (Node 22, this machine): `solve` on the tier-8 fixtures 2.0 ms,
  `schedule` 1.4–2.0 ms, `indexContent` on the slice 1.1 ms, a cold `computeExpansion` 0.7 ms,
  interpolating all 32 stock items once 3.4 µs. The slice bundle is 29 KB of JSON. BigInt is
  only on the indexing/expansion path, which is cached. **Exact rationals are not on the frame
  path, and neither is anything else that costs more than microseconds.**
- **`GET /api/world` never persists** (R-11) and returns no `summary`. Its resolve runs from the
  last *action*, capped at `offlineCapMs` (8 h on the slice; `resolve`:386, :465). An open tab
  that only watches therefore plateaus 8 h after the last action, and no response says when
  that action was.
- **Auth** (`apps/api/README.md`, `auth/supertokens.ts:125-152`): `Authorization: Guest
  <token>`, or a SuperTokens session (cookie or header mode; `Session.init()` takes the
  defaults). CORS (origin `WEBSITE_DOMAIN`, credentials) exists **only when accounts are on**
  (R-16). `apiBasePath` is `/auth`, and SuperTokens' default `websiteBasePath` is also `/auth`.
  Nothing tells a client whether accounts are enabled.
- **Limits** (`server.ts:107`): one bucket per player for `GET /api/world` *and*
  `POST /api/actions`, 30 burst, 3/s. `429 {"error":"rate-limited"}` with `Retry-After`;
  `503 accounts-unavailable` with `Retry-After: 5`. `409` bodies are
  `{ failedAction, index, reason }` with **no state** (`worlds.ts:227`). Idempotency keys are
  per player, kept 24 h, and replay the stored response, 409s included. `baseVersion` is
  advisory (`actions-schema.ts:55`).
- **The tap**: `count` is clamped to `floor(clientElapsedMs / 50)` (`TAP_MIN_INTERVAL_MS`,
  `economy.ts:16`); the server first caps `clientElapsedMs` to its time since the last TAP batch
  (`capTaps`, `worlds.ts:157`). Every TAP, `count: 0` included, refreshes the one shared expiry to
  `now + durationSeconds` (:191). On the slice: 10 stacks max, +5% each, 30 s.
- **The closest client**, `apps/sim/src/commands.ts`, calls `solve` after every action and
  renders lanes from `liquid`, `liquidCap`, `itemStateTag`, `state.bound` and `format(…,
  "hybrid")` (:214-235), and the handbook trace from `computeExpansion(…).rawCost` (:293).
- **The monorepo**: pnpm + turbo; every package's `build` is `tsc --noEmit` and turbo's `outputs`
  are `[]`; ESLint is configured for Node globals only; CI has `check`, `pacing` and
  `api-integration` jobs, and no browser. `apps/api`'s `main` is `src/main.ts`, which starts a
  process when imported.

## Decomposition (three PRs)

| PR | Scope | Ends in |
|---|---|---|
| **4a** | `apps/web` shell, the API and engine additions (W-5, W-8, W-15, W-26), the sync core (W-6 to W-12), guest start, the lane view with storage/QS/BOUND, split bars and the bottleneck frame (its inline buy sends the advised `BUY_MACHINE`), the e2e harness | A stranger opens the page, gets a guest factory from the real API, watches it run, and buys from the bottleneck frame |
| **4b** | Buy drawer (projection, ladder progress, `UPGRADE_MARK`, dismantle, storage/QS, recipe select/assign), priority list (drag, Simple/Advanced, pinned power, reserves), power dock and holdable tap | Every D.1 action is reachable; the slice is playable to tier 10 in a browser; per plan Q-14 the tier-10 proof runs in process (the `web-play` job), with the browser covering the flows via e2e |
| **4c** | Handbook, accounts (sign-up/in, claim, sign-out, password reset), motion polish (sweep, number tweens, conveyor), the a11y and 320 px pass, deploy example, source link | Other people can play, sign up, and keep their factory |

Each PR is its own plan and its own subagent-driven run.

---

## Scope

**W-1. Scope is F.1's five surfaces, plus what it takes to be played.** In scope:

1. **Lane view** (§13.1): lane tabs; per item, name, net rate, satisfaction bar; the storage bar
   (`liquid / liquidCap`) with **QS** and **BOUND** chips only when non-zero (F.1's three-line
   row); split bars on contested items; exactly one bottleneck frame per lane (§4.5).
2. **Buy drawer**: machine class and mark, cost, **projected effect**, **ladder progress**
   ("12 more Constructors → ×1.5"), **`UPGRADE_MARK`** with its consolidation ("45 Mk1 → 15 Mk2"),
   plus dismantle, storage and QS levels, recipe select and assign (every D.1 action needs a
   home, and §13.1 says a row opens buy/upgrade for its machines *and* its storage).
3. **Priority list** (§13.3): drag reorder with live satisfaction, Simple/Advanced toggle
   (Advanced shows mode, share, target rate, pause and reserve inline), power pinned at 1,
   movable behind an explicit warning (C.4).
4. **Power dock and tap** (§13.2): demand against capacity, the holdable tap, stacks and the
   kick's remaining time (C.6).
5. **Handbook** (§13.4): search, made from, **traces back to**, used in, a short glossary.

Also: **guest start**, **sign-up/sign-in with claim**, a **header tier readout** (current tier,
next milestone's requirement from `nextMilestoneCost`; without it tiers are invisible), and a
**settings sheet** (notation, theme, account).

**Not "while you were away".** The API doesn't support it: `GET /api/world` returns no
summary, and `POST /api/actions`' summary only covers time since the last action, and arrives
after the player has acted. See open question 2.

**Out of scope:** §13.5's other screens (Pioneers, contracts, milestone tree, expeditions,
leaderboards), the Power detail screen, statistics (§13.7), PWA, service worker, install sheet
and push (§13.8, Spec 4), Discord/GitHub sign-in (W-16), list virtualization (W-19), production
hosting (W-25), i18n, and any game logic in the client beyond display.
*Cost if wrong:* a surface added later is additive; none of these change the sync core.

**W-2. One origin.** The client and the API are always served from a single origin: in dev, Vite
proxies `/api` and `/auth` to the API; in production, a reverse proxy serves `apps/web/dist` and
forwards `/api` and `/auth` (W-25). *Why:* with accounts off the API sends no CORS headers
(R-16), so a cross-origin client cannot work in guest-only mode at all; on one origin, cookies
are first-party and `SameSite=Lax`, so SuperTokens' default anti-CSRF is `NONE` and the client
sends no anti-CSRF header, and nobody has to configure `WEBSITE_DOMAIN` against a second host.
Set `API_DOMAIN = WEBSITE_DOMAIN =` the origin. *Cost if wrong:* a split deployment later needs
accounts on (for CORS) and the SDK's `rid`/anti-CSRF header, which supertokens-web-js already
sends (W-15).

## Stack

**W-3. Vite + React 18.3 + TypeScript in `apps/web`; no router, no state library, no CSS
framework.** This departs from §12.1's Tailwind, Zustand and TanStack Query:
- **State** is one framework-free `GameStore` (W-6) read through `useSyncExternalStore`.
  TanStack Query's model (cache by key, refetch on staleness) fights this one (snapshots
  ordered by version, refetch at schedule boundaries, a single-flight outbox), and Zustand would
  only wrap the store.
- **Styling** is plain CSS with custom properties and Vite's built-in CSS modules. §13.0 is a
  dozen tokens and §13.6 is a handful of keyframes; the MVP (`manufactory-idle-mvp.html`) is
  already that.
- **Routing** is a `location.pathname` switch over three paths (`/`, `/handbook/:item`,
  `/account/reset-password`). Panes and sheets are state, not routes.
- **React 18.3**, matching `apps/sim`'s pin, so the workspace carries one React (Ink 5 needs 18).

Runtime dependencies: `react`, `react-dom`, `supertokens-web-js`. Dev: `vite`,
`@vitejs/plugin-react`, `@types/react(-dom)`, `@testing-library/react`,
`@testing-library/user-event`, `jsdom`, `@playwright/test`, `eslint-plugin-react-hooks`.
*Cost if wrong:* the store is behind one hook, so adopting a library later touches the hook,
not the components.

**W-4. The engine is consumed as TypeScript source; `@manufactory/content` is never imported by
browser code.** `@manufactory/engine` exports `./src/index.ts`, which Vite compiles like the
client's own code. The client imports `indexContent`, `deserializeWorld`, `schedule` (via W-8),
`solve`, `apply`, `liquid`, `liquidCap`, `itemStateTag`, `quantumCap`, `storageCap`,
`machineCostRange`, `levelCostRange`, `ladderInput`, `ladderMultiplier`, `bestUnlockedMark`,
`isLiveRecipe`, `computeExpansion`, `nextMilestoneCost`, `format`, `D`, `fromCanonical`,
`POWER_ENTRY_ID`, `MAX_RESERVE_PERCENT`. Build target `es2022` (BigInt literals; matches
`tsconfig.base.json`). An ESLint rule forbids `@manufactory/content` under `apps/web/src`.
*Cost if wrong:* if Vite trips on the source export, a `tsc` emit step for the engine is a
turbo `outputs` change.

**W-5. Content comes from the API, by checksum.** New route **`GET /api/content/:checksum`**:
unauthenticated, returns `content_versions.bundle` for that checksum, `404` if unknown,
`Cache-Control: public, max-age=31536000, immutable` (a checksum's bundle never changes). The
client fetches the checksum named by the world response (prefetching `/api/health`'s current
one in parallel on first load), indexes it with `indexContent`, and keeps indexed bundles by
checksum in memory. A response whose `contentChecksum` changes (an admin re-pin) loads the new
bundle before the snapshot is shown. *Why not bundle the slice into the client:* every world
pinned to an older checksum would be drawn with the wrong numbers, and a client deploy would
have to be lockstep with the server's content. The route reads a row the server already has.
*Cost if wrong:* one route; content is GPL source anyway, so serving it publicly leaks nothing.

## Sync model

```
first load ─► health ║ world ─► content(checksum) ─► snapshot ─► render
                                                       │
     ┌────────────── interpolate stock + net·t ◄────────┤   (no network, no solve)
     │                                                 │
     │  boundary+250ms (≥ MIN_REPOLL, backoff) ─► GET ─►│
     │  visible / focus / online ───────────────► GET ─►│
     │  user intent ─► outbox (one in flight) ──► POST ►│   409 ─► GET
     └─ taps ─► accumulator ─► flush (≤ 1/s) ───► POST ►┘
```

**W-6. A snapshot store, ordered by version then time.** A snapshot is `{ state, schedule,
stateVersion, contentChecksum, receivedAt }` plus its display derivation (W-8). A response is
adopted only if `(stateVersion, schedule.atMs)` is not older than the current snapshot's, so a
`GET` that started before a `POST` and lands after it is dropped. **Server time** is
`schedule.atMs + (performance.now() − receivedAt)`: `atMs` is the server's "now" for that
response (a resolve sets `lastResolvedAt` to the full elapsed, `resolve`:465), and the
monotonic clock ignores device clock changes. The error is at most one round trip, which is
invisible at display precision. *Cost if wrong:* none to correctness; the server never reads it.

**W-7. Interpolation: straight lines, clamped, drawn cheaply.** For each stock item,
`shown(t) = clamp(stock + net × (t − atMs) / 1000, 0, liquidCap)`, in `Dec`, with `liquidCap`
from the snapshot's state. The clamp makes a fill or drain that lands before the next fetch
look right, and keeps the EPSILON cycle (W-9) from drawing negative stock. Interpolation stops
at `nextBoundaryAtMs` only in the sense that the next snapshot replaces it; the clamp covers the
gap. Text updates at 4 Hz from one shared interval, for the visible lane, the dock and the
open drawer only. Storage bars don't run in JavaScript at all: each snapshot gives every bar one
CSS `transform: scaleX()` transition from its fraction now to its fraction at
`min(time to full/empty, nextBoundaryAtMs)`, with that duration and `linear` timing, so the
compositor draws it (D5). QS and BOUND chips show the snapshot's `quantum` and `bound`; they
change only by spend, refund or bound settling, which come with a response or a boundary. On
a new snapshot, displayed numbers tween to the new value over 300 ms in log space (§13.6).
*Cost if wrong:* a visible correction at each snapshot, which the tween softens.

**W-8. One display solve per snapshot; the client never resolves.** D5's rule is "the client
solves zero times in steady state". Here, *steady state* is between responses: per snapshot,
and only then, the client computes the solution behind what the schedule doesn't carry (split
bars from `allocations`, satisfaction from `entries`, the bottleneck, `power`, item state tags).
For that solution to match the server's rates, it has to be the solve of the state `schedule`
advanced past its unpins, so the engine gains:

```ts
/** schedule(), plus the advanced state and its solve. schedule() becomes its .schedule. */
export function scheduleDetail(state: WorldState, content: IndexedContent):
  { schedule: Schedule; state: WorldState; solution: Solution };
```

The client calls it on the response's state. **Rates and the boundary always come from the
server's `schedule`**; the client's own copy is used only for the solution, so a last-bit
difference in `Math.pow` between V8 and JavaScriptCore can't move a number on screen. The
client never calls `resolve` to advance time and never shows an `apply` result as truth. The
one other use of the engine is previews (W-13). Cost, measured: ~2 ms per snapshot on the tier-8
fixtures. *Why not have the API return the solution:* the buy drawer's projected effect needs a
client-side `apply` + `solve` anyway (§16.6, F.1), so the solver ships to the browser
regardless, and the response stays the engine's own wire format. *Cost if wrong:* if the full catalog makes `solve` slow on a phone, move the display
solve to a worker or into the response; the store's interface doesn't change.

**W-9. When to re-fetch.** `GET /api/world`:
- at `nextBoundaryAtMs + 250 ms`, mapped to local time (the 250 ms keeps a fetch from landing
  just before the server's clock reaches the boundary);
- **never sooner than `MIN_REPOLL_MS = 5_000` after the previous snapshot** (the Phase 3
  deferred item). When three snapshots in a row each report a boundary less than 1 s ahead (a
  pin/unpin cycle, as measured above), the interval doubles, 5 → 10 → 20 → 40 → 60 s, and
  resets on any action or on a boundary at least 1 s ahead;
- on `visibilitychange` to visible, `focus` and `online`, when the snapshot is older than
  `MIN_REPOLL_MS`;
- never on a timer otherwise. A `null` boundary means no requests while the player watches (D5:
  an idle open tab costs zero requests), apart from a guard: one fetch at
  `persistedAtMs + offlineCapMs` if open question 1 adds that field.

While hidden, the store stops its 4 Hz interval and boundary timer, and the root gets a class
that pauses every CSS animation. A `POST` response is a full snapshot, so actions never trigger a
`GET`, except after a `409`. *Cost if wrong:* the constants are named; the cost of the backoff
is that a cycling item is drawn from an older rate for up to a minute, inside the clamp.

**W-10. The outbox: one in flight, one batch per intent, one key per batch.** Every user intent
(a buy, an upgrade, a reorder) becomes one batch, queued FIFO; one request is in flight at a
time, which is what the row lock does on the server anyway. The idempotency key is made when
the batch is **queued** (`crypto.randomUUID()`, falling back to `crypto.getRandomValues` where
there's no secure context, such as a phone on LAN dev) and reused for every retry of that
batch. `baseVersion` is the current snapshot's `stateVersion`. Batches are never merged: D.1
batches are atomic, so a merged batch would let an unaffordable fifth click reject the four
before it. Bulk buys are one action with `count` (×1, ×10, ×max), not many clicks. The outbox is
in memory only; a batch lost to a tab close is simply not applied, and the next load shows the
server's truth. *Cost if wrong:* a reload in the instant after a click loses that click, and the
player sees that it didn't happen.

**W-11. Errors, by status.**

| Status | Meaning | Client |
|---|---|---|
| 200 | Applied (or a replayed key) | Adopt the snapshot (W-6) |
| 409 | `{ failedAction, index, reason }`, nothing applied | Drop the batch; revert any optimistic control (W-13); a toast with `reason`; `GET` to re-sync |
| 429 | `Retry-After` seconds | Pause the outbox **and** polling until then (they share one bucket); then resend with the same key |
| 503 | `accounts-unavailable`, `Retry-After: 5` | As 429, plus a banner "accounts are unavailable"; a guest's own requests don't hit this |
| network error, 5xx | Unknown whether it committed | Resend with the **same key**: a committed batch replays its stored response. Backoff 1, 2, 4 … 30 s; an "offline" banner after the second failure; `online` retries at once |
| 400 | A client bug (schema) | Drop the batch, log it, re-sync, generic toast |
| 401 | Identity is gone | W-14 / W-16 |
| 404 | `no world` | Re-sync once; on repeat, the identity flow |

*Cost if wrong:* a status mishandled shows as a stuck outbox, which the e2e suite injects (W-23).

**W-12. The tap: count locally, flush on a debounce.** A press or a hold starts a 10 Hz repeat
(inside the 50 ms floor); each tap bumps a local counter. A flush sends
`TAP { count, clientElapsedMs }` as its own batch, at most once per second while tapping, 300 ms
after release, and on `pagehide` / hidden with `fetch(…, { keepalive: true })`.
`clientElapsedMs` is `performance.now()` since the previous flush was sent (since load, for the
first). That way a single tap after a pause carries enough elapsed time to count, and the
server's ceiling (R-19) bounds it anyway. A flush never sends `count: 0`, since a zero tap still
refreshes the expiry (`economy.ts:191`). Taps are never merged with spends, so a rejected purchase
can't throw taps away. The dock shows stacks and the remaining kick optimistically (`min(maxStacks,
stacks + pending)`, expiry 30 s from the last tap), corrected by the response. With 10 stacks and a
30 s expiry, holding is "keep the kick full", which is the honest reading of C.6. *Cost if wrong:*
a lost flush costs at most one second of taps.

**W-13. Optimism: spends wait for the server; settings move at once.**
- **Spends** (`BUY_MACHINE`, `UPGRADE_MARK`, `DISMANTLE`, `BUY_STORAGE`, `BUY_QS`) are
  **pessimistic**. The button shows pending, and the numbers change when the response lands
  (~1 RTT). Showing a purchase the server then refuses is the worst kind of correction in a game
  whose pillar 4 is "every purchase must visibly help". The drawer's projection is what makes the
  wait informative.
- **Settings** (`REORDER_PRIORITY`, `SET_PRIORITY_MODE`, `SET_RESERVE`, `SELECT_RECIPE`,
  `ASSIGN_MACHINES`) cost nothing and can only fail validation. Their *controls* are optimistic:
  the dragged row stays where it was dropped, the chip shows the new mode. The *numbers* (split
  bars, satisfaction) update from the response. A 409 reverts the control.
- **Affordability** is shown from interpolated liquid plus the snapshot's `bound`, with an
  "affordable in 1m 20s" countdown from the straight line. The server decides; a 409 at the edge
  is an ordinary rejection.
- **Previews** (projected effect, the `UPGRADE_MARK` consolidation) apply the action to a copy
  of the snapshot state, with the action's cost first credited to `bound` (builds spend `bound`
  first, C.5, and `bound` changes no rate). Then `scheduleDetail` on the result gives the projected
  rates, diffed against the current ones. That reuses the real reducers (A.2), auto-assignment
  included, without bypassing the affordability check in the engine. A test pins that the credit
  is spent exactly.

*Cost if wrong:* if a later reducer reads `bound` for rates, previews drift; that test catches it.

## Auth

**W-14. Guests: created on first load, token in `localStorage`.** With no token and no session,
the client calls `POST /api/guests` on first render (D7: no wall in front of the first click) and
stores `guestToken` under `mi.guestToken`. Every request then carries
`Authorization: Guest <token>`, **unless a session exists**, in which case the header is omitted
(R-13 would ignore it anyway; omitting it keeps the two identities from mixing). Storage access is
wrapped: where `localStorage` throws (some private modes), the game runs on an in-memory token
behind a banner, "this factory will be lost when the tab closes". A `401` on a guest token means
the 30-day cleanup deleted it: the client says so and offers a new factory. A `429` from
`POST /api/guests` (5/hour/IP) shows a retry with the `Retry-After` countdown. *Cost if wrong:*
XSS could read the token. That's D.3's design, and a guest token is worth one guest world.

**W-15. `supertokens-web-js`, cookie mode; not `supertokens-auth-react`, not plain fetch.**
Plain fetch would mean re-implementing the SDK's work: refresh on `401 try refresh token`
(`/auth/session/refresh`, then retry), the front-token header, `rid`, and sign-out cleanup.
`auth-react` brings its own UI and styling, which would fight §13.0. `web-js` is the
framework-free core (EmailPassword + Session recipes). It patches `fetch` for the API domain, so
the client's own `fetch` calls get refresh for free. Cookie mode keeps the `Authorization` header
free for the guest token. The SDK is initialized only when **`GET /api/health` reports
`accounts: true`**. That field is new (it's `accounts !== undefined` in `buildServer`), because
nothing else tells a client whether `/auth/*` exists. The version is pinned to the one that
`supertokens-node` 24's FDI compatibility table lists, checked at install. *Cost if wrong:* the
SDK is behind `src/auth/`; swapping it touches that module.

**W-16. Claim before the first session read; never lose a guest world.** Sign-up and sign-in
(EmailPassword) run in a sheet. On success, **before any `GET /api/world` under the session**
(which would lazily create an account world and make the claim a 409, D.4/R-14):
- with a stored guest token → `POST /api/auth/claim { guestToken }`:
  - **200**: the response is the world; delete the token;
  - **404 `unknown-guest`**: delete the token, then `GET`;
  - **409 `already-has-world`**: move the token to `mi.parkedGuestToken` and load the account's
    world, with a notice: "this account already has a factory; your guest factory is kept on this
    device: sign out to return to it". Signing out restores the parked token. Nothing is deleted,
    because §16.6 calls progress loss the most damaging event in the genre;
- without one → `GET`.

A boot that finds an existing session never claims; only an explicit sign-in in this tab does.
The sign-up nudge is a chip, "save your factory", shown from tier 1 (D.4: after the first
milestone, never on first load, never a modal). Password reset: "forgot password" sends the
email; the link lands on `/account/reset-password`. That needs **`websiteBasePath: "/account"`**
in the API's `appInfo` (`supertokens.ts:125`): on one origin (W-2), the default `/auth` would send
the reset link to the API's own `/auth/*` routes. Discord and GitHub stay off in the UI until a
deployment has credentials (open question 4). *Cost if wrong:* a parked token that nobody returns
to is deleted by cleanup after 30 days, exactly as an abandoned guest would be.

## Look, motion, responsive, accessibility

**W-17. §13.0 as tokens.** Colours, the three sizes (15/13/12 px), two weights and the
monospace-for-numbers rule (`font-variant-numeric: tabular-nums`) are CSS custom properties in
one `tokens.css`, seeded from the MVP's `:root`. The four state colours (fed green, throttled
amber, bottleneck red, paused grey) are used for nothing else, and a vitest test over the CSS
modules fails if they appear outside the state classes. Dark is the default,
light is set by `prefers-color-scheme` or the settings toggle (stored in `localStorage`).
Rows, not cards; 0.5 px hairlines; no shadows or gradients. Numbers go through the engine's
`format`, `"hybrid"` by default and switchable in settings.

**W-18. §13.6 as rules.**
- **Only `transform` and `opacity` animate.** Bar fills are `scaleX` (the MVP animates `width`;
  that's not carried over), sweeps are `translateX`, pulses are `opacity`.
- **Production sweep** period: `clamp(0.8 s, 6 s − 1.2 s × log10(1 + rate), 6 s)`, set per row
  as a CSS variable.
- **Bottleneck pulse**: `--pulse-cycle: 2.6s`, opacity 1 ↔ 0.45, one named constant, and only
  ever one per lane, because the engine reports one.
- **Number tweens**: log space, 300 ms, on snapshot corrections only (W-7).
- **Conveyor** (4c): one low-opacity strip per *visible* lane, at most 12 blocks, speed from the
  lane's summed production, `translateX` keyframes.
- **Everything** sits in `@media (prefers-reduced-motion: no-preference)`. Reduced motion is a
  complete static UI, with the bottleneck legible from its frame colour and its label alone.
- **Hidden tab**: all animation paused (W-9). **No animation library.** Nothing routine
  celebrates; a tier-up gets one toast.

**W-19. §13.8 as breakpoints**, on viewport width only:

| Width | Layout |
|---|---|
| < 600 px | One column; bottom tab bar (Factory, Priority, Handbook); the dock above it; the drawer is a bottom sheet |
| 600–1000 px | Two panes: lane view, and detail (drawer or handbook entry) |
| > 1000 px | Three panes: lanes, detail, priority list, so a reorder updates the split bars in view |

**No horizontal scrolling in portrait, ever.** Every row must be legible at 320 px: buttons wrap,
tables stack, long names ellipsize but never push numbers off-screen. The e2e suite asserts
`scrollWidth <= clientWidth` at 320 px on every view (W-23). No virtualization in Phase 4: a slice
lane has about eight rows and only the visible lane renders. §13.6's "virtualize" applies when the
~160-item catalog lands.

**W-20. Accessibility basics.** Every control is a real `<button>`/`<input>` with a visible
focus ring; touch targets are at least 44 px (the tap target is 58 px, as in the MVP).
Satisfaction and storage bars are `role="meter"` with `aria-valuenow` updated per snapshot, not
at 4 Hz. Ticking numbers are **not** live regions. One polite live region announces only
discrete events: a bottleneck change, a rejection, a tier-up. The tap is holdable by
pointer **and** by a held Space/Enter. State colour is never the only signal: chips and the
bottleneck frame carry text. Contrast is WCAG AA in both themes, checked in the token test.
The polite region also announces priority moves (ruled in Phase 4b, Task 4).

**W-21. Priority drag is hand-rolled.** Pointer events with `setPointerCapture`, a
`translateY` ghost, and drop on release, plus **keyboard reorder** (focus a row, Alt+↑/↓) and
small up/down buttons, as the MVP has. A list of 8–12 rows doesn't justify a drag-and-drop
dependency, and the keyboard path is the accessible one. Moving the power entry off position 1
asks for confirmation once per move, citing C.4. *Cost if wrong:* `@dnd-kit` can replace one
component.

## Testing and CI

**W-22. Component tests on jsdom; sync tests against the real API, in process.**
- **Components**: vitest + Testing Library + jsdom, fed a store built from fixture snapshots
  (the slice fixtures in `engine/src/resolve/fixtures`, served through the real `worldView`
  shape). They cover row rendering at each storage tier, the chips' appearance thresholds, the
  bottleneck frame, the drawer's projection and ladder text, and priority keyboard reorder.
- **The sync core** is framework-free (`src/sync/`), and its tests run in vitest's `node`
  environment against **`buildServer` on PGlite**, the API's own test setup, through a `fetch`
  backed by `app.inject()`: no ports, no network. Both clocks are injected (the server's
  `clock`, the client's `now`), so a test moves time and watches the client re-fetch at a
  boundary, back off on the EPSILON fixture, retry a dropped response with the same key and get
  the replay, stop on a 429's `Retry-After` (with `limits` set small), re-sync after a 409, and
  run the claim flow with the fake session verifier the API's tests use. This is "against the
  real API from its first render", in tests.
- The API needs an `exports` map (`./server`, `./testing`: `pgliteDb`, `migrate`,
  `openContentStore`, `guestAuth`, `identityAuth`), because importing `main.ts` starts a server.
  A third, `./bundle`, is test-only, for the web client's jsdom tests.
  `@manufactory/api` becomes a `devDependency` of `apps/web`.

*Cost if wrong:* PGlite adds about a second per sync test file; that's fine at this size.

**W-23. Playwright: yes, one Chromium job, from 4a.** jsdom has no layout, so the 320 px rule,
the hold-to-tap and the drag can only be tested in a browser. A new `apps/api/src/dev.ts` serves
`buildServer` on PGlite (in memory, or a `PGLITE_DIR`), guest-only, on a port. It's also
`pnpm --filter @manufactory/api dev`, so local development needs no Docker. Playwright's
`webServer` starts it and `vite preview` behind the W-2 proxy. Specs: 4a, guest start → lane renders
→ the bottleneck buy succeeds → a reload keeps the world; 4b, drawer buy, drag reorder, tap
hold; 4c, 320 px overflow on every view, reduced motion, sign-up and claim (with a fake verifier
in the dev server behind a `DEV_FAKE_SESSIONS` flag; the real SuperTokens path stays the API's
smoke test). CI gains a **`web-e2e`** job alongside the others: install,
`playwright install --with-deps chromium`, `pnpm --filter @manufactory/web e2e`, with a
`timeout-minutes: 15` hang guard. Chromium only: WebKit's differences matter, but they are a
manual check before release, not a per-commit gate. *Cost if wrong:* a flaky e2e job reads as a
red build, so specs wait on store events, never on sleeps.

**W-24. Repo integration.**
- `turbo.json`: `@manufactory/web#build` outputs `["dist/**"]`; `apps/web`'s `build` is
  `tsc --noEmit && vite build`, and `typecheck` and `test` as in every package.
- `eslint.config.js`: an `apps/web/**` block with browser globals, `eslint-plugin-react-hooks`,
  and the W-4 import ban.
- The existing `check` job runs the web unit tests through `pnpm test` unchanged.
- Never run `pnpm lint`/`typecheck` alongside a background `pnpm test` (turbo builds race).

**W-25. GPL and deployment.** The footer links to the source at the deployed commit and to
`LICENSE` (D2: shipping JS is distribution). Production source maps are published. React (MIT),
supertokens-web-js (Apache-2.0) and break_infinity.js (MIT) are GPL-3.0-compatible. Deployment is
an example, not hosting: `infra/Caddyfile` (static `apps/web/dist`, `/api/*` and `/auth/*` to the
API), plus an optional compose profile. Choosing a host, a domain and TLS is outside the repo.
*Cost if wrong:* none to the code.

**W-26. The API and engine changes Phase 4 makes**, all in 4a except the last:

| Package | Change | For |
|---|---|---|
| engine | `scheduleDetail`; `schedule` delegates to it, so its output is byte-identical | W-8 |
| api | `GET /api/content/:checksum` | W-5 |
| api | `GET /api/health` gains `accounts: boolean` | W-15 |
| api | `exports` map; `src/dev.ts` + `dev` script | W-22, W-23 |
| api | world responses gain `persistedAtMs` | Open question 1 |
| api | `appInfo.websiteBasePath: "/account"` (4c) | W-16 |

Each has tests in its own package. Nothing changes the action set, the schema or a stored response.

---

## Open questions — resolved

Each recommended answer below was adopted as a ruling (2026-10-17): 1 and 2 shape 4a (`persistedAtMs`, no away summary); 3–7 are deferred or settled as written.


1. **Does an open, watching tab count as playing?** Today it doesn't: `GET` never persists, so a
   tab that only watches stops accruing 8 h after the last action (the offline cap counts from
   there), and the client draws past the plateau until a fetch snaps it back. **Recommend:** keep
   the server's rule (an open tab must not be worth more than a closed one; §13.8 says never
   require the app to be open). Add `persistedAtMs` (the stored `last_resolved_at`) to world
   responses in 4a, stop interpolating at `persistedAtMs + offlineCapMs`, and show a plain
   "production paused 8 h after your last action; do anything to resume". Without the field, the
   client is wrong, rarely and visibly.
2. **"While you were away".** **Recommend:** not in Phase 4. When it's built (with Spec 4's
   statistics), add `summary` to `GET /api/world`. `viewWorld` already computes it (`worlds.ts:141`)
   and throws it away. Note that it means "since your last action", not "since you last looked".
3. **Should `schedule` report a cycling item as an average rate?** **Recommend:** not now. W-9's
   backoff and W-7's clamp make the cycle harmless to the client. Revisit when the full catalog
   makes cycles common, alongside the deferred expansion-cache re-key.
4. **Discord and GitHub sign-in.** **Recommend:** defer until a deployment has credentials, then
   add `providers: string[]` to `/api/health` and a callback route at `/account/callback/:provider`.
5. **Two tabs on one world.** **Recommend:** no coordination. The server serializes, the tap
   ceiling is per world, and two tabs' polling fits the 3/s bucket. A `BroadcastChannel` is only
   worth it if tests show 429s in practice.
6. **React 19?** **Recommend:** stay on 18.3 until `apps/sim`'s Ink supports 19, then move both
   together.
7. **Should a zero-count TAP refresh the expiry?** **Recommend:** the client never sends one
   (W-12). The engine leaves it alone: a real one-tap flush every 30 s does the same thing
   legitimately.

## What Phase 4 does not do

- No offline play: no service worker, and nothing is computed without the server.
- No new game rules, actions or schema.
- No production hosting, PWA install, notifications, statistics, or Specs 2–4's screens.

## Errata found while planning 4a (2026-10-18)

Each corrects a claim above against the code; the 4a plan (`docs/superpowers/plans/2026-10-17-phase-4a-web-shell.md`) carries the ruling.

- **W-8, satisfaction.** `Solution.entries` cannot give satisfaction: every item entry has `requested: Infinity`. Satisfaction is production / consumption from `allocations` (plan P-1).
- **W-1 item 1 and W-18, one bottleneck frame per lane.** The engine reports a single, global bottleneck, so the client shows at most one frame in the whole factory (plan P-2). Per-lane frames would need an engine change; deferred.
- **OQ1 and W-9, the plateau.** Past `persistedAtMs + offlineCapMs`, `GET /api/world` still returns non-zero rates and a fresh boundary, so following the boundary would poll forever. Once past the plateau the client stops boundary polling and shows the notice (plan P-4). `persistedAtMs` is the stored state's `lastResolvedAt`, so no migration (P-5); idempotent replays of responses stored before 4a lack it, and the client tolerates its absence.
- **W-23, `PGLITE_DIR`.** `pgliteDb` takes no data directory today; 4a gives it one (P-15).
