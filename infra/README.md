# Local infrastructure

One Postgres 16 instance holding two databases — `manufactory` for game state and
`supertokens` for auth — plus the SuperTokens core. This mirrors the production
layout in spec section 15, where both databases live inside the existing Unraid
Postgres rather than a second instance.

## Usage

    cp .env.example .env      # then edit the secrets
    docker compose up -d
    curl http://localhost:3567/hello    # -> Hello

Reset everything, including data:

    docker compose down -v

## Notes

- Postgres (5432) and the SuperTokens core (3567) are published on `127.0.0.1` only.
  The core trusts whoever holds its API key, and neither belongs on the LAN.
- `.env` is gitignored. Never commit real secrets; the image carries none.
- `initdb/` runs only on a first-time volume initialization. If you change it,
  you must `docker compose down -v` for the change to take effect.
- Production adds a `pg_dump` cron sidecar (spec section 15). Not needed locally.

## Running the API against this Postgres

With the compose stack up (and `.env` filled in), from the repo root:

    DATABASE_URL=postgres://manufactory:<POSTGRES_PASSWORD>@localhost:5432/manufactory \
      pnpm --filter @manufactory/api start

The password is `POSTGRES_PASSWORD` from `.env`. The API applies its
migrations on startup and listens on `127.0.0.1:8080` (see `apps/api/README.md`).

## Running the API with accounts

Point the API at the compose SuperTokens core as well (port 3567, API key
`SUPERTOKENS_API_KEY` from `.env`):

    DATABASE_URL=postgres://manufactory:<POSTGRES_PASSWORD>@localhost:5432/manufactory \
    SUPERTOKENS_CONNECTION_URI=http://localhost:3567 \
    SUPERTOKENS_API_KEY=<SUPERTOKENS_API_KEY> \
    API_DOMAIN=http://localhost:8080 WEBSITE_DOMAIN=http://localhost:5173 \
      pnpm --filter @manufactory/api start

Without `SUPERTOKENS_CONNECTION_URI` the API runs guest-only (it logs `accounts
disabled`). With it, `API_DOMAIN` and `WEBSITE_DOMAIN` are required; an `http`
`API_DOMAIN` logs a warning (session cookies aren't `Secure`), which is expected locally.
The other account variables (SMTP for reset mail, the Discord and GitHub credentials)
are listed in `apps/api/README.md`.

The core image is pinned (`12.3.1`) to a version whose supported CDI list includes the
one `supertokens-node` speaks (5.4 for 24.0.3). When bumping either, compare
`node_modules/supertokens-node/lib/build/version.js` (`cdiSupported`) with the core
release's `coreDriverInterfaceSupported.json`.

## The SuperTokens smoke test

`apps/api/src/auth/supertokens.smoke.test.ts` signs up a real EmailPassword user through
the core, loads its lazily created world, and claims a guest. `pnpm test` skips it. With
the compose stack up (it defaults `API_DOMAIN`/`WEBSITE_DOMAIN` to the local ones above):

    SUPERTOKENS_CONNECTION_URI=http://localhost:3567 \
    SUPERTOKENS_API_KEY=<SUPERTOKENS_API_KEY> \
      pnpm --filter @manufactory/api exec vitest run src/auth/supertokens.smoke.test.ts

It creates accounts with unique `smoke-...@example.com` emails in the `supertokens`
database each run; `docker compose down -v` clears them.
