# @manufactory/api

Fastify server for Manufactory Idle. Phase 3a: guest play over HTTP. Phase 3b: optional
accounts (SuperTokens). Phase 3c: the anti-cheat guards (idempotency, rate limits, the tap
ceiling), the cleanup job and the admin migrate endpoint. The server is authoritative; the
client sends actions and gets back the resolved world.

## Run

    DATABASE_URL=postgres://... pnpm --filter @manufactory/api start

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. Migrations run at startup, under a Postgres advisory lock, so instances booting together apply each file once. |
| `CONTENT_DIR` | the vertical slice bundle | Directory of the content bundle to serve. A relative path resolves against the working directory, which under `pnpm --filter` is `apps/api`; use an absolute path. |
| `PORT` | `8080` | Listen port. |
| `HOST` | `127.0.0.1` | Listen address. |
| `LOG_LEVEL` | `info` | pino log level. |
| `TRUST_PROXY` | unset (off) | Fastify's `trustProxy`, for a deployment behind a reverse proxy: `true` exactly (case-sensitive: `TRUE` is not `true`, and is read as an address, not as trust-all) (trust every hop; only if nothing reaches the API except through the proxy), or a comma list of the proxy's addresses or CIDRs, e.g. `10.0.0.1` or `127.0.0.1,10.0.0.0/8`. A hop count is refused at startup: Fastify 5 accepts one but then trusts nothing. Unset behind a proxy, `request.ip` is the proxy's, and every guest shares one `POST /api/guests` bucket. |
| `ADMIN_TOKEN` | unset | Enables `POST /api/admin/migrate-world` (see below). Unset or empty: the route does not exist and answers 404. Use a long random value. |
| `SUPERTOKENS_CONNECTION_URI` | unset | The SuperTokens core, e.g. `http://localhost:3567`. Unset: accounts are disabled (see below). |
| `SUPERTOKENS_API_KEY` | unset | The core's API key (`API_KEYS` in `infra/.env`). |
| `API_DOMAIN` | required with accounts | Where browsers reach this API: the site's one origin (W-2), e.g. `https://play.example.com`, since the proxy in front forwards `/api` and `/auth`; SuperTokens serves `/auth/*` there. Session cookies are `Secure` only when it is `https` (startup warns otherwise; `http://localhost:5173` is fine for local dev). |
| `WEBSITE_DOMAIN` | required with accounts | The web client's origin, the same as `API_DOMAIN` (W-2; `http://localhost:5173` for both locally, behind Vite's proxy): the only CORS origin, with credentials. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | unset | Password-reset mail over your SMTP server (port 465 uses TLS). All five or none (R-24). |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | unset | Discord sign-in. Configured only when both are set (R-12). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | GitHub sign-in. Configured only when both are set (R-12). |

See `infra/README.md` for running against the compose Postgres.

## Auth model

A request acts as a player in one of two ways:

- **A SuperTokens session** (cookie, or `Authorization: Bearer <access token>` in header
  mode). The first request of an account with no player creates one with a fresh world
  (lazy creation; concurrent first requests still end with one player, R-17).
- **A guest token**, `Authorization: Guest <token>`, from `POST /api/guests`.

If a request carries both, the session wins and the guest token is ignored (R-13).

`POST /api/auth/claim { guestToken }` (session required) attaches a guest's world to the
signed-in account and retires the guest token. It answers `409 already-has-world` if the
account already has a world (no merge, R-14), and `404 unknown-guest` for an unknown or
already-claimed token (R-18). Clients offer the claim on first sign-in, before the
account's first `GET /api/world`.

SuperTokens' own routes (`/auth/signup`, `/auth/signin`, `/auth/session/refresh`, ...)
are served by its Fastify plugin. Sign-in is EmailPassword, plus Discord and GitHub when
their credentials are set. With `SUPERTOKENS_CONNECTION_URI` set, `API_DOMAIN` and
`WEBSITE_DOMAIN` are required: startup fails naming whichever is missing.

**Password-reset mail stays self-hosted (R-24).** SuperTokens' default would POST the
player's email and the live reset link to `api.supertokens.io`. Instead, with all five
`SMTP_*` variables set the API sends it through that SMTP server (the SDK's SMTP
service). Otherwise it sends nothing and logs only `password reset email not sent: SMTP
not configured`, without the address or the token.

**Accounts disabled (R-16).** Without `SUPERTOKENS_CONNECTION_URI` the API logs
`accounts disabled (SUPERTOKENS_CONNECTION_URI unset)` and runs guest-only: no `/auth/*`
routes, no CORS, and `/api/auth/claim` answers `503 accounts-disabled`. Dev and CI run
this way. Because no CORS headers are sent, a browser client on another origin needs
accounts on, or a dev proxy that serves the client and the API from one origin.

