# Byproduct-gridlock-aware bottleneck reporting

**Amends:** spec §4.5 (bottleneck as first-class solver output).
**Status:** design, approved 2026-10-09. Not yet implemented.
**Branch:** `worktree-phase-2-content`.
**Companion work, specced separately:** (A) give `fuel` a sink at tier 6 and teach the
validator to check sinks transitively. This document is (B), the reporter half, and is
deliberately done first: once (A) lands the vertical slice no longer gridlocks at tier 6,
and the real-content reproduction this design is measured against goes away.

---

## The problem, measured

After the power-branch fix (2026-10-09: a starved generator now names what starves it,
not another generator), `bottleneck` reaches tier 6 of the vertical slice at 0.9312
collections, faster than before, and then never reaches tier 7 in 10 simulated days.
`refine_rubber` is the binding constraint for 828M of the run's 864M ms.

Milestone 7 asks for 14,400 `plastic` and 14,400 `rubber`. Probed 80 policy steps after
tier 6 unlocks (seed 42):

| item | state | liquid / cap | net |
|---|---|---|---|
| `rubber` (required) | FLOWING | 8,192 / 9,175 | **0** |
| `plastic` (required) | FULL | 17,291 / 17,291 | 0 |
| `heavy_oil_residue` | **FULL** | 6,954 / 6,954 | 0 |
| `fuel` | **FULL** | 6,954 / 6,954 | 0 |
| `crude_oil` | FULL | 13,907 / 13,907 | 0 |

Every oil-lane recipe -- `extract_crude_oil`, `refine_plastic`, `refine_rubber`,
`refine_residual_fuel` -- runs at **clock 0**. The lane is gridlocked:

```
crude_oil -> refine_rubber -> heavy_oil_residue (byproduct) -> refine_residual_fuel -> fuel
  FULL         clock 0              FULL                           clock 0            FULL
```

`fuel` has no consumer at tier 6 (`burn_fuel` and `package_fuel` unlock at 7), so it
fills; `refine_residual_fuel` stops; residue fills; the fixpoint's FULL sweep scales both
refineries to zero, byproduct producers included; crude fills behind them.

The reporter says `{ kind: "recipe", recipeId: "refine_rubber", machinesToClear: 1 }`
throughout. The policy followed that advice into **50 refineries**, most bought while
`plastic` was already FULL, until refinery #51 cost ~2,890 `encased_industrial_beam`
against a cap of 2,111 and the policy could afford nothing at all.

## Why it happens

`resolveBlocker` checks FULL on the **requirement item only**. A recipe whose output is
FULL -- primary or byproduct -- is throttled by backpressure, and naming it advises a
purchase that cannot help. The handoff recorded this gap (item 8, second bullet) for the
primary-output case on 2026-09-19; this is the first measurement of it biting, and it
bites through a byproduct, two hops from the item the player asked for.

The priority-scan fallback has the identical gap, and so does the starved-generator case
the power-branch fix just added: a fuel producer can be blocked by a full byproduct too.

## Design

### No new `Bottleneck` kind

The answers this walk produces are all things the existing kinds already say: "buy N of
recipe R" (`recipe`) and "buy a level of storage for item X" (`storage`). A new kind would
be a new thing every consumer must learn, to say a thing the existing ones say.

### One helper, at every recipe-shaped return

Every place `bottleneck.ts` is about to return `kind: "recipe"` for a recipe R first
passes R through one helper:

- **None of R's outputs is FULL** -> the original advice, unchanged.
- **Some output X of R is FULL** -> the forward walk from X, below.

R's outputs are read from `content.recipes.get(R).outputPerSecond`, which includes
byproducts. The outputs are checked in that map's order, which is the authored order.

The four call sites:

1. `resolveBlocker`'s **zero-capacity** branch. "Buy your first `refine_rubber`" is as
   pointless as "buy another" when residue is already FULL.
2. `resolveBlocker`'s **limited** branch (`entry.limitedBy`). Today's tier-6 case.
3. The **priority-scan** fallback's recipe return.
4. The power branch's **starved-generator** return.

The power branch's generator advice (`kind: "power"`) is not routed through the helper: a
generator's output is power, which is never an item state, so it cannot be FULL.

### The forward walk

At a FULL item X:

1. Take X's **live consumers**: `content.consumersOf.get(X)`, filtered by
   `isLiveRecipe(content, C, state.tier, state.activeRecipe)`, in `content.recipeIds`
   order so the result is deterministic.
2. For each consumer C, in that order:
   - **C has no capacity** (`capacity.unitsByRecipe.get(C) <= 0`) -> return
     `recipe C, machinesToClear: 1`. A drain beats storage: it is permanent.
   - **C has capacity and one of C's outputs Y is FULL**, Y not yet visited -> recurse on
     Y. If that returns a blocker, return it; otherwise continue with the next consumer.
   - **C has capacity and none of its outputs is FULL** -> C is running but cannot drain
     X fast enough. Return `recipe C, machinesToClear: 1`.
3. **No live consumer**, or every path visited -> return `storage X`, with
   `upgrade: cheaperUpgrade(content, state, X)`.

Every blocker the walk returns carries the **original** `limitingTarget` -- the advice has
to read "this is what is stopping your rubber", for the reason `resolveBlocker`'s doc
comment already gives. The blocker's own identity travels in `recipeId` / `itemId`.

