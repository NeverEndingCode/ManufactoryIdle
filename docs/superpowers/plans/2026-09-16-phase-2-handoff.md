# Phase 2 handoff — calibrated content

Written 2026-09-16, at the end of the session that finished Task 3; header sections
refreshed 2026-10-12 for PR #4 leaving draft. This is the
orientation document: what is true now, what is left, and which assumptions have already
been measured and disproved so the next session does not re-derive them.

The plan of record is `2026-09-06-phase-2-calibrated-content.md`. This file does not
replace it — it says where that plan is now and which parts of it have gone stale.

---

## Where the work is

- Worktree: `.claude/worktrees/phase-1-engine`, branch `worktree-phase-2-content`,
  pushed to `origin/worktree-phase-2-content` (PR #4).
  The top-level checkout's `main` is stale; do not work from it.
- The vertical slice is `packages/content/bundles/vertical-slice/` — 5 lanes, 31 items,
  44 recipes, 14 machine classes.
- `derived.yaml` in that directory is **generated**. Do not hand-edit it.

## State: Tasks 3 and 4 done; all three policies gated, two of them by known-red pins

Phase 2's deliverable is a calibrated `derived.yaml` plus CI pacing gates. Both now
ship. The gate is `sim gate` (`apps/sim/src/gate.ts` for the rules, `gate-cli.ts` for
the runs), in two depths:

| | what it runs | cost | where |
|---|---|---|---|
| `pnpm --filter @manufactory/sim gate:smoke` | greedy to tier 4, twice | **2.6 s** | every commit, in `check` |
| `pnpm --filter @manufactory/sim gate` | all three policies to tier 10, greedy twice | **2m15s** local (2026-10-14), **5m15s** in CI (2026-10-12) | `pacing` job, PRs + nightly |

Both currently PASS. The full gate's cost history: 15m54s (2026-09-16), ~49 min once
`bottleneck` made progress, 13 min after the stall cut-off and parallel workers, 135 min
once `bottleneck` finished all ten tiers, 85 min after R32 asked jointly, and 2m18s since
`resolve` solves each item-state configuration once (2026-10-12), 2m15s at 2026-10-14 with
`bottleneck` finishing tier 10. `timeout-minutes` on
the `pacing` job is 20. It fails the build on a tier time outside tolerance, a known-red
pin that has drifted *or gone stale*, dead time over threshold, an observed `r_eff` at
the runaway floor, or a determinism divergence. Verified to actually fail: pointed at
the pre-retune bundle it exits 1 with `tier 1 at 0.4194 against target 0.5 (-16.1%)`.

The rules are a pure function over `RunReport`s, unit-tested in 0.3 s (21 tests), so the
judgement is not hidden behind a full gate run.

Current fit — **10 of 10 tiers within 5%** (2026-10-13: tier 10 got its capstone; see specs/2026-10-13-tier10-capstone-design.md):

| tier | target | observed | miss | | tier | target | observed | miss |
|---|---|---|---|---|---|---|---|---|
| 1 | 0.42 | 0.4220 | +0.5% | | 6 | 4.40 | 4.5009 | +2.3% |
| 2 | 0.80 | 0.7605 | −4.9% | | 7 | 6.80 | 6.9341 | +2.0% |
| 3 | 1.20 | 1.1552 | −3.7% | | 8 | 11.00 | 10.8558 | −1.3% |
| 4 | 1.90 | 1.8714 | −1.5% | | 9 | 16.00 | 15.6099 | −2.4% |
| 5 | 2.90 | 3.0350 | +4.7% | | 10 | 25.00 | 24.0583 | −3.8% |

History (superseded by the table above): until 2026-10-13 tier 10 was the one miss
(20.8722, −16.5%). A plain `sim run` against the committed bundle reproduces
`derived.yaml`'s tier times exactly. That was not true until 2026-09-17: tier 10's column
said 15.54 where the game did 20.87, because its amounts search short-circuited and
reported one constant for every candidate. Fixed; see below. Tier 10's miss was −37.8%
against a number nothing measured, and was −16.5% against the real one.

---

## Measured facts — do not re-derive these

Every line here cost a run to establish, and several overturned a confident reading.
Three root-cause claims were wrong in this session alone; instrumentation settled all of
them. Check a claim against a measurement before acting on it.

**Spec E.5's "all three policies within tolerance" is not achievable, and not for a
content reason.** Calibration fits ONE set of milestone amounts, against `greedy`.
Measured to tier 10, seed 42:

| policy | reaches | tier times vs target | dead time | note |
|---|---|---|---|---|
| `greedy` | 10 | 9 of 10 within 5% | 0.061 colls | the calibrated policy |
| `casual` | 10 | **+378% to +720%** | 1.000 colls | checks in once per window |
| `bottleneck` | **6** | 66–82% faster than target, then nothing | **356.3 colls** | stalls again; see below |

A player checking in every two minutes and one checking in three times a day cannot both
land on the same tier times unless the game is entirely idle-bound. `casual` is pinned
rather than chased. Both readings pre-date this session's content change — the baseline
bundle measures the same.

**`casual`'s dead time is exactly 1.0000 collections, by construction.** Its check-in
interval IS the offline cap, so it acts once per window. That is the policy's cadence,
not pace decay, and it is why the gate's dead-time threshold is 2 collections and not 1:
at 1 the gate would be decided by the last bit of a float.

> Superseded 2026-10-09: see item 1's blockquote -- `bottleneck` now passes tier 6 and stalls at tier 7.
> Superseded again 2026-10-10: see item 1 -- it no longer stalls at tier 7 and finishes all 10 tiers.

**`bottleneck` now reaches tier 6, then stalls again — a real win, not a closed defect.**
The milestone-aware reporter (tasks 1-3 of this plan) fixed the failure described in the
previous version of this section: a player sitting on 2,307,820 `iron_plate` and 430,367
`screw`, owning zero assemblers, being advised to "buy 3 miners" while tier 2 needed an
assembler-only item. That failure mode — optimising throughput of the top PRIORITY item
instead of naming what blocks the MILESTONE — is gone. Measured 2026-09-19, seed 42,
`--max-days 120`: `bottleneck` reaches tier 6 of 10 (was tier 1), 229 purchases, max dead
time **356.3315 collections**.

It stalls again at tier 6, bound by `refine_rubber` and `power:burn_biomass` (with
`mine_copper_ore` and `make_screw` also binding). And every tier it does reach, it reaches
66–82% FASTER than target (tier 1 −82%, tier 2 −79%, tier 3 −66%, tier 4 −69%, tier 5
−76%, tier 6 −73%) by buying almost nothing — so reaching a tier faster is not the same as
being well paced, and the same minimal-buying that let it race past the early tiers is
plausibly why the right purchase never gets made by tier 6.

Spec E.2: *"if `bottleneck` lands materially worse than `greedy`, the UI is lying to
players and no amount of balance tuning fixes that."* `bottleneck` reaches tier 6 of 10;
`greedy` reaches all 10 — nowhere near it yet. E.2's bar is not met. This is the same
shape of defect as the one tasks 1-3 fixed (the reporter falls through to naming a
blocker it CAN name instead of the one that actually blocks the milestone) and it may
need the same kind of fix, but that is unconfirmed — nobody has yet looked at what the
reporter says at the tier-6 stall the way tasks 1-3 looked at the tier-1 one.

**Tier times are QUANTISED by the binding item's liquid storage cap.** This is the
single fact that explains both staircase misses. `tierProgress` returns 0 for a
requirement above the cap -- correctly, since waiting never delivers it and only buying a
level does -- so a requirement one unit over the cap pins the purchase cadence at
`purchaseIntervalEarlySeconds` for the WHOLE run instead of ramping to
`purchaseIntervalLateSeconds`. A binary regime switch, worth far more than any amount of
extra stuff. Tier 1 sweeping `iron_plate` (cap 2500): 2400 -> 0.250, 2500 -> 0.260,
2600 -> 0.418, 2900 -> 0.746. Below the cap the curve is smooth (~0.0104 collections per
100 plate); above it the steps are ~0.33 tall against a 0.025 tolerance.

**A second requirement item does NOT give a finer knob.** This was the standing guess and
it is wrong. Calibration scales every item of a tier by ONE factor, so the ratio decides
which item is satisfied last, and only the last one matters. An item that fills to its own
cap first is FREE: tier 1 with `iron_plate` 2800 plus `iron_ingot` at anything from 200 to
3300 measures 0.419367 every time, and tier 5's `copper_sheet` measured a flat 2.428110
from 1800 to 2600. Only an item pushed above ITS OWN cap adds anything, and then it adds a
whole cliff.

**That cliff-stacking is what fixed tier 5, and could not fix tier 1.** Re-weighting tier
5's authored seeds 800:300 -> 800:563 makes `copper_sheet` the one over its cap; its cliff
lands between steel's two and the tier fits at +2.2% where the old ratio could only manage
+5.1%. Tier 1 has no such landing spot: a grid over all five tier-0 items x both plate
plateaus x ~100 amounts found NOTHING in [0.44, 0.58]. Its target is now an honest 0.42.

**Tier 10's amounts search WAS inert — fixed 2026-09-17.** `resolve` can unlock several
tiers in one step, and `runSimulation` pushes a checkpoint per tier that all share the
same state, so the checkpoint saved for tier 9 carried `state.tier = 10`. Every tier-10
probe resumed from it, recorded no tierTime, and hit a branch that returned the
checkpoint's clock — **15.539209 for every candidate, including 7,168,000
smart_plating**. `derived.yaml` claimed 15.54 where a plain run measured 20.87.

The fix is `withMilestonesUpTo` in `calibrate.ts`: the run for tier k is given only the
milestones up to k, so nothing above it can ride along in the same resolve. Truncating
rather than suppressing the unlock, because unlocking two tiers at once is CORRECT
behaviour for a real player and the engine is shared with the game. Nothing in a prefix
can read a milestone above the one it runs to — `tierProgress` reads `state.tier + 1` and
the loop exits when `state.tier` reaches its target — so the truncation changes no
decision the run would otherwise have made. The same fix is applied to `tierCeilings`,
which walked the same checkpoint chain and would have read a co-unlock as "ceiling beyond
the budget, so it clears its target", the opposite of what happened.

The short-circuit branch is gone. It rescued the symptom and kept the defect: the value
it returned did not depend on the candidate, so the search reported one constant and
called it a measurement.

**All ten tiers now reproduce.** `derived.yaml` and a plain `sim run` agree exactly on
every tier, which was the invariant this broke.

**What tier 10 actually is, measured honestly.** The search now returns distinct values
(15.54, 20.14, 20.87) where it used to return one. It says:

- Any requirement up to about **1,024,000** smart_plating is FREE — tier 9 already banks
  that much, so tier 10 unlocks in the same resolve and lands at 15.54.
- Anything above **7,665,440** is infeasible: that is
  `maxAttainableCap(smart_plating, tier 9)`, the most a player can ever hold, and ruling
  R7 pays deliveries from liquid stock.
- The solved amount, 7,663,000, is **99.97% of that ceiling**, and it lands at 20.87.

So tier 10 is hard-capped at 20.87 against a target of 25, and the cap is storage, not
patience. The earlier conclusion — that tier 10 must gate on something the amounts search
can move — survives, but it is now supported by a search that works rather than one
returning a constant. The options are recipe depth, a power or throughput wall, or more
storage depth across the tier 9 -> 10 step. **Still your call.**

**`greedy` buys storage alphabetically.** `levelCostRange` ignores the item, so every
level-0 silo costs exactly the same, all ~23 candidates tie on score, and `cheapest` breaks
the tie on label. At tier 1 greedy buys silos for `crude_oil`, `fuel` and
`heavy_oil_residue` -- items it cannot produce -- before `iron_plate`, the one actually
capped. This is the same defect already fixed one loop above for machines (the `live`
filter and its "790 of 1,639 purchases" comment); the storage half was missed. Measured: a
`live` filter on storage candidates cuts tier 1 from 100 to 89 purchases and ~20% off the
high plateaus. NOT applied -- it re-paces every tier and wants its own calibration run.
It does not remove the cliff: with the filter the tier-1 steps are still ~0.22 tall.

**Do not "fix" `tierProgress` by deleting its over-cap guard.** Measured this session:
removing it takes tier 1 from 0.26 to **5.44** and makes the curve non-monotone either
side (2600 slower than 2800), reproducing the catastrophe its doc comment already records.
The guard is load-bearing.

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

**1. `bottleneck`'s tier-9 stall — FIXED 2026-10-14 (slow-payer advice); history below.**

Originally (2026-10-13): under the gate's dead-time cut-off it reported `reachesTier: 9`. From about 3.65
collections its advice stuck on one constructor Mk.3 for `make_steel_pipe` (limiting
target `item:heavy_modular_frame`), priced at about 36.6 `steel_pipe`. The assembly rigs
drained `steel_pipe` to 0, so the advice was payable on paper and never in practice. Run
alone, the policy reached tier 10 at 26.75 collections after a 7d18h dead stretch. This was
a payable-advice gap: the payability check ignored the net drain of the cost item by its
consumers. It was then the open follow-up.

**Updated 2026-10-13 (reserves protect stock, `specs/2026-10-13-reserves-protect-stock-design.md`):**
the drained-payer stall is fixed by reserve advice: the reporter names a reserve on a drained
payer, `bottleneck` sets it and clears it once the advice moves on, and the stall moved from
~3.65 to a last purchase near 5.1 collections (at the time: still `reachesTier: 9`; tier 9 then at 2.5329).
The new stall is the next follow-up: the advice is the 12th assembly rig for
`make_heavy_modular_frame` (11 owned), priced at 409,600 `smart_plating` + 409,600
`encased_industrial_beam`. Liquid (stored + quantum) figures: `smart_plating` 720,576 (FULL,
net 0) covers its share; `encased_industrial_beam` 169,905 of a 450,360 liquid cap, growing
at 2.94/s (production 15.63, consumption 12.69). So the price is payable and no payer is
drained: the run waits about 22.6 hours for 239,695 more beams, past the gate's 2-collection
dead-time cut-off. The next question is whether that wait is a pacing finding or wants
more beam capacity.

**Fixed 2026-10-14 (slow-payer advice, `specs/2026-10-14-slow-payer-advice-design.md`):** the
12th-rig beam wait is gone. The reporter now advises one more machine for a payer too slow
to afford the purchase soon, so `bottleneck` keeps building and finishes all ten tiers under
the gate: tier 10 at 12.4274 collections, dead time 0.61 (tier 9 at 2.4785). The pin no
longer carries `reachesTier: 9`.

**Amended 2026-10-14 (final review):** the redirect now walks on to the recipe that limits a
starved input, since it had named starved recipes (beam 318 advised, 98 bought with `steel_beam`
EMPTY; cable 12 of 12 with `wire` EMPTY). Then-current pins (superseded by the 2026-10-15 bullet below): tier 10 at 10.6168, dead time 0.5473,
tiers 7 to 9 at 1.3033, 1.6826, 2.5167.

**Follow-ups from the slow-payer branch (2026-10-14):**
- **Fixed 2026-10-15: recipe advice is bought as a lane/class machine and auto-assignment can place
  it elsewhere.** `BUY_MACHINE` now names its recipe and `bottleneck` passes the advised one. Misplaced
  purchases on advice: 105 -> 0 (probe: 272 purchases made on advice, 0 misplaced). Spec
  `2026-10-14-buy-for-a-recipe-design`. Part 1 alone stalled `bottleneck` at tier 7 on an oil-chain
  jam; the new blocked-payer rule (Part 2: storage for a FULL output that stops a short payer's
  recipe) fixed it. Pins moved (2026-10-15): bottleneck t3 0.3055 -> 0.2965, t4 0.4986 -> 0.4496,
  t5 0.6190 -> 0.5172, t6 0.8877 -> 0.7622, t7 1.3033 -> 1.0315, t8 1.6826 -> 1.4204,
  t9 2.5167 -> 2.2693, t10 10.6168 -> 10.5551; dead 0.5473 -> 0.6089.
- **The reporter can advise a recipe already running below nameplate.** 16 of 339 purchases (measured on `main` before this branch),
  mostly `mine_coal`, buy a machine for a recipe that is live but limited by something else, so the
  machine adds little.
- **Edge case (not observed):** if the slow payer's recipe is the advised recipe itself, the
  redirect resets `machinesToClear` to 1.
- **Done 2026-10-15: the blocked-payer rule now checks the cause.** For a short payer that is not
  made, the reporter checks in order: recipe starved (one machine for the recipe that limits it),
  then no machines (one machine for it), then FULL output (storage). Measured: on `main`, 33
  decisions kept advice `encased_industrial_beam` could not pay while its recipe was starved; the
  new walk fires 19 times in a `bottleneck` run, all for the beam. Pins moved: bottleneck t10
  10.5551 -> 10.5329; dead 0.6089 -> 0.6379; t1-t9, greedy and casual unchanged. Spec
  `2026-10-15-unmade-payer-design`.
- **`visited` serves two purposes in `payable`** (follow-up, not observed): "considered as a payer"
  and "already advised storage". A payer considered with no cause, or an input a dead-end walk
  stepped through, stays visited; if a later redirect's price overflows that item's cap, `payable`
  returns the honest wall (`upgrade: null`) without trying `cheaperUpgrade`. The slow-payer path
  already had this; the unmade-payer check adds more ways in.
- **Walk-end advice doesn't check the end recipe's FULL outputs or power** (follow-up, theoretical):
  both the slow-payer and unmade-payer walks advise a machine for the recipe they end on without
  checking it can use one. Probed on the slice: every such advice had power 1.0, clock 1.0, no FULL
  output. Belongs with the below-nameplate item above.
- **Done 2026-10-15: `payable`'s loop has a hard cap that throws.** It allows `items.size + 2`
  passes and then throws, so a lost `visited` guard fails fast in tests instead of hanging the
  game (the reporter runs on every resolve).
- **No rejection test in an unaffordable world** for `BUY_MACHINE.recipeId`; validation order is
  correct by reading.
- **The maxed-storage `upgrade: null` wall for a blocked output is untested.**
- **The gate-cli `why` texts repeat a long re-measure sentence;** a shared constant would be tidier.

**Follow-ups from the reserves branch (2026-10-13):**
- **Size a reserve against the remaining upstream.** A reserve's target (25% of the
  unconstrained rate, ranked right after power) can take nearly all of a short shared
  upstream and starve its consumers (`steel_pipe` reserved: consumption 4.386 to 0), so each
  reserve lasts one interval. Cap the target by what is left of the upstream.
