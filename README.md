# Manufactory Idle

An idle/incremental factory game that takes AdVenture Communist's lane-and-tier
progression structure, replaces its free-cascade economy with a real recipe graph
drawn from Satisfactory, and adds a power grid with Spaceplan-style manual generation.

No ads. No dark patterns. No monetization. Self-hosted. Built to stay interesting
for years.

## Status

**Phases 0 to 3 complete; Phase 4, the web client, in progress.** Phase 3, the server:
guest play over HTTP (3a), optional accounts with SuperTokens (3b), and the anti-cheat
guards, cleanup job and admin content migrate (3c); see
[`apps/api/README.md`](apps/api/README.md). The monorepo, its packages (`rational`,
`content`, `engine`, `sim`), the `apps/api` server and the `apps/web` client, CI
(including a real-Postgres job for the API), and local infra (Postgres + SuperTokens via
Docker Compose) are in place, with the test suite, lint, typecheck and
`pnpm content:check` all green. `pnpm --filter @manufactory/api dev` and
`pnpm --filter @manufactory/web dev` run the game locally on PGlite with no Docker. Local play needs two terminals:

    pnpm --filter @manufactory/api dev    # the API, on port 8787
    pnpm --filter @manufactory/web dev    # the client; then open http://localhost:5173

The Vite dev server proxies the API; if the API listens elsewhere (`PORT=9000`), start the
client with `API_PORT=9000`. Every D.1 action is playable in the browser; `web-play` in CI
proves tier 10 through the client's own builders.

There is deliberately no test count here. It was wrong three times before it was removed —
run `pnpm test` for the number, which is the only place it cannot go stale.

| Document | What it is |
|---|---|
| [`manufactory-idle-spec.md`](manufactory-idle-spec.md) | The original full-game specification — all systems, all progression layers |
| [`docs/superpowers/specs/2026-09-01-engine-core-design.md`](docs/superpowers/specs/2026-09-01-engine-core-design.md) | **Complete design for Spec 1 (engine core).** Decision record plus Sections A–F. **Supersedes the original spec where they disagree** |
| [`manufactory-idle-mvp.html`](manufactory-idle-mvp.html) | Single-file browser prototype — waterfall solver, split bars, backpressure, byproduct triangle, the tap |

The original spec is decomposed into four, of which the engine core is the first:

| Spec | Covers | Status |
|---|---|---|
| **1. Engine core** | Solver, storage, power, offline resolution, server authority, simulator | **Design complete** |
| 2. Progression | Alt recipes, ranks, Pioneers, contracts, Phases, Engineer Level, disruptions | Not started |
| 3. Live content | Expeditions, Deep Core, daily contracts, achievements, leaderboards | Not started |
| 4. Statistics & platform | Statistics, graphs, PWA, push notifications | Not started |

### Build order for Spec 1

| Phase | Deliverable | Ends in |
|---|---|---|
| 0 | Monorepo, Postgres, SuperTokens, engine skeleton, content validator, CI | Green pipeline — **done** |
| 1 | Engine + simulator | A playable game in the terminal — **done** |
| 2 | Calibrated content | A game that is *paced* — **done** |
| 3 | Server + authority | A game with a backend — **done** |
| 4 | Web client | A game other people can play — **in progress** (4a: shell and lane view; 4b: drawer, priority, dock and tap) |

## Design pillars

1. **Idle at its core.** Close the app for a day, come back to meaningful progress.
   Nothing decays. Nothing is lost by not playing.
2. **Challenge lives in decisions, not labor.** The player chooses recipes, orders
   priorities, and budgets power. The engine does all routing and arithmetic.
3. **No management-game surface area.** No belts, no placement, no ratios to
   hand-solve. If the player has to do math the engine could do, that is a design bug.
4. **Every purchase must visibly help.**
5. **Content is data.** The recipe graph is a versioned seed file, not code.

## The MVP prototype

Open `manufactory-idle-mvp.html` in a browser. No build step, no dependencies.

## License

GPL-3.0. The project reuses GPL-3.0 code from
[`EvanTrow/Satisfactory-Colab-Modeler`](https://github.com/EvanTrow/Satisfactory-Colab-Modeler)
(`packages/solver`, `packages/gamedata`, `packages/rational`), which makes this a
derivative work. Since the web client ships JavaScript to every player's browser,
the entire project is source-available.
