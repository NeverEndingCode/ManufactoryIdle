# Phase 1 — status and open findings

**Status:** Complete. All 16 planned tasks done, plus two unplanned fixes (R32, and the
milestone knife-edge). Phase 1's stated deliverable — a playable game in the terminal —
is met. One design gap found by the simulator, described below.
**Branch:** `worktree-phase-1-engine`
**Tests:** rational 67/67 · engine 332/332 · content 79/79 · sim 69/69 (547 total) ·
lint, typecheck and `content:check` all clean.
**Date:** 2026-09-06

---

## What is built

The whole engine, per spec Section C:

| | |
|---|---|
| Content schema extensions, indexed graph, exact per-unit expansion vectors | Tasks 1–3 |
| `WorldState`, seeded xoshiro128** PRNG, canonical serialization | Task 4 |
| Cost curves, purchase ladder, piecewise-linear softcaps | Task 5 |
| Machine capacity — pooled per lane-class, mark-weighted (ruling R5) | Task 6 |
| Storage, Quantum Storage, the `bound` tier | Task 7 |
| The waterfall allocation | Task 8 |
| Item states and the constraint-pinning fixed point | Task 9 |
| Power equilibrium, bottleneck reporting, the `solve` entry point | Task 10 |
| Event-driven `resolve` | Task 11 |
| All eleven action reducers and the `apply` dispatcher | Tasks 12–13 |
| Spec E.6 property suite and fuzzer (`fast-check`, seed 20260904) | Task 14 |
| Pin/unpin limit-cycle fix (unplanned, ruling R32) | Task 14b |
| Milestone knife-edge fix (unplanned, see below) | Task 14c |
| `apps/sim`, `sim run`, the four policies and the report | Task 15 |
| `sim play` — the Ink terminal client, with `explain` and `assert` | Task 16 |

Phase 1's stated deliverable, a playable game in the terminal, is met.

---

## The open Critical — split-invariance breaks at a milestone knife-edge

**One property test is red and should stay red until this is fixed.**
`properties.test.ts`, "holds on random states for windows well under the offline cap".

> **RESOLVED in `fb7ae51`, and the diagnosis below was WRONG.** It attributed the divergence
> to the two paths computing the milestone-completion *instant* differently. They do not — the
> instants agree, and once the real defect is fixed they coincide bit-for-bit.
>
> The actual cause was in `spendInOrder` (`packages/engine/src/economy/storage.ts`):
> `canAffordLiquid` sums `stored + quantum` in one `.plus()` and compares once, while
> `spendInOrder` decomposes the same spend field-by-field. Different split anchors integrate
> `quantum` to values that agree in aggregate but differ by ~5e-12 per field — enough to trip
> `spendInOrder`'s defensive residual check, making it silently **decline a spend** the other
> arrangement completed, and deferring an entire tier's new production rate. Measured pre-fix,
> the split path's milestone fired **1.8518ms later**; that delay is the decline-and-defer, not
> a differently-computed instant.
>
> `spendForBuild` shares the same internals and was silently exposed to the identical bug for
> machine build costs — a spurious decline there is a player pressing buy and nothing happening.
> The same fix covers it.
>
> Fixed by a `SPEND_RESIDUAL_TOLERANCE` set two to three orders of magnitude above the
> worst-case accumulation one resolve can produce (`MAX_EVENTS` plus the coarse tail caps a
> resolve near 10,482 steps, so ~2.3e-12 relative). A review confirmed the tolerance cannot
> manufacture value: `canAffordLiquid`/`canAffordBuild` gate entry on the same state, so only
> renormalization noise reaches the residual check, and genuine shortfalls still reject.
>
> The original text is kept below because it records what the symptom looked like before it was
> understood — and because the horizon and split-point evidence in it remains correct and was
> what established the defect as structural rather than float noise.

### What happens (as originally mis-diagnosed)

`resolve(s, 2t) ≡ resolve(resolve(s, t), t)` fails when a long uninterrupted resolve
crosses a milestone completion while an item sits near zero.