- **Latent livelock.** The policy holds one reserve at a time, so two items both short in
  the same price could alternate reserves without either reaching the price (not seen in
  the gate). A fix would keep reserves for every short payer of the current price.

History, kept below (the pre-capstone state, no longer current):

**`bottleneck` finished all 10 tiers, at 5.58 collections against a target of 25 (was: the tier-7 stall).**

Current pins (re-measured 2026-10-10 after R32 asked jointly, unchanged since): tier 10 at
5.5792, 500 purchases, dead time 0.225 collections. The 5.87 / 514 figures below are the
payable-advice measurement before that.

Gate-confirmed 2026-10-10 from a fresh run (not the resumed checkpoint): tier 6 at
0.9337, tier 7 at 1.2871, 194 purchases, then cut off for dead time (2.004 collections).
History: at that point the open question was why the reporter advised quantum storage
for `packaged_fuel` while the policy bought nothing -- unaffordable advice (the
out-of-scope case the gridlock spec named) or a policy-side gap. The resolution below
answers it.

Resolved 2026-10-10 (payable advice, `specs/2026-10-10-payable-advice-design.md`): it was
unaffordable advice -- a Quantum Storage level costing 4,473 `iron_plate` while
`iron_plate` could hold 4,000 (measured before the fix). After payable advice the run
passes tier 7. The advice it took there was not captured: the Step 1 probe started from
a checkpoint saved by pre-payable code and showed recipe advice for `package_fuel`.
Gate-measured: `bottleneck` passes tier 7 (1.2871) and finishes the
slice: tier 8 at 1.6482, tier 9 at 3.1939, tier 10 at 5.8707, 514 purchases, dead time
0.221 collections. Nothing stops it any more; the remaining defect is the opposite one,
that it lands 77% to 85% EARLIER than target at tiers 7 to 10 (as at tiers 1 to 6), so
its pins are now overshoot pins, not a stall. `greedy` and `casual` are unchanged.

