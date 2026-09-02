# Phase 0 — outcomes and carry-forward

**Status:** Phase 0 complete. 160 tests; lint, typecheck and `content:check` all green.
**Branch:** `worktree-phase-0-foundations`, 24 commits, 51 source files.
**Date:** 2026-09-02

This records decisions made during execution that later phases need, and work
deliberately deferred. The plan and spec say what was intended; this says what
was decided while building it.

---

## What shipped

| Package | |
|---|---|
| `packages/rational` | BigInt exact rational arithmetic, vendored GPL-3.0 with a dated modification notice |
| `packages/engine` | Decimal magnitude layer, display formatter, and the purity boundary enforced in lint |
| `packages/content` | Bundle schema, loader, 8 of 11 validator checks, `content:check` CLI, fixture bundle |
| `infra/` | Docker Compose: Postgres 16 + SuperTokens, one instance and two databases |

---

## Carry-forward — things a later phase must not rediscover the hard way

### Phase 2 pacing gates must not assume a policy ordering

The Phase 1 plan's self-review removed an assertion that `greedy` reaches tier 1
before `casual`. On the fixture, greedy spends iron plate on miners that do not
raise plate output, so it can genuinely arrive **later**. That is faithful policy
behaviour and exactly what spec E.2's policy comparison exists to surface.

**Phase 2's CI pacing gates must assert absolute tier times against
`pacing.targetCollectionsToTier`, never a relative ordering between policies.**

### Validator check 7 is not what its spec description says

Spec B.6 defines check 7 as "a machine whose build cost needs an item only that
machine can make." `checkBuildCostsSatisfiable` implements tier ordering only —
it never reads `recipe.machineClass`, so it does not model machine-class
reachability and cannot catch a genuine bootstrap deadlock.

This was found by the final review, which also found that the fixture bundle
*was* such a deadlock and passed validation cleanly. The fixture is fixed; the
check is not.

**A correct implementation needs a fixed-point bootstrap analysis** — at each
tier, iterate over "machine classes I can afford → items I can produce" starting
from recipes with no inputs, and flag any class that never becomes reachable.
That belongs with Phase 2's calibration checks 8-10. The gap is documented in a
comment beside the function so the code does not read as complete.

### The fixture needs an externally-granted starting machine

A literal zero-input bootstrap is impossible: something must grant the first
miners. The Phase 1 plan already anticipates this (it authors starting machines
and asserts they are installed). Any future content bundle inherits the same
requirement — a bundle is not self-starting.

### SuperTokens image pinning does not need Docker

`infra/docker-compose.yml` still references `supertokens-postgresql:latest`. This
was initially parked as "blocked on Docker," which was **wrong**: you can pin to a
published version tag from SuperTokens' release notes, or resolve a digest through
the registry HTTP API, without a daemon and without pulling.

Deferred to the start of Phase 3, when something first connects to these
containers. An unpinned auth core is a supply-chain and reproducibility risk from
that moment on.

### The formatter renders sub-1 values as "0.00"

`plain()` in `packages/engine/src/numbers/format.ts` caps at two decimals. Spec
A.4 zone 2 puts clocks and satisfaction in [0, 1], and sub-1/sec rates are the
normal early-game state of an idle factory — so every one of them renders
`"0.00"` the moment `sim play` draws a screen.

It cannot bite in Phase 0, but it is an **early Phase 1 fix**, not a nicety.

---

## Deliberately deferred, with reasons

| Item | Why it was left |
|---|---|
| Validator checks 8, 9, 10 | Need calibration machinery that arrives in Phase 2 |
| `earliestProduction` / `earliestConsumption` duplication | Their correctness was established by hand-verifying the tier comparisons; a selector-taking helper would cost that by-eye verifiability. The real duplication on this branch is the three test-bundle factories |
| Three test-bundle factories in `schema.test.ts`, `checksum.test.ts`, `graph.test.ts` | Phase 1 will want a fourth; reconcile then, not now |
| `ValidationIssue` defined in `load.ts` | The pure validation modules import a type from the module that does I/O. Type-only today, so no runtime edge, but backwards. Move to `validate/types.ts` when convenient |
| `turbo.json` declaring `outputs: ["dist/**"]` | A no-op for source-only packages that never emit. Reconcile when Phase 1 adds apps with real build output |
| `format:check` absent from CI | The script exists; nothing enforces it |
| Extensionless imports in `packages/rational`'s tests | Inherited from upstream. Typechecks under `moduleResolution: "Bundler"`; will break under NodeNext |
| `README.md` hardcodes a test count | Stale by 9 as of this branch's tip. **Delete the number rather than updating it** — it goes stale on every commit that adds a test, and has already drifted twice in one phase |

---

## Design decisions made during execution

Two resolve genuine ambiguities in the spec and are already reflected in the
Phase 1 plan:

**Machine capacity pools per (lane, machineClass) and distributes proportionally.**
The spec contradicted itself: original §4.2 computes `capacity[R] = machineCount[R] × baseRate[R]`
as though machines are owned per-recipe, while B.2 scopes the cost counter and
purchase ladder to `(lane, class, mark)` — which is what makes `r_eff` exact.
Resolution: `assignedFraction[R] = assignment[R] / installedMachines[lane][class]`,
and `capacity[R] = assignedFraction[R] × installedUnits[lane][class] × baseRate[R] × multipliers[R]`,
with `installedUnits` mark-weighted. Marks are fungible, so the engine never
tracks which physical mark runs which recipe, and a mark upgrade automatically
lifts every recipe in the lane-class.

**Cyclic recipes are forbidden in Phase 1, not solved.** Spec §4.3 explicitly
permits this and §17.2 leaves it open. Cycle detection ships in Phase 0; any
recipe inside a non-trivial SCC is unselectable. The outer waterfall does not
change when an SCC solver is added later.

---

## What the review loop caught

Worth recording, because it calibrates how much to trust a plan going into
Phase 1: **most defects found during execution were in the plan, not in the
implementations.**

- A CI workflow that could not start — `pnpm/action-setup` strict-compares its
  `version` input against `packageManager` and throws when they differ
- A rate regex that accepted `"11.25/4"`, which the paired parser rejects
- A YAML guard where `typeof parsed === "object"` is true for arrays, so a
  misindented file silently vanished with no error and no validation issue
- Formatter test expectations derived from the wrong tier
- An engine purity rule that enforced static imports only, so `Date.now()`,
  `Math.random()` and `await import("node:fs")` all passed
- A fixture bundle that was an unbootstrappable deadlock and validated clean

Every one was found by a reviewer checking against reality — running eslint
against probe files, opening the downstream parser, counting the YAML by hand —
rather than by reading for plausibility.
