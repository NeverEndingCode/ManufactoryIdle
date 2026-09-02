# Manufactory Idle

An idle/incremental factory game that takes AdVenture Communist's lane-and-tier
progression structure, replaces its free-cascade economy with a real recipe graph
drawn from Satisfactory, and adds a power grid with Spaceplan-style manual generation.

No ads. No dark patterns. No monetization. Self-hosted. Built to stay interesting
for years.

## Status

**Design phase.** The engine core design is complete and ready for an implementation plan. No code has been written yet.

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
| 0 | Monorepo, Postgres, SuperTokens, engine skeleton, content validator, CI | Green pipeline |
| 1 | Engine + simulator | A playable game in the terminal |
| 2 | Calibrated content | A game that is *paced* |
| 3 | Server + authority | A game with a backend |
| 4 | Web client | A game other people can play |

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
