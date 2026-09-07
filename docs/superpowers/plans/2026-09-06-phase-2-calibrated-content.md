# Phase 2 — Calibrated content

**Goal (spec F.2):** the B.5 vertical slice, the calibration script, all eleven validator
checks, and CI pacing gates. **Ends in:** a game that is *paced*.

**Branch:** `worktree-phase-2-content`, off Phase 1's tip.
**Base state:** 547 tests green — rational 67 · content 79 · engine 332 · sim 69.

---

## Where the numbers actually are today

The fixture is a self-consistent placeholder, and it is nowhere near its own pacing
intent. Measured, seed 42:

| | target (`targetCollectionsToTier`) | greedy | casual |
|---|---|---|---|
| tier 1 | 2 | 0.01 | — |
| tier 2 | 5 | 0.43 | 4.00 |

`greedy` reaches tier 1 roughly **200× faster** than intended. That gap is not a defect;
it is the entire job of this phase. It is recorded here so the first calibration run has
a before-number to move.

---

## Task 0 — Give the bottleneck report a storage kind (blocking) — **DONE**

**Outcome:** `bottleneck` goes from never reaching tier 2 in 365 days to reaching it in
**0.07 collections (34 minutes) on 8 purchases** — the fastest of all four policies, and by
a wide margin the cheapest. Max dead time falls from 19d 23h to 18m. 553 tests green.

| policy | before | after | purchases |
|---|---|---|---|
| bottleneck | never | **0.07** (34m) | 8 |
| optimal | 0.22 (1h46m) | 0.22 | 52 |
| greedy | 0.43 (3h26m) | 0.43 | 102 |
| casual | 4.00 (1d8h) | 4.00 | 121 |

Two things this result says, which should not be conflated:

1. **The advice mechanism is now sound.** Following the game's own recommendation is the
   best available strategy rather than a trap. That was the acceptance criterion.
2. **It also says the fixture is badly uncalibrated** — and that is not a bug in this task.
   `bottleneck` wins by buying almost nothing: three storage levels and a handful of
   machines, then waiting. A game where "buy storage and idle" dominates "build a factory"
   has its costs and its milestone requirements in the wrong ratio. That is exactly what
   Tasks 2–4 exist to fix, and this is the before-number.

**`optimal` being beaten is a real finding, not noise.** It is a rate-greedy heuristic
("pick a candidate that does not lower the top target's rate"), not a true optimum, and it
buys 52 machines to `bottleneck`'s 8. The name oversells it. Worth revisiting during
calibration — a policy called `optimal` that is 3× off the best observed line will be
misread as an upper bound.

### What was found and fixed

**This must land before anything else in the phase, and it is not optional.**

Spec E.5 makes a CI gate of it: *"`greedy`, `casual`, and `bottleneck` all land within
tolerance of `pacing.targetCollectionsToTier`."* Today `bottleneck` never reaches tier 2
at all, so that gate cannot be written, let alone pass. Every calibration number produced
before this is fixed would be measured against advice known to be wrong.

The Phase 1 finding, confirmed by probing the stuck state:

```
stored.iron_plate:   300   ← exactly baseStorageCap
quantum.iron_plate: 1200   ← exactly baseQuantumCap
                    ────
                    1500   vs. tier 2's requirement of 2000
storageLevel/qsLevel: all 0    ← bought no upgrade, ever
iron_plate: allocated 0        ← production fully stopped
report: "buy 1 more constructor"
```

Two compounding causes:

1. `Bottleneck` has kinds `recipe` and `power` only
   (`packages/engine/src/solve/bottleneck.ts:16-21`). A storage cap is the binding
   constraint and the type cannot name it, so the reporter falls through to a recipe it
   can name.
2. `machinesToClearRecipe` computes `target = allocated * 1.1` for an unbounded entry;
   with `allocated` at 0 that is 0, the shortfall is 0, and `Math.max(1, 0)` converts
   "no machine would help" into "buy 1 machine" (`bottleneck.ts:50`).

**The wall is not permanent — which is what makes it an advice bug rather than a content
bug.** One QS level (base cost 500 `iron_plate`, affordable inside the 1500 cap) lifts the
cap to 2220; three storage levels also clear it. The player has the money and the option
and is simply never told.

