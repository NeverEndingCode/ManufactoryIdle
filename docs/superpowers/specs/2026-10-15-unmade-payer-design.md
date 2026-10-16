# Advice for a payer that is not being made

**Amends:** engine spec §4.5 (the bottleneck reporter's final `payable` step), and its
2026-10-15 blocked-payer amendment.
**Status:** implemented 2026-10-15.
**Follows:** `2026-10-14-buy-for-a-recipe-design.md` (PR #11), whose Part 2 added the
blocked-payer rule. That rule's open follow-up was: it doesn't check that the FULL output
is why the payer isn't made.

---

## The problem, measured

`payable` handles a short payer in three ways today:
- **drained:** made but not growing → reserve advice;
- **blocked:** not made, and its recipe has a FULL output → storage for that output;
- **slow:** growing too slowly → one machine for its recipe.

A payer that is short and **not made for some other reason** gets nothing: the advice
stays the original purchase, which can't be paid. The blocked rule also fires on any
FULL output, without checking that the output is the cause.

A probe of a full `bottleneck` run (seed 42, the gate's settings, `main` at `55d812f`)
classified every short, unmade payer `payable` met:

| payer ← its recipe | machines | starved of an input | FULL output | decisions |
|---|---|---|---|---|
| `rubber` ← `refine_rubber` | yes | no | yes | 4 |
| `encased_industrial_beam` ← `make_encased_industrial_beam` | yes | **yes** | no | 33 |

- **The 4 rubber decisions** are the blocked rule's real case. Its two missing guards
  (the recipe has machines; no input is EMPTY) would not change them.
- **The 33 beam decisions** keep advising a purchase the beam can't pay, because the
  beam recipe is starved. That is spec E.2's "the UI is lying" failure: the advice
  should name what limits the beam.

## Design

### The rule

The blocked-payer check becomes an **unmade-payer** check, in the same place: after the
drained-payer check and before the slow-payer check.

For each cost item of the price, in price order, a candidate is a payer that:
- is **short:** liquid + bound is below the price;
- is **not made:** production ≤ `FLOW_TOLERANCE`;
- has a **live active recipe** R;
- is **not yet in `visited`.**

The first candidate whose cause is found decides the advice. The causes are checked in
this order:
1. **Starved:** R has an EMPTY input. Walk to what limits R with the existing walk
   (`starvedStep`: the first EMPTY input, in recipe order, whose live active recipe isn't
   visited). Each step adds its input to `visited`. Advise one machine for the recipe the
   walk ends on, `{ kind: "recipe", recipeId, limitingTarget, machinesToClear: 1 }`. If
   that recipe still has an EMPTY input it can't walk to, this payer has no answer; go on
   to the next candidate.
2. **No machines:** R has no machines (`capacity.unitsByRecipe`). Advise one machine for
   R.
3. **Blocked:** R has a FULL output, byproducts included, in recipe order, not in
   `visited`. Advise storage for that output, as today. This is the blocked rule with
   both guards: it applies only when R has machines and isn't starved.

A candidate with none of these causes is skipped. The payer is added to `visited` once
it is considered, and the blocked output too when advised. The answer goes back around
`payable`'s loop like every other redirect. The cap from PR #12 still bounds the loop:
each continuing pass adds at least one new item.

### What this does not change

- The storage-cap, drained-payer and slow-payer checks, and their order.
- Answers whose payers are all made, or all able to pay.
- `greedy`, `casual` and `optimal`, which don't read the reporter.

## Measured (prototype, the gate's settings)

| | t1–t9 | t10 | longest dead stretch | purchases |
|---|---|---|---|---|
| `main` (`55d812f`) | — | 10.5551 | 0.6089 | 461 |
| the guards alone | identical | 10.5551 | 0.6089 | 461 |
| this design | identical | 10.5329 | 0.6379 | 464 |

The walk fired 19 times, every time for the beam. It named `mine_iron_ore` 10 times,
`make_steel_ingot` 7 times and `mine_coal` 2 times. The no-machines cause never
occurred on the slice. Pacing is essentially neutral: tier 10 is 0.2% sooner, and the
longest dead stretch is 0.03 collections longer. The gain is in what the reporter says.

## The §4.5 amendment

To be added after the 2026-10-15 blocked-payer amendment:

> **Amended 2026-10-15: a payer that is not being made gets the cause.** A payer short
> of the price and not made at all is checked for why, in this order:
> - its recipe is starved of an input: advise one machine for the recipe that limits it;
> - it has no machines: advise one machine for it;
> - it has a FULL output: advise storage for that output (the blocked-payer rule, now
>   applying only when the first two don't).
>
> Each answer passes through this final step again. Measured cause: in a `bottleneck`
> run on the vertical slice, 33 decisions kept advising a purchase that
> `encased_industrial_beam` could not pay, while the beam recipe was starved. The
> reporter now names what limits it.

## Acceptance

**Reporter tests** (`bottleneck.test.ts`, in the blocked-payer describe or a new one):
1. A short, unmade payer whose recipe is starved gets one machine for the recipe that
   limits it, and not storage, even when an output is also FULL.
2. A short, unmade payer whose recipe has no machines gets one machine for that recipe.
3. The existing blocked-payer tests still pass: the recipe has machines, isn't starved,
   and its output is FULL, so the advice is storage for that output.
4. A starved payer whose walk ends on a recipe that is still starved, with nothing it can
   walk to, leaves the advice as it was. (Moving on to a second candidate payer in that
   case follows from the loop; the fixture has no two-payer price to test it on.)
5. The termination test and the iteration cap still hold.

**Measured:**
- **The suite:** the full suite, lint, typecheck and `content:check` pass.
- **The gate:** a full `sim gate` run.
  - `greedy` and `casual` pins are byte-identical.
  - `bottleneck` tiers 1–9 are unchanged.
  - Tier 10 and the dead time are re-pinned from the run, which should be about 10.533
    and 0.638.
  - If anything else moves, or `bottleneck` misses tier 10, stop and report.
- **The handoff:** the blocked-payer guards follow-up is recorded as done.
