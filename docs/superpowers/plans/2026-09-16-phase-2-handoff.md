# Phase 2 handoff — calibrated content

Written 2026-09-16, at the end of the session that finished Task 3. This is the
orientation document: what is true now, what is left, and which assumptions have already
been measured and disproved so the next session does not re-derive them.

The plan of record is `2026-09-06-phase-2-calibrated-content.md`. This file does not
replace it — it says where that plan is now and which parts of it have gone stale.

---

## Where the work is

- Worktree: `.claude/worktrees/phase-1-engine`, branch `worktree-phase-2-content`,
  pushed to `origin/worktree-phase-2-content` at `4cd5e32`. `main` is stale; do not
  work from the top-level checkout.
- The vertical slice is `packages/content/bundles/vertical-slice/` — 5 lanes, 31 items,
  44 recipes, 14 machine classes.
- `derived.yaml` in that directory is **generated**. Do not hand-edit it.

## State: Task 3 done, Task 4 not started

Phase 2's deliverable is a calibrated `derived.yaml` plus CI pacing gates. The
calibration ships and reproduces; the gates do not exist yet.

Current fit — **7 of 10 tiers within 5%**:

| tier | target | observed | miss | | tier | target | observed | miss |
|---|---|---|---|---|---|---|---|---|
| 1 | 0.50 | 0.42 | **−16.1%** | | 6 | 4.40 | 4.42 | +0.5% |
| 2 | 0.80 | 0.79 | −0.7% | | 7 | 6.80 | 6.84 | +0.7% |
| 3 | 1.20 | 1.19 | −0.9% | | 8 | 11.00 | 10.75 | −2.2% |
| 4 | 1.90 | 1.83 | −3.5% | | 9 | 16.00 | 15.49 | −3.2% |
| 5 | 2.90 | 3.05 | **+5.1%** | | 10 | 25.00 | 15.54 | **−37.9%** |

A plain `sim run` against the committed bundle reproduces `derived.yaml`'s tier times to
seven significant figures, so the derived block is verified end to end rather than only
against itself.

---

## Measured facts — do not re-derive these

Every line here cost a run to establish, and several overturned a confident reading.
Three root-cause claims were wrong in this session alone; instrumentation settled all of
them. Check a claim against a measurement before acting on it.

**The deep end is logarithmic.** With the ladder raised past any plausible need,
32x the tier-10 requirement (2.56M → 81.9M smart_plating) buys 4.5 collections, 15.80 →
20.26. Each doubling is worth ~0.65. Reaching 25 by amounts alone needs ~4,000x. **The
deep end cannot be paced by asking for more stuff.**

**The ladder softcap is inert.** Slopes 0.25, 0.1, 0.05, 0.02 give identical tier times.
A piecewise-*linear* cap only rescales an exponential and leaves its growth rate alone —
and production is not the constraint anyway. Check `bindingConstraints` before reaching
for any multiplier: `storage:iron_plate` binds for 306.7M of a 464M ms run.

**`r_eff` runs backwards here.** Raising it makes the game FASTER — tier 10 goes 16.89 →
14.60 as the scale goes 1 → 3. Pricier machines mean `greedy` reinvests less and banks
more toward a requirement that is fixed. `r_eff` only slows things where amounts sit at
the storage cap, which is the regime the older ceiling numbers came from. Both readings
are right about their own regime; that is exactly why the older one misleads.

**Storage `costGrowth` is the lever that works**, and it is tier-targeted for free: early
levels stay cheap, late levels compound. 1.5 → 1.8 left tiers 1–3 byte-identical and moved
tier 9 from 15.73 to 28.12. `baseCostAmount` is the wrong knob — it scales every level, so
50 → 400 moved tier 1 from 0.42 to 1.10.

**`costGrowth` above `capGrowth` is intended.** §3.3 wants caps growing *slightly slower
than build costs* so capacity periodically binds. Check 12 permits it: the check tests
`cost <= holdable` per level, so outgrowing capacity is fine until the crossover and the
ladder only has to end first. Its message used to claim the stricter rule; corrected.

**Calibration must not read its own output.** `loadBundleDir` applies `derived.yaml` by
default. The calibrator passes `{ applyDerived: false }` so it searches from authored
seeds — otherwise two runs over unchanged content disagree and scale factors compound.

**A gate run costs ~10.8 minutes.** `sim run --until tier:10`: greedy 173.7s, bottleneck
232.5s, casual 240.7s. `optimal` did not finish in 33 minutes (worker pegged at 100% CPU —
slow, not stuck) and is not in E.5's list. One `--report json` carries `reachedTier`,
`tierTimes`, `maxDeadTimeMs`, `rEff` and `bindingConstraints`, so the gate is three runs,
not fifteen. Two of the five checks already pass: dead time 0.50 game-hours, minimum
observed `r_eff` 1.023285 against the 1 + 1e-3 floor.

---

## What is left