`machinesToClear` is always 1 on this path. `machinesToClearRecipe` answers "how many
more machines of the recipe limiting this entry close the gap to the runner-up", and a
drain is not that question. One is the honest minimum, and the caller re-solves after
buying -- the argument the zero-capacity branch and the storage branch already make.

### Cycle safety

The walk records every item it enters in a `visited` set. Within `resolveBlocker` it
shares the call's existing set -- the one the 2026-09-19 change kept "dormant, not
load-bearing"; it becomes load-bearing again here, and its doc comment must say so. The
priority-scan and power call sites, which have no set today, each start a fresh one.
The vertical slice's one genuine SCC (`alt_recycled_plastic` / `alt_recycled_rubber`) is
permanently unselectable under ruling R6, so `isLiveRecipe` already excludes it, but the
walk must not depend on that: `visited` alone bounds it at |items| entries.

### What this says on today's content, and after (A)

- **Today, tier 6:** `refine_rubber` -> residue FULL -> `refine_residual_fuel` has
  capacity, `fuel` FULL -> `fuel` has no live consumer -> **storage for `fuel`**.
- **After (A):** the same walk reaches `fuel`, whose live consumer `burn_fuel` has no
  machines -> **buy 1 `burn_fuel`** (a fuel generator).

  **Measured 2026-10-09, after this spec was approved: (A) as first scoped does not
  produce that.** A throwaway run of these rules on the tier-6 checkpoint, with
  `burn_fuel` and `fuel_generator` unlocked at tier 6 in memory, still answers `storage
  fuel`. The engine keys `activeRecipe` by primary output and every generator's primary
  output is `__power__`, so only ONE generator recipe is live at a time; while the grid
  runs `burn_biomass`, `burn_fuel` gets no capacity. That is an engine constraint, not a
  walk defect: this design needs no change, and once (A) lets generator types run side by
  side, `burn_fuel` becomes a live consumer and the walk names it unaided. (A)'s spec owns
  that engine change.

### What this does not change

- The selection order: power, then milestone, then priority scan.
- Any advice for a recipe none of whose outputs is FULL -- byte-identical.
- The solver. The walk reads `itemStates`, `capacity`, and the content index, all of
  which the reporter already receives; `computeBottleneck`'s signature is unchanged.

### Determinism and cost

Deterministic: consumers are taken in `content.recipeIds` order, outputs in authored
order, and nothing reads a clock or a float that the walk compares for equality. Cost is
bounded by |items| visits per call, each a few map lookups; it runs only when a named
recipe has a FULL output.

## Out of scope

- **(A), the content and validator change.** Its own spec.
- **Advice the policy cannot afford** because the cost exceeds the paying item's storage
  cap (refinery #51 above). It was reached by following bad advice 50 times; better
  advice should keep the policy away from it. Re-examine only if it recurs.
- **A paused milestone requirement is invisible to the walk** (handoff item 8, first
  bullet). Unchanged.

## Acceptance

Unit tests, on the fixture bundle, which has the same chain in miniature (`refine_plastic`
-> `heavy_oil_residue` -> `residual_fuel` -> `fuel` -> `burn_fuel`). Each asserts its
preconditions first, as the existing bottleneck tests do:

1. **Gridlock with no sink.** Residue FULL, fuel FULL, fuel's consumer locked at that
   tier -> `storage fuel`, `limitingTarget` the original target.
2. **A sink with no machines.** The generator unlocked but uninstalled -> `recipe
   burn_fuel, machinesToClear: 1`.
3. **A sink that cannot keep up.** The consumer installed, nothing downstream FULL ->
   `recipe <consumer>, machinesToClear: 1`.
4. **A FULL primary output** (handoff 8b). A requirement limited by a recipe whose own
   primary output is FULL -> storage for that output, not more of that recipe's machines.
5. **The healthy case.** No FULL outputs -> the existing advice, unchanged.
6. **Real content.** The existing "terminates at every tier of the vertical slice" test
   still passes.

Each guard is mutation-checked: deleting it must fail exactly the test that names it.

Measured on the vertical slice:

- From the saved tier-6 + 80-step checkpoint, the advice becomes `storage fuel` and
  `rubber`'s net rate leaves zero within a few policy steps. Seconds to run.
- A full `sim gate`, re-pinned with `--emit-pins`. `greedy`'s ten tier times must be
  byte-identical -- the walk is reporter-only, and `greedy` does not read the reporter.
- Not required: that `bottleneck` reaches tier 10. Spec E.2's bar is the goal; this
  change removes one measured reason it is not met, and wherever `bottleneck` stalls next
  is the next investigation, recorded in the handoff.

## The §4.5 amendment

To be added to `2026-09-01-engine-core-design.md` after the 2026-09-19 amendment:

> **Amended 2026-10-09 (Phase 2): a recipe throttled by a full output is not the
> blocker.** Before naming any recipe, the reporter checks that recipe's outputs,
> byproducts included. If one is FULL, buying the recipe cannot help -- the solver's FULL
> sweep holds it at the drain rate -- so the reporter walks forward from the full item to
> its live consumers and names the first that is missing, too slow, or itself blocked
> further on; with no live consumer, it names storage for the full item. Measured cause:
> `bottleneck` bought 50 refineries into a gridlocked oil lane at tier 6 of the vertical
> slice, because `fuel` -- two hops past the rubber it was asked for -- had nowhere to go.
