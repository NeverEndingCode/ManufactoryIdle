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

## Task 8 — The slice was unplayable past tier 1 (blocking Task 3) — **DONE** (unplanned)

Task 2 recorded `greedy` failing to reach tier 2 on the slice as "placeholder milestone
amounts, not a defect… the content validates, solves, and runs". **That was wrong, and it
was wrong in the direction this phase's own review note warns about: a number that looked
like bad balance was a stuck save.** Measured rather than reasoned — a 20-day greedy run:

```
purchases                    1639
make_iron_rod                   0 machines    iron_rod   liquid 0
make_screw                      0 machines    screw      liquid 0
make_reinforced_iron_plate      0 machines    RIP        liquid 0
make_iron_plate               109 machines    iron_plate liquid 194,424  (at cap, level 12)
```

Tier 2 needs 300 `iron_rod` and 50 `reinforced_iron_plate`. Both producers had **zero**
machines and always would, so tier 2 was unreachable at *any* milestone amount. A
calibration run would have bisected forever against an infeasible target.

**Two defects, both invisible to the fixture**, whose iron lane-classes have exactly one
live recipe each — so no assignment rule can starve anything in it, and no existing test
could see this class of defect at all.

**1. `autoAssignTarget` was winner-take-all, twice over.** Task 2 replaced the
busiest-recipe rule with priority rank, which only moved which recipe starved: rank 0
(`iron_plate`) took every iron constructor forever. Adding "skip a recipe whose output is
FULL" reached tier 2 and then stalled at tier 3 for a second reason — `cable` ranks *above*
`wire` and is never full because it is never made, so 99 copper constructors went to
`make_cable` and none to `make_wire`, which makes cable's only input.

Rank now decides only among recipes that can *use* another machine: output not FULL, and
either unstaffed or already at nameplate. The solver already computes the second, per
recipe, as its clock — so the engine reads that rather than re-deriving a cheaper
approximation that could disagree with what the player is shown. The rule is
self-correcting rather than a tuned ratio: wire takes machines until cable can run at
nameplate, at which point cable outranks it again.

**2. `affordableCandidates` offered machines for lane-classes with no live recipe.** A mark
can unlock long before any recipe using it: miner mk1 is tier 0, `mine_copper_ore` is
tier 2. **790 of greedy's first 1,639 purchases** went into copper, coal and oil — machines
that produce nothing, bought with money that is then gone. No player does that, and a pace
measured with it in is not the game's pace.

**Outcome.** Same content, same seed, same policy:

| | before | after |
|---|---|---|
| tier reached within 60d | 1 | **5 — in 12h 24m** |
| purchases to get there | 1,401, mostly wasted | 332 |
| max dead time | 58d 0h | **28m 29s** |

602 tests green, up six. Every one was watched failing against the pre-fix code — which
mattered: the locked-lane integration guard passed on first write and only discriminated
once its run was extended to tier 2, because ten simulated minutes is not long enough for
greedy to reach a locked lane at all. A test that cannot fail is worse than no test.

The two slice-level guards in `run.test.ts` assert **reachability, deliberately not a
time** — the time is Task 3's to calibrate and will move every time it runs.

**What this says about Task 3.** Every before-number in Tasks 0 and 2 was measured on the
fixture or on a slice that could not be played, so none of them is a baseline for
calibration. The row above is.

---

## Task 3 — The calibration script — **IN PROGRESS**

**It is the simulator with a search wrapper** (B.7). It runs `sim run --policy greedy` and
binary-searches the free parameters until the observed curve matches
`targetCollectionsToTier`. Solves for per-class `r_eff` (hence `r`), milestone delivery
requirements, storage `s`/`sc`, and QS `q` and its cost curve.

The property that makes this trustworthy: there is exactly **one** implementation of "how
long does this take," so calibrated numbers cannot disagree with measured ones. Do not add
a second, faster estimator for the search loop — that would reintroduce the disagreement
the design exists to prevent, and it is the kind of shortcut that looks like an
optimisation.

### What landed

`sim calibrate [--content <dir>] [--max-tier n] [--tolerance f] [--write]`.

- **The authored/derived split is now structural** (spec B.1). `derived:` is a schema'd
  block that `loadBundleDir` lays over the authored values, emitted by the calibrator as a
  generated `derived.yaml` next to the hand-written files. A patch naming a machine class
  or requirement the bundle does not have **throws** rather than being ignored: that means
  the content was re-authored since the run, so the numbers no longer describe it.
- **The authoring inversion** (spec D3): `machineClasses[].rEff` is authorable and
  `r = rEff · step^(1/interval)` is derived. Retuning the ladder now moves pacing by zero.
  `costRatio` stays legal for bundles with hand-verified numbers, which is what the fixture
  has.
- **Per-tier bisection** of delivery requirements, in tier order, each tier resuming from
  the previous tier's checkpoint. That resume is *exact*, not an approximation — tier k's
  requirements cannot affect anything before tier k-1 unlocked, because the purchase cadence
  in that span ramps against milestone k-1 — and a test asserts the resumed run reaches the
  next tier **on the same millisecond** as an unbroken one. It is memoisation of this
  simulator, which is the distinction B.7's "exactly one implementation" rule turns on.
