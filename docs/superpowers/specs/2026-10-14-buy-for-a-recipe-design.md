# A purchase that names its recipe

**Amends:** engine spec §D.1 (the action set) and §4.5 (the bottleneck reporter's final
`payable` step). It also touches the R5 auto-assignment rule in `actions/machines.ts`.
**Status:** implemented 2026-10-15.
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

## Part 2: a payer blocked by its own output (added 2026-10-15)

### The problem, measured

With Part 1 in place, `bottleneck` stalled at tier 7: dead 2.0035 collections, 148
purchases. Tiers 3–7 were all faster than `main`. The state at the stall:

- **The advice:** one packager for `package_fuel`, priced at 20 `steel_beam` (2,000
  held) + 20 `rubber` (15.46 held). The policy could never afford it.
- **Why rubber never grew:** the oil chain had jammed. `fuel` was FULL, and nothing
  consumed it, because its consumer is the packager being advised. So
  `refine_residual_fuel` stopped, `heavy_oil_residue` backed up to FULL, and both
  refineries (`refine_rubber`, `refine_plastic`) stopped too, because their residue
  byproduct had nowhere to go. Every oil recipe was at clock 0, and rubber's production
  was exactly 0.
- **Why `payable` said nothing:**
  - the drained-payer check names only an item that is made ("a reserve cannot bank
    what no machine makes");
  - the slow-payer check names only an item that is growing.

  A payer whose production is 0 because its own recipe is backed up fell between the
  two.

On `main` the run avoided this by chance: machines advised for rubber landed on plastic
and took a different path. The gap was already there, and a player could reach the same
jam.

### The rule

A fourth check in `payable` runs after the drained-payer check and before the slow-payer
check. For each cost item of the price, in price order, the item is a **blocked payer**
when:
- it is **short:** liquid + bound is below the price;
- it is **not made:** production ≤ `FLOW_TOLERANCE`;
- its **active recipe is live;**
- one of that recipe's **outputs is FULL,** byproducts included, checked in the recipe's
  output order, and that output is not yet in `visited`.

The advice then becomes storage for that FULL output:

```ts
{ kind: "storage", itemId: <the FULL output>, limitingTarget: <unchanged>, upgrade: cheaperUpgrade(...) }
```

The output joins `visited`, and the storage answer goes back around `payable`'s loop
like any other redirect, so its own price meets every check. The first blocked payer
found wins.

**Why storage for the backed-up output.** Any room in the output lets its recipe run
again. The payer only needs its shortfall (4.54 rubber here), so one level is enough to
afford the purchase. The purchase then usually adds the missing consumer, which here is
the packager that burns the fuel.

**What it does not do.** It does not walk further down the jam (for example to `fuel`,
the root of the residue backup). Clearing the payer's own recipe is enough to pay, and
the reporter re-solves after each purchase.

### Measured (prototype, the gate's settings)

| | reaches | t7 | t8 | t9 | t10 | dead | purchases |
|---|---|---|---|---|---|---|---|
| `main` (`06324be`) | 10 | 1.3033 | 1.6826 | 2.5167 | 10.6168 | 0.547 | — |
| Part 1 alone | 7, stalled | 1.0315 | — | — | — | 2.004 | 148 |
| Part 1 + Part 2 | 10 | 1.0315 | 1.4204 | 2.2693 | 10.5551 | 0.609 | 461 |

Tiers 1–2 are unchanged throughout. With both parts:
- tiers 3–10 are all at least as fast as `main`;
- the longest dead stretch is slightly longer (0.61 against 0.55);
- `greedy`, `casual` and `optimal` don't read the reporter, so they cannot move.

### The §4.5 amendment

To be added after the 2026-10-14 slow-payer amendment:

> **Amended 2026-10-15: a payer blocked by its own output gets storage advice.** If a
> payer is short of the price and not made at all, because its live active recipe has
> a FULL output (byproducts included), the advice becomes storage for that output, and
> passes through this final step again. Measured cause: once purchases landed on the
> advised recipe, `bottleneck` stalled at tier 7 of the vertical slice. It was told to
> buy a packager it could not afford, because rubber had stopped: the oil chain had
> backed up through `heavy_oil_residue` to an unconsumed `fuel`. With this rule it
> finishes tier 10 at 10.56 collections.

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

**Reporter tests** (`bottleneck.test.ts`, Part 2):
4. A short payer with production 0 whose active recipe has a FULL output gets storage
   advice for that output.
5. The same payer with that output not FULL leaves the advice as it was.
6. A short payer that is made (production > 0) is not a blocked payer: the existing
   drained- and slow-payer behaviour is unchanged.
7. A blocked-payer redirect whose storage price overflows continues through the loop,
   as the other redirects do.

**Measured:**
- **The suite:** the full suite, lint, typecheck and `content:check` pass.
- **The probe:** re-run, it reports 0 advised purchases landing elsewhere (105 today).
- **The gate:** a full `sim gate` run.
  - `greedy` and `casual` pins are byte-identical.
  - `bottleneck` is re-pinned, with its `why` texts recording the cause.
  - If `bottleneck` no longer reaches tier 10, stop and report rather than re-pin to a
    stall. (Part 1 alone did stall, at tier 7; Part 2 is the fix.)
- **The handoff:** the follow-up is recorded as fixed, and the below-nameplate case is
  added as a new follow-up.