> **Investigated 2026-10-09; three causes, in the order they bite.** (1) The power branch
> always named the generator: `bottleneck` owned 77 biomass burners and zero collectors.
> FIXED -- a starved generator now names what starves it. (2) The oil lane gridlocks:
> `fuel` has no consumer at tier 6, so residue fills and the FULL sweep holds both
> refineries at zero while the reporter keeps naming `refine_rubber` (50 refineries
> bought). FIXED -- the forward walk (`specs/2026-10-09-byproduct-gridlock-design.md`).
> Measured by resuming `bottleneck` from the saved step-80 gridlocked state: step 0 now
> advises storage for `fuel` (limitingTarget `item:rubber`) where it advised
> `refine_rubber`; rubber rose from 8,192 at step 0, its `net` first printed positive
> (0.242) at step 10, and the policy crossed into tier 7 at step 8. Run on from the
> tier-6 checkpoint for 200 steps (sampled every 20, 0.98 to 1.84 offline caps): tier 6
> clears before step 80, and by step 100 the advice is storage for `packaged_fuel`
> (`upgrade: "quantum"`; tier 7 -> 8 needs 38,400 `packaged_fuel` and 51,200 `modular_frame` -- the calibrated `derived.yaml` amounts; an earlier version of this line quoted the authored seeds, 600 and 800)
> with no purchases emitted, unchanged through step 180. `bottleneck` stalls next at
> tier 7. (3) Content part (A): give `fuel` a sink at tier 6 by moving
> `burn_fuel` / `fuel_generator` down from tier 7, and teach the validator to check
> byproduct sinks transitively (check 5 stops one hop short). **(A) needs an engine
> change first:** `activeRecipe` is keyed by primary output and every generator's is
> `__power__`, so only ONE generator recipe is ever live -- unlocking fuel generators at
> tier 6 gives fuel no sink while the grid runs `burn_biomass`. Generator types must run
> side by side; that is the first item in (A)'s spec, not yet written. The text below
> predates this investigation.

