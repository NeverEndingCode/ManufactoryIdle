# Reserves that last

**Amends:** ruling R8 (reserve entries, `solve/waterfall.ts`). Also amends
`2026-10-13-reserves-protect-stock-design.md`'s rule that a `bottleneck` reserve lasts
only while the reporter asks for it.
**Status:** implemented 2026-10-16.
**Closes:** the two follow-ups from the reserves branch (2026-10-13) recorded in the
phase-2 handoff, plus three small test and doc gaps.

---

## The problem, measured

A probe of a full `bottleneck` run (seed 42, the gate's settings, `main` at `0583997`)
followed every reserve the policy set:

- **Every reserve lasts exactly one decision.** All 32 do. (The causes below are as first
  diagnosed; "Measured after implementation" corrects them.)
- **The cause.** The reserve does make its item grow, but it also starves the item's
  consumers. For example, `steel_pipe` reserved takes consumption to 0. That changes the
  solve, so on the next decision the reporter's main answer moves, usually upstream (for
  example, `make_steel_ingot`). The policy clears every reserve the reporter isn't
  currently asking for, so it drops the reserve, the consumers resume, the item drains,
  and later the reporter reserves it again.
- **The livelock.** The same churn across two payers: `iron_plate` and
  `reinforced_iron_plate` alternate at tiers 7–8 (4 A-B-A alternations).

Two things drive this:
1. **Sizing doesn't match ruling R8.** R8 says a reserve "can never eat more than half of
   an item's own production", but the target is `percent × unconstrainedRate(...)`, the
   item's rate with every machine unthrottled. When the upstream is short, 25% of that
   can exceed what the chain actually makes, so the reserve takes everything.
2. **The policy drops a working reserve** the moment the advice moves, even while the
   reserve is still banking.

## Design

### Part 1: size a reserve against the item's actual production (ruling R8)

When any reserve is set, `solve` first works out each reserved item's production
**without reserves, at full power**: one item solve (`solveItems`) of the same state with
every reserve set to 0, with capacity at power ratio 1 and no power demand. A reserve's
target becomes:

```
targetRate = percent × productionWithoutReserves(itemId)
```

