# The FULL sweep throttles unbankable EMPTY feeders

> **SUPERSEDED 2026-10-13.** This approach was implemented (8a7caec), reverted
> (d8d87a1) after the gate showed it stalled `bottleneck` at tier 1, and two redesigns
> prototyped after it also failed the gate. The cycle it targeted is now cheap rather
> than gone: `resolve` caches `solve` per item-state configuration (engine spec §C.7,
> 2026-10-13). Kept as the record of what was tried and why it failed.

**Amends:** spec C.2/C.3 (the solver), ruling R6 (the FULL backpressure sweep).
**Status:** superseded 2026-10-13 (see the note above).
**Branch:** `worktree-phase-2-content`.
**Follows:** `2026-10-10-coupled-empty-pins-design.md`. R32 asked jointly removed the
`iron_plate`/`screw` cycle and brought the pacing gate from 135 to 85 minutes. The final
review of that work found a second cycle, and this spec covers it.

---

## The problem, measured

Start from the saved `slice-tier-8` world and step forward in 120 s resolves with no
purchases. Steps 0-18 are quiet (2 events, then 0-1 per step). In step 19, starting
2,280 s in, `reinforced_iron_plate` fills 38.75 s into the step. From there one resolve
holds **5,001 events**: the fill, 4,999 drains of `screw` at about 5 µs spacing, and the
`MAX_EVENTS` guard. That step takes about 19.5 s, where a quiet step takes about 6 ms.
This is not a regression from R32: from the same state the per-entry R32 cycled
`iron_plate`/`screw` instead.

## Why

It is not R32. With `screw` pinned EMPTY, R32 holds it: `item:screw` is disqualified and
allocated 0. The surplus comes later in `solvePass`, from the FULL sweep (ruling R6).
Instrumenting one `solvePass` at the moment `screw` re-pins:

| stage | `screw` production | `screw` consumption |
|---|---|---|
| waterfall output (`screw` pinned EMPTY) | 551.49/s | 551.49/s |
| after the FULL sweep | 551.49/s | 401.60/s |

`reinforced_iron_plate` is FULL, so the sweep scales `make_reinforced_iron_plate` by
consumption / production = 32.55 / 45.04 ≈ 0.72. That cuts the `screw` it consumes. The
sweep visits items downstream-first and touches only FULL ones. `screw` is EMPTY, so
`make_screw` keeps the clock the waterfall gave it, which was sized to feed the consumers
that were just throttled.

The result is a +150/s surplus on an item pinned EMPTY. That is R32's limit cycle again,
arriving from a different place: the surplus lifts `screw` off zero, which un-pins it,
which lets its walkers draw from stock (net −34/s), which drains it, which re-pins it.

## Design

### The rule

In the FULL sweep, an item is treated like a FULL item when all three hold:

- it is pinned EMPTY;
- **no entry may bank it**: every live (unpaused) entry for the item is in the
  waterfall's R32 `disqualified` set, or it has no live entry;
- every producer of the item has that item as its **only output**.

If, by the time the sweep reaches such an item, its production exceeds its consumption,
its producers are scaled down to match, exactly as for a FULL item.

**The reasoning.** When an item is pinned EMPTY, any production it gets either feeds its
consumers or is banked by an entry for it. If no entry may bank it, because none is live
or because R32 has already ruled that banking it is unsustainable, then production
beyond its consumption has nowhere legitimate to go. Banking it anyway is what restarts
the pin/unpin cycle, so that production follows the consumers down.

**If an entry may bank the item**, the freed production is legitimate banking for that
entry, and the sweep leaves it alone, as it does today. Measured on the fixture bundle:
with `iron_plate` at cap and one smelter feeding one constructor, `iron_ingot` (pinned
EMPTY) is exactly balanced before the sweep. With `item:iron_ingot` live and not
disqualified, the freed smelter banks ingot at +0.5/s. That un-pins `iron_ingot` without
any cycle. The same condition keeps spec C.2's test "throttles producers of an item at
cap so its net rate is zero" unchanged. In that test, `iron_ore` is pinned EMPTY and
banked by `item:iron_ore`, and the miner stays at clock 1.

**A producer with other outputs** would cut those outputs too when throttled, for a
reason unrelated to them: throttling a refinery to stop a plastic surplus would starve
its residue consumers. An item with such a producer is therefore left as it is today.

**History of this rule.** This spec was first approved with a narrower trigger than the
rule above: "pinned EMPTY and exactly balanced in the waterfall's output". Probing the
plan's tests on the fixture showed three things:

- That version idled the smelter in the `iron_ingot` case above, leaving the ingot stuck
  at zero.
- Once "no entry may bank it" was added, the "balanced" condition was redundant. No test
  failed without it, and the snapshot of flows taken before the sweep went with it.
- The output guard was added for the byproduct hazard.

### The computation

In `solvePass` (`packages/engine/src/solve/fixpoint.ts`), the downstream-first sweep
visits an item when it is FULL (as today) or when all of the following hold:

- it is in `pinnedEmpty`;
- no entry with `!paused` and that `itemId` is outside `waterfall.disqualified`;
- every recipe in `content.producersOf.get(itemId)` has `outputPerSecond.size <= 1`.

For a visited item, the existing body runs unchanged. If production exceeds consumption
by more than `FLOW_TOLERANCE`, every producer is scaled by consumption / production and
added to `sweepTouched`.

