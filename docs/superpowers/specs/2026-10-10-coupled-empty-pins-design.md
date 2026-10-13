# R32 for coupled EMPTY items

**Amends:** spec C.3 (the solver), ruling R32 (Phase 1 task 14b).
**Status:** implemented 2026-10-10 (commit 0c666a1).
**Branch:** `worktree-phase-2-content`.
**Follows:** `2026-10-10-payable-advice-design.md`. With payable advice in, `bottleneck`
finishes all ten tiers -- and the pacing gate takes 135 minutes against CI's 90.

---

## The problem, measured

`sim gate` took 135m18s locally; `bottleneck` alone 135m17s. From the saved tier-8
checkpoint, `resolve` is 99.9% of a policy step's time, ~1.93 s per 120 s step. One 120 s
resolve held **6,668 events**: 3,334 drains of `iron_plate`, 3,333 of `screw`, and the
`MAX_EVENTS` guard -- after which `resolve` falls back to 60 s coarse steps.

Both items feed `make_reinforced_iron_plate` (30 `iron_plate` + 60 `screw` per cycle) and
come from separate chains (`iron_plate` from ingots, `screw` from rods). From the first
`screw` drain on, the two cycle at microsecond spacing through three states:

| state | `iron_plate` | `screw` | `make_reinforced_iron_plate` clock |
|---|---|---|---|
| both pinned EMPTY | net **+209**/s | net **+538**/s | 0.0039 |
| both just above zero | net −85/s | net −206/s | 0.1630 |
| only `iron_plate` pinned | net 0 | net −46/s | 0.1103 |

A surplus on a pinned EMPTY item lifts it off zero, which un-pins it, which lets its
walkers draw from stock, which drains it. That is R32's limit cycle, which R32 was written
to stop -- for one item.

## Why R32 misses it

Instrumenting one `solvePass` in the both-EMPTY state: neither the FULL sweep nor the
R30 EMPTY sweep touches `make_reinforced_iron_plate`. The waterfall gives it 0.0105
directly, because `item:iron_plate` and `item:screw` -- both `guaranteed`, both
outranking `item:reinforced_iron_plate` -- take nearly all of `make_iron_plate`'s and
`make_screw`'s capacity to bank their own item. Only `item:biomass` is disqualified.

R32 disqualifies an entry from its own item's producing recipe when, re-running the
waterfall with that item X removed from the pin set, X's net would be negative. The re-run
excludes nothing else (`runPasses(pinnedWithoutX, new Set())`). So:

| R32's re-run | `make_reinforced_iron_plate` | net `iron_plate` | net `screw` |
|---|---|---|---|
| all pins (what runs today) | 0.0105 | +209 | +538 |
| `iron_plate` un-pinned, `item:screw` still banking | starved by `screw` | **≥ 0 → kept** | -- |
| `screw` un-pinned, `item:iron_plate` still banking | starved by `iron_plate` | -- | **≥ 0 → kept** |
| `iron_plate` un-pinned, `item:screw` disqualified | 0.6642 | −55.56 | 0 |
| `screw` un-pinned, `item:iron_plate` disqualified | 0.5271 | 0 | −80.57 |
| both un-pinned | 1.0000 | −191.67 | −463.91 |

Each item looks sustainable only because the OTHER item's entry is still starving the
shared consumer. Both escape disqualification, both bank, both un-pin, both drain.

## Design

### The rule

R32's question is asked per item, under the disqualifications R32 itself is making: an
item X is held (its entries disqualified) when, with X un-pinned and every OTHER held
item's entries disqualified, X's net would be negative.

### The computation

The structural pre-checks are unchanged: `guaranteed`, item pinned EMPTY, item has a
consumer, item has an active recipe, that recipe touched by at least two entries. Entries
passing them are the **candidates**; their items are the candidate items.

1. Start with every candidate item held.
2. For each candidate item X still held, in candidate order: re-run the waterfall with X
   removed from the pin set and the entries of every other held item excluded. If X's
   own net is not below `-1e-9`, release X.
