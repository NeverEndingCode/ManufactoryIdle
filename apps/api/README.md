# @manufactory/api

Fastify server for Manufactory Idle. Phase 3a: guest play over HTTP. The server is
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

See `infra/README.md` for running against the compose Postgres.

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

Errors: 400 malformed body, 401 missing or unknown token, 404 no world, 409 an action
was rejected (body: `failedAction`, `index`, `reason`).

## Tests

    pnpm --filter @manufactory/api test

Tests run on PGlite (in-process Postgres) through Fastify's `inject()`; no database,
network or Docker is needed.