The paragraphs below predate the 2026-10-09 investigation.

The milestone-aware reporter (tasks 1-3) fixed the tier-1 advice failure described in
earlier versions of this doc: the reporter no longer optimises the top-priority item's
throughput irrespective of what blocks the milestone. `bottleneck` now reaches tier 6 of
10 (was tier 1), seed 42, `--max-days 120`: 229 purchases, max dead time 356.3315
collections — a real fix, not a closed one. It stalls again at tier 6, bound by
`refine_rubber` and `power:burn_biomass` (with `mine_copper_ore` and `make_screw` also
binding), and it reaches every tier it touches 66–82% faster than target, still buying
almost nothing. It remains far from `greedy` (tier 10), and spec E.2's bar ("if
`bottleneck` lands materially worse than `greedy`, the UI is lying to players") is not
yet met. The gate now pins `bottleneck` at tier 6 with six known-red tier entries plus a
dead-time pin; whether the tier-6 stall is the same reporter shape (naming a blocker it
CAN name instead of the one that actually blocks the milestone) needs the same kind of
investigation tasks 1-3 did for tier 1, not yet done.

**2. `SET_RESERVE` and `REORDER_PRIORITY` are related, and may be the same fix.**
Still emitted by no policy (carried forward below). A milestone-aware reporter would
naturally want to reorder priority toward the blocking item, which is the mechanic
already implemented and unused.

