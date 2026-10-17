# @manufactory/api

Fastify server for Manufactory Idle. Phase 3a: guest play over HTTP. Phase 3b: optional
accounts (SuperTokens). The server is
authoritative; the client sends actions and gets back the resolved world.

## Run

    DATABASE_URL=postgres://... pnpm --filter @manufactory/api start

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. Migrations run at startup. |
| `CONTENT_DIR` | the vertical slice bundle | Directory of the content bundle to serve. A relative path resolves against the working directory, which under `pnpm --filter` is `apps/api`; use an absolute path. |
| `PORT` | `8080` | Listen port. |
| `HOST` | `127.0.0.1` | Listen address. |
| `LOG_LEVEL` | `info` | pino log level. |
| `SUPERTOKENS_CONNECTION_URI` | unset | The SuperTokens core, e.g. `http://localhost:3567`. Unset: accounts are disabled (see below). |
| `SUPERTOKENS_API_KEY` | unset | The core's API key (`API_KEYS` in `infra/.env`). |
| `API_DOMAIN` | `http://localhost:8080` | Where browsers reach this API; SuperTokens serves `/auth/*` here. |
| `WEBSITE_DOMAIN` | `http://localhost:5173` | The web client's origin: the only CORS origin, with credentials. |
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
their credentials are set.

**Accounts disabled (R-16).** Without `SUPERTOKENS_CONNECTION_URI` the API logs
`accounts disabled (SUPERTOKENS_CONNECTION_URI unset)` and runs guest-only: no `/auth/*`
routes, no CORS, and `/api/auth/claim` answers `503 accounts-disabled`. Dev and CI run
this way.

## Endpoints

Authentication is `Authorization: Guest <token>`, with the token from `POST /api/guests`.
It is returned once; only its sha256 is stored.

    # health
    curl http://127.0.0.1:8080/api/health

    # create a guest (returns guestToken and the starting world)
    curl -X POST http://127.0.0.1:8080/api/guests

    # get the world, resolved to now (writes nothing to the world; opens a session row)
    curl http://127.0.0.1:8080/api/world -H "Authorization: Guest $TOKEN"

    # apply actions atomically (all or none). The body requires idempotencyKey and
    # baseVersion (the stateVersion you last saw); 3a validates but does not yet act on
    # them, replay and stale-version handling arrive in a later PR. Make idempotencyKey
    # unique per batch (e.g. a UUID): from 3c a repeated key replays the stored response.
    # The BUY_MACHINE below is illustrative: a fresh world may answer 409 until it has
    # the stock to pay for it.
    curl -X POST http://127.0.0.1:8080/api/actions \
      -H "Authorization: Guest $TOKEN" -H "Content-Type: application/json" \
      -d '{"idempotencyKey":"'"$(uuidgen)"'","baseVersion":0,"actions":[{"type":"BUY_MACHINE","lane":"iron","machineClass":"miner","mark":1,"count":1}]}'

    # claim a guest's world for the signed-in account
    curl -X POST http://127.0.0.1:8080/api/auth/claim \
      -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
      -d '{"guestToken":"'"$TOKEN"'"}'

Errors: 400 malformed body, 401 missing or unknown token, 404 no world, 409 an action
was rejected (body: `failedAction`, `index`, `reason`). Claim errors are listed under
the auth model above.

## Tests

    pnpm --filter @manufactory/api test

Tests run on PGlite (in-process Postgres) through Fastify's `inject()`; no database,
network or Docker is needed. Sessions are faked by an injected verifier. The one test
against a real SuperTokens core, `src/auth/supertokens.smoke.test.ts`, is skipped unless
`SUPERTOKENS_CONNECTION_URI` is set; see `infra/README.md`.