- Amounts are **rounded before they are measured**, so the simulator runs the number that
  ships. Rounding at emit time would mean committing a bundle nobody ever ran — and a test
  pins that reloading the authored files with the derived block on top reproduces the
  reported measurement to nine decimal places.
- The reported observation comes from a **confirming run over the emitted numbers**, never
  from the search's memory of its best evaluation.

### The ramp read "capped" as "nearly finished" — a third defect, and the reason tier 1 had no solution

The first real search found the tier-time curve was not a curve. Raising tier 1 from 2,500
`iron_plate` — exactly the base liquid cap of 500 + 2000 — to **2,600** moved the tier from
**0.26 collections to 4.05**: four per cent more plate for fifteen times the time, with the
curve non-monotone on both sides of it.

| tier 1 requires | before | after |
|---|---|---|
| 2,500 | 0.260 | 0.260 |
| 2,600 | **4.052** | **0.323** |
| 3,000 | 7.739 | 0.626 |
| 10,000 | 11.282 | 1.722 |
| 20,000 | never | 2.168 |

Cause: `tierProgress` is `liquid / amount`, so a player pinned at a cap of 2,500 against a
requirement of 2,600 reads as **96% done** — and B.7's purchase-interval ramp duly slowed
them from one decision every 2 minutes to one every **29 minutes**, exactly when the thing
they had to do was go and buy storage.

A requirement the player cannot physically hold is not progress at any fill level.
Deliveries are paid from liquid stock (R7), so waiting never completes that tier; only a
purchase does. `tierProgress` now returns 0 in that case. **This was not a calibration
difficulty, it was an unsolvable problem**: a whole band of tier times, roughly 0.3 to 3.7
collections, was unreachable at every possible requirement.

### Tier 1 is on target. Tiers 2+ are blocked on a self-terminating storage ladder

```
tier   target   observed     miss   runs
   1     2.00       2.09     4.5%     10
   2     5.00       4.20   -15.9%     19   OFF TARGET
   3    11.00       5.08   -53.8%     19   OFF TARGET
```

Tier 2's response saturates and then falls off a cliff into "never":

| iron_rod required | collections | purchases | top binding constraint |
|---|---|---|---|
| 30,000 | 2.83 | 168 | `make_iron_plate` |
| 194,400 | 4.20 | 496 | `make_iron_plate` |
| 450,000 | **never** | 548 | `storage:iron_plate` 469h |
| 9,000,000 | **never** | 548 | `storage:iron_plate` 469h |

Every stalled run parks at `iron_plate = 194424.579555328`, and that is not an
approximation of anything — it is **exactly** `500 · 1.6^12 + 2000 · 1.6^7`, the liquid cap
at storage level 12 and QS level 7. Storage level 13 costs `50 · 2^13 = 409,600`; QS level 8
costs `500 · 2.5^8 = 762,939`. Neither can ever be banked, because the cap is 194,425.

**`curves.yaml` sets `costGrowth` above `capGrowth` on both curves — 2.0 against 1.6 for
storage, 2.5 against 1.6 for Quantum Storage.** Cost outruns capacity, so past a crossover
level the next level costs more than the maximum the player can hold and the storage ladder
**permanently ends**. It is structural, not a tuning miss: it happens for every item in
every bundle authored this way, only the crossover level moves.

This is precisely the permanent-hard-wall class B.6 check 9 exists for — "you could never
bank enough to buy the thing" — on the one purchase check 9 does not look at: **the storage
levels themselves.** Check 9 measures build costs and milestone requirements against the
*maximum attainable* cap, and the maximum attainable cap is not attainable.

Confirmed at scale, independently of the calibrator: a 365-day `greedy` run on the slice
**stops at tier 5 and spends 362 of those 365 days bound on `storage:iron_plate`.** The
slice was not a slow game, it was a game with an ending at tier 5.

### Check 12 — the storage ladder must be climbable

Proposed as a B.6 amendment, and it is check 9's own class of defect on the one purchase
check 9 does not look at. Buying the level from L to L+1 costs `baseCostAmount ·
costGrowth^L` and is paid out of stock, so it is bounded by what the player can hold:

```
cost(L)  =  baseCostAmount   · costGrowth^L
hold(L)  =  baseStorageCap   · capGrowth^L  +  baseQuantumCap · qsCapGrowth^qsMax
```

`costGrowth > capGrowth` makes the first outrun the second, and the ladder ends. The check
walks levels 0..maxLevel and names the one it stops at, since that is what the author has
to move. It is an **error**: a permanent hard wall is a stuck save, which B.6 says is worth
failing the build over.

This is the same argument spec C.0 makes about marks. There, `B = A` — build cost scaling
with rate — is exactly pace-neutral. Here, a storage level whose cost scales with the
capacity it grants is neutral in the same way, and anything steeper eventually stops being
buyable.

**Check 9 now depends on check 12.** Its "maximum attainable cap" is attainable only if the
ladder can be climbed to `maxLevel`.