**1. Task 4 — CI pacing gates (spec E.5). The remaining deliverable.**
`content:check` all twelve checks; `greedy`/`casual`/`bottleneck` within tolerance of
`targetCollectionsToTier`; max dead time under threshold; `r_eff > 1 + eps` with every
multiplier maxed; replay determinism. **Assert absolute tier times, never a policy
ordering** — `greedy` can honestly finish after `casual`, because it spends plate on miners
that do not raise plate output. At ~22 min a commit including `pnpm test`, the gate wants
splitting: a cheap per-commit smoke (`sim:ci` already exists) plus the ten-tier
three-policy run nightly or pre-merge. Needs a decision on how known-red tiers are treated.

**2. The three off-target tiers.**
- **Tier 10 (−37.9%) is a content-design decision and the only real blocker.** Storage
  depth, the ladder softcap, `r_eff` and milestone amounts have all been ruled out by
  measurement. Tiers 9 and 10 sit 0.05 apart because both requirements are storage-capped
  in a logarithmic regime. Tier 10 must gate on something the amounts search can move —
  recipe depth, a power or throughput wall — not a bigger pile.
- **Tiers 1 (−16.1%) and 5 (+5.1%) are staircases**, and this has NOT been investigated
  properly yet. Tier 1 is the only milestone with a single requirement item
  (`iron_plate 2800`); every other tier has two. At 0.42 collections (~3.4 hours) one
  discrete event moves the time by more than the tolerance. Candidate fixes: a second
  requirement item for a finer knob, or an honest target. Measure before choosing.

**3. Test-fixture coupling — a correctness problem, not a speed one.**
Three times this session a content change silently invalidated mechanics-test premises
(5 tests on retuned targets, 4 on the deeper ladder, 6 on `costGrowth`). One test had
stopped testing its claim entirely: the pre-filter test that exists to prove the expensive
fit is SKIPPED spent 23 minutes performing it, and reported nothing wrong. `withTargets`,
`withLadder` and `shallow` in `apps/sim/src/calibrate.test.ts` patch the live slice, so
`shallow` still spreads shipped content and pins only storage fields — the next recipe or
machine-cost edit reopens this. Fix: a frozen `bundles/calibration-fixture/` that is
explicitly never tuned, with the ceiling and capPerTier tests pointed at it. Keep one
cheap end-to-end test against the live slice so the calibrator still has a canary.

**4. Two decisions open since the plan was written.**
- **B.7's storage list.** `costGrowth` is now authored with measurements behind it, but
  `capGrowth`, `baseCostAmount` and `maxLevel` are still placeholders, and
  `pacing.storageBindingCadence: 12` is read by nothing. Solve against it or delete the
  intent — an authored pacing knob nothing consumes is the `purchaseIntervalLateSeconds`
  pattern for a third time.
- **`SET_RESERVE` and `REORDER_PRIORITY`.** Implemented in the engine and reachable from
  `sim play`; no automated policy emits either. Every calibrated number is therefore tuned
  for a player who never uses two core mechanics. A spec decision about E.2.

**5. Eleven carried-forward items** from Phases 0/1, none blocking. See the plan's
"Carried forward, still open" table.

**6. Plan hygiene.** The plan's "Still to do" list has duplicated numbering, claims a
ten-tier scan costs "ten hours a scale" (~1 hour since the `resolve` fix), and still cites
"33 collections for one rotor", which the floor measurement disproved.

---

## Working rules learned the hard way

- **Never run `pnpm format`.** It rewrites 69 files / ~5,900 lines against the committed
  tree and buries any real diff. Match surrounding style by hand.
- **Never run `pnpm lint` or `pnpm typecheck` while `pnpm test` runs.** Turbo rewrites
  `dist/` underneath them and you get failures that do not reproduce — once as a bogus
  `'.' import is restricted ... packages/engine is pure` error.
- **`pgrep -f <pattern>` matches its own wrapper shell.** It reported processes alive that
  were dead, twice. Check by explicit PID.
- **`pnpm test` through turbo produced an empty output file twice.** Per-package
  `npx vitest run` is what to trust.
- The sim suite is ~10 min and `calibrate.test.ts` is ~99% of it; 6 of its 71 tests are
  86% of that. A full ten-tier calibration is ~1 hour.

## Commands

```bash
# verify — run SERIALLY, never alongside pnpm test
pnpm lint && pnpm typecheck && pnpm content:check
cd packages/content && npx vitest run     # 136 tests
cd apps/sim && npx vitest run             # 163 tests, ~10 min

# one gate-shaped run
cd apps/sim && npx tsx src/bin.ts run --policy greedy \
  --content ../../packages/content/bundles/vertical-slice \
  --seed 42 --until tier:10 --max-days 120 --report json

# re-calibrate (~1 hour; writes derived.yaml)
cd apps/sim && npx tsx src/bin.ts calibrate \
  --content ../../packages/content/bundles/vertical-slice \
  --policy greedy --seed 42 --max-tier 10 --tolerance 0.05 --scales 0.5 --write
```

The one known-acceptable `content:check` warning is check 6, the deliberate
`alt_recycled_plastic -> alt_recycled_rubber` cycle.

## How this work should be reviewed

Most defects across Phases 0–2 were in the *plan*, not the implementations, and every
confident root cause that turned out wrong was overturned by instrumentation rather than
by argument. Run the thing; open the downstream parser; count it by hand. Calibration
makes this sharper, not softer: a balance number that looks reasonable is the easiest
kind of wrong number to accept.
