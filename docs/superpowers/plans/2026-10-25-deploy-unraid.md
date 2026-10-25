# Deploy to Unraid: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the game to the user's Unraid server, reachable at `https://manufactory.neverendingcode.com` through their existing Cloudflare tunnel.

**Architecture:**
- Two container images built from one multi-stage Dockerfile:
  - `api`: Node 22, running `apps/api` with its content bundle.
  - `web`: Caddy, serving the built `apps/web/dist` and proxying `/api`, `/auth` to the API.
- Both run on the server's existing `pgnet` Docker network, alongside `postgresql16` and `SuperTokens---PostgreSQL`.
- Only `web` is published, on host port 8087. `cloudflared`, on the default bridge, reaches it at `http://192.168.68.50:8087`.
- A deploy script builds the images on the server from a pushed commit and (re)creates the containers from Unraid templates.

**Tech Stack:** Docker (BuildKit), node:22, caddy:2, pnpm 10, Unraid dockerMan templates.

**Spec:**
- `docs/superpowers/specs/2026-10-17-phase-4-web-client-design.md`:
  - W-2: one origin;
  - W-25: GPL source link, deployment example;
  - W-15: SuperTokens, cookie mode.
- `docs/superpowers/specs/2026-10-16-phase-3-server-design.md`:
  - R-16: accounts are optional, and API_DOMAIN / WEBSITE_DOMAIN are required with them;
  - R-24: reset mail goes through SMTP or nothing;
  - R-23: per-IP guest limit.

## Rulings made in this plan

- **D-1. Two containers, not one.**
  - *Why:* Caddy and Node each run as PID 1 with their own restart and logs, which is how Unraid manages containers.
  - *Cost if wrong:* one more container in the Docker tab.
- **D-2. Images are built on the server,** from `git archive` of a commit that is pushed to `origin`. There is no registry.
  - The image tag is the short commit, plus a moving `:current` tag that the Unraid templates use.
  - *Why:* nothing to host and no credentials to manage.
  - *Cost if wrong:* the build uses the server's CPU for a few minutes per deploy.
- **D-3. TLS ends at Cloudflare.** The `web` container serves plain HTTP on :80 (`SITE_ADDRESS=:80`). The canonical scheme stays https for SuperTokens: `API_DOMAIN = WEBSITE_DOMAIN = https://manufactory.neverendingcode.com`, so cookies are `Secure`.
- **D-4. Real client IPs** (R-23: 5 guest creations per IP per hour).
  - Behind tunnel → Caddy → API, every request would otherwise share one IP.
  - Caddy takes the client from `Cf-Connecting-Ip`, using the global options `servers { trusted_proxies static private_ranges; client_ip_headers Cf-Connecting-Ip }`, and sends `X-Forwarded-For {client_ip}` upstream.
  - The API sets `TRUST_PROXY=172.19.0.0/16`, pgnet's subnet, so `request.ip` is the player's address.
  - *Cost if wrong:* a LAN client could spoof `Cf-Connecting-Ip` to dodge the guest limit. That's acceptable; the limit is anti-abuse, not auth.
  - The repo's example `infra/Caddyfile` gains this as an opt-in block driven by env (`CLIENT_IP_HEADER`), so the localhost example is unchanged.
- **D-5. The API's database:** a new role `manufactory` and database `manufactory` on `postgresql16`, with a generated password stored only in the API's Unraid template (masked). The API runs its migrations at boot.
- **D-6. The API runs TypeScript through `tsx`,** as `pnpm start` does. That matches the repo, where every package exports `./src/index.ts`. The image runs `pnpm --filter @manufactory/api start` with `HOST=0.0.0.0`, `PORT=8080`.
- **D-7. The web build gets its commit.** It passes `SOURCE_COMMIT` (the deployed short sha), so the footer links to the source at that commit (W-25). Source maps ship.
- **D-8. Secrets never enter the repo or a log.**
  - The deploy script reads the SuperTokens API key from the running core's container env, and writes it straight into the API template.
  - Templates are written mode 600, and their secret fields carry `Mask="true"`.

## Global Constraints

- **Where to work:**
  - Repo work is in `.claude/worktrees/phase-4c`, branch `deploy-unraid` (from `main` at 018120e).
  - Server work is done only by the controller over `ssh -i ~/.ssh/unraid root@192.168.68.50`, never by an implementer.