Both bundles were re-authored to `costGrowth ≤ capGrowth` — storage 1.5 and Quantum Storage
1.55 against a capGrowth of 1.6. The *shape* is an authoring decision, like the ladder
(B.3); the *values* remain placeholders for the calibrator. Four hand-verified arithmetic
tests in the engine moved with the fixture's curve.

### With the ladder climbable, tier 2 lands — and tier 3 reveals the real lever

```
tier   target   observed     miss   runs
   1     2.00       1.95    -2.4%      8    iron_plate 22,400
   2     5.00       5.10    +2.0%     10    reinforced_iron_plate 512,000, iron_rod 3,072,000
   3    11.00       7.86   -28.5%     22    OFF TARGET
```

Tier 2 was −15.9% before check 12 and is +2.0% after, on the same search. Tier 3 is not
a near miss, and the per-step trace says exactly why:

| tier 3 requires (cable) | collections |
|---|---|
| 200 | 5.30 |
| 12,800 | 5.54 |
| 819,200 | 6.41 |
| 3,276,800 | 7.22 |
| 6,680,000 | **7.86** |
| 6,690,000 | never — `reinforced_iron_plate 5,020,800 is above the maximum 5,010,283 a player can hold` |

**Milestone amounts are a logarithmically weak lever, and they run out of room before
they run out of effect.** Multiplying the requirement by 33,000 buys 2.56 collections;
the bisection then converges onto the cap boundary to the last thousand — 5,010,000
against a maximum attainable 5,010,283 — and the target of 11 is simply not in the
reachable set. This is not the cliff of the ramp defect, which was a hole in an otherwise
continuous curve. This is a **ceiling**.

It follows from `r_eff > 1`: machine count grows logarithmically, so time to bank N is
roughly `a + b·log N`. Stretching a tier by a factor needs an exponentially larger
requirement, and the liquid cap arrives long before the exponent does.

**The lever with authority over the tier-time curve is `r_eff`, and the spec disagrees
with itself about who sets it.** B.7 lists calibration as solving "per-class `r_eff`
(hence `r`)"; §D3 says "you author the ladder and `r_eff` … the calibration script derives
`r = r_eff × m`". The measurement says B.7 is right. Note the targets
`[2, 5, 11, 24, 52, 110, 230, 480, 1000, 2100]` have near-constant ratios of about 2.1 —
which is exactly the shape a *fixed* `r_eff` produces. That makes the solve well posed at
two levels:

- **`r_eff` sets the ratio between successive tiers.** One global scale against the
  curve's shape.
- **Milestone amounts set each tier's absolute placement.** What is already built.

### `r_eff` is solved by scanning — DONE, and the tier-3 ceiling is U-shaped

§D3 amended to defer to B.7: calibration solves `r_eff`, the author writes only the
ladder. `sim calibrate` scans one scale on `r_eff − 1` across every class and scores each
candidate on the whole tier curve with the amounts re-solved underneath it.

**It is a scan and not a bisection because the response is not monotone**, and the
tier-3 ceiling — the latest a tier can be made to land, with its requirement at the most
a player can ever hold — shows exactly why:

| scale on `r_eff − 1` | `r_eff` (miner) | tier 3 ceiling | vs. target 11 |
|---|---|---|---|
| 0.25 | 1.011672 | 10.79 | short |
| 0.50 | 1.023344 | 9.39 | short |
| 1.00 | 1.046688 | **7.72** | short — the authored value, and the worst of the four |
| 2.00 | 1.093376 | **12.45** | **reachable** |

The ceiling is **U-shaped with its minimum at the authored `r_eff`**. Both directions
lengthen tier 3 and they do it by opposite mechanisms: raising `r_eff` slows production;
lowering it makes machines cheap enough that `greedy` pours its currency into machines
instead of banking it. A bisection would have walked downhill into the minimum and
reported that the target was unreachable.

**Scale 2 clears the target**, so tier 3 is solvable — the phase is not blocked on
content after all. The scan finds it, given the time to look.

### Three defects the scan found in itself

1. **The ranking pass's own noise swamped its signal.** Fitting amounts to a 15%
   tolerance accumulates up to 0.45 of noise across three tiers — larger than the
   differences being ranked. `curveMiss` now measures from the edge of the fitting
   tolerance, so only misses the fitting could not close survive.
2. **Offered a scale of 0.001, the scan chose it** — `r_eff` 1.00005, deep inside D3's
   runaway, which scores well precisely because a runaway game hits its milestones
   promptly. Every candidate now goes through `checkRunawayGrowth`, the same function
   `content:check` runs; a refused scale is never simulated, and if every scale is
   refused the run throws rather than emitting a solution.
3. **The refinement grid walked.** Each of its four points was computed from a
   `bestScale` the loop was itself mutating, so as soon as one refinement won, the next
   was measured relative to that instead of to the coarse winner.

### The blocker is now runtime, not content

A single coarse point at scale 2 ran **13 minutes at 100% CPU on tier 3 alone**; tiers 1
and 2 took seconds each. A full eleven-point scan over ten tiers is an overnight job, not
an hour's.

