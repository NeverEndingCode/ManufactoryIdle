# Payable bottleneck advice

**Amends:** spec §4.5 (bottleneck as first-class solver output).
**Status:** implemented 2026-10-10 (commits 65fbe5c onward).
**Branch:** `worktree-phase-2-content`.
**Follows:** `2026-10-09-byproduct-gridlock-design.md`, which named this case out of scope
("advice the policy cannot afford because the cost exceeds the paying item's storage
cap"). It is now the measured stall.

---

## The problem, measured

With the gridlock walk in, `bottleneck` reaches tier 7 of the vertical slice at 1.2871
collections and is cut off for dead time after 2.004 collections with nothing bought
(pacing gate, 2026-10-10). Probed from the tier-7 checkpoint, 120 policy steps in:

| | amount |
|---|---|
| milestone 8 requires (calibrated, `derived.yaml`) | 38,400 `packaged_fuel`, 51,200 `modular_frame` |
| `packaged_fuel` | 25,468, FULL at its cap |
| reporter's advice | `{ kind: "storage", itemId: "packaged_fuel", upgrade: "quantum" }` |
| next Quantum Storage level, oil lane (L5) | **4,473 `iron_plate`** |
| next storage level, `packaged_fuel` (L8) | **5,510 `iron_plate`** |
| `iron_plate` liquid cap | **4,000** (FULL) |
| `iron_plate`'s own next storage level (L1) | **90 `iron_plate`** |

Ruling R7 pays every purchase from liquid stock, so a purchase costing more of an item
than that item's liquid cap can **never** be made, however long the player waits.
Neither upgrade the reporter can name for `packaged_fuel` fits under 4,000. The policy
correctly declines what it cannot afford, goes idle, and is cut off. `modular_frame` is
in the same shape: FULL at 3,377 against a requirement of 51,200, its upgrades paid in
`iron_plate`.

One `iron_plate` storage level (90) lifts its cap to 4,480, which makes the 4,473 Quantum
Storage level payable. Measured by buying `iron_plate` storage levels one at a time with
an offline window between: the cap goes 4,000 -> 4,480 -> 5,248 -> 6,477 -> ... ->
228,380 after twelve levels. The way out exists; nothing names it. `bottleneck` had
bought exactly one `iron_plate` storage level all game.

The same shape stopped the policy once before: refinery #51 cost ~2,890
`encased_industrial_beam` against a cap of 2,111 (byproduct-gridlock spec).

## Why it happens

The reporter never asks whether its advice can be paid for. `cheaperUpgrade` picks the
cheaper of the two storage curves by total cost; the recipe and power branches name a
machine without pricing it. "Not affordable yet" and "never affordable" look identical
from inside the reporter, and only the first is fixed by waiting.

Validator check 12 guarantees every storage ladder is climbable using the cost item's own
storage plus maxed Quantum Storage, at the deepest tier. So there is always an honest
answer at the deepest tier -- "grow the payer's storage" -- and at earlier tiers there
usually is. The reporter just has to name it.

## Design

### The rule

A purchase whose cost in some item P exceeds **P's liquid cap** can never be made. Not
P's current stock: waiting fixes stock, and only storage fixes a cap. "Affordable later"
is left alone -- waiting for income is the right advice for it.

### One final step

Every answer `computeBottleneck` is about to return passes through one final step,
`payable(walk, bottleneck)`, which prices the purchase the answer implies and:

- **fits** (every cost item's amount `<=` its liquid cap) -> returns the answer unchanged;
- **does not fit** -> returns storage advice for the first payer that overflows -- in
  the cost map's order, which is the curve's or the mark's authored order, so the choice
  is deterministic -- run through the same step again.

How each kind is priced, the way the `bottleneck` policy prices it:

| answer | purchase priced |
|---|---|
| `kind: "storage"`, `upgrade: "storage"` | `levelCostRange(content.bundle.storage, storageLevel[itemId], 1)` |
| `kind: "storage"`, `upgrade: "quantum"` | `levelCostRange(content.bundle.quantumStorage, qsLevel[item.lane], 1)` |
| `kind: "storage"`, `upgrade: null` | nothing; passes through |
| `kind: "recipe"` | ONE machine of the recipe's class at `bestUnlockedMark(content, class, tier)`, `machineCostRange(content, class, mark, owned, 1)` |
| `kind: "power"` with a generator | the same, for the generator recipe |
| `kind: "power"`, `generatorRecipeId: null` | nothing; passes through |

One machine, not `machinesToClear`: the policy falls back to buying one when it cannot
afford more, so one is the purchase that has to be possible. A recipe whose class has no
unlocked mark passes through unchanged (the policy cannot act on it either; not this
design's problem).

### Choosing a storage upgrade that fits

`cheaperUpgrade(content, state, itemId)` gains the fits-cap filter. Among the curves that
are open (below `maxLevel`), it considers only those whose next level fits under the
liquid cap of that curve's cost item, and returns the cheaper of those. If neither fits,
it returns the cheaper of the two as today, and the final step then redirects to the
payer. Here: Quantum (4,473) and storage (5,510) both overflow 4,000, so the answer
becomes storage for `iron_plate`.

### Stepping back through payers

Storage advice for payer P is itself priced: P's own upgrades are paid in some item too
-- `iron_plate`'s storage in `iron_plate`. If P's advice does not fit, the step repeats
on P's payer. A `visited` set of payer items bounds it at one visit per item; reaching an
item already visited, or one whose two curves are both maxed, ends at `{ kind: "storage",
itemId: <that payer>, upgrade: null }` -- the honest permanent-wall answer the kind
already has. Check 12 makes that unreachable at the deepest tier; at earlier tiers it may
be a real wall, and saying so beats inventing a purchase.

### What the advice says

`limitingTarget` is always the ORIGINAL answer's -- "this is what is stopping your
`packaged_fuel`" -- for the same reason `resolveBlocker` gives. The blocker's identity
travels in `itemId`. No new `Bottleneck` kind.

Today, at the tier-7 stall: `{ kind: "storage", itemId: "iron_plate", upgrade: "storage",
limitingTarget: "item:packaged_fuel" }` (the next `iron_plate` storage level, 90, fits
under 4,000).

### What this does not change

- Any advice whose purchase fits under its payers' caps -- byte-identical.
- The selection order (power, milestone, priority scan) and the gridlock walk.
- The solver, and the `bottleneck` policy: it already declines what it cannot afford.
  The fix is that it is now told something it can eventually afford.
- `canAffordBuild`'s semantics, and ruling R7.

### Determinism and cost

Pure arithmetic on the world state and content, no clock. At most one pricing call per
answer plus one per payer stepped back through, bounded by |items|.

## Out of scope

- Making the policy smarter on its own (it is E.2's test of the advice, not a planner).
- Content changes such as cheaper storage cost curves.
- (A), generators side by side and fuel generators at tier 6.

## Acceptance

Unit tests on the fixture, each asserting its preconditions first, each guard
mutation-checked:

1. **Storage advice whose next level overflows the payer's cap** -> storage advice for
   the payer, `limitingTarget` unchanged.
2. **Of two open upgrades, only the dearer one fits** -> the dearer one, not the cheaper
   one that never fits.
3. **A machine whose one-machine cost overflows a payer's cap** -> storage advice for the
   payer (the refinery #51 shape).
4. **The payer's own advice overflows too** -> the step repeats on the next payer, or
   ends at `upgrade: null` when nothing fits.
5. **Unaffordable now but within the cap** -> unchanged.
6. **Real content** -- the existing "terminates at every tier of the vertical slice" test
   still passes.

Measured on the vertical slice:

- From the saved tier-7 checkpoint, the advice becomes storage for `iron_plate` and the
  policy starts buying again. Seconds.
- A full `sim gate` and an `--emit-pins` re-pin. `greedy` and `casual` must be
  unchanged (neither reads the reporter). Wherever `bottleneck` stops next is recorded,
  not required to be tier 10.

## The §4.5 amendment

To be added to `2026-09-01-engine-core-design.md` after the 2026-10-09 amendment:

> **Amended 2026-10-10 (Phase 2): advice must be payable.** Before returning, the reporter
> prices the purchase its answer implies -- a storage level, a Quantum Storage level, or
> one machine at the best unlocked mark. If any cost item's amount exceeds that item's
> liquid cap, the purchase can never be made (ruling R7 pays from liquid stock), so the
> reporter names storage for that payer instead, priced the same way, ending at
> `upgrade: null` only when nothing fits. Measured cause: `bottleneck` stalled at tier 7
> of the vertical slice advised to buy a Quantum Storage level costing 4,473 `iron_plate`
> while `iron_plate` could hold 4,000; one `iron_plate` storage level, 90, was the way
> out.
