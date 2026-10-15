# A purchase that names its recipe

**Amends:** engine spec §D.1 (the action set). It also touches the R5 auto-assignment rule
in `actions/machines.ts`.
**Status:** approved design, 2026-10-14.
**Follows:** `2026-10-14-slow-payer-advice-design.md` (PR #10), whose final review found
this.

---

## The problem, measured

The bottleneck reporter's `recipe` advice names a recipe: "one more machine for
`refine_rubber`". But `BUY_MACHINE` takes only `{ lane, machineClass, mark, count }`.
The recipe the machine goes to comes from auto-assignment (R5), which picks by the
player's priority list. So acting on the advice can put the machine somewhere else.

A probe of a full `bottleneck` run (seed 42, the gate's settings, `main` at `06324be`)
traced every purchase made on recipe advice: **105 of 339 (31%) landed on a recipe other
than the advised one.**

| why auto-assignment skipped the advised recipe | purchases | largest cases |
|---|---|---|
| **A sibling ranks higher.** The advised recipe could use the machine, but a sibling in the same lane and class ranks higher in the priority list. | 89 | `refine_rubber` → `refine_plastic` ×31; `make_modular_frame` → `make_reinforced_iron_plate` ×21; `make_rotor` → `make_reinforced_iron_plate` ×16; `make_steel_beam` → `make_concrete` ×9 |
| **Already below nameplate.** The advised recipe already runs below nameplate. | 16 | `mine_coal` → `mine_limestone` ×11 |

A player has the same problem the policy does. Told to buy one more refinery for
rubber, they buy one, and it goes to plastic. Spec E.2 says `bottleneck` measures
whether the advice is good, and 89 of these purchases measured something else.

## Design

### The action

```
BUY_MACHINE  { lane, machineClass, mark, count, recipeId? }
```

**With `recipeId`:** the `count` new machines are added to that recipe's assignment,
and auto-assignment is not consulted. The action is rejected, with nothing spent and
the state unchanged, when the recipe:
- **is unknown:** `unknown recipe "<id>"`;
- **is in another lane or class:** `recipe "<id>" does not run on <machineClass> in
  <lane>`;
- **is not live:** `recipe "<id>" is not live`. "Live" is `isLiveRecipe`: not in a
  cycle, unlocked at the current tier, and the active recipe for its output. This is
  the same test auto-assignment applies to its candidates.

These checks run before any cost is paid. They join the existing lane, class, mark and
count checks.

**Without `recipeId`:** the action behaves exactly as it does today.

The field is optional, so the batch and replay format (§D.1, §16.3) stays backward
compatible: every existing log replays unchanged.

### The callers

- **`bottleneck` policy** (`apps/sim/src/policies.ts`): when it buys on `recipe` or
  `power` advice, it passes the advised recipe (`recipeId` or `generatorRecipeId`), if
  that recipe is live (`isLiveRecipe`). Otherwise it omits the field and the purchase
  auto-assigns as before. Checking liveness first means a stale or odd answer can never
  abort the decision's batch: a rejected action aborts the whole batch (§D.1), and that
  would discard the idle reassignments and reserve clears that travel with it.
- **`sim`'s `buy` command** (`apps/sim/src/commands.ts`): it gains `--recipe <id>`.
  Usage becomes `buy <class> [count] [--lane L] [--mark M] [--recipe R]`. When
  `--lane` is not given, the lane is taken from the recipe. A person in `sim play` can
  then act on the advice in one step.
- **`greedy`, `casual` and `optimal`:** unchanged. They never pass `recipeId`, so their
  purchases, and their gate pins, cannot move.

### What this does not change

- Auto-assignment itself, `ASSIGN_MACHINES`, `DISMANTLE`, `UPGRADE_MARK` and
  `idleReassignments`.
- The reporter. The 16 purchases advised to a recipe already below nameplate are a
  reporter question. They are recorded as a follow-up, not fixed here.

## The §D.1 amendment

To be added under §D.1's action list:

> **Amended 2026-10-14: a purchase may name its recipe.** `BUY_MACHINE` takes an
> optional `recipeId`. When it is given, the new machines are assigned to that recipe
> instead of by R5's auto-assignment. The recipe must be live, and must run on that
> lane and machine class, or the action is rejected. Measured cause: 105 of 339
> `bottleneck` purchases made on recipe advice went to a different recipe, because a
> purchase could not say which recipe it was for. A player acting on the reporter's
> advice had the same problem.

## Acceptance

**Engine tests** (`actions/machines.test.ts`, or wherever `BUY_MACHINE` is tested):
1. With `recipeId`, the machines land on that recipe, even when a sibling in the same
   lane and class ranks higher and would have won auto-assignment. Without
   `recipeId`, the same purchase goes to the sibling, which shows the test case
   discriminates.
2. Each rejection (unknown recipe, wrong lane or class, not live) returns `rejected`
   and spends nothing.
3. The `assigned` effect reports the named recipe and its new count.

**Policy test** (`policies.test.ts`): on recipe advice, `bottleneck`'s `BUY_MACHINE`
carries the advised `recipeId`.

**Command test** (`commands.test.ts`): `buy <class> --recipe <id>` dispatches
`BUY_MACHINE` with that `recipeId`. An unknown recipe is refused.

**Measured:**
- **The suite:** the full suite, lint, typecheck and `content:check` pass.
- **The probe:** re-run, it reports 0 advised purchases landing elsewhere (105 today).
- **The gate:** a full `sim gate` run.
  - `greedy` and `casual` pins are byte-identical.
  - `bottleneck` is re-pinned, with its `why` texts recording the cause.
  - If `bottleneck` no longer reaches tier 10, stop and report rather than re-pin to a
    stall.
- **The handoff:** the follow-up is recorded as fixed, and the below-nameplate case is
  added as a new follow-up.