**Gate hygiene.** Known-red pins are asserted, not excused: they fail on drift AND go
stale loudly when the underlying tier starts hitting its target, so they cannot outlive
the problem. `sim gate --emit-pins` prints a paste-ready block from current measurements
— re-pin with that after any calibration run rather than by hand.

History: the gate used to pin greedy's tier 10 at 20.8722, which was both what
`derived.yaml` said and what the game did. It no longer pins it: tier 10 has been on target
(24.06) since 2026-10-13.

**DONE 2026-10-13** — **3. Tier 10 — the only off-target tier, and now honestly measured.**
Tier 10 is now a capstone (`heavy_modular_frame`, made on the steeply priced `assembly_rig`, authored `costRatio` 2.0): greedy observes 24.06 against a target of 25 (-3.8%), with a solved amount of 30,000.
Tiers 1 and 5 are DONE (2026-09-16); the calibrator short-circuit is FIXED (2026-09-17).
What is left is the content-design decision, and it now rests on a search that works:

- **The ceiling is storage, not patience.** The requirement cannot exceed
  `maxAttainableCap(smart_plating, tier 9)` = 7,665,440, because ruling R7 pays
  deliveries from liquid stock. The solved 7,663,000 is 99.97% of that, and it lands at
  20.87 against a target of 25. **No amount reaches 25.** Anything up to ~1,024,000 is
  free, because tier 9 already banks that much.
