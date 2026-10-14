# Reserves protect stock, and the reporter can advise one

**Amends:**
- original §4.1 (Reserve %) and engine spec §C.2/§C.3 (the solver): a reserve now protects
  the stock it banks;
- engine spec §4.5 (the bottleneck reporter, amended 2026-10-10 "payable advice"): a new
  advice kind;
- spec E.2 (`bottleneck` follows it).

**Status:** designed 2026-10-13; not implemented.
**Depends on:** `2026-10-13-tier10-capstone-design.md` (PR #8), whose stall this addresses.

---

## The problem, measured

Since tier 10 became the assembly-rig capstone, `bottleneck` stalls at tier 9 (pinned
`reachesTier: 9`).
- **Stuck advice:** from ~3.65 collections, the reporter advises one constructor for
  `make_steel_pipe`, priced at ~36.6 `steel_pipe`.
- **Why it can't be paid:** the assembly rigs consume every pipe made, so stored
  `steel_pipe` stays at 0 at net 0. The price fits under the cap, so §4.5's "payable"
  check (cost ≤ cap + bound) passes. The advice is payable on paper, never in practice.

A player gets out of this with §4.1's **Reserve %**: "divert a share of this target's
output to storage rather than to consumers".

## Why a reserve does not work today

Measured with a prototype that sets a 25% reserve on the drained payer, from `bottleneck`'s
tier-9 checkpoint:
- **The reserve is starved:** `reserve:steel_pipe` asks for 2.07/s and is allocated **0**,
  and `item:steel_pipe` too.
- **R32 is the cause:** `steel_pipe` is pinned EMPTY, and ruling R32 disqualifies an
  entry from its own item's recipe whenever, unpinned, the item would drain. The rigs
  would drain it, so R32 disqualifies the reserve, the one entry whose job is to bank.

So the engine breaks §4.1's promise for exactly the items that need it. It is the same
root cause as the deferred stock-model project, where consumers always win over banking.
This spec fixes it narrowly, for reserves only.

## Design

### 1. Engine: a reserve protects the stock it banks

In `runWaterfall` (`packages/engine/src/solve/waterfall.ts`), while item X has an active
reserve entry (`reserve:X` with `targetRate > 0`):

1. **The reserved item is exempt from R32:** while it has an active reserve, none of its
   entries is an R32 candidate (rule 2 already implies this; see below), so a reserve
   always banks its share.
2. **Every other entry walks through X's recipe instead of drawing X's stock**, exactly
   as if X were pinned EMPTY. Let *reserved* be the set of items with an active reserve.
   Every requirement walk uses `pinnedEmpty ∪ reserved` (and `pinnedEmptyForPass ∪
   reserved` in R32's re-runs). The reserve's share of X's production therefore builds
   up as stock, consumers get only the remaining capacity, and their draw does not depend
   on how much stock X holds. That removes the pin/unpin flip for X.

And in `effectivePriority`:

3. **A reserve on a FULL item claims nothing.** No reserve entry is injected while X is
   FULL, because there is nowhere to put the stock. Without this, the reserve would claim
   X's recipe, the FULL sweep would stop it, and consumers walking through the recipe would
   get nothing: the deadlock found in the 2026-10-12 rank-gating prototype.

Purchases still spend X's stock as before; protection is against consumers, not against
the player. Nothing changes when no reserve is set.

### 2. Reporter: advise a reserve for a drained payer

A new `Bottleneck` kind:

```ts
| { kind: "reserve"; itemId: ItemId; percent: number; limitingTarget: string }
```

It is emitted by `payable`, the final step every answer passes through (§4.5, 2026-10-10),
when the answer's price includes an item that is **drained**:
- its liquid stock plus bound stock is below the price;
- its net rate in the solution is ≤ 0;
- and it has **no** reserve set (`state.reserve[item]` is 0 or absent).

In that case the advice becomes `{ kind: "reserve", itemId: <that item>, percent: 0.25,
limitingTarget: <unchanged> }`.

- **The 25% figure** is the prototype's measured value, under the 50% maximum.
- **Ordering:** the existing cap check (cost > cap + bound → storage for the payer) runs
  first, unchanged. A payer that cannot even hold the price is a storage problem, not a
  reserve one.
- **An item already reserved and still not growing** means the reserve is not helping.
  The advice stays as it would be today, which avoids an advice loop.

`priceOf` returns `null` for a reserve answer: setting a reserve costs nothing.

### 3. The `bottleneck` policy follows it

In `apps/sim/src/policies.ts`, `bottleneck`'s `decide`:
- **On reserve advice:** emit `{ type: "SET_RESERVE", itemId, percent }`.
- **Cleanup, every decision:** for each item with a non-zero `state.reserve` that the
  current advice does not name as `kind: "reserve"`, emit `SET_RESERVE` with percent 0.
  A reserve therefore lasts only while the reporter still asks for it. It ends once the
  purchase it was saving for goes through or the advice moves on.

`greedy`, `casual` and `optimal` are unchanged: they never set reserves.

The other places that switch on advice kind handle the new kind:
- **`sim play`'s status:** "BOTTLENECK reserve 25% of X so it can bank toward Y".
- **`run.ts`'s binding-constraint key:** `reserve:X`.

### Determinism and cost

Pure and deterministic. The walk adds a set union per entry when a reserve is active, and
nothing otherwise.

## Measured with the prototype

**Without reserves**, nothing changes. With all three engine rules in place and no policy
setting a reserve, the full gate emitted pins **identical** to the branch's for all three
policies. The engine suite passed 396/396.

**With reserves**, `bottleneck` from its tier-9 state, with the reserve habit:

| | last purchase / stall |
|---|---|
| today | stalls at 3.49 collections (`steel_pipe` drained) |
| reserve habit, current engine | 3.49: R32 gives the reserve 0 |
| reserve habit, **reserves protect stock** | buys on to ~**6.6**, then a second, different stall |

**The second stall** is not a drained payer.
- **The price:** the 10th assembly rig costs 102,400 `smart_plating` + 102,400
  `encased_industrial_beam`. `smart_plating` is FULL at 720,576; `encased_industrial_beam`
  is at 90,851 and growing ~2/s.
- **Still unexplained:** it should be payable within ~0.2 collections, yet no purchase
  came for 2 collections.

It is out of scope here and recorded as a follow-up.

## Out of scope

- The 10th-rig stall above.
- **Reserves for any policy but `bottleneck`.** Calibration is unaffected, since
  `greedy` never reserves.
- **Protecting stock by priority rank in general**, rather than for reserves only: the
  stock-model project.
- **Choosing the reserve percentage adaptively.**

## Acceptance

Unit tests:
1. **Engine (`waterfall.test.ts` / `fixpoint.test.ts`, fixture bundle):**
   - a reserve on an item pinned EMPTY whose consumers would drain it gets its share
     (allocated > 0) where today it gets 0;
   - with a reserve on X, another entry's requirement vector routes through X's recipe
     even though X has stock;
   - no reserve entry is injected for a FULL item.
2. **Reporter (`bottleneck.test.ts`):**
   - a recipe answer priced in a drained item becomes `kind: "reserve"` for that item at
     0.25;
   - it does not when the item is growing, when it already has a reserve, or when the price
     exceeds cap + bound (storage advice, as today).
3. **Policy (`policies.test.ts`):**
   - `bottleneck` emits `SET_RESERVE` on reserve advice;
   - it clears a reserve the advice no longer names;
   - `greedy`, `casual` and `optimal` never emit `SET_RESERVE`.
4. **`renderStatus`** renders the reserve advice.

Measured:
- The full suite, lint, typecheck and `content:check` pass.
- A full `sim gate`: `greedy` and `casual` pins byte-identical. `bottleneck` is
  re-measured, and its tier-9 stall is expected around 6.6 collections, still `reachesTier:
  9`. Moved pins are listed, and the `why` text records the new stall's cause as far as it
  is known.
- The handoff gains the 10th-rig stall as a follow-up.

## The §4.5 amendment

To be added after the 2026-10-10 payable-advice amendment:

> **Amended 2026-10-13: a drained payer gets a reserve.** If a purchase's price includes an
> item whose stock (plus bound) is below the price, whose net rate is not positive, and
> which has no reserve, the advice becomes `{ kind: "reserve", itemId, percent: 0.25 }`:
> reserve a share of that item so it can bank. That works because of the 2026-10-13
> amendment to §C.3: a reserve is exempt from R32, and while it is set, other entries
> walk through the reserved item's recipe rather than drawing its stock. Measured cause:
> `bottleneck` stalled at tier 9 of the vertical slice told to buy a constructor priced
> in `steel_pipe`, which the assembly rigs drain to zero.

## The §C.3 amendment

To be added to `2026-09-01-engine-core-design.md` §C.3, after the 2026-10-12 §C.7 cache
note's neighbours (with the other §C.3 amendments):

> **Amended 2026-10-13: a reserve protects the stock it banks.** While an item has an
> active reserve, none of its entries is an R32 candidate. Every other entry's
> requirement walk treats the item as pinned EMPTY, drawing through its recipe rather
> than from its stock. A reserve on a FULL item is not injected. Without the first rule,
> R32 gave a reserve on a drained item zero, which broke §4.1's promise that a reserve
> diverts output to storage. Without the second, consumers drew the banked stock straight
> back out. Without the third, a reserve claiming a FULL item's recipe deadlocked its
> consumers. None of this applies when no reserve is set: the pacing gate's pins are
> unchanged.