The cheap fix is visible in the table above: the ceiling is one run per scale, and it
answers *"can this scale reach the target at all"* on its own. Used as a pre-filter it
would have discarded 0.25, 0.5 and 1.0 without a single amounts calibration and gone
straight to 2. That is not a second estimator of duration — it is the same simulator,
asked a cheaper question.

### Still open: `SET_RESERVE` is implemented and no policy emits it

Same shape as `purchaseIntervalLateSeconds` in Task 2: the action exists in the engine
(`applySetReserve`), is wired into `sim play`, and is reachable from no automated policy.
Milestones are paid from liquid stock, so reserving a required item stops downstream
recipes eating it — which is exactly the "bank toward the milestone" lever, and the one
whose absence produces the low-`r_eff` half of the U above. **Every calibrated number is
currently tuned for a player who never uses a core mechanic.** Whether `greedy` should
reserve is a spec decision about E.2's policy definitions, not a calibration one. The
size of the effect is unmeasured.

### The pre-filter — DONE, and it made the scan affordable

One run per scale instead of a whole amounts calibration. The ceiling run sets every
requirement up to the deepest tier at the most a player could ever hold — the latest
each tier can be made to land — and rejects a scale the moment a tier lands *before* its
target. It abandons the run at that first failure, since everything after it is wasted:
the ten-tier measurement went from **899 s to under 4 s**, about 65× faster, and the
pre-filter stopped being the dominant cost of the scan.

Two defects found building it, both recorded in the commits: `withREffScale` moved
`rEff` and left `costRatio` alone, so a "scaled" bundle **simulated as if unscaled**
while reporting the new `r_eff`; and the ceiling run's budget was authored data, so a
typo in `targetCollectionsToTier` asked for two and a half million years of simulated
time instead of complaining.

### Task 9 — nothing ever reassigned a machine (blocking) — **DONE** (unplanned)

The full run then stalled at tier 4, and not on content or `r_eff`. Measured:

```
make_reinforced_iron_plate   81 machines   RIP  5,010,283  ← exactly its maximum cap
make_rotor                    0 machines   rotor        0
make_concrete                95 machines   concrete 8,350,472
tier 4 needs: concrete 1, rotor 1          → never reached
```

Tier 4 was unreachable with its requirement bisected all the way down to **one rotor**,
which cost 34 simulated runs to discover.

The engine was not at fault: bought on that state, a new assembler goes to `make_rotor`,
and moving 40 of the idle 81 produces **143 rotor/s immediately**. The gap is that
nothing ever revisits an assignment, and `greedy` had stopped buying assemblers because
they were never the cheapest thing on offer. The machines existed, the verb to move them
existed (`ASSIGN_MACHINES`, two calls — shrink one, grow the other), and no policy used
it.

> An earlier probe appeared to show the auto-assign rule itself was broken. It was not:
> the probe funded *every* item to make the purchase affordable, which pushed rotor over
> its own cap, so every recipe read FULL and the rule correctly fell back to ranking. The
> probe created the behaviour it then blamed on the rule.

`idleReassignments` moves half of a fully-idle recipe's machines to a live sibling in the
same lane-class that has **exactly zero**. Narrow on purpose: the receiving condition can
be true at most once before it has machines, so it cannot oscillate the way a general
"rebalance toward the busiest" rule would.

**This is deliberately not the strategy question `SET_RESERVE` and `REORDER_PRIORITY`
raise.** Those are choices about what a player wants. Leaving machines you already own
idle while a sibling starves is not a strategy, it models no player, and spec E.2 does
not describe any of its policies as doing it. Proposed as an amendment to E.2.

Also fixed: `purchases` counted every action a policy returned, so reassignments would
have been reported as purchases. A purchase is a spend.

### The wall moved from tier 3 to tier 4 — and the real limit is the storage caps

| | scale 1 (authored) | scale 2 |
|---|---|---|
| tier 1 (target 2) | 5.21 clears | 7.15 clears |
| tier 2 (target 5) | 6.70 clears | 15.24 clears |
| tier 3 (target 11) | **8.93 short** | 17.66 clears |
| tier 4 (target 24) | — | **19.50 short** |

Real progress — scale 2 now clears three tiers where tier 4 was previously unreachable
at any requirement. But the shape is the problem:

```
targets  grow ~2.15x per tier
ceilings grow ~1.13x per tier   (7.15 → 15.24 → 17.66 → 19.50)
```

**The ceilings flatten within a scale because the maximum bankable amount does not grow
with the tier.** `maxAttainableCap` is `baseStorageCap · s^20 + baseQuantumCap · q^15`,
and the slice's base caps are flat — *declining*, in fact:

| tier | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| mean base liquid cap | 3000 | 3000 | 3500 | 2500 | 4000 | 1500 | 2400 | 2000 | 1500 |

A player can bank **half** as much of a tier-8 item as of a tier-0 item, while production
accelerates the whole way.

