# Milestone-aware bottleneck reporting

**Amends:** spec §4.5 (bottleneck as first-class solver output) and §E.2 (what the
`bottleneck` policy tests).
**Status:** design, approved 2026-09-19. Not yet implemented.
**Branch:** `worktree-phase-2-content`.

---

## The problem, measured

`bottleneck` reaches tier 1 of the vertical slice in 0.0927 collections and then **never
reaches tier 2**, in 120 simulated days. It makes 54 purchases in that span and records
102.892 collections of maximum dead time.

The stalled state, probed 20 simulated days in:

| | |
|---|---|
| `iron_plate` held | **2,307,820** |
| `screw` held | **430,367** |
| assemblers owned | **0** |
| tier 2 requires | `reinforced_iron_plate` 200, `iron_rod` 1200 |
| `reinforced_iron_plate` held | 0 |
| the reporter says | `{ kind: "recipe", recipeId: "mine_iron_ore", limitingTarget: "item:iron_plate", machinesToClear: 3 }` |

The player is sitting on 2.3 million iron plate and 430 thousand screws — both inputs to
the item the milestone wants — owns no machine of the only class that can combine them,
and the game's advice is **"buy 3 more iron ore miners."**

Spec E.2 is explicit about what that means: *"is the advice actually good? If
`bottleneck` lands materially worse than `greedy`, the UI is lying to players and no
amount of balance tuning fixes that."* `greedy` reaches tier 10. `bottleneck` reaches
tier 1.

This is not a pacing defect and no calibration touches it. It also pre-dates the Phase 2
content retune — the earlier bundle measures the same. Task 0's reported result
(`bottleneck` reaching tier 2 in 0.07 collections) was measured on the *uncalibrated*
fixture and was never re-checked against calibrated content.

## Why it happens — two independent halves

**1. The scan is ranked by authored priority.** `computeBottleneck` takes
`entries.find((e) => e.limitedBy !== null)` — the highest-priority *limited* target. The
slice authors `iron_plate` first in `start.priority`. `iron_plate` is genuinely limited by
`mine_iron_ore`, so that is what gets named. The reporter is answering "what limits
throughput of your top priority item" when the question a stalled player has is "what
blocks the next milestone".

**2. A target with zero machines is invisible to that scan.** Measured: with
`assignment["make_reinforced_iron_plate"] === 0`, the recipe is present in
`capacity.unitsByRecipe` with `units: 0`, and its waterfall entry comes back with
`allocated: 0` and **`limitedBy: null`**. A recipe with no machines is not *limited* by
anything — nothing is constraining it, it simply has no capacity — so `find(limitedBy !==
null)` can never return it.

**Fixing either half alone does not work**, which is why both are in scope:

- Ranking by milestone alone still finds `limitedBy: null` on `reinforced_iron_plate` and
  falls through to the priority scan.
- Fixing the zero-capacity blind spot alone still scans by priority, where `iron_plate` is
  first and genuinely limited, so it still wins and still says "buy miners".

## Design

### No new `Bottleneck` kind

A recipe with zero machines genuinely *is* the binding constraint for the target that
needs it, so the existing `kind: "recipe"` already says the right thing, and
`limitingTarget` already carries which target the advice is about. The `Bottleneck` union
is unchanged.

Consequences: `sim play`'s UI, `RunReport`, and the `bottleneck` policy need no changes at
all. The entire change is target *selection* inside `computeBottleneck`.

This was not the first design considered. A fourth `unstaffed` kind was, and it was
dropped once it became clear it would carry no information the `recipe` kind does not
already carry — a new kind every consumer must learn, to say a thing the existing one
says.

### Selection order

One new branch in `computeBottleneck`, between the power branch and the existing priority
scan:

1. **Power** — unchanged. A browning grid still wins, as §4.5 already requires.
2. **Milestone (new)** — the next milestone is the one at `state.tier + 1`. For each of
   its requirements whose liquid stock is short of the required amount, in the milestone's
   **authored order**, resolve a blocker by the walk below. The first blocker found is
   returned.
3. **Priority scan** — unchanged, and reached whenever the milestone is fully satisfied,
   has no unmet requirement that resolves to a blocker, or does not exist (the player is
   at the last tier).

Existing behaviour is therefore preserved everywhere it was already correct: the new
branch can only fire when a milestone requirement is unmet AND something concrete blocks
it.

### The chain walk

From an unmet requirement item `I`, with a visited set:

1. `r = activeRecipe[I]`. If absent, `I` has no producer — nothing to name; continue to
   the next requirement.
2. If `capacity.unitsByRecipe.get(r)` is 0 → return `{ kind: "recipe", recipeId: r, … }`.
   This is the stall: `make_reinforced_iron_plate`, zero assemblers.
3. Else if `itemStates.get(I) === "FULL"` → return `{ kind: "storage", itemId: I, … }`,
   exactly as the existing FULL branch does. A cap is still a cap.
