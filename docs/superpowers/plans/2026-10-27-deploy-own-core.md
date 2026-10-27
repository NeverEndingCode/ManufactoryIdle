# Deploy: a dedicated SuperTokens core for the game. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The game gets its own SuperTokens core, so its user pool is no longer shared with the user's other app on the same server.

**Architecture:**
- **A third managed container,** `manufactory-supertokens`: `supertokens/supertokens-postgresql:12.3.1`, on `pgnet`, with no published port.
- **Its own database and role:** `manufactory_supertokens`, owned by a role of the same name, on `postgresql16`. Like the existing ones, they are created with the container's `POSTGRES_USER`.
- **A generated API key.** Neither the key nor the password is ever printed.
- **The API is repointed.** `deploy.sh` points the API at `http://manufactory-supertokens:3567` with that key.
- **The old shared core is untouched.** Nothing about the existing `SuperTokens---PostgreSQL` container, or its port 3567, changes.

**Spec:** `docs/superpowers/plans/2026-10-25-deploy-unraid.md` (D-1 to D-8), extended here.

## Rulings
- **DC-1. The core is managed by `deploy.sh` like the other two.** It gets the same template, env file, dockerman label and autostart, and is recreated before the API. Its readiness check is `GET /hello` from inside `pgnet`, done through the API container or a short `docker run --network pgnet curlimages/curl`. *Why:* one runbook, and rollback covers it.
- **DC-2. No published port.** Only the API reaches the core, by name. *Why:* least exposure. The shared core's published 3567 stays as it is, since it belongs to the other app.
- **DC-3. Migration.** The game has 0 account players, so switching cores loses nothing.
  - The first run with DC-1 renders `SUPERTOKENS_CONNECTION_URI=http://manufactory-supertokens:3567` and the new key into the API template, replacing the values read from the shared core.
  - It never reads the shared core's key again.
- **DC-4. The core's template follows the existing templates' rules:** secrets masked, mode 600, a `Mask="true"` env file, and the core's env is `POSTGRESQL_CONNECTION_URI` and `API_KEYS`.

## Global Constraints
Work in `.claude/worktrees/phase-4b` on branch `deploy-own-core` (from main dd4ab61).
- Never run `pnpm format`.
- Never run anything in the background, and never `pkill -f`.
- Don't SSH. The controller runs the deploy.
- Use the same commit trailers as before, and don't push.

### Task 1: the core in deploy.sh, its template, and the runbook
- [ ] **`deploy.sh`:**
  - `ensure_database` gains the second role and database, idempotent, with no password printed.
  - A new template, `infra/unraid/templates/my-manufactory-supertokens.xml`, is rendered with its DB URI and a generated API key. An existing template keeps its key and password.
  - The core is recreated first, and waits for `/hello` over `pgnet`.
  - The API template's `SUPERTOKENS_CONNECTION_URI` and `SUPERTOKENS_API_KEY` come from the core's template, not the shared core.
  - The core is included in the autostart, rollback, `--recreate` and prune paths.
  - The smoke test through the core still passes.
- [ ] **`infra/unraid/README.md`:** the architecture, secrets and rollback sections are updated. It names the OAuth variables (`DISCORD_CLIENT_ID`/`_SECRET`, `GITHUB_CLIENT_ID`/`_SECRET`), shows how to add one as a `<Config>` line, and lists the callback URLs `https://manufactory.neverendingcode.com/account/callback/{discord,github}`.
- [ ] **Checks:** `bash -n`, shellcheck through podman, and the stubbed-docker render checks the earlier tasks used. Run the SQL against a throwaway podman `postgres:16` and remove it afterwards. Then `pnpm test`, `pnpm lint`, `pnpm typecheck`. Commit "Deploy: a dedicated SuperTokens core for the game".