- The standing reading — that tier 10 must gate on something the amounts search can move
  — is confirmed rather than merely suspected. The options are recipe depth, a power or
  throughput wall, or more storage depth across the tier 9 -> 10 step.
- **The item RATIO is ruled out — measured 2026-09-19, and this one was measured through a
  search that works.** It was the obvious untried lever, being the one that fixed tier 5.
  It does nothing here. Both requirement items carry the SAME base caps (200 + 800) and
  therefore the same ceiling, 7,665,440. Sweeping each independently from a tier-9
  checkpoint:

  | binding item | 3.0M | 5.0M | 7.0M | 7.6M | at ceiling |
  |---|---|---|---|---|---|
  | `smart_plating` | 19.356 | 20.141 | 20.869 | 20.8719 | never |
  | `encased_industrial_beam` | — | 20.141 | 20.656 | — | never |

  `encased_industrial_beam` binding lands at **20.656**, which is FURTHER from 25 than
  `smart_plating`'s 20.869, so the shipped weighting is already the better of the two. And
  the two do not compose the way tier 5's did: both binding together measures
  **identically** to `smart_plating` alone — (7.0M, 7.0M) and (7.0M, free) are both
  20.8688 — because they are in the same saturated regime rather than on opposite sides of
  one cap.

- **The curve SATURATES, which is stronger than "logarithmic".** Per million units,
  5M -> 7M is worth 0.364 collections; 7M -> 7.5M is worth 0.0052. A seventy-fold collapse
  in marginal value, and then the ceiling. The shipped 7,663,000 measures 20.8722, which is
  within 0.0003 of the best any amount achieves. **The calibrator has already found the
  optimum; there is no amount left to find.** Tier 10's miss floor is -16.5%.

- So the reachable band for tier 10 is **[15.54, 20.872]** and 25 is not in it — not by
  either item, not in any ratio, not by both together. Raising storage depth is the
  remaining amount-shaped idea and it is the weakest: the deep end was already measured at
  ~0.65 collections per doubling, needing ~4,000x to reach 25. **What is left is structural
  — recipe depth, or a power or throughput wall.** Still your call, but the amount-shaped
  half of the decision space is now closed by measurement rather than by argument.

**4. Test-fixture coupling — a correctness problem, not a speed one.** **DONE 2026-10-12:**
the calibrator's mechanics tests now measure `packages/content/bundles/calibration-fixture/`,
a frozen copy of the slice's authored files that is never calibrated or edited to follow
the slice (its README states the rules). Two canaries stay on the live slice. Verified by
deepening the live slice's storage ladder to 30/24 and re-running the calibrate tests:
unaffected. History below.
Three times this session a content change silently invalidated mechanics-test premises
(5 tests on retuned targets, 4 on the deeper ladder, 6 on `costGrowth`). One test had
stopped testing its claim entirely: the pre-filter test that exists to prove the expensive
fit is SKIPPED spent 23 minutes performing it, and reported nothing wrong. `withTargets`,
`withLadder` and `shallow` in `apps/sim/src/calibrate.test.ts` patch the live slice, so
`shallow` still spreads shipped content and pins only storage fields — the next recipe or
machine-cost edit reopens this.

**It happened a fourth time on 2026-09-16.** Retuning tier 1's target 0.5 -> 0.42 failed
"refuses a scale that drives r_eff below the runaway floor", which asserted
`rEffScale === 1`. That assertion was never about refusal: the test passes a 2-entry grid,
so the refinement pass runs, and at the new target a scale of 0.6 legitimately fits tier 1
better than 1 does. The test now asserts what it is named for — the refused scale is
reported, scores an infinite miss, gets no `capPerTier`, and is not the one chosen — and
says in a comment why it must not pin the winner. Fix: a frozen `bundles/calibration-fixture/` that is
explicitly never tuned, with the ceiling and capPerTier tests pointed at it. Keep one
cheap end-to-end test against the live slice so the calibrator still has a canary.