4. Else if `I`'s entry has `limitedBy !== null` → return `{ kind: "recipe", recipeId:
   entry.limitedBy, … }` with today's `machinesToClearRecipe`.
5. Else if `r` is producing `I` at zero, or is starved of an input, recurse into those
   starved inputs in authored order, skipping visited items.
6. Else **this requirement is not blocked — it is merely accumulating.** Continue to the
   next requirement.

Step 6 is the one that keeps this branch honest, and it is easy to get wrong. A milestone
requirement is unmet for two very different reasons: something is stopping it, or the
player simply has not banked enough yet. Only the first is a bottleneck. Without step 6
the walk would descend into a healthy production chain and name the tightest thing it
found there, hijacking the report on a factory with nothing wrong with it — the same class
of error as the current defect, pointed the other way. If every unmet requirement reaches
step 6, the milestone branch reports nothing and the priority scan runs exactly as today.

`limitingTarget` is set to the milestone item's entry id (`item:<I>`) rather than the
recursed-into item's, so the advice reads "this is what is stopping the thing you need"
rather than naming an intermediate the player never asked for. The blocker's own identity
still travels in `recipeId` or `itemId`, so "your screw storage is full" and "you need
this for reinforced iron plate" are both recoverable.

**The visited set is load-bearing, not defensive.** The slice ships a deliberate recipe
cycle — `alt_recycled_plastic → alt_recycled_rubber`, the known-acceptable check 6 warning
— so an unguarded walk terminates only by luck.

`machinesToClear` for the zero-capacity case comes out of the existing
`machinesToClearRecipe`, whose `Math.max(1, …)` floor yields 1. Task 0 called that floor
out as a defect because it converted "no machine would help" into "buy 1 machine". Here
one machine genuinely does help — it is the difference between zero production and some —
so the floor is correct in this branch and is deliberately left alone.

### What this does not change

The waterfall, the priority list's semantics, and therefore **allocation**. This matters
concretely: priority order feeds the waterfall, so anything that reordered priority to fix
this would move every calibrated number and force a full recalibration of the nine tiers
currently on target. A reporter-only change cannot.

`greedy` and `casual` are unaffected. `derived.yaml` is unaffected. **No recalibration.**

Two alternatives were considered and rejected on exactly this ground: having the policy
emit `REORDER_PRIORITY` to lift milestone items to the top, and introducing a `milestone`
`PriorityKind` so milestone needs become first-class waterfall entries. Both are cleaner
conceptually. Both perturb allocation and cost a recalibration of the whole slice. The
`REORDER_PRIORITY` idea remains attractive for a *player-facing* feature and is recorded
in the handoff as still open; it is not the way to fix the reporter.

### Determinism and cost

Spec A.5: iteration is in authored order at every level — requirements in the milestone's
order, inputs in the recipe's order — so the walk is canonical and replay-stable. It adds
no floating-point arithmetic, so E.4's libm hazard is not engaged.

Cost is bounded by the visited set at O(items) per solve, against §4.5's existing ~4,000
operations per pass. Negligible.

## Acceptance

**Measured, not assumed.** Task 0 set this precedent and its result did not hold; this
design does not get to repeat that.

1. Engine unit tests over `computeBottleneck`: an unmet milestone item with no machines
   names its own recipe; a FULL milestone item names storage; a satisfied milestone falls
   back to the priority scan unchanged; **an unmet-but-flowing requirement falls back to
   the priority scan** (step 6); a cyclic chain terminates.
2. `bottleneck` on the vertical slice reaches materially further than tier 1, and **how
   far is reported as a number**, not asserted to be "fixed".
3. The pacing gate's `bottleneck` pins — tier 1 at 0.0927 and dead time at 102.8917 — are
   expected to fire `stale-pin`. That is the pin contract working, and the entries are
   then re-measured and updated or deleted.
4. No change to `derived.yaml`, and `greedy`/`casual` tier times byte-identical. If either
   moves, this design is wrong about its own blast radius and the change stops.

**Open risk, stated up front:** clearing this blocker may reveal another behind it.
`bottleneck` buys only what the reporter names, so it is the policy most exposed to any
remaining gap in the reporter. Landing near `greedy` is the goal; landing further than
tier 1 with an honest number is the deliverable.

## The §4.5 amendment

To be added inline at §4.5, matching the form of the 2026-09-06 amendment:

> **Amended 2026-09-19 (Phase 2): the scan is milestone-first.**
>
> §4.5 originally returned the constraint limiting the highest-priority *limited* target.
> Two measured defects follow from that wording. A target with zero machines has
> `limitedBy: null` and is invisible to the scan, since a recipe with no capacity is not
> limited by anything. And ranking by the authored priority list answers a question a
> stalled player is not asking.
>
> Measured on the vertical slice: `bottleneck` stalled at tier 1 for 120 simulated days
> holding 2,307,820 `iron_plate` and 430,367 `screw`, owning zero assemblers, needing 200
> `reinforced_iron_plate` — and was advised to buy three iron ore miners.
>
> The reporter now resolves the next milestone's unmet requirements first, walking each
> item's input chain to the first genuine blocker, and falls back to the priority scan
> when the milestone is satisfied or nothing in it is blocked. The returned kinds are
> unchanged: a zero-capacity recipe is reported as `kind: "recipe"`, because it genuinely
> is the binding constraint.
