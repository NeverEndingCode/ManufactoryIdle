# Manufactory Idle

An idle/incremental factory game that takes AdVenture Communist's lane-and-tier
progression structure, replaces its free-cascade economy with a real recipe graph
drawn from Satisfactory, and adds a power grid with Spaceplan-style manual generation.

No ads. No dark patterns. No monetization. Self-hosted. Built to stay interesting
for years.

## Status

**Design phase.** No implementation has started.

| Document | What it is |
|---|---|
| [`manufactory-idle-spec.md`](manufactory-idle-spec.md) | The original full-game specification — all systems, all progression layers |
| [`docs/superpowers/specs/2026-09-01-engine-core-design.md`](docs/superpowers/specs/2026-09-01-engine-core-design.md) | The working design for Spec 1 (engine core). Decision record + Section A. **Supersedes the original spec where they disagree** |
| [`manufactory-idle-mvp.html`](manufactory-idle-mvp.html) | Single-file browser prototype — waterfall solver, split bars, backpressure, byproduct triangle, the tap |

The original spec is being decomposed into four specs, of which the engine core is
the first. See §1 of the engine core design.

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