**5. One decision open since the plan was written.**
- **DONE 2026-10-12:** `storageBindingCadence` removed; the curves are recorded as
  authored-with-measurements in §B.7. Was: B.7's storage list, where `costGrowth` was
  authored with measurements behind it but `capGrowth`, `baseCostAmount` and `maxLevel`
  were placeholders, and `pacing.storageBindingCadence: 12` was read by nothing. The
  choice was to solve against it or delete the intent; it was deleted.

(`SET_RESERVE` and `REORDER_PRIORITY` were the second decision here; promoted to item 2,
since the `bottleneck` finding gives them a concrete reason to exist.)

**6. Eleven carried-forward items** from Phases 0/1, none blocking. See the plan's
"Carried forward, still open" table.

**7. Plan hygiene.** DONE 2026-10-12: the plan's "Still to do" list is renumbered, and
its "ten hours a scale" and "33 collections for one rotor" claims are marked superseded
in place.

**8. Two gaps in the milestone-aware bottleneck reporter, noted so they are not
rediscovered as new.**
- **A PAUSED milestone requirement is invisible to the walk.** `waterfall.ts` filters
  paused entries out of `entries`, so `resolveBlocker`'s `entries.find` returns
  `undefined` for a paused item and the walk declines exactly as it does for a
  requirement that is merely accumulating. A player who pauses an item the next
  milestone needs (spec 4.1 makes `paused` the remove verb) gets silence from the
  reporter instead of a blocker. No automated policy emits pause today, so this is
  human-CLI-only, not something the pacing gate can hit.
- **CLOSED 2026-10-09** by the gridlock walk, which checks every output of the recipe it
  would name. In the cable / `make_wire` example below it now answers `make_cable`, the
  drain for `wire`, and storage for `wire` only if nothing live consumes it. Pinned by
  the test "checks the recipe it is about to name" in
  `packages/engine/src/solve/bottleneck.test.ts`.

  Original text, kept as history: **the milestone branch checks FULL on the requirement item only, not on the output
  of the recipe it names — pre-existing, not introduced by this change.** A milestone
  needing `cable`, limited by `make_wire`, with `wire` itself at cap, yields "buy N
  more wire machines" when the real answer is a storage level for `wire`. The old
  priority scan has the identical gap at its own level, so this is not a regression;
  it is recorded here so it is not mistaken for one.

**9. Greedy's storage sweep depends on how many stock items exist.** `policies.ts` (about
lines 254-261) offers storage for every `content.stockItemIds`, live or not; the machine
offer was already fixed for the same reason. Adding `heavy_modular_frame` therefore added
one 2-minute `BUY_STORAGE` to greedy's tier-0 sweep (greedy tier 1 0.4178 to 0.4220;
casual tier 1 2.0065 to 3.0035, as those 2 minutes cross an offline-window boundary).
Fixing it is a policy change that shifts every calibrated tier, so it is its own branch.

---

## Follow-ups from the milestone-aware bottleneck change (2026-09-19)