Work:

- Add `{ kind: "storage"; itemId; upgrade: "storage" | "quantum" }` to `Bottleneck`.
- Report it when an entry's rate is cap-bound rather than capacity-bound.
- Replace the `max(1, …)` floor with an honest "no machine helps" result.
- Re-run the four-policy comparison. `bottleneck` should land near `greedy` or better. **If
  it does not, the advice still needs work and this task is not done** — that is the whole
  point of the policy.

Spec 4.5 defines the report as recipe-or-power, so this is a spec amendment; make it in
the design doc in the same commit.

---

## Task 1 — Validator checks 7 through 10 — **DONE**

All eleven checks now exist. Content 79 → 94 tests; 568 green overall.

**Check 7 was rewritten and it found a live defect in our own test suite.** The shared
bundle factory in `graph.test.ts` was itself an unbootstrappable deadlock — no starting
machines, miner mk1 costing plate, and every recipe that makes plate needing a miner —
and its first test asserted that bundle validated clean. That is the Phase 0 fixture bug,
encoded as an expectation. The factory now carries a starting machine, and a test removes
it to assert the deadlock is caught.

The strongest guard is on real content: `fixture.test.ts` now empties the real fixture's
`start.machines` and asserts check 7 fires. That bundle *was* the Phase 0 deadlock, so
this is the actual historical defect, reproduced and caught.

**Check 9 deliberately stays silent on the Phase 1 stall, and that is correct.** It
compares against the *maximum attainable* cap, so it flags only genuine permanent walls.
2000 iron_plate against a 1500 base cap is recoverable by buying levels — the player had
the money and the option and was simply never told, which was Task 0's bug, not a content
bug. Widening check 9 to flag every requirement above a base cap would fail bundles that
are merely paced and would not have caught the real defect. This is written into the
function's own doc comment so the next person does not "fix" it.

**Check 8 covers the static half only.** `r_eff = r / m` with the uncapped per-machine
ratio is the worst case, because a softcap can only bend `m` down and so only raises
`r_eff`. The maxed-multiplier half of B.6's wording is E.5's simulator gate. Documented
in place rather than left implicit — an approximation labelled as the real thing is
exactly how check 7 shipped broken.

### Original task notes

Checks 8, 9 and 10 were deferred out of Phase 0 for needing calibration machinery that
arrives now. Check 7 is a different problem: **it does not do what its spec says.**

- **Check 7 — rewrite.** Spec B.6 defines it as "a machine whose build cost needs an item
  only that machine can make." `checkBuildCostsSatisfiable` implements tier ordering only
  and never reads `recipe.machineClass`, so it cannot catch a genuine bootstrap deadlock —
  it passed the Phase 0 fixture, which *was* one. Needs a fixed-point bootstrap analysis:
  from recipes with no inputs, iterate "classes I can afford → items I can produce" and
  flag any class that never becomes reachable.
- **Check 8** — `r_eff > 1 + ε` with every multiplier maxed. Static, from the curves.
- **Check 9** — storage + QS cap ≥ largest single build cost at that tier.
- **Check 10** — generator capacity ≥ draw of everything unlocked at that tier.

### Check 9 should also cover milestone requirements

Spec B.6 scopes check 9 to *build costs*. The Phase 1 stall was a **milestone delivery
requirement** (2000 `iron_plate`) exceeding the base liquid cap (1500) — the same class of
defect, on the axis the check does not look at. A milestone you can never bank enough for
is exactly the "permanent hard wall" the check exists to catch.

**Extend check 9 to milestone requirements, evaluated against the max attainable cap for
that tier** (not the base cap — upgrades are legitimate). Proposed as an amendment to
B.6 rather than assumed.

---

## Task 2 — The B.5 vertical slice — **DONE (content authored; numbers are Task 3's)**

`packages/content/bundles/vertical-slice`, alongside the fixture rather than replacing
it: the fixture is a test artifact with hand-verified numbers and the deliberate
`constructor`-named prototype canary (R23), and dozens of tests assert its values.

