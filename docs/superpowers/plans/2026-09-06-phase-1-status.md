# Phase 1 — status and open findings

**Status:** Engine complete and property-tested. 14 of 16 planned tasks done, plus one
unplanned Critical fix. One test red, deliberately, on a real defect described below.
**Branch:** `worktree-phase-1-engine`
**Tests:** rational 67/67 · engine 326/327 · content 79/79 · lint, typecheck and
`content:check` all clean.
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

**Not built:** Tasks 15–16, `apps/sim` — `sim run`'s four policies and report, and
`sim play`, the Ink terminal client. Phase 1's stated deliverable ("a playable game in
the terminal") therefore is not met; the engine underneath it is.

---

## The open Critical — split-invariance breaks at a milestone knife-edge

**One property test is red and should stay red until this is fixed.**
`properties.test.ts`, "holds on random states for windows well under the offline cap".

### What happens

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

1. **Fix the milestone knife-edge divergence.** Make both paths agree on the
   milestone-completion instant and on the post-spend classification. Likely shapes: compute
   the milestone instant canonically once, or make the EMPTY classification hysteretic
   across a spend so a boundary balance cannot flip on arithmetic route. The red property
   is the acceptance test.
2. **Then Tasks 15–16**, the simulator, which depend on a trustworthy long-horizon
   `resolve()`.
3. Phase 2's pacing gates must assert absolute tier times, never a policy ordering —
   carried forward from Phase 0.
