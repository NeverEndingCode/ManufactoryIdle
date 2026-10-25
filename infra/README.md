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

The client and the API always share one origin (W-2): the browser reaches `/api` and
`/auth` on the page's own host, and something in front (Vite locally, a reverse proxy in
production) forwards them. So `API_DOMAIN` and `WEBSITE_DOMAIN` are both that one origin.
Locally, point the API at the compose SuperTokens core (port 3567, API key
`SUPERTOKENS_API_KEY` from `.env`) and give both domains the Vite dev server's origin:

    DATABASE_URL=postgres://manufactory:<POSTGRES_PASSWORD>@localhost:5432/manufactory \
    SUPERTOKENS_CONNECTION_URI=http://localhost:3567 \
    SUPERTOKENS_API_KEY=<SUPERTOKENS_API_KEY> \
    API_DOMAIN=http://localhost:5173 WEBSITE_DOMAIN=http://localhost:5173 \
      pnpm --filter @manufactory/api start

Then run the client with `API_PORT=8080 pnpm --filter @manufactory/web dev` and open
`http://localhost:5173`: Vite proxies `/api` and `/auth` to the API on 8080, so the
browser sees one origin. (For accounts with no Docker at all, the dev server's fake
SuperTokens is `DEV_FAKE_SESSIONS=1 pnpm --filter @manufactory/api dev`; see the root
README.)

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
the compose stack up (it sets its own `API_DOMAIN`/`WEBSITE_DOMAIN`; no browser is involved):

    SUPERTOKENS_CONNECTION_URI=http://localhost:3567 \
    SUPERTOKENS_API_KEY=<SUPERTOKENS_API_KEY> \
      pnpm --filter @manufactory/api exec vitest run src/auth/supertokens.smoke.test.ts

It creates accounts with unique `smoke-...@example.com` emails in the `supertokens`
database each run; `docker compose down -v` clears them.

## Deploying (example)

`infra/Caddyfile` is an example of the production shape, not hosting (W-25): one origin
that serves the built client and forwards `/api/*` and `/auth/*` to the API. Choosing a
host, a domain and TLS is outside the repo. There is no compose profile for it: the API
has no container image.

1. Build the client at a known commit, so its footer links the source it was built from
   (GPL-3.0: shipping JS is distribution), and copy it to the web root:

       SOURCE_COMMIT=$(git rev-parse HEAD) pnpm --filter @manufactory/web build
       cp -r apps/web/dist/. /srv/manufactory/web/

   Without `SOURCE_COMMIT` the build takes `GITHUB_SHA`, then `git rev-parse HEAD` (and
   says "modified from" when tracked files differ from it). `SOURCE_REPO` overrides the
   linked repository, for a fork. The source maps (`assets/*.js.map`) are published with
   the chunks on purpose.

2. Run the API on loopback behind the proxy, with both domains set to the site's one
   origin and the proxy trusted, so the guest rate limit sees client IPs:

       DATABASE_URL=postgres://... \
       HOST=127.0.0.1 PORT=8080 TRUST_PROXY=127.0.0.1 \
       API_DOMAIN=https://<site> WEBSITE_DOMAIN=https://<site> \
       SUPERTOKENS_CONNECTION_URI=... SUPERTOKENS_API_KEY=... \
         pnpm --filter @manufactory/api start

   plus the other account variables (SMTP for reset mail; see `apps/api/README.md`).
   Without `SUPERTOKENS_CONNECTION_URI` it runs guest-only and needs no domains.

3. Run Caddy with the example, setting `SITE_ADDRESS` (default `localhost:8443`),
   `API_UPSTREAM` (default `127.0.0.1:8080`) and `WEB_ROOT` (default
   `/srv/manufactory/web`) as needed:

       SITE_ADDRESS=<site> caddy run --config infra/Caddyfile --adapter caddyfile

   Check the file with `caddy validate --config infra/Caddyfile --adapter caddyfile`
   where Caddy is installed. That is not part of CI.

`/assets/*` (content-hashed) is cached for a year as immutable; everything else, the
`index.html` fallback above all, is `no-cache`, so a deploy is picked up on the next load.