**5 lanes, 31 items, 44 recipes, 14 machine classes** — B.5's shape exactly. Ten tiers,
matching the ten `targetCollectionsToTier` entries. Every milestone amount and curve is a
placeholder; Task 3 solves them.

Two authoring decisions, both recorded as spec amendments rather than silent divergence:

- **Ratios are Satisfactory-*shaped*, not Satisfactory-exact** (amends B.5's "real
  Satisfactory ratios throughout"). Topology — what feeds what, where byproducts emerge —
  is faithful; rates are tunable. Calibration tunes the economy around ratios, never the
  ratios themselves, so this costs nothing structural.
- **Check 6 now warns instead of erroring.** B.6 says cycles are "flagged unselectable in
  v1", and ruling R6 already makes every SCC recipe permanently non-live in the engine —
  but the validator returned `severity: "error"`, which would have made B.5's *required*
  deliberate cycle unauthorable. `ValidationIssue.severity` gained `"warning"`, and the
  CLI exits non-zero only on errors.

### What the slice found — three defects the 7-recipe fixture could not expose

This is the return on building real content, and all three were invisible before it.

**1. Auto-assignment starved every recipe but the incumbent.** `autoAssignTarget` sent each
new machine to whichever recipe already had the most — indistinguishable from correct while
a lane-class has ONE live recipe, which is true throughout the fixture's iron lane. The
slice has several per class, so every iron constructor ever bought piled onto
`make_iron_plate`; `make_iron_rod` never received a machine and a tier needing 300 iron
rods was unreachable. Now assigns by the player's priority list (spec 4.1's stated intent),
with the old busiest-recipe rule surviving as a tie-break so single-recipe behaviour is
byte-identical.

**2. `resolve` burned 10,000 events per call on a zero-progress fill loop.** An item parked
a hair under its cap — `have = cap − 1e-10`, a **1.76e-15 relative gap**, pure Decimal
round-off — failed `itemStateTag`'s exact `have >= cap` test, so it read FLOWING, was never
pinned, kept a positive net rate, and scheduled a fill 1.4e-10 ms out. `resolve` floored
the step at `EPSILON_MS`, integrated nothing measurable, and re-fired the same event until
the `MAX_EVENTS` guard tripped — ~3 seconds per call, on every call. Fixed with
`FULL_TOLERANCE = 1e-9` relative, the same bound and derivation as
`SPEND_RESIDUAL_TOLERANCE`. **Same defect class as the Phase 1 knife-edge:** an exact
Decimal comparison between two values reached by different arithmetic paths. A 30-day run
went from hanging to 23 seconds.

**3. `purchaseIntervalLateSeconds` was authored, schema'd, typed — and read by nothing.**
B.7 defines purchases slowing from 120s at tier start to 1800s at tier end; every policy
used the early value as a constant. Now ramps on progress toward the next milestone,
measured as its *least*-satisfied requirement.

The ramp changed the fixture's four-policy numbers, correctly — policies check in less often
near a milestone:

| policy | before | after |
|---|---|---|
| bottleneck | 0.07 | **0.25** |
| optimal | 0.22 | 2.28 |
| casual | 4.00 | 4.00 (uses the offline cap, not the ramp) |
| greedy | 0.43 | 5.23 |

**greedy is now slower than casual**, which is exactly the Phase 0 carry-forward's warning
made concrete. No test asserts an ordering, so nothing broke — that guidance earned its keep.

### Still open, and it belongs to Task 3

`greedy` does not reach tier 2 on the slice inside 30 days, bound on `storage:iron_plate`
for 29 of them. That is placeholder milestone amounts, not a defect — the content validates,
solves, and runs. Calibrating it is the next task, and this is its before-number.

### Original task notes

Four lanes, 31 items, ~44 recipes, real Satisfactory ratios. The largest authoring job in
the phase. What each piece is load-bearing for is specified in B.5 and must survive:

- **Cross-lane contention** — Steel Ingot draws iron ore *and* coal, so Iron and Coal
  compete for solver capacity. Encased Industrial Beam needs concrete plus steel.
- **The byproduct triangle** — Plastic and Rubber both emit heavy oil residue; Residual
  Fuel is the consume corner; fuel feeds generators. Coated Cable gives the triangle a
  second consume corner and turns a byproduct into a mainline input.