> **Correction.** On that evidence this plan first said *"no `r_eff` scale fixes this,
> because it is not a rate problem."* **That was wrong, and scale 4 disproved it:**
>
> | tier | 1 | 2 | 3 | 4 | 5 | 6 |
> |---|---|---|---|---|---|---|
> | target | 2 | 5 | 11 | 24 | 52 | 110 |
> | ceiling | 19.41 | 66.14 | 87.16 | 105.15 | 106.90 | **109.03** |
>
> Five tiers clear and the sixth misses by **0.9%**. The asymptote is not fixed: it moved
> from about 19.5 at scale 2 to about 109 at scale 4 — 5.6× for a 2× scale. `r_eff` has
> far more reach than the scale-2 numbers alone suggested.
>
> What survives is narrower and still worth acting on: **within a fixed scale the
> ceilings asymptote** (87.16 → 105.15 → 106.90 → 109.03, ratios 1.21, 1.02, 1.02), and
> the flat base caps are why. So each scale has a deepest tier it can support, and
> raising `r_eff` to reach tier 10 means a very steep game in the early tiers — scale 4
> already puts tier 1's ceiling at 19.41 against a target of 2.
>
> Whether some scale reaches tier 10's 2100 is **unmeasured**: scale 8 was still running
> when its 1500 s budget expired. Cost grows steeply with scale — scale 2 took 94 s,
> scale 4 took 1245 s — which is now the scan's binding constraint.

### Storage: `capPerTier` — amends spec B.4's cap formula

```
cap = base · capGrowth^level · capPerTier^tier
```

The diagnosis pointed at one number, so that is what was added rather than 31 hand-tuned
item caps. Authored per-item caps stay the **relative** intent — screws hold more than
rotors — and the progression scaling is the single value calibration solves. It defaults
to 1, exactly the old behaviour, so every existing bundle and every hand-verified fixture
number is untouched.

A tier is an integer, so the new power is exponentiation by squaring like every other
power in `curves.ts`: spec E.4's ban on fractional powers in state-affecting paths holds,
and two machines cannot disagree about a cap.

`maxAttainableCap` and check 12 both read caps and both account for it. **Two
expectations written for check 12 were wrong, and the measurements corrected them:**

- A constant multiplier does *not* rescue a self-terminating ladder. `costGrowth >
  capGrowth` is cost outgrowing capacity **per level** — a difference in growth rate, and
  a constant cannot beat a rate. It only moves the crossover level.
- But the ladder is **finite**, so a large enough factor moves the crossover past
  `maxLevel` entirely. That is a legitimate pass, not a hole: a ladder climbable to its
  own top has no wall in it, which is all check 12 claims.

Both are now asserted rather than assumed.

Unlike `r_eff` it genuinely bisects: raising a cap can only make a tier take longer to
fill, never less. `smallestClearing` takes the **smallest** sufficient value — bigger caps
mean a player hoarding more of everything, which is a real cost to the game's feel rather
than a free win.

#### It was keyed on the wrong tier, and the measurement said so

Keyed on the **item's** tier, `capPerTier 2` was short in 4 s and `capPerTier 4` was still
short after 259 — nonsense for a factor reaching 4⁹ by tier 9. **A milestone's ceiling is
set by its lowest-tier requirement**, and those sit far below the milestone's own tier:
the slice's tier-2 milestone asks for `iron_rod`, a **tier-0** item, so its cap was
multiplied by `capPerTier⁰ = 1` and no factor could raise that ceiling at all.

Keyed on the **player's** tier, every cap grows as the player advances, so a tier-k
milestone can demand `capPerTier^k` more of anything. It is also the better mechanic —
warehouses get bigger as the factory does. It forces every cap reader to say *when*, and
they do not agree: a milestone is banked on the tier **below** it, a machine can be bought
on any tier at or after it unlocks, and check 12 asks at the deepest tier.

#### It is a logarithmic lever, and that makes headroom exponentially expensive

Tier 3's ceiling against the cap factor, measured:

| capPerTier | cap at tier 2 | tier-3 ceiling |
|---|---|---|
| 1.0 | 1× | 8.93 |
| 1.5 | 2.25× | 9.39 |
| 2.0 | 4× | 10.10 |
| 3.0 | 9× | 10.68 |

`ceiling = 8.87 + 0.82 · ln(cap factor)` — the same logarithmic weakness milestone amounts
have, and for the same reason: time to bank grows slowly with amount because production
accelerates.

**The consequence is a defect in the solve as first written.** Its `capHeadroom` default of
1.25 costs, in a log regime, a cap factor 28× larger than simply reaching the target:

| goal for tier 3 | cap factor needed | capPerTier |
|---|---|---|
| reach the target (11) | 13.3× | **3.64** |
| target × 1.25 headroom (13.75) | 372× | **19.29** |

`capPerTier` 19 puts tier-9 caps at 3×10¹¹ times base. Headroom must be small — 1.02 to
1.05 — or expressed as an absolute margin rather than a ratio.

#### Solved jointly with `r_eff`

Each candidate scale now gets its **own** `capPerTier`: the smallest that clears every
target at that scale. `capPerTier` bisects because it is monotone — a bigger cap can only
make a tier take longer to fill, never less — while the scale is scanned because it
measurably is not. The pre-filter and the storage solve became the same step: a scale is
usable exactly when *some* cap clears, and the smallest such cap is the one to use with
it.