3. Repeat step 2 until a full round releases nothing.
4. The disqualified set is every candidate entry whose item is held.

It starts at the largest set and only removes, so it terminates in at most one round per
candidate item; each round costs one re-run per held item, as today's single round does.
Nothing is ever re-held once released, and the scan order is the candidate order, which
priority fixes -- so the result is deterministic.

**Grouped by item, not by entry.** An item can have several entries -- a `reserve:`
entry beside its ordinary priority entry. They bank the same item, so they are held or
released together, and an item's own siblings are never in its re-run's excluded set.
Measured: a per-entry version of this rule breaks two fuzz properties on exactly that
shape (a fixture item with a 0.1 reserve beside its ordinary entry).

### What this does not change

- The pre-checks, the `-1e-9` threshold, `forceDisqualified` reuse in the reconciliation
  pass, and share-mode's exemption.
- A lone candidate in isolation: with nothing else held, its re-run excludes nothing, as
  today. Where other candidates exist, its re-run now excludes their entries -- which is
  what the final pass will do to them anyway.
- The FULL and R30 sweeps, `resolve`, the bottleneck reporter, and the policies.

### Determinism and cost

Pure arithmetic in a fixed order, no clock. Measured from the tier-8 checkpoint with a
throwaway version of this rule: the 120 s resolve goes from 6,668 events (~1.9 s) to 2
events (one drain of each item, after which both stay pinned at net 0).

## Out of scope

- Damping in `resolve` (an item stays EMPTY until its stock passes a tolerance). It would
  hide the cycle while the solver kept producing the wrong rates in that state.
- Share-mode entries in this shape (still no covered case).
- The 90-minute CI cap's value; it is re-checked against the new measurement, not
  re-chosen.

## Acceptance

Unit tests, each asserting its preconditions first, each guard mutation-checked:

1. **Two coupled items** -- two items pinned EMPTY, each with its own `guaranteed` entry
   outranking a shared consumer's entry that needs both -> both items' entries are
   disqualified, and both items' nets are 0 (not positive). Fails today. The fixture has
   no two-input recipe, so this uses the vertical slice or a minimal in-test bundle.
2. **One of two coupled items is sustainable** -- the same shape where one item's
   producer has spare capacity beyond what the shared consumer can use -> that item is
   released, and its entry banks the spare.
3. **Siblings** -- an item with an ordinary entry and a `reserve:` entry is held or
   released as one; the existing R32 tests in `waterfall.test.ts` pass unchanged.
4. **Resolve** -- from a state with both coupled items EMPTY, a resolve over a window of
   minutes finishes with a handful of events, not the guard.
5. **Existing properties** -- the full suite, including `fuzz.test.ts` and
   `properties.test.ts`, passes.

Measured on the vertical slice:

- From the saved tier-8 checkpoint, one 120 s resolve: events down from 6,668.
- A full `sim gate`, timed. Every pin re-checked; `greedy`, `casual` and `bottleneck`
  re-pinned with `--emit-pins` if any tier time moved (this is a solver change, so all
  three can). The gate's wall time is recorded in the CI workflow comment and the handoff;
  if it fits under 90 minutes the push can go ahead.

## The C.3 amendment

To be added to `2026-09-01-engine-core-design.md` §C.3, after the cost paragraph:

> **Amended 2026-10-10 (Phase 2): R32 for coupled EMPTY items.** Ruling R32 disqualifies
> an entry from drawing on its own item's producing recipe when that item is pinned
> EMPTY and, were it not pinned, would drain -- a surplus there un-pins the item and
> starts a pin/unpin limit cycle. The question is asked jointly: each candidate item is
> tested with every other disqualified item's entries still disqualified, starting from
> all candidates and releasing until stable, with an item's entries (ordinary and
> `reserve:`) treated as one. Measured cause: `iron_plate` and `screw`, both feeding
> `make_reinforced_iron_plate`, each looked sustainable only while the other's entry
> starved the shared consumer; neither was disqualified, and the pair cycled 6,668 times
> in 120 s of the vertical slice, which accounted for about 50 of the pacing gate's 135 minutes.
