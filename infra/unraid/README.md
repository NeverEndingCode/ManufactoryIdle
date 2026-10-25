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

## First deploy

The branch or commit must be pushed to `origin` (the public GitHub repo). On the server:

    git clone --branch <branch> https://github.com/NeverEndingCode/ManufactoryIdle.git \
      /mnt/user/appdata/manufactory/src
    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh <branch-or-sha>

It runs, in order:

1. Clone or fetch the repo into `/mnt/user/appdata/manufactory/src` and check out the ref
   (a branch name means `origin/<branch>`).
2. Build both targets from `git archive` of that commit (so only committed files go in), web with
   `SOURCE_COMMIT=<full sha>` for the footer's source link; tag `:<12-char sha>`, then `:current`
   once both built.
3. Create the `manufactory` role (no superuser) and the `manufactory` database it owns in
   `postgresql16` if missing, with a generated password (kept from the existing template on later
   runs). A database owned by someone else is handed to `manufactory`. This runs as the
   container's own admin role, read at run time from its `POSTGRES_USER` (`docker exec
postgresql16 printenv POSTGRES_USER`), so no admin name is in the repo.
4. Render `templates/my-manufactory-{api,web}.xml` into
   `/boot/config/plugins/dockerMan/templates-user/` (mode 600). `<Config>` entries added there
   by hand are carried over.
5. Recreate the containers (`docker rm -f`, then `docker run` from the rendered template) and add
   both to `/var/lib/docker/unraid-autostart`.
6. Smoke-test `curl -fsS http://127.0.0.1:8087/api/health`, which must say `"accounts":true`.
7. Prune all but the 3 newest sha tags of each image.

If step 5 or 6 fails and containers ran before, it puts back the old images (by ID, retagged
`:current`) and the old templates, restarts them, and exits non-zero.

### Why not `update_container`

Unraid's `update_container <Name>` starts by `docker pull`-ing the template's Repository; for
these local-only images the pull fails and the script skips the container. So `deploy.sh` builds
the `docker run` from the rendered template itself, the way dockerMan's `xmlToCommand` does (name,
network, ports, env, ExtraParams, and the `net.unraid.docker.managed=dockerman` and
`net.unraid.docker.webui` labels). The Docker tab lists them with their templates and can start,
stop and show logs. **Don't use the Docker tab's Update or Edit → Apply on them**: those pull
first too, and can leave the container removed. Edit the template if you need to, then run
`deploy.sh --recreate`.

## Redeploy

    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh <branch-or-sha>

Same steps; the database step only checks. To apply a template change without a build (for
example a variable added in the Docker tab or on the flash drive):

    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh --recreate

## Rollback

Point `:current` at an older build, then rerun step 5 (and 6):

    docker image ls manufactory-api            # the sha tags kept (3)
    bash /mnt/user/appdata/manufactory/src/infra/unraid/deploy.sh --rollback <sha>

which is `docker tag manufactory-{api,web}:<sha> manufactory-{api,web}:current` followed by
`--recreate`. **Migrations are forward-only**: an older API on a database that a newer one
migrated may fail. Check `apps/api/migrations` between the two commits before rolling back
across a migration.

## Where the secrets live

| Secret                                                     | Where                                                                                                     | Source                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Database password (in `DATABASE_URL`)                      | `templates-user/my-manufactory-api.xml` (masked), the role in `postgresql16`, and the API container's env | Generated by step 3 on the first deploy                       |
| `SUPERTOKENS_API_KEY`                                      | `templates-user/my-manufactory-api.xml` (masked) and the container's env                                  | Copied on every deploy from the core's `API_KEYS` (first key) |
| Optional: `ADMIN_TOKEN`, `SMTP_*`, `DISCORD_*`, `GITHUB_*` | Add them to the API template in the Docker tab or on the flash drive (Mask on), then `--recreate`         | You (see `apps/api/README.md`)                                |

Nothing secret is in the repo, an image layer, a build arg or the script's output. The script
passes the password to `psql` on stdin, and the container env through a temporary `--env-file`
(mode 600, deleted at exit), never on a command line. The password is put in a statement only
when it is new (or the role is): once, on the first deploy. `postgresql16` runs with
`log_statement = none`, so even that is not logged, and its `pg_hba` already takes password logins
from pgnet (SuperTokens and Linkwarden log in that way). `/boot` is FAT, so the templates' mode is
whatever its mount gives (root only); anyone with root on the server can read them, as with every
other Unraid template.

## Disk

Builds leave BuildKit cache behind. `docker builder prune` reclaims it; the next build is then
slower.