Since the sweep runs downstream-first, a throttle cascades upstream. Throttling
`make_screw` cuts its `iron_rod` draw, and `iron_rod` (FULL here) is visited later and
throttled in turn. Each step only multiplies a clock by a factor in [0, 1], so the R31
reconciliation argument (touched recipes are already final) holds unchanged.

The `pinnedEmpty` condition cannot be reached for an item that has stock. A requirement
walk draws such an item from stock and never runs its producer, so only its own entries
could, and none may. No test can make it bite. It stays in the code because it states
the rule's scope.

### What this does not change

- **A pinned EMPTY item an entry may bank** is skipped, as today. This covers the C.2
  `iron_ore` test and the fixture's `iron_ingot` case.
- **A pinned EMPTY item with a multi-output producer** is skipped, as today.
- FULL items, the R30 EMPTY sweep, R32, the reconciliation pass, `resolve`, the
  bottleneck reporter and the policies.

### Determinism and cost

Pure arithmetic in a fixed order, with no clock. The new conditions read `entries`,
`waterfall.disqualified` (which the first `runWaterfall` call already returns) and the
indexed recipes. A newly visited item costs one `computeFlows`, the same per-item cost
the sweep already pays.

Measured with a throwaway version of this rule:

- **The repro:** the step that held 5,001 events holds 1 (the fill), and the run stays
  quiet through 2,880 s.
- **The engine suite**, with acceptance tests 1-4 added, passes 395/395.
- **Mutations:** each new test fails with its condition removed, and the rule removed
  fails tests 1 and 4.

## Out of scope

- **The R30 mirror of this shape.** When the R30 EMPTY sweep throttles a consumer because
  a different input ran out, the consumer's other inputs, if pinned EMPTY and
  unbankable, get the same kind of surplus. It has not been observed. If it shows up,
  the fix is the same rule applied at the end of the R30 sweep. It is not added
  speculatively.
- **Unbankable EMPTY items with multi-output producers.** They keep today's behaviour,
  which is a possible cycle. Throttling them correctly would mean scaling one output
  without the others, which the clock model cannot express.
- **Damping in `resolve`.** Rejected for the same reason as in the R32 spec: it would
  hide the cycle while the solver kept producing the wrong rates.
- **The 90-minute CI cap's value.** It is re-checked against the new measurement, not
  re-chosen.

## Acceptance

Unit tests, each asserting its preconditions first, each guard mutation-checked:

1. **An EMPTY feeder nobody may bank** (`fixpoint.test.ts`, fixture bundle).
   - **Setup:** `iron_plate` at cap, `smelt_iron` assigned 1 unit, `item:iron_ingot`
     paused, `iron_ore` and `iron_ingot` pinned.
   - **Preconditions:** the waterfall alone runs `smelt_iron` at clock 1 and
     `make_plate` at 1 unit.
   - **Expected:** after `solvePass`, `make_plate` and `smelt_iron` are both at clock 0,
     and `iron_ingot`'s net is 0.
   - **Today:** fails, because `smelt_iron` stays at 1.
2. **An EMPTY feeder an entry may bank**: the same world with `item:iron_ingot` live.
   - **Precondition:** `item:iron_ingot` is not disqualified.
   - **Expected:** `smelt_iron` stays at clock 1, and `iron_ingot`'s net is +0.5.
   - **Today:** passes. It fails without the "no entry may bank it" condition.
3. **A multi-output producer**: test 1's world, but on a content variant where
   `smelt_iron` also emits `heavy_oil_residue` as a byproduct.
   - **Expected:** `smelt_iron` stays at clock 1.
   - **Today:** passes. It fails without the only-output condition.
4. **Resolve, the measured case** (`resolve.test.ts`).
   - **Setup:** a frozen world saved just before `reinforced_iron_plate` fills, 2,280 s
     after `slice-tier-8`, committed as
     `fixtures/slice-tier-8-reinforced-full.world.json`.
   - **Expected:** a 120 s resolve finishes with the guard untripped, a `fill` of
     `reinforced_iron_plate`, no `drain` of `screw`, and fewer than 20 events.
   - **Today:** trips the guard.
5. **Existing tests**: the full suite passes unchanged. This includes the C.2 `iron_ore`
   test, `fuzz.test.ts` and `properties.test.ts`.

Measured on the vertical slice:

- A full `sim gate`, timed, with every pin re-checked. This is a solver change, so all
  three policies can move. Re-pin with `--emit-pins` where they do, and call out any
  `greedy` or `casual` move. Record the wall time in the CI workflow comment and the
  handoff. If the slowest lane fits under 90 minutes at the 2.43x runner factor, say so.
  If it does not, leave `timeout-minutes` unchanged and record what is left.

## The C.3 amendment

To be added to `2026-09-01-engine-core-design.md` §C.3, after the R32 amendment. That
amendment's "Not yet covered" sentence is replaced with a pointer to this one:

> **Amended 2026-10-11 (Phase 2): the FULL sweep throttles unbankable EMPTY feeders.**
> The downstream-first FULL sweep (R6) also visits an item that meets three conditions.
> It is pinned EMPTY. No entry may bank it: every live entry for it is R32-disqualified,
> or it has none. And it is every producer's only output. When a throttle further down
> has cut the item's consumption, the sweep scales the item's producers to match.
> Without this, a FULL consumer's throttle left its EMPTY feeder with a surplus that
> only the sweep had made. The surplus lifted the feeder off zero and restarted R32's
> pin/unpin cycle. Measured cause: once `reinforced_iron_plate` filled, `screw` cycled
> ~5,000 times per 120 s resolve of the vertical slice.
