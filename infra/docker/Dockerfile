# syntax=docker/dockerfile:1
# Container images for the Unraid deploy (docs/superpowers/plans/2026-10-25-deploy-unraid.md).
# Build from the repo root, which is the context:
#
#   docker build -f infra/docker/Dockerfile --target api -t manufactory-api .
#   docker build -f infra/docker/Dockerfile --target web --build-arg SOURCE_COMMIT=<40-hex sha> \
#     -t manufactory-web .
#
# No secret is baked in: the API's DATABASE_URL, SuperTokens key and ADMIN_TOKEN come from the
# container's env at run time. SOURCE_COMMIT is the only build arg, and it is public (W-25).

# ---- base: Node 22 with the repo's pinned pnpm (root package.json "packageManager") ----------
FROM node:22-bookworm-slim AS base
# Corepack's cache lives outside /root so the non-root `node` user can run the same pnpm.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/opt/pnpm \
    CI=true
RUN corepack enable \
 && corepack prepare pnpm@10.24.0 --activate \
 && chmod -R a+rX "$COREPACK_HOME" \
 && pnpm --version
WORKDIR /app

# ---- deps: every workspace's dependencies, from the manifests alone (layer cache) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/sim/package.json apps/sim/
COPY apps/web/package.json apps/web/
COPY packages/content/package.json packages/content/
COPY packages/engine/package.json packages/engine/
COPY packages/rational/package.json packages/rational/
RUN pnpm install --frozen-lockfile

# ---- deps-api: only the API and the workspaces it depends on (no web toolchain) -----------
FROM base AS deps-api
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/sim/package.json apps/sim/
COPY apps/web/package.json apps/web/
COPY packages/content/package.json packages/content/
COPY packages/engine/package.json packages/engine/
COPY packages/rational/package.json packages/rational/
# The store is dropped in the same layer: node_modules holds copies, not links, of it. (pnpm
# still installs the root's dev tools; dropping them would need a lockfile change.)
RUN pnpm install --frozen-lockfile --filter "@manufactory/api..." \
 && rm -rf "$(pnpm store path)"

# ---- build-web: the static client, with the commit for the footer's source link (D-7) -----
FROM deps AS build-web
# buildInfo() (apps/web/scripts/build-info.ts) takes it only as 40 lowercase hex; there is
# no .git in the context, so anything else leaves the footer without a commit.
ARG SOURCE_COMMIT=""
ARG SOURCE_REPO=""
COPY . .
RUN pnpm --filter @manufactory/web build

# ---- api: Fastify through tsx, as `pnpm start` runs it (D-6) -------------------------------
FROM deps-api AS api
# Owned by root: the `node` process can read its source but not rewrite it (tsx caches in /tmp).
COPY . .
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
USER node
WORKDIR /app/apps/api
EXPOSE 8080
# --start-interval (Docker 25+) probes every 2s during the start period, so a deploy sees
# "healthy" within seconds of the API listening, not after the first 30s interval.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# `pnpm start`'s own command, run without pnpm: pnpm exits 1 on SIGTERM ("Command failed with
# signal"), while tsx relays the signal to main.ts, whose shutdown closes Fastify and the pool
# and exits 0.
CMD ["node_modules/.bin/tsx", "src/main.ts"]

# ---- web: Caddy serving the built client and proxying /api and /auth (D-1, D-3) ------------
FROM caddy:2 AS web
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build-web /app/apps/web/dist /srv/manufactory/web
ENV SITE_ADDRESS=:80 \
    API_UPSTREAM=manufactory-api:8080 \
    WEB_ROOT=/srv/manufactory/web
EXPOSE 80
# Busybox wget (the image is Alpine); SITE_ADDRESS is :80 in this image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1/ || exit 1
