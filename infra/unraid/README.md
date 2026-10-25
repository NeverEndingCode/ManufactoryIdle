# Deploying to Unraid

The production deploy of `https://manufactory.neverendingcode.com`, on the Unraid server at
`192.168.68.50`. Everything runs from `infra/unraid/deploy.sh`, as root on the server.

## Architecture

    browser ──https──▶ Cloudflare ──tunnel──▶ cloudflared (default bridge)
                                                  │ http://192.168.68.50:8087
                                                  ▼
       pgnet (172.19.0.0/16) ┌──────────────────────────────────────────────────────┐
                             │ manufactory-web  Caddy, :80 → host 8087               │
                             │   /assets/*, the SPA; /api/*, /auth/* ──▶            │
                             │ manufactory-api  Fastify, :8080 (not published)       │
                             │   ──▶ postgresql16:5432, database + role manufactory  │
                             │   ──▶ SuperTokens---PostgreSQL:3567 (accounts)        │
                             └──────────────────────────────────────────────────────┘

- **Two containers** (D-1), both on `pgnet`, built on the server from `infra/docker/Dockerfile`
  (D-2): `manufactory-api:<sha>` and `manufactory-web:<sha>`, each also tagged `:current`, which
  is what the templates run. There is no registry.
- **TLS ends at Cloudflare** (D-3). The web container serves plain HTTP; `API_DOMAIN` and
  `WEBSITE_DOMAIN` are still `https://manufactory.neverendingcode.com`, so cookies are `Secure`.
- **Client IPs** (D-4): Caddy takes the player's address from `Cf-Connecting-Ip`
  (`CLIENT_IP_HEADER=Cf-Connecting-Ip` with `CLIENT_IP_TRUSTED_PROXIES=private_ranges`; one
  without the other does nothing) and sends it as `X-Forwarded-For`. The API trusts that from
  pgnet (`TRUST_PROXY`, pgnet's subnet, read from `docker network inspect`).
- **Database** (D-5): role and database `manufactory` on `postgresql16`; the API migrates at boot.

## The Cloudflare route

In the tunnel's public hostnames: `manufactory.neverendingcode.com` → service
`http://192.168.68.50:8087`. Nothing else is published; the API is reachable only over pgnet.

Turn on HSTS in Cloudflare (SSL/TLS → Edge Certificates → HTTP Strict Transport Security), where
TLS ends. Keep the `Strict-Transport-Security` line in `infra/Caddyfile` commented: this Caddy
serves plain HTTP.

## First deploy

Before the first run, check that nothing else already uses the names. The script takes over a
role named `manufactory` (it sets its password) and a database named `manufactory` (it makes the
role its owner), and replaces containers named `manufactory-api` and `manufactory-web`.
These should show none of them:

    docker exec postgresql16 psql -U "$(docker exec postgresql16 printenv POSTGRES_USER)" \
      -d postgres -c '\du manufactory' -c '\l manufactory'
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
   failure up to then leaves the running game and `:current` on the old images.
3. Create the `manufactory` role (no superuser) and the `manufactory` database it owns in
   `postgresql16` if missing, with a generated password (kept from the existing template on later
   runs). A database owned by someone else is handed to `manufactory`. This runs as the
   container's own admin role, read at run time from its `POSTGRES_USER` (with
   `docker exec postgresql16 printenv POSTGRES_USER`), so no admin name is in the repo.
4. Render `templates/my-manufactory-{api,web}.xml` into
   `/boot/config/plugins/dockerMan/templates-user/` (mode 600). `<Config>` entries added there
   by hand are carried over.
5. Recreate the containers, API first: build the `docker run` from the rendered template (a
   malformed template stops here, with the old container still up), `docker rm -fv` the old one
   (`-v` drops Caddy's anonymous `/data` and `/config` volumes), run the new one, and wait for
   its HEALTHCHECK. Then add both to `/var/lib/docker/unraid-autostart`.
6. Smoke-test through the published port: `curl -fsS http://127.0.0.1:8087/api/health` must say
   `"accounts":true`, which says only that the SuperTokens env is set. Then
   `/auth/emailpassword/email/exists?email=smoke@example.invalid` must answer `"status":"OK"`;
   that one goes to the core, so a wrong `API_KEYS` or a core the SDK can't talk to fails here.
7. Prune all but the 3 newest sha tags of each image. A failure here is only a warning.

If step 5 or 6 fails and containers ran before, it puts back the old images (by ID, retagged
`:current`) and the old templates, restarts them, and exits non-zero.

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

### Adding a variable (SMTP, `ADMIN_TOKEN`, sign-in providers)

Edit `/boot/config/plugins/dockerMan/templates-user/my-manufactory-api.xml` directly. Add one line per variable before `</Container>`, in the same one-line form as
the others, with `Mask="true"` for a secret:

    <Config Name="SMTP_PASSWORD" Target="SMTP_PASSWORD" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="true">…</Config>

Then apply it without a build:

    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh --recreate

Later deploys carry such lines over. The variables themselves are listed in `apps/api/README.md`.

## Rollback

Point `:current` at an older build, then rerun step 5 (and 6):

    docker image ls manufactory-api            # the sha tags kept (3)
    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh --rollback <sha>

which is `docker tag manufactory-{api,web}:<sha> manufactory-{api,web}:current` followed by
`--recreate`. **Migrations are forward-only**: an older API on a database that a newer one
migrated may fail. Check `apps/api/migrations` between the two commits before rolling back
across a migration.

## Where the secrets live

| Secret                                                     | Where                                                                                                                      | Source                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Database password (in `DATABASE_URL`)                      | `templates-user/my-manufactory-api.xml` (masked), the role in `postgresql16`, and the API container's env                  | Generated by step 3 on the first deploy                       |
| `SUPERTOKENS_API_KEY`                                      | `templates-user/my-manufactory-api.xml` (masked) and the container's env                                                   | Copied on every deploy from the core's `API_KEYS` (first key) |
| Optional: `ADMIN_TOKEN`, `SMTP_*`, `DISCORD_*`, `GITHUB_*` | Lines you add to `/boot/config/plugins/dockerMan/templates-user/my-manufactory-api.xml` (`Mask="true"`), then `--recreate` | You (see "Adding a variable")                                 |

Nothing secret is in the repo, an image layer, a build arg or the script's output. The script
passes the password to `psql` on stdin, and the container env through a temporary `--env-file`
(mode 600, in `/tmp`, deleted at exit), never on a command line.

The password is put in a statement only when it is new (or the role is): once, on the first
deploy. `postgresql16` runs with `log_statement = none`, so a successful `ALTER ROLE` is not
logged. A _failed_ one can still be: `log_min_error_statement` (default `error`) logs the
statement text of an erroring statement, password included. If step 3 ever reports an error, check
the Postgres log and rotate the password (delete `DATABASE_URL`'s line from the API template and
rerun; a new one is generated and set). Its `pg_hba` already takes password logins from pgnet
(SuperTokens and Linkwarden log in that way).

`/boot` is FAT, so the templates' mode is whatever its mount gives (root only). Anyone with root on
the server can read them, as with every other Unraid template. **Check that Unraid's `flash` SMB
share is not exported publicly** (Shares → flash → SMB Security Settings: Export "No", or
Private): the templates there hold the database password and the SuperTokens key.

## Disk

Builds leave BuildKit cache behind. `docker builder prune` reclaims it; the next build is then
slower.