This replaces `percent × unconstrainedRate(...)`. `RESERVE_MAX_PERCENT` (0.5) still
clamps `percent`, so the target is capped at `percent × full-power reserve-free
production` (at most 50% of that counterfactual). This makes reserves smaller than the
unconstrained sizing, but it is not a bound on the reserve's share of what is actually
made, and consumers can still be cut off while their item is reserved, because walks treat
a reserved item as pinned EMPTY (measured: 30 decisions; see "Measured after
implementation"). With no reserve set, nothing changes and no extra solve runs. A reserved item
whose production without reserves is 0 gets target 0, so the reserve has no effect.
This matches today's drained-payer rule, which never names an unmade item.

**Why full power** (amended 2026-10-16, after measuring). The first version of this design
used the `production` from a full reserve-free `solve`, including the power loop. In the
gate, that gave `bottleneck` a longest dead stretch of 1.34 collections, over this design's
1.0 limit. It also slowed tiers 7 and 9 and made the gate about 65% slower (2m12s). The
full-power item pass, measured on the same branch, gives 0.775 and is cheaper. During a
brownout, the full `solve` reports less production, so reserves shrink exactly when the
grid is short. Sizing against what the chain makes at full power keeps a reserve steady
through a brownout.

The reserve-free pass is internal to `solve` and depends only on (state, content), so
`solve` stays pure. The per-resolve solve cache is keyed on the state, and the
reserve-free pass is a function of that same state, so the cache stays sound.

### Part 2: the policy keeps a reserve that is working

The `bottleneck` policy clears a reserve only when:
- the item is FULL (there's nowhere left to bank), or
- the item is not growing: its net rate is ≤ `FLOW_TOLERANCE`. In practice this means the
  rule keeps a reserve until its item is FULL (or the reserve receives nothing), because
  `net` comes from the solution that includes the reserve, so the reserve's own banking
  counts as growth. Measured: 13/13 holds ended at FULL, at most 2 held at once.

In either case it clears only if the reporter isn't currently advising that same reserve.
Otherwise it keeps the reserve, even after the advice has moved on. Several reserves can
then be held at once, so two short payers of one price both bank instead of alternating.
That fixes the livelock.

Reserve advice itself is unchanged: the policy still *sets* a reserve only when the
reporter advises one. A reserve a human set by hand is treated the same way while
`bottleneck` is driving, as today.

### Part 3: small gaps

1. **A test for a named-recipe purchase the player can't afford.** `BUY_MACHINE` with a
   wrong-lane `recipeId` in a world that can't afford the purchase still rejects with the
   recipe message, not the afford message. This pins that validation runs before payment.
2. **A test for the maxed-storage wall for a blocked output.** When the FULL output's
   storage and quantum curves are both at their max level, the unmade-payer advice is
   storage for it with `upgrade: null`.
3. **The gate's `why` texts.** `apps/sim/src/gate-cli.ts` repeats a long re-measure
   sentence. Name it once, as a constant or a small helper, without changing any pin's
   text in meaning.

### What this does not change

- Reserve advice: when the reporter names a reserve, and at what percent
  (`RESERVE_ADVICE_PERCENT` 0.25).
- The rules that a reserve on a FULL item is skipped and that walks treat a reserved item
  as pinned EMPTY.
- `greedy`, `casual` and `optimal`, which never set reserves. Their pins can't move.

## Measured (prototype, the gate's settings)

| variant | t4 | t7 | t9 | t10 | longest dead stretch | purchases |
|---|---|---|---|---|---|---|
| `main` (`0583997`) | 0.4496 | 1.0315 | 2.2693 | 10.5329 | 0.638 | 464 |
| Part 1 alone | 0.4496 | 1.0315 | 2.2971 | 10.4116 | 0.631 | 476 |
| Part 2 alone | 0.4209 | 0.9996 | 2.2644 | 9.4287 | 1.620 | 500 |
| **Parts 1 + 2** | **0.4209** | **1.0156** | **2.2276** | **10.0576** | **0.775** | 504 |

Tiers 1–3 were unchanged in every variant. A third variant, ranking reserves last so they
bank only surplus, was slower on every tier and was dropped.

The prototype's Part 1 used the full-power item pass this design now specifies (see "Why
full power" above), so the table's Parts 1 + 2 row is what the gate should reproduce.

## Measured after implementation (final review)

One `bottleneck` run, seed 42. 13 reserve holds in 908 decisions; at most 2 held at once;
every hold ended at FULL (13/13), none because the item stopped growing. Holds lasted
0.1-0.9 h except `encased_industrial_beam` at t9 (4.05 h, 1.57 h). On 30 decisions with a
reserve held, the item's consumers got 0 despite surplus (for example `steel_pipe` at t9:
reserve about 20% of production, consumption 0 against 9-20/s reserve-free). The cause is
the 2026-10-13 rule that walks treat a reserved item as pinned EMPTY (`waterfall.ts`),
interacting with R32, not the reserve's size. On 7 decisions the reserve took more than 50%
of actual production (up to 100%) at power 1.0, because the 50% cap is against the
full-power reserve-free counterfactual, not the solved production with the reserve in
place. The measured gate gains above are real; only the explanations were wrong.

## Amendments

**To ruling R8**, in the engine spec, where reserve entries are described:

> **Amended 2026-10-16: a reserve is sized against what its item makes at full power**
> (ruling R8 — reserve entries, `solve/waterfall.ts`: a reserve's percent is clamped to 50%). A
> reserve's target is `percent × the item's production in the same state with no
> reserves, at full power`, with `percent` clamped to 50%, so the target is at most half of
> that full-power reserve-free counterfactual, and a brownout doesn't shrink a reserve. This
> is not a bound on the reserve's share of what is actually made. It was `percent × the
> unconstrained rate`, which, when the upstream was short, let a 25% reserve exceed what
> the chain makes. Consumers of a reserved item can still be cut off while it is reserved
> (walks treat it as pinned EMPTY). Measured before this change: every `bottleneck` reserve lasted
> exactly one decision.

**To §4.5 / the reserves spec's policy rule:**

> **Amended 2026-10-16: `bottleneck` keeps a reserve until its item is FULL.** A reserve is
> kept until its item is FULL (or the reserve receives nothing), unless the reporter is
> advising it; the reserve's own banking counts as growth. It is no longer cleared just
> because the advice moved. Two short payers of one price
> can then both bank instead of alternating; measured, they alternated four times on the
> vertical slice.

## Acceptance

**Engine tests:**
1. With a reserve set on an item whose upstream is short, the reserve's target equals
   `percent × that item's production with no reserves`, not
   `percent × unconstrainedRate`. (The item's consumers keep a nonzero share in the fixture
   test; this does not hold generally on the slice, see "Measured after implementation".)
2. With no reserve set, `solve` makes no reserve-free pass and its result is
   byte-identical to before.
3. A reserved item whose production without reserves is 0 gets no reserve effect.

**Policy tests** (`policies.test.ts`):
4. `bottleneck` keeps a reserve whose item is growing and not FULL when the advice has
   moved on.
5. It clears a reserve whose item is FULL, or not growing, when the advice isn't that
   reserve.
6. It keeps two reserves at once when both items are growing.

**Part 3 tests:** the two tests described there.

**Measured:**
- **The suite:** the full suite, lint, typecheck and `content:check` pass.
- **The probe:** reserves last more than one decision, and the A-B-A alternations fall.
- **The gate:** a full `sim gate` run.
  - `greedy` and `casual` pins are byte-identical.
  - `bottleneck` is re-pinned from the run.
  - If `bottleneck` misses tier 10, or its longest dead stretch reaches 1.0 collection or
    more, stop and report.
- **The handoff:** both reserve follow-ups and the three small gaps are recorded as done.