At the milestone instant, `iron_plate`'s liquid balance *after* `spendFromLiquid`
deducts the milestone cost lands on **opposite sides of zero** in the two paths. The
whole path computes it as pinned-EMPTY (`have <= 0`), fires an extra `unpin` micro-step
then a `drain`. The split path computes it as not-empty (`have > 0`) and fires a `fill`
directly. A sign-flip in a discrete classification, driven by the two paths computing
the milestone-completion *instant itself* differently — continuous Decimal integration
versus a fresh `solve()` plus `nextDiscontinuity` at the split boundary.

### Why it is Critical, not a rounding nit

It was first characterised as ~6e-7 accumulated float error. **It is not.** Measured:

- **Horizon scan** (fixed 2×): flat at ~1e-14 for `halfMs` from 1,000 to 700,000, then
  discontinuously **1.875e-3** at 730,075 (where a milestone falls inside the window),
  then **229× relative error** at 900,000. A step function, not a smooth curve.
- **Split-point scan** (fixed total): divergence bit-for-bit identical across split
  points from 600,000 to 1,400,000 — invariant to *where* the split lands. Accumulated
  error would grow with position.

Both signatures say structural mechanism, not accumulation. And the magnitude is
unbounded in practice: one input over from the observed case gives 229×.

A long uninterrupted resolve **is** an offline claim. So a player returning after eight
hours whose factory crossed a milestone can get a materially different result than the
same span played online — which is the exact disagreement the single-code-path design
exists to prevent.

### Confirmed pre-existing

Reverting the Task 14b fix and re-running the scan gives bit-for-bit identical numbers.
Independent of that work.

### Do not

- Do not loosen the 1e-8 tolerance. The divergence is structural and unbounded; a wider
  tolerance would hide it rather than accommodate physics.
- Do not build `sim run` on this. Its purpose is measuring time-to-tier by driving
  `resolve()` over long horizons crossing milestones — precisely the failing case. Its
  numbers would be wrong in a way that reads as a balance finding rather than an engine
  defect.

---

## The open finding — the bottleneck report cannot say "your storage is full"

**The `bottleneck` policy exists to test whether the game's own advice is any good. It
found that the advice is wrong, in a state every player will reach.**

`sim run --policy bottleneck --until tier:2` never finishes. It reaches tier 1 in 5m46s
and then sits for the entire remaining budget — **19d 23h of dead time**, against
`greedy`'s 3h26m to tier 2 and `optimal`'s 1h46m.

### The mechanism, confirmed by probe rather than by reading

After 400 decision rounds the stuck state is exact:

| | |
|---|---|
| `stored.iron_plate` | 300 — exactly `baseStorageCap` |
| `quantum.iron_plate` | 1200 — exactly `baseQuantumCap` |
| liquid total | **1500**, against tier 2's requirement of **2000** |
| `storageLevel`, `qsLevel` | all `0` — the policy bought no upgrade, ever |
| `iron_plate` entry | `allocated: 0`, `limitedBy: "make_plate"` |
| report | `{ recipe, make_plate, machinesToClear: 1 }` |

Production has stopped dead, storage is exactly full, the tier is unreachable without a
storage purchase — and the game says *buy another constructor*.

Two separate causes compound:

1. **`Bottleneck` has no vocabulary for this.** Its two kinds are `recipe` and `power`
   (`packages/engine/src/solve/bottleneck.ts:16-21`). A storage cap is the binding
   constraint here and the type cannot name it, so the reporter falls through to the
   recipe it *can* name.
2. **The `max(1, ...)` floor manufactures a recommendation from nothing.**
   `machinesToClearRecipe` computes `target = allocated * 1.1` for an unbounded entry;
   with `allocated` at 0 that is 0, the shortfall is 0, and `Math.max(1, 0)` turns "no
   machine would help" into "buy 1 machine" (`bottleneck.ts:50`).

`greedy` escapes only incidentally: storage and QS are ordinary "cheapest affordable"
candidates for it, so it buys them without ever being advised to.

### Why this matters more than a policy losing a race

This is not the sim being pessimistic. It is the engine's advice channel — the thing
`sim play`'s `explain` prints and the future UI will surface — being confidently wrong
at the exact moment a player is stuck and looking for guidance. A player following it
buys constructors forever.

