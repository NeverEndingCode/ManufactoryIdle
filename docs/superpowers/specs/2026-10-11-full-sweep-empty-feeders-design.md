# The FULL sweep throttles balanced EMPTY feeders

**Amends:** spec C.2/C.3 (the solver), ruling R6 (the FULL backpressure sweep).
**Status:** designed 2026-10-11; not implemented.
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

In the FULL sweep, an item pinned EMPTY whose production exactly matched its consumption
in the waterfall's output is treated like a FULL item. If, by the time the sweep reaches
it, its production exceeds its consumption, its producers are scaled down to match.

The reasoning: a pinned EMPTY item balanced at net 0 is produced only to feed its
consumers. Nobody banks it (if its own entry could bank it sustainably, R32 would have
released it, and the waterfall's output would show a positive net). When the sweep
throttles those consumers, the production that existed only to feed them follows them
down.

### The computation

In `solvePass` (`packages/engine/src/solve/fixpoint.ts`):

1. Before the sweep, snapshot `computeFlows` at the waterfall's clocks: the **pre-sweep
   flows**.
2. The downstream-first sweep visits an item when it is FULL (as today) **or** it is in
   `pinnedEmpty` and its pre-sweep production ≤ its pre-sweep consumption +
   `FLOW_TOLERANCE` (balanced).
3. For a visited item, the existing body runs unchanged. If current production exceeds
   current consumption by more than `FLOW_TOLERANCE`, every producer is scaled by
   consumption / production and added to `sweepTouched`.

Since the sweep runs downstream-first, a throttle cascades upstream through a chain of
balanced EMPTY items. Throttling `make_screw` cuts its `iron_rod` draw, and `iron_rod`
(FULL here) is visited later and throttled in turn. Each step only multiplies a clock by
a factor in [0, 1], so the R31 reconciliation argument (touched recipes are already
final) holds unchanged.

### What this does not change

- **A pinned EMPTY item that was already banking before the sweep** (pre-sweep
  production above consumption) is skipped, exactly as today. Spec C.2's test
  "throttles producers of an item at cap so its net rate is zero" pins this: `iron_ore`
  is pinned EMPTY with its miner at clock 1 and net +1 before the sweep, and the test
  expects the miner to stay at clock 1 after the `iron_ingot` throttle. A broader variant
  of this rule, which trimmed every sweep-created surplus on an EMPTY item, broke that
  test. The test stays as it is.
- FULL items, the R30 EMPTY sweep, R32, the reconciliation pass, `resolve`, the
  bottleneck reporter and the policies.

### Determinism and cost

Pure arithmetic in a fixed order, with no clock. It costs one extra `computeFlows` per
`solvePass`, plus one per newly visited item, the same per-item cost the sweep already
pays. Measured with a throwaway version of this rule: the step that held 5,001 events
holds 1 (the fill), the run stays quiet through 7,080 s, and the engine suite passes
391/391.

## Out of scope

- **The R30 mirror of this shape.** When the R30 EMPTY sweep throttles a consumer because
  a different input ran out, the consumer's other inputs, if pinned EMPTY and balanced,
  get the same kind of surplus. It has not been observed. If it shows up, the fix is the
  same rule applied at the end of the R30 sweep. It is not added speculatively.
- **Damping in `resolve`.** Rejected for the same reason as in the R32 spec: it would
  hide the cycle while the solver kept producing the wrong rates.
- **The 90-minute CI cap's value.** It is re-checked against the new measurement, not
  re-chosen.

## Acceptance

Unit tests, each asserting its preconditions first, each guard mutation-checked:

1. **Balanced EMPTY feeder of a FULL item** (`fixpoint.test.ts`): an item pinned EMPTY,
   balanced in the waterfall's output, whose only consumer makes an item at cap. Assert
   these preconditions first: the feeder is pinned and its pre-sweep net is 0. After
   `solvePass`, the feeder's net is 0 (not positive) and its producer's clock was scaled
   by the same factor as the FULL item's producer. Fails today. If the test fixture has
   no single-input chain that fits, use a minimal in-test bundle.
2. **A banking EMPTY item is untouched**: the existing C.2 test passes unchanged
   (`mine_iron` stays at clock 1).
3. **Resolve, the measured case** (`resolve.test.ts`): a frozen world saved just before
   `reinforced_iron_plate` fills (2,280 s after `slice-tier-8`, committed as
   `fixtures/slice-tier-8-reinforced-full.world.json`). A 120 s resolve finishes with the
   guard untripped, a `fill` of `reinforced_iron_plate`, no `drain` of `screw`, and fewer
   than 20 events. Today it trips the guard.
4. **Existing properties**: the full suite, including `fuzz.test.ts` and
   `properties.test.ts`, passes.

Measured on the vertical slice:

- A full `sim gate`, timed, with every pin re-checked. This is a solver change, so all
  three policies can move. Re-pin with `--emit-pins` where they do, and call out any
  `greedy` or `casual` move. Record the wall time in the CI workflow comment and the
  handoff. If the slowest lane fits under 90 minutes at the 2.43x runner factor, say so.
  If it does not, leave `timeout-minutes` unchanged and record what is left.

## The C.3 amendment

To be added to `2026-09-01-engine-core-design.md` §C.3, after the R32 amendment, and
that amendment's "Not yet covered" sentence replaced with a pointer to this one:

> **Amended 2026-10-11 (Phase 2): the FULL sweep throttles balanced EMPTY feeders.** The
> downstream-first FULL sweep (R6) also visits an item pinned EMPTY whose production
> matched its consumption in the waterfall's output, and scales its producers to its
> consumption when a throttle further down has cut that consumption. Without this, a
> FULL consumer's throttle left its EMPTY feeder with a surplus that only the sweep had
> made. The surplus lifted the feeder off zero and restarted R32's pin/unpin cycle. A
> pinned EMPTY item that was already banking is not visited. Measured cause: once
> `reinforced_iron_plate` filled, `screw` cycled ~5,000 times per 120 s resolve of the
> vertical slice.