## Endpoints

Authentication is `Authorization: Guest <token>`, with the token from `POST /api/guests`, or
a session (see the auth model above). The guest token is returned once; only its sha256 is
stored.

    # health: { ok, contentChecksum, accounts } (accounts: whether /auth/* and claim are live)
    curl http://127.0.0.1:8080/api/health

    # a content bundle by checksum (public, immutable: cache-control public, max-age=31536000,
    # immutable). Serves the current bundle and any older one a world is pinned to. An unknown
    # or malformed checksum is 404 { "error": "unknown content" }; no rate limit.
    curl http://127.0.0.1:8080/api/content/$CHECKSUM

    # create a guest (returns guestToken and the starting world)
    curl -X POST http://127.0.0.1:8080/api/guests

    # get the world, resolved to now (writes nothing to the world; opens a session row)
    curl http://127.0.0.1:8080/api/world -H "Authorization: Guest $TOKEN"

    # apply actions atomically (all or none). The body requires idempotencyKey and
    # baseVersion (the stateVersion you last saw; validated, not yet acted on). Make
    # idempotencyKey unique per batch (e.g. a UUID): a repeated key replays the stored
    # response. The BUY_MACHINE below is illustrative: a fresh world may answer 409 until it
    # has the stock to pay for it.
    curl -X POST http://127.0.0.1:8080/api/actions \
      -H "Authorization: Guest $TOKEN" -H "Content-Type: application/json" \
      -d '{"idempotencyKey":"'"$(uuidgen)"'","baseVersion":0,"actions":[{"type":"BUY_MACHINE","lane":"iron","machineClass":"miner","mark":1,"count":1}]}'

    # claim a guest's world for the signed-in account
    curl -X POST http://127.0.0.1:8080/api/auth/claim \
      -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
      -d '{"guestToken":"'"$TOKEN"'"}'

A world comes back as `{ state, schedule, stateVersion, contentChecksum }` (plus `summary`
from `POST /api/actions`). `contentChecksum` is the checksum of the content bundle the world
is pinned to, and `/api/health` reports the current one under the same name. It is not
`state.contentVersion`, which is the bundle's authored label (e.g. `slice.v1`); before 3c the
checksum was also called `contentVersion` (R-22).

Errors: 400 malformed body, 401 missing or unknown token, 404 no world, 409 an action was
rejected (body: `failedAction`, `index`, `reason`), 429 rate-limited, 503
`accounts-unavailable` (below). Any other 4xx carries the generic `request failed`; only
Fastify's own errors (validation, `FST_*`) keep their message. Claim errors are listed under
the auth model above.

## Guards (spec D.5)

- **Idempotency.** Inside the action transaction, after the world's row lock, a seen
  `(player, idempotencyKey)` returns the stored response verbatim, with its status, and
  applies nothing. The key wins: a different body under a seen key still gets the stored
  response. A rejected batch's 409 is stored too, under the same lock, so a retry gets the
  same 409. Keys are kept 24 hours (cleanup).
- **Rate limits** are per instance and in memory (R-15, R-23): 30 calls burst, 3 per second
  per player on `/api/world` and `/api/actions` (after auth, so an unauthenticated call
  spends nothing; a replayed idempotency key still counts), and 5 per hour per IP on
  `POST /api/guests` (keyed on `request.ip`; see `TRUST_PROXY`). Over the limit:
  `429 {"error":"rate-limited"}` with `Retry-After` in whole seconds. Each bucket table holds
  at most 100,000 keys (the least recently used is evicted, and starts full again) and is
  swept of refilled keys at most once per 30 seconds or per 1,000 new keys.
- **Tap ceiling** (R-19). Before a batch is applied, its TAPs' `clientElapsedMs` are capped, in
  order, to the server time since the world's last TAP batch (or its creation); the engine's
  per-tap clamp then applies. The capped actions are what the action log stores, so replay
  stays exact. `last_tap_flush_at` only moves forward.
- **An accounts outage is a 503.** If the SuperTokens core cannot be reached while verifying a
  session, the API answers `503 {"error":"accounts-unavailable"}` with `Retry-After: 5`, and
  never falls back to the request's guest token. The SuperTokens wrapper tags every error
  from `getSession` that is not a SuperTokens error as `AccountsUnavailableError` (the SDK has
  no typed error for a missing core, so nothing matches its message strings); other verifier
  errors are a 500. A core that is down while only its JWKS is needed shows up as SuperTokens'
  own `try refresh token` 401, since the SDK reports a failed key fetch that way.

## Cleanup

    DATABASE_URL=postgres://... pnpm --filter @manufactory/api cleanup

A one-shot job for a nightly cron. It migrates, then runs four steps, each in its own
transaction, and prints their counts as JSON:

1. delete guest players unseen for 30 days, with their worlds, logs, sessions and keys
   (account players are never deleted);
2. compact `action_log` rows older than 30 days, one world per transaction: replay them onto
   the world's replay base (or its recorded start), store the result as the new base, and
   delete them, so the base plus the remaining log still replays the world exactly (R-20). A
   world whose replay throws is rolled back, logged by id, and listed in `logFailures`; the
   others still compact;
3. delete idempotency keys older than 24 hours;
4. close sessions idle for 30 minutes.

## Admin: re-pin a world's content (D.6)

    curl -X POST http://127.0.0.1:8080/api/admin/migrate-world \
      -H "Authorization: Admin $ADMIN_TOKEN" -H "Content-Type: application/json" \
      -d '{"playerId":"<uuid>","toVersion":"<content checksum>"}'

Only with `ADMIN_TOKEN` set (otherwise 404). The token is compared in constant time (both
sides are sha256-hashed, then `timingSafeEqual`); a missing or wrong one is a 401, checked
before the body. `toVersion` must already be in `content_versions` (a server must have
started on that bundle), else `400 unknown-version`. The world must fit it: the same stock
items, and every lane, machine class, recipe and item it refers to must exist, else
`400 incompatible-version` with a `detail`. A re-pin is for content that changes numbers,
not ids.

In one transaction under the world's row lock, the world is resolved to now on `toVersion`,
stored with `stateVersion` bumped, and `content_version` is re-pinned
(`initial_content_version` never changes). The re-pin is logged as an `action_log` row with
no actions and `toVersion` (R-21), so replay crosses it exactly. The answer is
`{ playerId, worldId, fromVersion, toVersion, stateVersion }`.

## Tests

    pnpm --filter @manufactory/api test

Tests run on PGlite (in-process Postgres) through Fastify's `inject()`; no database,
network or Docker is needed. Sessions are faked by an injected verifier. Two files are
skipped by default:

- `src/pg.integration.test.ts` runs only with `DATABASE_URL` set, against real Postgres:
  concurrent actions on one world serialize, migrations apply (twice at once, under the
  advisory lock), a failed COMMIT destroys its client, and lazy account creation racing a
  claim ends with one player. Each test creates and drops its own schema, so any scratch
  database will do. CI's `api-integration` job runs it on `postgres:16`.
- `src/auth/supertokens.smoke.test.ts` runs only with `SUPERTOKENS_CONNECTION_URI` set,
  against a real SuperTokens core; see `infra/README.md`.

## World responses and `persistedAtMs`

Every world response (`POST /api/guests`, `GET /api/world`, `POST /api/actions`,
`POST /api/auth/claim`) is `{ state, schedule, stateVersion, contentChecksum, persistedAtMs }`
(plus `summary` on actions). `persistedAtMs` is the time the world was last stored: production
simulated past `persistedAtMs + offlineCapMs` is not credited until the next action. A GET
resolves the world to now in memory only, so `persistedAtMs` stays put until an action is
applied. Idempotent replays return the stored response verbatim; responses stored before this
field existed lack it and are not backfilled.

## Package exports and the dev server

`package.json` has an `exports` map, `./server`, `./testing` and `./bundle`, and no `main`: a bare
`import "@manufactory/api"` does not resolve, because `src/main.ts` starts a process when
imported. `./testing` re-exports the pieces tests need (`pgliteDb`, `migrate`,
`openContentStore`, `guestAuth`, `identityAuth`, `noSessions`, `Db`). `./bundle` is test-only,
for the web client's jsdom tests, which cannot load the server.

    pnpm --filter @manufactory/api dev

runs a PGlite-backed, guest-only server (`src/dev.ts`): no accounts, no admin route, and up to
1000 guests per IP per hour.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port. |
| `HOST` | `127.0.0.1` | Listen address. |
| `PGLITE_DIR` | unset (in memory) | Directory to persist the database across restarts. |
| `CONTENT_DIR` | the vertical slice bundle | Content bundle to serve. |
| `LOG_LEVEL` | `warn` | pino log level. |

### Fake sessions (`DEV_FAKE_SESSIONS=1`)

`DEV_FAKE_SESSIONS=1 pnpm --filter @manufactory/api dev` also mounts an in-memory fake of the
SuperTokens front-end interface (`src/dev-sessions.ts`: sign-up, sign-in, sign-out, refresh,
password reset, plus `GET /auth/dev/reset-link?email=`), so the web client's account e2e runs
without a SuperTokens core. It rejects an `fdi-version` the node SDK does not speak. Any value
other than unset, empty or `1` stops `dev.ts`. **Never in production**: `main.ts` cannot reach
it and `devServer` throws under `NODE_ENV=production`. The real path is covered only by the
SuperTokens smoke test (`src/auth/supertokens.smoke.test.ts`, needs a core).