> **Both follow-ups below are DONE (2026-10-10), in a different shape than proposed.**
> Not a per-policy day budget but a **stall cut-off**: `runSimulation` takes
> `stopWhenDeadMs`, and the gate passes its own 2-collection dead-time threshold, since a
> run past it has already failed that check. That adapts as policies improve, where a day
> budget would need re-tuning. It also dissolves the dead-time-pin trap described below:
> a stalled run's dead time is the cut-off by construction, so `deadTimePin` is gone and a
> known-broken policy pins WHERE it stalls (`reachesTier`). And the gate's runs now go in
> parallel worker threads (`gate-worker.ts`). Measured: greedy 259.0s, casual 528.5s,
> bottleneck 812.0s (cut off at tier 7, dead 2.004 collections), determinism rerun
> 256.3s -- **812s wall, against ~49 minutes before**. CI cap lowered 180 -> 90. The
> `bottleneck` pins are re-measured: `reachesTier: 7`, tiers 1-7 pinned.
>
> **Superseded 2026-10-10 (payable advice): the cost above is out of date.** `bottleneck`
> now finishes all 10 tiers and the gate takes 135m18s locally (greedy 2m30s, casual
> 6m24s, determinism rerun 2m29s, bottleneck 135m17s), not 812s. At the 2.43x runner
> factor the pacing job will exceed `.github/workflows/ci.yml`'s `timeout-minutes: 90`,
> which is unchanged and needs a decision.
>
> **Partly fixed 2026-10-10 (R32 asked jointly):** part of the 135 minutes was a solver
> cycle, not needed simulation -- see `docs/superpowers/specs/2026-10-10-coupled-empty-pins-design.md`.
> The gate now takes 85m18s locally (greedy 2m29s, casual 6m29s, bottleneck 85m17s,
> determinism rerun 2m30s). That is still ~207 minutes at the 2.43x runner factor, over
> the 90-minute cap, so the decision on it remains open. The 50-minute drop is not purely
> the cycle's cost: bottleneck's trajectory changed too (500 purchases against 514, tier 10
> at 5.58 days against 5.87). Pins moved: bottleneck tiers 8-10, and casual tier 10
> (205.0095 -> 205.0120 days). Casual does not read the reporter, so that move is the
> solver change itself; it is negligible.
>
> **Next follow-up: a second cycle remains.** Once `reinforced_iron_plate` is FULL (about
> 2,270 s of play after the `slice-tier-8` fixture), `screw` alone pins and un-pins --
> ~5,000 `drain:screw` events in one 120 s resolve, tripping MAX_EVENTS. It is not a
> regression (from the same state the per-entry R32 cycled `iron_plate`/`screw`), but it
> is the same kind of R32 escape, with the shared consumer FULL rather than starved. So
> the remaining 85 minutes is not known to be needed simulation: fix this, with a frozen
> fixture taken just before `reinforced_iron_plate` fills as the failing test, before
> raising `timeout-minutes`.
>
> **Resolved differently 2026-10-12: the cycle is now cheap, not gone.** Three attempts to
> remove it in the solver failed the gate (see
> `docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md`, superseded). Each
> rule moved the flip somewhere else, because the three-state stock model lets a consumer's
> draw switch between "from stock" and "through the recipe" at zero stock. Instead
> `resolve` caches `solve` per item-state configuration (engine spec §C.7, 2026-10-12):
> pins are byte-identical and the gate takes 2m18s (greedy 23s, casual 22s, bottleneck
> 2m17s, determinism rerun 24s), ~5.5 minutes in CI against the 90-minute cap. The
> frozen fixture `slice-tier-8-reinforced-full.world.json` prices the cycle in
> `resolve.test.ts`. Removing the cycle for real is a separate project: a solver that
> rations an item's stock by priority, with no stock-dependent switch.

**The pacing gate needs a per-policy day budget.** Fixing the advice made the gate three
times slower, for a reason worth understanding: a policy that makes progress simulates far
more steps than one sitting dead. Measured after the change — greedy 141.8s, casual 382.8s,
**bottleneck 2273.9s**, ~49 minutes locally against 15m54s before, and ~119 projected in CI
at the measured 2.43x runner factor. The CI cap was raised 90 -> 180 minutes as a stopgap.

Almost all of that 37.9 minutes is `bottleneck` simulating a stall the gate has ALREADY
pinned. It reaches tier 6 at 1.17 collections — about half a simulated day — and then runs
the remaining ~119 days to establish what `reachesTier: 6` already asserts. The gate passes
one `--max-days` to every policy, and it cannot go below ~69 because `casual` needs 68.3
days to reach tier 10. So the fix is a per-policy budget on `PolicyGate`, not a smaller
global one.

**And a subtler thing that fix must handle:** a stalled policy's dead-time pin — currently
356.3315 collections — is largely an ARTIFACT of the 120-day budget rather than a property
of the game. Shorten the budget and the number moves, because dead time for a stalled
policy is essentially "budget minus time-to-stall". Whatever budget the per-policy fix
picks, `bottleneck`'s dead time has to be re-pinned against it, and the pin's `why` should
say that the number is budget-relative. Pinning it as though it were a measured property of
the content would be pinning an artifact.

**Run independent simulations in parallel — do this together with the per-policy budget.**
Queued 2026-10-09. Nothing in `apps/sim` uses workers or child processes today, so every
gate and calibration run is serial on one core (the dev machine has 16). A single run
cannot be parallelised -- each step depends on the state the last one produced -- but the
runs themselves are independent:

- **Gate:** the policy runs (greedy twice, casual, bottleneck) are self-contained calls to
  `runSimulation`, and the rules in `gate.ts` are already a pure function over the
  collected `RunReport`s. Running them concurrently makes the gate cost its slowest run
  rather than the sum. Determinism must survive: the greedy-twice divergence check has to
  compare two genuinely separate runs, not one shared result.
- **Calibration:** candidates within one tier's search are independent and can fan out;
  tiers cannot, because tier k resumes from tier k-1's checkpoint.
- CI runners have few cores, so the win is mostly local; size the pool from
  `os.availableParallelism()` rather than hard-coding it.
- GPU and RAM do not help: the work is branchy decimal arithmetic, CPU-bound per run.

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

# the pacing gate (spec E.5) -- exits non-zero on any finding
cd apps/sim && npm run gate:smoke     # greedy to tier 4, ~3s, runs on every commit
cd apps/sim && npm run gate           # three policies to tier 10, ~16 min
cd apps/sim && npx tsx src/bin.ts gate --content <dir> --emit-pins   # re-pin

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