**It is a design gap, not a regression.** Spec 4.5 defines the report as recipe-or-power;
nothing was broken by Tasks 15–16. Fixing it means extending the `Bottleneck` type with a
storage kind, which is a spec change and therefore a Phase 2 decision, not a quiet
Phase 1 edit.

**Recommended:** add a `{ kind: "storage" }` variant naming the capped item and the
upgrade that would clear it, and drop the `max(1, ...)` floor in favour of returning "no
machine helps" honestly. Then re-run the four-policy comparison; `bottleneck` should
land near `greedy` or better, and if it does not, the advice still needs work.

---

## Deferred, with reasons

| Item | Why deferred |
|---|---|
| `entries`/`allocations` reconciliation early-exit when no sweep touched anything | Correct but unconditional; a Minor optimisation on the common case |
| `installedUnits` / `ladderInput` duplication | Same mark-weighted sum in two files. Now asserted equal by a property, so the `UPGRADE_MARK` guarantee is structural rather than coincidental — but de-duplicating would be better |
| `resolve.test.ts` stale comment referencing a pre-fix 0.98 clock | Harmless; the test asserts a range, not the clock |
| `fireDueTimers` comparator not antisymmetric for duplicate timer ids | Degenerate and unreachable with one timer kind in Phase 1 content |
| Task 14's report names the wrong item for the flapping bug | It says `iron_ore`; it is `iron_ingot`, and the imbalance is 1 smelter against 4 constructors. **Corrected here — do not use that report as a spec** |
| Task 14b's report calls the residual accumulated float error | It is structural. **Corrected here** |

---

## Rulings made during Phase 1

| # | Ruling |
|---|---|
| R20 | Task 1 must not regress three Phase 0 hardenings (non-mapping YAML throws, `Rate` refinement, strict Zod objects) |
| R21 | `toApproximateNumber` may return to the `rational` barrel — plain division, no transcendental; `powerAtClock` stays unexported |
| R22 | Prototype-key hazard applies to construction as well as reads, everywhere |
| R23 | Keep the fixture's machine class named `constructor` — it is a deliberate canary |
| R24 | Keep `Record` rather than switching to `Map` mid-plan |
| R25 | Do not ban prototype-colliding ids in the schema; the engine must be robust to content it did not validate |
| R26 | No `git stash` — the stack is shared across worktrees |
| R27 | The plan predates a fixture change; verify fixture-derived values rather than trusting a brief |
| R28 | Check the prototype hazard mechanically (grep the diff), not from memory |
| R29 | Boundaries must be asserted *and* bite-checked, not only hand-checked |
| R30 | Enforce the EMPTY invariant in the fixed point via a forward-topological clamp, not in the requirement walk |
| R31 | `entries`/`allocations` staleness deferred to Task 14's property, which forced the fix |
| R32 | Fix the pin/unpin limit cycle before the simulator |

---

## Recommended next steps, in order

1. ~~Fix the milestone knife-edge divergence.~~ **Done** in `fb7ae51` — see the correction
   above. Horizon scan is now flat from 1e-15 to 8e-12 with no step at the milestone boundary,
   the 229× case is 2.3e-14, and the split-point scan is position-invariant at ~7.5e-12.
2. ~~Tasks 15–16, the simulator.~~ **Done** in `ac58fc6` and `ba79ea0`.
3. **Give the bottleneck report a storage kind** — see the open finding above. This is the
   first thing Phase 2 should do, because every balance number measured before it is
   measured against advice known to be wrong.
4. Phase 2's pacing gates must assert absolute tier times, never a policy ordering —
   carried forward from Phase 0, and now doubly relevant: `bottleneck` losing to `greedy`
   is a real finding, not a test to be tuned away.

## A note on two overturned diagnoses

Twice in this phase a confident root-cause was wrong, and both times the correction came from
someone instrumenting rather than reasoning:

- Task 14's report named `iron_ore` as the flapping item; it was `iron_ingot`, with the
  imbalance being 1 smelter against 4 constructors.
- This document attributed the knife-edge to differently-computed milestone instants; the
  instants agreed all along, and the fork was a spuriously-declined spend.

Both were plausible, both were adjacent to something true, and both would have sent the next
person down the wrong chain. Worth remembering when a report cites a cause: the citation is
the part to check.