- **Fluids and packaging** — water gates coal generators; Packaged Fuel exercises the
  "fluids cannot be sunk directly" rule.
- **A deliberate cycle** — Recycled Plastic and Recycled Rubber form a genuine SCC, so
  cycle detection has something real to catch.

Authoring order should be lane by lane, running `content:check` after each, so a break is
attributable to the lane that caused it.

---

## Task 3 — The calibration script

**It is the simulator with a search wrapper** (B.7). It runs `sim run --policy greedy` and
binary-searches the free parameters until the observed curve matches
`targetCollectionsToTier`. Solves for per-class `r_eff` (hence `r`), milestone delivery
requirements, storage `s`/`sc`, and QS `q` and its cost curve.

The property that makes this trustworthy: there is exactly **one** implementation of "how
long does this take," so calibrated numbers cannot disagree with measured ones. Do not add
a second, faster estimator for the search loop — that would reintroduce the disagreement
the design exists to prevent, and it is the kind of shortcut that looks like an
optimisation.

---

## Task 4 — CI pacing gates (spec E.5)

- `content:check` — all eleven checks
- `greedy`, `casual`, `bottleneck` all within tolerance of `targetCollectionsToTier`
- Max dead time under threshold
- `r_eff > 1 + ε` with every multiplier maxed
- Replay determinism: same log twice, identical discrete state

**Assert absolute tier times, never a policy ordering.** Carried forward from Phase 0 and
now doubly earned: `greedy` can legitimately reach a tier *after* `casual`, because it
spends plate on miners that do not raise plate output. A `greedy < casual` assertion fails
for an honest reason. `bottleneck` losing to `greedy` is a finding to investigate, never a
test to tune away.

---

## Task 5 — The dropped formatter carry-forward

`plain()` in `packages/engine/src/numbers/format.ts:44-48` caps at two decimals, so
`plain(0.004)` renders `"0.00"`. Phase 0 flagged this as "an early Phase 1 fix, not a
nicety" and it was never done — it could not bite while nothing drew a screen.

`sim play` now draws screens, and spec A.4 zone 2 puts clocks and satisfaction in [0, 1],
where sub-0.01/sec rates are the normal early-game state. Every one of them currently
reads `0.00`, which during calibration is indistinguishable from "stalled."

Small, and it should go in early — a calibration run misread because the display lies is
an expensive way to rediscover it.

---

## Open decisions

**The SCC question is the one that needs a call, and it needs evidence first.** B.5
includes Recycled Plastic and Recycled Rubber as a genuine cycle specifically so we can
"decide from evidence whether to ship §4.3's SCC solver or forbid cycles in v1." Phase 1
forbade cycles (any recipe in a non-trivial SCC is unselectable) and the outer waterfall
was built so that adding an SCC solver later does not change it.

Decide **after** Task 2 authors the cycle and we can see what forbidding it actually costs
the player. Deciding before then is guessing.

---

## Carried forward, still open

| Item | From |
|---|---|
| Pin SuperTokens image (currently `:latest`) — needs no Docker, just a version tag or registry digest | Phase 0, due at Phase 3 |
| `installedUnits` / `ladderInput` duplication — same mark-weighted sum in two files, now asserted equal by a property | Phase 1 |
| `entries`/`allocations` reconciliation early-exit | Phase 1 |
| `fireDueTimers` comparator not antisymmetric for duplicate ids | Phase 1 |
| `ValidationIssue` defined in `load.ts` — pure validation importing from the I/O module | Phase 0 |
| Three test-bundle factories to reconcile | Phase 0 |
| `README.md` hardcodes a test count — **delete the number rather than updating it**; it has drifted twice already | Phase 0 |

---

## A note on how this phase should be reviewed

Two confident root-causes were overturned in Phase 1, both by instrumentation rather than
reasoning, and most defects across Phases 0 and 1 were in the *plan* rather than in the
implementations. The reviewer's job is to check claims against reality — run the thing,
open the downstream parser, count it by hand — not to read for plausibility.

Calibration makes this sharper, not softer: a balance number that looks reasonable is the
easiest kind of wrong number to accept.
