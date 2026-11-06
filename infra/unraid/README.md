# Deploying to Unraid

The production deploy of `https://manufactory.neverendingcode.com`, on the Unraid server at
`192.168.68.50`. Everything runs from `infra/unraid/deploy.sh`, as root on the server.

## Architecture

    browser ──https──▶ Cloudflare ──tunnel──▶ cloudflared (default bridge)
                                                  │ http://192.168.68.50:8087
                                                  ▼
       pgnet (172.19.0.0/16) ┌────────────────────────────────────────────────────────────┐
                             │ manufactory-web  Caddy, :80 → host 8087                     │
                             │   /assets/*, the SPA; /api/*, /auth/* ──▶                  │
                             │ manufactory-api  Fastify, :8080 (not published)             │
                             │   ──▶ postgresql16:5432, database + role manufactory        │
                             │   ──▶ manufactory-supertokens:3567 (accounts; not published)│
                             │         ──▶ postgresql16:5432, manufactory_supertokens      │
                             └────────────────────────────────────────────────────────────┘

- **Two containers built here** (D-1), both on `pgnet`, built on the server from
  `infra/docker/Dockerfile` (D-2): `manufactory-api:<sha>` and `manufactory-web:<sha>`, each also
  tagged `:current`, which is what the templates run. There is no registry.
- **The game's own SuperTokens core** (DC-1, DC-2): `manufactory-supertokens`, the stock
  `supertokens/supertokens-postgresql:12.3.1` image, on `pgnet` with **no published port**. Only
  the API reaches it, by name. It keeps its users in its own database, `manufactory_supertokens`,
  and it has its own API key. The other app's core, `SuperTokens---PostgreSQL` (published on
  3567, database `supertokens`), is a different container that the script never reads or touches.
- **TLS ends at Cloudflare** (D-3). The web container serves plain HTTP; `API_DOMAIN` and
  `WEBSITE_DOMAIN` are still `https://manufactory.neverendingcode.com`, so cookies are `Secure`.
- **Client IPs** (D-4): Caddy takes the player's address from `Cf-Connecting-Ip`
  (`CLIENT_IP_HEADER=Cf-Connecting-Ip` with `CLIENT_IP_TRUSTED_PROXIES=private_ranges`; one
  without the other does nothing) and sends it as `X-Forwarded-For`. The API trusts that from
  pgnet (`TRUST_PROXY`, pgnet's subnet, read from `docker network inspect`).
- **Databases** (D-5, DC-1): role and database `manufactory` on `postgresql16`, which the API
  migrates at boot; and role and database `manufactory_supertokens`, whose tables the core creates
  on its first start.

## The Cloudflare route

In the tunnel's public hostnames: `manufactory.neverendingcode.com` → service
`http://192.168.68.50:8087`. Nothing else is published; the API is reachable only over pgnet.

Turn on HSTS in Cloudflare (SSL/TLS → Edge Certificates → HTTP Strict Transport Security), where
TLS ends. Keep the `Strict-Transport-Security` line in `infra/Caddyfile` commented: this Caddy
serves plain HTTP.

## First deploy

Before the first run, check that nothing else already uses the names. The script takes over the
roles `manufactory` and `manufactory_supertokens` (it sets their passwords) and the databases of
the same names (it makes each role its database's owner). It also replaces the containers
`manufactory-supertokens`, `manufactory-api` and `manufactory-web`. These should show none of them:

    docker exec postgresql16 psql -U "$(docker exec postgresql16 printenv POSTGRES_USER)" \
      -d postgres -c '\du manufactory*' -c '\l manufactory*'
    docker ps -a --filter name=manufactory

The branch or commit must be pushed to `origin` (the public GitHub repo). On the server:

    git clone --branch <branch> https://github.com/NeverEndingCode/ManufactoryIdle.git \
      /mnt/user/appdata/manufactory/src
    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh <branch-or-sha>

It runs, in order:

1. Clone or fetch the repo into `/mnt/user/appdata/manufactory/src` and check out the ref
   (a branch name means `origin/<branch>`).
2. Build both targets from `git archive` of that commit (so only committed files go in), web with
   `SOURCE_COMMIT=<full sha>` for the footer's source link, `--pull` for fresh base images; tag
   `:<12-char sha>`. `:current` moves only after steps 3 and 4 succeed, just before step 5, so a
   failure up to then leaves the running game and `:current` on the old images. Then pull the
   core's image, `supertokens/supertokens-postgresql:12.3.1`, if it is not on the server. If that
   pull fails, the run stops there, with the databases, templates and containers unchanged.
3. In `postgresql16`, create two roles and the databases they own, if they are missing:
   `manufactory` for the API, `manufactory_supertokens` for its core. Each gets a generated
   password, which later runs keep from the existing template. A database owned by someone else is
   handed to its role. Every run also holds each role to
   `NOSUPERUSER NOCREATEDB NOCREATEROLE LOGIN`, and limits `CONNECT` on each database to its own
   role (`REVOKE CONNECT … FROM PUBLIC`, then `GRANT CONNECT … TO` the owner). The admin role is a
   superuser, so it can still connect. This runs as the container's own admin role, read at run
   time from its `POSTGRES_USER` (with `docker exec postgresql16 printenv POSTGRES_USER`), so no
   admin name is in the repo.
4. Render `templates/my-manufactory-{supertokens,api,web}.xml` into
   `/boot/config/plugins/dockerMan/templates-user/` (mode 600). The core's template gets its
   database URL and an API key, generated on the first run and kept after that. Only the first key
   in `API_KEYS` is kept: a second key added there by hand is dropped at the next render. The API's
   `SUPERTOKENS_CONNECTION_URI` is `http://manufactory-supertokens:3567`, and its
   `SUPERTOKENS_API_KEY` is copied from the core's template (DC-3). `<Config>` entries added there
   by hand are carried over.
5. Recreate the containers, the core first, then the API, then web. For each, build the
   `docker run` from the rendered template (a malformed template stops here, with the old
   container still up), `docker rm -fv` the old one (`-v` drops Caddy's anonymous `/data` and
   `/config` volumes), and run the new one. The core is ready when `GET /hello` answers `Hello`,
   asked with the image's own curl from inside the core's container:
   `docker exec manufactory-supertokens curl -fsS --max-time 3 http://127.0.0.1:3567/hello`.
   If it never answers, the probe's last error and the core's last 30 log lines are printed,
   with any postgres URL's credentials redacted. The API and web are ready when their
   HEALTHCHECK passes. Then add all three to `/var/lib/docker/unraid-autostart`,
   with the core ahead of the API. The file is rewritten through a temporary file next to it,
   moved over it, after a copy to `unraid-autostart.bak`.
6. Smoke-test. First, through the published port, `curl -fsS http://127.0.0.1:8087/api/health`
   must say `"accounts":true`, which says only that the SuperTokens env is set; its `"providers"`
   (the sign-in providers configured) is logged but not required. Then, from inside
   the API container, `node -e` fetches `$SUPERTOKENS_CONNECTION_URI/users/count` with
   `api-key: $SUPERTOKENS_API_KEY`, which must answer 200. That check depends on no sign-in
   recipe, and the key never leaves the container. A wrong key, a core the API can't reach, or a
   core that is down fails here.
7. Prune all but the 3 newest sha tags of `manufactory-api` and `manufactory-web`. A failure here
   is only a warning. The core's image is a pinned registry tag that the other app's core may share,
   so it is never pruned.

If step 5 or 6 fails and containers ran before, it puts back the old images (by ID, retagged
`:current`) and the old templates, restarts them, and exits non-zero. On the first run with the
core, no core of ours ran before. In that case the rollback removes the new core, puts back the
API's old template, which points at the shared core, and restarts the API and web on it. The
core's template stays, so the next deploy reuses its key and password.

### Switching off the shared core (once)

Until this change, the API used the other app's core (`SuperTokens---PostgreSQL`) with that
core's key. The game has no account players yet (DC-3), so the switch loses nothing. The deploy
runs one version behind itself (see "Redeploy"), so it takes two runs.

First, check that the core's names are still free. These should show nothing:

    docker exec postgresql16 psql -U "$(docker exec postgresql16 printenv POSTGRES_USER)" \
      -d postgres -c '\du manufactory_supertokens' -c '\l manufactory_supertokens'
    docker ps -a --filter name=manufactory-supertokens

Check that only the game's API connects to the `manufactory` database, since step 3 now revokes
`CONNECT` from everyone else. This should list only the `manufactory` role:

    docker exec postgresql16 psql -U "$(docker exec postgresql16 printenv POSTGRES_USER)" \
      -d postgres -c "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = 'manufactory'"

Pre-pull the core's image (step 0 would pull it too), so a registry problem shows up first:

    docker pull supertokens/supertokens-postgresql:12.3.1

Then run both runs inside `tmux` or `screen`, so a dropped SSH session can't cut one off halfway:

    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh <branch-or-sha>   # old script: builds, still on the shared core
    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh --recreate        # new script: creates the core, switches the API

The second run creates `manufactory_supertokens` and `manufactory-supertokens`, generates the
key, renders the API with the new URI and key in place of the shared ones, and smoke-tests
through the new core. After that, nothing reads the shared core's key again. To check:

    docker exec manufactory-api printenv SUPERTOKENS_CONNECTION_URI   # http://manufactory-supertokens:3567

### Why not `update_container`

Unraid's `update_container <Name>` starts by `docker pull`-ing the template's Repository; for
these local-only images the pull fails and the script skips the container. So `deploy.sh` builds
the `docker run` from the rendered template itself, the way dockerMan's `xmlToCommand` does (name,
network, ports, env, ExtraParams, and the `net.unraid.docker.managed=dockerman` and
`net.unraid.docker.webui` labels). The Docker tab lists them with their templates and can start,
stop and show logs. **Don't use the Docker tab's Update or Edit → Apply on them**: those pull
first too, and can leave the container removed. Edit the template file on the flash drive
instead, then run `deploy.sh --recreate`.

## Redeploy

    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh <branch-or-sha>

Same steps; the database step only checks.

The script runs one version behind itself: `bash …/src/infra/unraid/deploy.sh` is the copy from
the previous checkout, and bash has read all of it before step 1 checks out the new commit. A
change to `deploy.sh` takes effect on the next run. The templates are read from the new checkout,
so changes to them take effect at once.

### Tabs open across the OAuth change

Tabs left open on the old bundle still show the old email forms until they reload; that is
harmless, since there are no email/password users. The deploy itself needs nothing special: the
core check (step 6) depends on no sign-in recipe.

### Adding a variable (`ADMIN_TOKEN`, sign-in providers)

Edit `/boot/config/plugins/dockerMan/templates-user/my-manufactory-api.xml` directly. Add one
line per variable before `</Container>`, in the same one-line form as the others, with
`Mask="true"` for a secret:

    <Config Name="DISCORD_CLIENT_SECRET" Target="DISCORD_CLIENT_SECRET" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="true">…</Config>

Then apply it without a build:

    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh --recreate

Later deploys carry such lines over. The variables themselves are listed in `apps/api/README.md`.

## Sign-in providers

Accounts are Discord and GitHub only (no email/password). A provider is on when both of its
variables are set in the API template (see "Adding a variable"):

| Provider | Variables                                    | Callback URL to register                                           |
| -------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Discord  | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | `https://manufactory.neverendingcode.com/account/callback/discord` |
| GitHub   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`   | `https://manufactory.neverendingcode.com/account/callback/github`  |

- **Discord:** in the [developer portal](https://discord.com/developers/applications), create an
  application. Under OAuth2, add the callback URL above as a redirect, and copy the client ID and
  the client secret (reset it to see it).
- **GitHub:** under Settings → Developer settings → OAuth Apps, create an OAuth App with homepage
  `https://manufactory.neverendingcode.com` and the callback URL above as its "Authorization
  callback URL". Copy the client ID, and generate a client secret.

The scopes are the SDK's defaults, Discord's `identify email` and GitHub's `read:user user:email`;
there is nothing to set. The API accepts only these exact callback URLs (it pins the redirect URI),
so register them exactly. After `--recreate`, `curl -s http://127.0.0.1:8087/api/health` lists the
live providers in `"providers"`; a provider with only one of its two variables set is left out,
with a warning in the API's log.

## Rollback

Point `:current` at an older build, then rerun steps 3 to 6:

    docker image ls manufactory-api            # the sha tags kept (3)
    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh --rollback <sha>

which is `docker tag manufactory-{api,web}:<sha> manufactory-{api,web}:current` followed by
`--recreate`. **Migrations are forward-only**: an older API on a database that a newer one
migrated may fail. Check `apps/api/migrations` between the two commits before rolling back
across a migration.

A rollback keeps the game's own core: the templates are rendered from the current checkout, so
the API stays on `manufactory-supertokens`. Going back to the shared core is not a rollback
target, because the accounts are now in the game's own core.

## Where the secrets live

| Secret                                                  | Where                                                                                                                      | Source                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Database password (in `DATABASE_URL`)                   | `templates-user/my-manufactory-api.xml` (masked), the role in `postgresql16`, and the API container's env                  | Generated by step 3 on the first deploy                       |
| Core database password (in `POSTGRESQL_CONNECTION_URI`) | `templates-user/my-manufactory-supertokens.xml` (masked), the role in `postgresql16`, and the core container's env         | Generated by step 3 on the first run with the core            |
| The core's API key (`API_KEYS`, `SUPERTOKENS_API_KEY`)  | `templates-user/my-manufactory-supertokens.xml` and `my-manufactory-api.xml` (both masked), and both containers' env       | Generated by step 4 on the first run with the core, then kept |
| Optional: `ADMIN_TOKEN`, `DISCORD_*`, `GITHUB_*`        | Lines you add to `/boot/config/plugins/dockerMan/templates-user/my-manufactory-api.xml` (`Mask="true"`), then `--recreate` | You (see "Adding a variable")                                 |

`SMTP_*` lines left in the API template from before the OAuth change are no longer read and can be
deleted.

Nothing secret is in the repo, an image layer, a build arg or the script's output. The script
passes the password to `psql` on stdin, and the container env through a temporary `--env-file`
(mode 600, in `/tmp`, deleted at exit), never on a command line.

A password is put in a statement only when it is new (or its role is): once, on the first
deploy (and once more for the core's role, on the first run with the core). `postgresql16` runs
with `log_statement = none`, so a successful `ALTER ROLE` is not logged. A _failed_ one can still
be: `log_min_error_statement` (default `error`) logs the statement text of an erroring
statement, password included. If step 3 ever reports an error, check
the Postgres log and rotate the password (delete `DATABASE_URL`'s line from the API template and
rerun; a new one is generated and set). Its `pg_hba` already takes password logins from pgnet
(SuperTokens and Linkwarden log in that way).

The core's secrets rotate the same way. Delete the `API_KEYS` line (or the
`POSTGRESQL_CONNECTION_URI` line) from `my-manufactory-supertokens.xml` and run `--recreate`. A new
key (or password) is generated, set, and copied to the API.

**Rotate only when the deploy is otherwise a no-op:** a `--recreate` on a running, healthy game,
with nothing else changed. A new password is set on the role in step 3, before the containers are
replaced. If that run then fails, the rollback puts back the old template, holding the old
password, which the role no longer accepts. If that happens, rerun `--recreate`. The template
then lacks the line again, so a new password is generated and set, and the containers start
with it.

`/boot` is FAT, so the templates' mode is whatever its mount gives (root only). Anyone with root on
the server can read them, as with every other Unraid template. **Check that Unraid's `flash` SMB
share is not exported publicly** (Shares → flash → SMB Security Settings: Export "No", or
Private): the templates there hold the database passwords and the SuperTokens key.

## Disk

Builds leave BuildKit cache behind. `docker builder prune` reclaims it; the next build is then
slower.
