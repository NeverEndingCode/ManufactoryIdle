# Milestone-first policies, and the dead storage knob

**Amends:** spec E.2 (the policies), spec B.7 (calibration inputs).
**Status:** designed 2026-10-12; not implemented.
**Follows:** the PR #4 follow-ups. Spec B, tier 10's structural fix, comes after this one,
measured against the policies this spec leaves.

---

## The question

Original §4.1 makes the priority list the player's main lever: "the split is a
*consequence* of where those two sit in the priority list". Spec E.2 defines the
simulated players, and none of them ever touches the list. `casual` is defined as
"never reorders priorities", but `greedy`, the policy the content is calibrated against,
doesn't reorder either. So every calibrated number assumes a player who never uses the
game's central control.

The intent agreed for this spec is **realistic calibration**: the calibration player
should play the way a competent player does. The player model chosen is
**milestone-first**: keep the next milestone's required items at the top of the list,
and put them back in authored order once delivered. No reserves.

## The measurement that shaped this spec

Before designing a recalibration, this was measured with a throwaway milestone-first
`greedy` on the current `derived.yaml`, 2026-10-12:

| tier | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| `greedy` today | 0.418 | 0.798 | 1.193 | 1.837 | 2.965 | 4.423 | 6.847 | 10.757 | 15.49 | 20.872 |
| milestone-first | 0.418 | 0.798 | 1.193 | 1.820 | 2.965 | 4.422 | 6.847 | 10.756 | 15.49 | 20.868 |

Purchases: 4,868 against 4,867. Only tier 4 moves (−0.9%). The reorder does fire; it
barely matters. That agrees with what Phase 2 already measured. `greedy`'s tier times
are set by storage caps and purchase cadence, and consumers draw a milestone item from
stock, which the priority order does not govern (engine spec §C.2). So who outranks whom
rarely binds.

**Consequence:** the calibrated numbers already hold for a milestone-first player, to
within 1%. A recalibration would move nothing, so this spec does not recalibrate.

**A design observation, recorded, not acted on:** if the priority list barely affects
pacing, it is not yet doing the job §4.1 gives it. The reason is the same stock-bypasses-
priority behaviour behind the pin/unpin cycles. Both belong to the deferred stock-model
project.

## Design

### 1. The milestone-first habit, for `greedy` and `optimal`

A shared helper in `apps/sim/src/policies.ts`:

```ts
export function milestoneFirstReorder(ctx: PolicyContext): Action[]
```

It computes the **desired order**:
1. the power entry (spec C.4 keeps it first);
2. the next milestone's required items (`content.milestoneByTier.get(state.tier + 1)`),
   as `item:<id>` entries, in the milestone's own `requires` order;
3. every other entry, in **authored order**, meaning the bundle's `start.priority`.
   An entry not in `start.priority` (none exist today) goes last, keeping its relative
   order.

It returns `[]` when `state.priority` is already in that order. Otherwise it returns one
`{ type: "REORDER_PRIORITY", entries: desired }`. Once there is no next milestone (tier 10
done), step 2 is empty and the order reverts to authored. It never changes paused flags,
modes, target rates or reserves.

- **`greedy`** prepends it to its actions, before `idleReassignments` and the purchase.
  Its purchase choice (the cheapest affordable candidate) does not read the priority
  list, so it is unaffected by the order of actions.
- **`optimal`** prepends it too. `optimal`'s lookahead targets `topTargetItem`, which
  reads the priority list, so it is computed from the **reordered** state: the helper's
  action is applied to a copy of `ctx.state` before the lookahead runs.
- **`casual`** and **`bottleneck`** are unchanged. `casual` keeps E.2's "never reorders
  priorities" as the lower bound. `bottleneck` keeps doing only what the advice says, so
  it still measures the advice alone.

### 2. Pins, not recalibration

`derived.yaml` is unchanged. The gate's pins are re-measured with `--emit-pins` and
re-pinned where they move:
- **`greedy`:** expected to move by about 1% at tier 4, so still inside its ±5% band.
- **`optimal`:** not in the gate.
- **`casual` and `bottleneck`:** their behaviour is unchanged, so their pins should not
  move. If one does, investigate before re-pinning.

### 3. The dead B.7 knob

`pacing.storageBindingCadence` ("machines between storage binding") is read by nothing.
It is removed from:
- the content schema (`packages/content/src/schema.ts`);
- the engine's `ContentBundle` type (`packages/engine/src/content/types.ts`);
- all three bundles;
- the test fixtures that construct a pacing block;
- the stale reference in `apps/sim/src/calibrate.ts`'s header.

Removing it from `bundles/calibration-fixture/` is the one edit the frozen bundle's README
allows: a schema change forces it, and no test's premise reads the field.

Spec B.7 is amended: storage `capGrowth`, `costGrowth`, `baseCostAmount` and `maxLevel`
are authored, with measurements behind them (§3.3's binding shape, check 12's climbable
ladder, the 22/16 depth). Calibration solves `capPerTier` and `r_eff`. There is no
storage-cadence target.

### 4. Spec E.2's table

- **`greedy`:** "Buy the cheapest available upgrade; plays milestone-first."
- **`optimal`:** "Perfect ordering; plays milestone-first. The upper bound."
- `casual` and `bottleneck` keep their wording.

A note under the table records the measurement above, and that the calibration therefore
holds for a milestone-first player.

## Out of scope

- **Reserves (`SET_RESERVE`).** Not part of the chosen player model, and still emitted by
  no policy.
- **Making priority matter more to pacing.** This is the stock-model project.
- **Recalibration.** The measurement shows it would move nothing.

## Acceptance

Unit tests, in `apps/sim/src/policies.test.ts`:
1. The desired order puts power first, then the next milestone's items in `requires`
   order, then the rest in authored order.
2. No reorder is emitted when the list is already in that order.
3. Items return to authored order after their milestone is delivered (the next tier's
   milestone has different items).
4. With no next milestone, the order is authored.
5. `greedy` and `optimal` emit the reorder. `casual` and `bottleneck` never emit
   `REORDER_PRIORITY`.
6. `optimal`'s lookahead target is the milestone item after the reorder.

Schema: a bundle with no `storageBindingCadence` loads. Whether one that still has it is
rejected or stripped follows the schema's existing strictness, and is stated in the plan.

Measured: the full suite, lint, typecheck and `content:check` pass. A full `sim gate`
passes with re-pinned values; every moved pin is listed in the PR, with any `casual` or
`bottleneck` move called out.
