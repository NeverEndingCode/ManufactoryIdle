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

- `.env` is gitignored. Never commit real secrets; the image carries none.
- `initdb/` runs only on a first-time volume initialization. If you change it,
  you must `docker compose down -v` for the change to take effect.
- Production adds a `pg_dump` cron sidecar (spec section 15). Not needed locally.