The scan runs ascending and each bisection is **warm-started from the previous scale's
answer**, since a faster game needs a bigger cap and the last answer is a good guess for
the next.

`capHeadroom` drops from 1.25 to **1.05**, which the log fit makes non-negotiable rather
than a taste call.

#### The levers multiply, so solving them in sequence overcharged

`capPerTier` is solved at the bundle's **authored** `r_eff`, which is the worst case for it.
But `r_eff` scale 4 alone already cleared tiers 1–5 and missed tier 6 by 0.9%. The two
multiply — `capPerTier` raises what can be asked, `r_eff` slows how fast it is made — so
solved together each needs far less than either does alone.

The original argument for solving storage first ("it decides what is reachable, the others
decide where inside the reachable range things land") is right in principle and wrong in
practice: **both** levers move reachability.

### The real blocker is `resolve`, and it is measured

Every search in this task has been bottlenecked on individual simulated runs taking
minutes or never finishing, at scattered parameter values. Profiled on the configuration
that stalled the joint solve for 800+ seconds (`r_eff` scale 1.6, tier 2):

```
steps 1129   sim days 1.6   wall 122s
  solve     1.2s   ( 1%)   0.54 ms/call
  resolve  122.0s  (99%)  108.09 ms/call
  decide    0.0s   ( 0%)
  apply     0.1s   ( 0%)
  events: 85,788 total — 76.0 per resolve, max 5,002
  step length: 121 s of simulated time per resolve
```

**`resolve` is 99% of the wall clock at ~200 solve-equivalents per call.** It emits
**76 events for a 121-second step** — an event every 1.6 simulated seconds — and one call
reached **5,002 events**, half of `MAX_EVENTS`.

That is the same family as the Task 2 defect (`FULL_TOLERANCE`, a zero-progress fill loop
burning 10,000 events per call), not fully closed: something is still churning events at a
rate the interval cannot justify. `resolve`'s own doc comment claims "an 8-hour resolve
with 20 events is 20 of those [solves]" — the measurement says 76 events for **two
minutes**, so the doc describes a simulator this no longer is.

**This is the next task, and it precedes finishing the calibration.** Every remaining
measurement — the ten-tier scan, the `derived.yaml` run, Task 4's CI gates — is priced by
`resolve`, and at 108 ms a call none of them is affordable. It is also the highest-value
fix available: a 10× here makes every search in this phase 10× cheaper, where more search
cleverness buys single-digit factors at best.

### Investigated: `resolve`'s churn is one defect said four ways — and the fix is blocked

**Root cause, with evidence.** `nextDiscontinuity` guarded with `net === 0`, an exact
comparison against a number reached by subtraction. When an item's production and
consumption cancel, `net` is not zero but cancellation noise: measured
**3.552713678800501e-15, exactly 16 × `Number.EPSILON`**. With `have` at zero that reads
as a positive rate, so resolve schedules an `unpin` a nanosecond out; integrating a
nanosecond of 3.5e-15/s lifts the stock to ~1e-24, which then reads as positive stock
with a negative net and schedules a `drain` straight back to zero.

The pair repeats for ever — **49.3% drains and 49.2% unpins, alternating 1:1 on the same
two items** (`iron_rod` 25,059/25,003, `screw` 15,007/15,000), 117.7 loop iterations per
resolve, each paying for a full solve.

**A tolerance on that guard is a 79× speedup: `resolve` drops from 108.09 ms a call to
1.37 ms**, and the workload that previously could not reach tier 2 in 120 seconds reaches
it comfortably.

**But it breaks spec E.6's split-invariance, and that is the real finding.** The same
exact-comparison defect exists in *four* places, and the live-lock was hiding the other
three by making every step infinitesimal — nothing was ever integrated across a stale
classification:

| # | Site | Test |
|---|---|---|
| 1 | `nextDiscontinuity` | `net === 0` |
| 2 | `itemStateTag` EMPTY | `have <= 0` — while FULL has had a tolerance since Task 2 |
| 3 | `fixpoint` pin seed | `liquid(...) <= 0` |
| 4 | `fixpoint` pin loop | `liquid(...) <= 0` |

Sites 3 and 4 decide `pinnedEmpty`, which decides whether a recipe is *contested* and so
whether waterfall charges it the **2% reserve-floor tax**. An item resting at
8.105460747032112e-14 — thirteen orders below its own cap — is therefore "stock", and
whether it is flips as float residue accumulates. Downstream that is a 2% jump in
production (`iron_plate` 0.6615 → 0.675/s), a genuine discontinuity in `solve`'s output
that `resolve` cannot schedule an event for, because nothing actually happened.

Measured consequence: the whole-window resolve takes one 1,489,947 ms step at 0.6615
while the split arrangement re-solves at the boundary and gets 0.675, so the two disagree
by 1.5%. Capping the step at 1000 ms restores agreement — which confirms the diagnosis and
is not a fix, since a 1000 ms cap reinstates the very step count the change removed.

**Unifying sites 2–4 on one notion of "empty" was tried and made things worse** — seven
failures including basic integration — so the pin set's threshold is load-bearing in ways
`itemStateTag`'s is not. All changes were reverted; the tree is green.

**This is an architectural decision, not a patch.** `resolve`'s correctness currently
rests on a live-lock, and the two cannot both be kept. The options, none cheap:

1. **One notion of "empty", done properly** — reconcile the pin threshold with
   `itemStateTag` and re-derive whatever depends on the exact boundary. Biggest change,
   correct answer.
2. **Bounded integration step** — accept a maximum `dtMs`, trading exactness for a bound.
   Contradicts spec C.7's event-driven design and costs most of the speedup.
3. **Make the noise not arise** — compute `net` so cancellation is exact (e.g. sum
   production and consumption in a fixed order, or carry rationals), removing the
   residue at source rather than tolerating it downstream.

### Still to do

1. **Decide how to close `resolve`'s live-lock**, per the three options above.
2. **Measure how deep the `r_eff` scale needs to go, and what it costs.** Scale 8 timed
   out unmeasured.
2. **Solve the storage curves and scale the per-item base caps with tier** (B.7's `s`,
   `sc`, `q`) if step 1 says `r_eff` alone cannot reach tier 10, or if the `r_eff` it
   needs makes the early tiers absurd.
3. Re-run the full calibration and commit `derived.yaml` with its target-vs-observed
   claim.
4. Decide `SET_RESERVE` / `REORDER_PRIORITY` — still implemented and still emitted by no
   policy.
2. **Solve the storage curves** — B.7's `s`/`sc` and `q`. `costGrowth ≤ capGrowth` is now a
   validated constraint, which is what makes that search well posed, and
   `pacing.storageBindingCadence` (12 machines between storage binding) is the target.
   Raising the ceiling here also widens the band amounts can reach.
3. Re-run the full ten-tier calibration and commit `derived.yaml` with its
   target-versus-observed claim. Tier 1 and 2 already calibrate; committing a partial
   block would put a stale `observed` column next to eight unsolved tiers, which is worse
   than none.

**Do not hand-tune `curves.yaml` values to move a tier time.** The shape constraint is an
authoring decision; the numbers inside it are the calibrator's output.

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

## Task 5 — The dropped formatter carry-forward — **DONE**

`plain()` in `packages/engine/src/numbers/format.ts:44-48` caps at two decimals, so
`plain(0.004)` renders `"0.00"`. Phase 0 flagged this as "an early Phase 1 fix, not a
nicety" and it was never done — it could not bite while nothing drew a screen.

`sim play` now draws screens, and spec A.4 zone 2 puts clocks and satisfaction in [0, 1],
where sub-0.01/sec rates are the normal early-game state. Every one of them currently
reads `0.00`, which during calibration is indistinguishable from "stalled."

Small, and it should go in early — a calibration run misread because the display lies is
an expensive way to rediscover it.

**Outcome.** `plain()` now keeps three significant figures below 1 — the same three the
`[1, 1000)` branches above it already gave — and trims the zeros `toPrecision` pads with,
so `0.004` renders `0.004` rather than `0.00`. Below 1e-4 `format` renders straight from
mantissa/exponent instead: a fixed-point rendering there is all leading zeros, and the
float magnitude the plain path computes underflows to 0 at very negative exponents, which
would have printed a confident `0.00` for a nonzero rate at any scale.

Five tests, written red first. No caller changed behaviour above 1, so nothing else moved.

---

## Task 6 — Gate the vertical slice — **DONE** (unplanned; found while starting Task 5)

`pnpm content:check` was hardcoded to `bundles/fixture` — 7 items, 7 recipes. The 44-recipe
slice Task 2 authored was referenced **nowhere** in the repo: no test loaded it, no script
validated it, nothing imported it. Task 4's first CI gate is `content:check` running all
eleven checks, so shipping it as-was would have given a green gate over content nobody
checked, and the only reason we knew the slice validated at all was one hand-run of the CLI.

**Outcome.**

- `src/cli.ts` takes any number of bundle directories and, given none, discovers every
  directory under `bundles/`. Discovery rather than an explicit list is the point: a new
  bundle cannot now be added without being checked. Every bundle is validated before the
  process exits, so one broken bundle does not mask the others.
- `src/validate/slice.test.ts` — nine tests pinning B.5's *load-bearing properties* rather
  than its size: the five lanes, cross-lane contention through Steel Ingot and Encased
  Industrial Beam, both byproduct emitters and both consume corners, fluids and packaging,
  generation at three power tiers, alternates and machine marks. Authoring more content
  stays free; losing a shape the solver is meant to exercise does not.
- The warning assertion is deliberately exact — one warning, check 6, naming both recycled
  recipes. If that assertion ever changes, the v1 SCC decision changed with it.
- `turbo.json` declared `"outputs": ["dist/**"]` on `build` while every package builds with
  `tsc --noEmit`. Now `[]`. Only two of four packages warned, because the other two were
  cached — the noise would have grown as caches turned over.

Worth recording: `build` and `typecheck` now run identical commands. `build` earned its
keep immediately (it caught a strict-mode error in the new test that `vitest` did not), but
the duplication should be resolved rather than left to drift.

---

## Task 7 — Producibility must be evaluated over the *selectable* graph — **DONE**

Found while gathering the SCC evidence below, and it is the reason that decision needed to
come first.

`checkProducers` in `src/validate/graph.ts` builds `earliestProduction` from
`bundle.recipes` — **every** recipe, including recipes inside a non-trivial SCC that Phase 1
made unselectable. `checkConsumers` reads the graph the same way. So an item whose only
producer is a forbidden cycle passes check 3 and is then permanently unobtainable in game.

That is precisely the class of defect check 5 exists for: a *permanently stuck save* rather
than merely bad balance, which B.6 says is worth failing the build over.

It does not bite on the slice today — pruning both recycled recipes yields zero validation
issues (evidence below) — so this is latent, not live. It will bite when the full catalog
lands, since Satisfactory's recycling loops are numerous, or the first time someone authors
content where a cycle is the sole route to an item.

**The fix is one idea, not one line:** checks 3 and 4 must run over the same selectable
recipe set the solver uses, so "unselectable" means the same thing to the validator as it
does to the player. Do it before Task 3 — a calibration run over content the validator has
mis-cleared would be calibrating a game the player cannot actually play.

**Outcome.** `scc.ts` now owns the notion — `cyclicRecipeIds` and `selectableRecipes` —
and four checks read it, one more than this task was written for:

- **Check 3** distinguishes its two cases. "Nothing produces it" and "produced only by
  recipes inside a cycle, which ruling R6 makes unselectable" call for different fixes, the
  same reason check 7 already told its three messages apart.
- **Check 4** counts only selectable consumers.
- **Check 5** reads the selectable graph on *both* sides: an unselectable recipe is neither
  an outlet for a byproduct nor a source of one. Not in the original write-up, and the same
  stuck-save defect — a byproduct whose only consumer sits in a cycle is a hard stall under
  section 3.4.
- **Check 7** was assumed immune, and is not. The reasoning that its fixed point cannot
  bootstrap a circularity holds only when the *whole* cycle is unreachable. If a cyclic
  recipe's inputs happen to be reachable acyclically, the fixed point fires it and adds
  outputs the player can never make — marking a build cost satisfiable when it is not. Both
  `producibleAtTier` and its message-selection map now take the selectable set.

Nine tests. The check 7 test was run against the pre-fix code to confirm it discriminates
rather than merely passing — assuming immunity is what put the hole there in the first place.

The slice is unaffected: still one warning, same checksum.

---

## Open decisions

**The SCC question — DECIDED: forbid cycles in v1.** Phase 1's behaviour stands.

The plan said to decide after Task 2 authored the cycle. It also has to be decided *before*
Task 3: if the cycle became selectable, `greedy` and `casual` would gain a recipe, tier
times would move, and every number the calibration solved for would be void. Calibrate
first and you calibrate twice.

**The evidence.** Pruning `alt_recycled_plastic` and `alt_recycled_rubber` from the slice
entirely — which is what "unselectable" means to a player — produces **zero** validation
issues. Nothing depends on them:

| item | acyclic producers |
|---|---|
| plastic | `refine_plastic` @ t6, `refine_residual_plastic` @ t8 |
| rubber | `refine_rubber` @ t6, `refine_residual_rubber` @ t8 |
| fuel | `refine_residual_fuel` @ t6 |

So forbidding costs the player exactly one tier-10 efficiency alt pair — the last tier of
the slice, the least-exercised content, and the part most likely to be re-authored when the
full catalog arrives. Against that, shipping §4.3's SCC solver would put new solver
semantics underneath the calibration run, which is the one thing Task 3 needs to hold still.

The two recipes stay in the bundle. They are the cycle detector's only real fixture, they
document the intent, and the warning plus the Task 6 assertion make their status explicit
rather than silent.

**What this decision obliges us to do:** Task 7. Forbidding cycles is only honest if the
validator agrees that a forbidden recipe is not a producer. Revisit the decision itself when
the full catalog lands and we can see whether any item there is cycle-only.

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
| Ruling R6 is implemented twice — engine `findCyclicRecipes`, content `findStronglyConnectedComponents`. Same semantics today; if they drift the validator clears content the engine refuses to run | Task 7 |
| Check 10's generator-unlock scan still reads every recipe. Over-strict rather than stuck-save, so it can wait | Task 7 |
| Spec B.5 prose says "Four lanes" while its own table lists five and the bundle has five (Power is a lane) — a spec fix, not a content one | Task 6 |
| `build` and `typecheck` now run identical `tsc --noEmit` commands in every package | Task 6 |
| ~~`README.md` hardcodes a test count~~ — **DONE** (Task 3): number deleted rather than updated, with a line saying why, and the stale "Phase 1 is next" status corrected | Phase 0 |

---

## A note on how this phase should be reviewed

Two confident root-causes were overturned in Phase 1, both by instrumentation rather than
reasoning, and most defects across Phases 0 and 1 were in the *plan* rather than in the
implementations. The reviewer's job is to check claims against reality — run the thing,
open the downstream parser, count it by hand — not to read for plausibility.

Calibration makes this sharper, not softer: a balance number that looks reasonable is the
easiest kind of wrong number to accept.