- **Never run `pnpm format`.** Run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, sequentially, in the foreground.
- **Local verification uses podman,** which is installed. Building images and running them locally is allowed. Remove every container and pod you start, by name, when done. Never `pkill -f`.
- **Commit trailers:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ`. Do not push.

## Review Focus

- **No secret ends up in an image layer, a build arg, the repo or the script's output.**
- **Caddy's client-IP chain actually yields the player's IP at the API.** Check it with a local request that carries `Cf-Connecting-Ip`, and read `request.ip` back.
- **The web image serves `/assets/*` immutable and everything else no-cache,** with `/api` and `/auth` proxied. This must be unchanged from `infra/Caddyfile`'s rules.
- **The API image starts with the env the templates give it and runs its migrations.**

---

### Task 1: Container images, verified locally

**Files:**
- Create: `infra/docker/Dockerfile`, with multi-stage targets `api` and `web`.
- Create: `.dockerignore`.
- Modify: `infra/Caddyfile`, to add D-4's opt-in client-IP block.

- [ ] **Dockerfile.**
  - A `base` stage on `node:22-bookworm-slim`, with corepack pnpm pinned to the root `packageManager`.
  - A `deps` stage that runs `pnpm install --frozen-lockfile` with only the manifests copied first, for layer caching.
  - A `build-web` stage that runs `pnpm --filter @manufactory/web build` with `ARG SOURCE_COMMIT`.
  - Target `api`: workspace source, production run via `tsx`, `EXPOSE 8080`, a non-root `node` user, and a `HEALTHCHECK` on `/api/health`.
  - Target `web`: `caddy:2` with `infra/Caddyfile` and the dist at `/srv/manufactory/web`, `EXPOSE 80`, and env defaults `SITE_ADDRESS=:80`, `API_UPSTREAM=manufactory-api:8080`.
- [ ] **`.dockerignore`.** Excludes `node_modules`, `.git`, `.claude`, `.superpowers`, `dist`, `.turbo`, test artefacts and `*.env`.
- [ ] **Caddyfile.** When `{$CLIENT_IP_HEADER}` is set, add the D-4 global options and `header_up X-Forwarded-For {client_ip}`. When unset, nothing changes.
  - Do this so the localhost example still validates.
  - If Caddy can't express "only when set" cleanly, make it a separate snippet imported by the container image, and say so.
- [ ] **Verify locally with podman.**
  - Build both targets.
  - Run a pod with `postgres:16` and the api (accounts off, `TRUST_PROXY` set to the pod's subnet or `127.0.0.1`) and the web.
  - `curl` against the web container:
    - `/` gives index.html with no-cache;
    - an `/assets/*` file gives immutable;
    - a missing asset gives 404;
    - `/api/health` gives 200;
    - `POST /api/guests` with a `Cf-Connecting-Ip` header gives 201;
    - the API log, or a debug request, shows that IP as `request.ip`.
  - Six `POST /api/guests` with the same header: the 6th is 429. A different header value still gets 201.
  - Remove everything you started.
- [ ] **Run the gates.** `pnpm test`, `pnpm lint`, `pnpm typecheck`. Commit "Deploy: container images for the API and the web client".

### Task 2: The Unraid deploy script, templates and docs

**Files:**
- Create: `infra/unraid/deploy.sh`.
- Create: `infra/unraid/templates/my-manufactory-api.xml` and `my-manufactory-web.xml`, with placeholders and no secrets.
- Create: `infra/unraid/README.md`.
- Modify: `infra/README.md`, to link it.

- [ ] **`deploy.sh`.** It runs on the server as root and takes `<git-ref>`. It is idempotent and uses `set -euo pipefail`. In order, it:
  1. clones or fetches the public repo into `/mnt/user/appdata/manufactory/src`, and checks out the ref;
  2. builds both targets, tagged `manufactory-api:<sha>`/`:current` and `manufactory-web:<sha>`/`:current`;
  3. on first run, creates the `manufactory` role and database in `postgresql16`, with a generated password. It is idempotent, and it never prints the password;
  4. renders the two templates into `/boot/config/plugins/dockerMan/templates-user/` (mode 600). It fills in:
     - `DATABASE_URL`;
     - `SUPERTOKENS_CONNECTION_URI=http://SuperTokens---PostgreSQL:3567`;
     - `SUPERTOKENS_API_KEY`, read from the core container's env;
     - `API_DOMAIN`/`WEBSITE_DOMAIN`;
     - `TRUST_PROXY`;
     - `CLIENT_IP_HEADER=Cf-Connecting-Ip`;
     - the host port 8087.

     It keeps the existing password when the template already exists.
  5. recreates both containers through Unraid's `update_container … ca_docker_run_override`, and adds them to `/var/lib/docker/unraid-autostart` if they're absent;
  6. smoke-tests `curl -fsS http://127.0.0.1:8087/api/health`. The output must show `accounts:true`.
  7. prunes `manufactory-*` images older than the last 3 shas.
- [ ] **Templates.** Valid dockerMan XML:
  - `Network` is `pgnet`; `Repository` is `manufactory-api:current` and `manufactory-web:current`;
  - only web publishes 8087→80;
  - secret configs carry `Mask="true"`;
  - icon and WebUI fields are optional.
- [ ] **`README.md`.** Covers the architecture, the Cloudflare route (`http://192.168.68.50:8087`), first deploy, redeploy, rollback (retag `:current` to an older sha, then rerun step 5), and where the secrets live.
- [ ] **Check the script.** Run `bash -n` and `shellcheck` if it's available. Don't run it locally.
- [ ] **Run the gates and commit** "Deploy: Unraid deploy script, templates and runbook".
