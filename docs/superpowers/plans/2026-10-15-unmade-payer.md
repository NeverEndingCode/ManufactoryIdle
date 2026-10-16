# Unmade Payer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A short payer that isn't being made at all gets advice for the cause, checked in this order:
- a starved recipe → one machine for what limits it;
- no machines → one machine for its recipe;
- a FULL output → storage for that output, which is the existing blocked-payer rule, now guarded.

**Architecture:**
- **Task 1:** replace `blockedPayerOutput` and its call in `payable` (`packages/engine/src/solve/bottleneck.ts`) with an unmade-payer check in the same place, test-first.
- **Task 2:** the gate re-pin and the docs.

**Tech Stack:** TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-15-unmade-payer-design.md`

## Global Constraints

- Work in `.claude/worktrees/phase-1-engine`, branch `blocked-payer-cause`, cut from `main` at `55d812f`. Never work in the top-level checkout.
- **The check's position:** after the drained-payer check, before the slow-payer check.
- **The cause order:** starved, then no machines, then blocked (FULL output).
- **Shape of the advice:**
  - recipe advice is `{ kind: "recipe", recipeId, limitingTarget, machinesToClear: 1 }`;
  - storage advice is `{ kind: "storage", itemId, limitingTarget, upgrade: cheaperUpgrade(...) }`.
- **"No machines"** means `walk.capacity.unitsByRecipe.get(recipeId) ?? 0` is `0`.
- **"Starved"** means `hasEmptyInput(walk, recipeId)`, and the walk is the existing `starvedStep` loop.
- **The bound:** every redirect adds at least one new item to `visited`, so PR #12's iteration cap still holds.
- **The gate:** `greedy` and `casual` pins must stay byte-identical, and `bottleneck` tiers 1–9 must stay unchanged.
- **Purity:** `packages/engine` is pure (lint-enforced).
- **Commands:**
  - Never run `pnpm format`.
  - Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another in the foreground.
  - Never `pgrep -f` a pattern that matches your own wait loop. Run any mutation that might hang under `timeout -s KILL 120`.
- **Commit trailers:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **The existing blocked-payer tests.** The fresh fixture has `iron_ore` EMPTY, so `smelt_iron` is starved there. Under the new rule, the existing blocked-payer tests (storage for residue, "leaves the advice alone when the output is not FULL", the termination test, the overflow test) would take the starved cause instead. They test the blocked cause, so their `advise` must feed `iron_ore` (and any other starved input) as FLOWING, with their assertions unchanged. Task 1 Step 1 says how.
- **The cause order.** A starved recipe that also has a FULL output gets the walk, not storage. This is covered by Task 1 test A.
- **A dead-end walk.** A walk that ends on a recipe still starved, with nothing it can walk to, skips that payer and leaves the advice unchanged. This is covered by Task 1 test C.
- **Termination.** The existing termination test and the iteration cap still hold. The cap is covered by the mutation in Step 5.

---

### Task 1: The unmade-payer check, test-first

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts` (replace `blockedPayerOutput` and its call in `payable`)
- Test: `packages/engine/src/solve/bottleneck.test.ts` (the describe "computeBottleneck — a payer blocked by its own output gets storage")

**Interfaces:**
- Produces: no exported change. `computeBottleneck`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests**

In the describe "computeBottleneck — a payer blocked by its own output gets storage":

1. **Feed the existing tests.** Extend `advise` with a trailing optional parameter `ore: "EMPTY" | "FLOWING" | "FULL" = "FLOWING"` that sets `states.set("iron_ore", ore)`. Every existing test in the describe then runs with `iron_ore` FLOWING, and their assertions stay exactly as they are. The termination test and the overflow test build their own states or calls. Feed `iron_ore`, and any other EMPTY input on the payer's recipe chain such as `iron_ingot` for `make_plate`, as FLOWING in the same way. Keep their assertions. If keeping an assertion is impossible, STOP and report which, and why.

2. **Add three tests** at the end of the describe:

```ts
  // Spec 2026-10-15 (unmade payer): a short payer not made at all gets the cause. Measured
  // cause: 33 bottleneck decisions kept advising a purchase encased_industrial_beam could
  // not pay while the beam recipe was starved.
  it("walks a starved payer's recipe to what limits it, even when an output is FULL", () => {
    // Precondition: the fresh variant has iron_ore EMPTY, so smelt_iron is starved.
    expect(sol.itemStates.get("iron_ore")).toBe("EMPTY");
    expect(advise(0, "FULL", blockable, sol, 0, "EMPTY")).toEqual({
      kind: "recipe",
      recipeId: start.activeRecipe.iron_ore,
      limitingTarget: "item:iron_plate",
      machinesToClear: 1,
    });
  });

  it("advises one machine for a payer whose recipe has no machines", () => {
    const capacity = { ...sol.capacity, unitsByRecipe: new Map(sol.capacity.unitsByRecipe) };
    capacity.unitsByRecipe.set("smelt_iron", 0);
    const s = { ...sol, capacity };
    expect(advise(0, "FLOWING", blockable, s)).toEqual({
      kind: "recipe",
      recipeId: "smelt_iron",
      limitingTarget: "item:iron_plate",
      machinesToClear: 1,
    });
  });

  it("leaves the advice alone when a starved payer's walk dead-ends", () => {
    // iron_ore's recipe is not live, so the walk from smelt_iron cannot step to it.
    const { iron_ore: _dropped, ...activeRecipe } = start.activeRecipe;
    const rates = new Map(sol.itemRates);
    rates.set("iron_ingot", { production: 0, consumption: 0, net: 0 });
    const states = new Map(sol.itemStates);
    states.set("iron_ore", "EMPTY");
    states.set("heavy_oil_residue", "FLOWING");
    const advice = computeBottleneck(blockable, sol.capacity, sol.entries, sol.power, { ...start, activeRecipe }, states, rates);
    expect(advice).toMatchObject({ kind: "recipe", recipeId: "make_plate" });
  });
```

**Fixture facts to check before running.** If any is wrong, STOP and report it; do not guess.
- `sol.capacity` is an object with a `unitsByRecipe` `Map` (read `CapacityTable` in the solve code). If its shape differs, build the no-machines case the equivalent way.
- In the no-machines test, `computeBottleneck`'s main walk may itself change the first advice once `smelt_iron` has no units. If it no longer reaches the payable step with `make_plate`, STOP and report. If changing `capacity` is the wrong lever, report that too.
- In the dead-end test, deleting `activeRecipe.iron_ore` might change the first advice before `payable` runs. If the result isn't `make_plate` for that reason, report what it is.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/bottleneck.test.ts 2>&1 | grep -E "×|✓ .*(starved|no machines|dead-ends)|Tests " | head -20
```

Expected:
- the starved and no-machines tests fail, because today's code gives storage or keeps `make_plate`;
- the dead-end test passes, which is fine: it guards the skip;
- every existing test still passes with `iron_ore` fed.

- [ ] **Step 3: Implement**

In `bottleneck.ts`, replace `blockedPayerOutput` with:

```ts
/**
 * Spec 2026-10-15 (unmade payer): advice for the first item the purchase is priced in that
 * is short of the price and not made at all, by the cause -- its recipe is starved (one
 * machine for the recipe that limits it), has no machines (one machine for it), or has a
 * FULL output (storage for that output). Null when no such payer has an answer. Adds each
 * payer it considers, and each item the starved walk steps through, to `visited`, which
 * is what bounds `payable`'s loop through these redirects.
 */
function unmadePayerAdvice(
  walk: WalkContext,
  costs: ReadonlyMap<ItemId, Dec>,
  visited: Set<ItemId>,
  limitingTarget: string,
): NonNullable<Bottleneck> | null {
  const { content, state, itemRates, itemStates } = walk;
  for (const [itemId, amount] of costs) {
    if (visited.has(itemId)) continue;
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    if (liquid(state, itemId).plus(bound).gte(amount)) continue;
    if ((itemRates.get(itemId)?.production ?? 0) > FLOW_TOLERANCE) continue;
    const recipeId = activeRecipeOf(state.activeRecipe, itemId);
    if (recipeId === undefined || !isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) continue;
    visited.add(itemId);

    if (hasEmptyInput(walk, recipeId)) {
      let target = recipeId;
      for (let next = starvedStep(walk, target, visited); next !== null; next = starvedStep(walk, target, visited)) {
        target = next;
      }
      if (hasEmptyInput(walk, target)) continue;
      return { kind: "recipe", recipeId: target, limitingTarget, machinesToClear: 1 };
    }
    if ((walk.capacity.unitsByRecipe.get(recipeId) ?? 0) === 0) {
      return { kind: "recipe", recipeId, limitingTarget, machinesToClear: 1 };
    }
    for (const output of content.recipes.get(recipeId)!.def.outputs) {
      if (itemStates.get(output.item) === "FULL" && !visited.has(output.item)) {
        visited.add(output.item);
        return { kind: "storage", itemId: output.item, limitingTarget, upgrade: cheaperUpgrade(content, state, output.item) };
      }
    }
  }
  return null;
}
```

Use whatever type `limitingTarget` has on `Bottleneck`, and match the existing names: check `WalkContext` has `capacity`, which it should, since `adviseBottleneck` builds it with one. In `payable`, replace the blocked-payer block, `const blocked = blockedPayerOutput(...)` through its `continue; }`, with:

```ts
      // Spec 2026-10-15: a payer not made at all gets advice for the cause -- starved,
      // no machines, or a FULL output -- priced through this same loop. Each redirect
      // adds a new item to `visited`, which keeps the loop inside its cap.
      const unmade = unmadePayerAdvice(walk, costs, visited, answer.limitingTarget);
      if (unmade !== null) {
        current = unmade;
        continue;
      }
```

Update `payable`'s doc comment: its blocked-payer sentence becomes one sentence about the unmade-payer step and its three causes.

- [ ] **Step 4: Run the tests, then the engine suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/bottleneck.test.ts 2>&1 | grep -E "×|Tests "
npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: all pass. If an existing test outside this describe fails, report it with its name and why. Do not change its assertions.

- [ ] **Step 5: Mutation-check**

Edit by hand, run the bottleneck tests under `timeout -s KILL 120`, then undo by hand:

| edit | must fail |
|---|---|
| delete the `if (hasEmptyInput(walk, recipeId)) { ... }` block | "walks a starved payer's recipe…" |
| delete the no-machines `if` | "advises one machine for a payer whose recipe has no machines" |
| move the FULL-output loop above the starved block | "walks a starved payer's recipe…, even when an output is FULL" |
| replace `if (hasEmptyInput(walk, target)) continue;` with nothing | "leaves the advice alone when a starved payer's walk dead-ends" |
| delete `visited.add(itemId);` | record the result; it must fail fast (cap error) or pass, never hang |

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts
git commit -m "Advise the cause for a payer that is not being made

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 2: Gate, re-pin, record

**Files:**
- Modify: `apps/sim/src/gate-cli.ts` (the bottleneck entry: tier 10 and the comment's dead time)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§4.5 amendment)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` (follow-ups)
- Modify: `docs/superpowers/specs/2026-10-15-unmade-payer-design.md` (Status)

**Interfaces:**
- Consumes: Task 1's commit.

- [ ] **Step 1: Full suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
```

Expected: green. Report any failure by name.

- [ ] **Step 2: Gate with pins emitted**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=${CLAUDE_JOB_DIR:-/home/nec/.claude/jobs/56686703}/unmade-payer; mkdir -p "$S"
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate.out 2>&1; echo "exit $?" >> $S/gate.out
```

Expected:
- **`greedy` and `casual`:** identical to the committed pins. Diff them explicitly against `gate-cli.ts`.
- **`bottleneck`:**
  - tiers 1–9 identical to the committed pins;
  - reaches tier 10 at about 10.5329;
  - dead time about 0.638.

If any of `greedy`, `casual`, or `bottleneck` tiers 1–9 moves, or `bottleneck` misses tier 10, STOP and report BLOCKED. Do not re-pin.

- [ ] **Step 3: Re-pin `bottleneck`**

In `VERTICAL_SLICE_GATE`'s bottleneck entry:
- update tier 10's value from the emitted block;
- end its `why` with `Re-measured 2026-10-15 after the reporter advised the cause for a payer not being made.`;
- update the dead time in the comment above the entry.

Re-run the gate without `--emit-pins` and confirm exit 0 with no findings.

- [ ] **Step 4: Docs**

- **§4.5:** in `docs/superpowers/specs/2026-09-01-engine-core-design.md`, after the 2026-10-15 blocked-payer amendment, insert the spec's "The §4.5 amendment" text without the `> ` prefixes, keeping its list.
- **The handoff:** in `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, mark the follow-up "the blocked-payer rule doesn't check that the FULL output is why the payer isn't made" as done (2026-10-15). Say that it now checks the cause in order (starved, then no machines, then FULL output), with the measured counts (33 → 19 walk firings) and the new tier 10 and dead time.
- **The spec's Status:** `**Status:** implemented 2026-10-15.`

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add apps/sim/src/gate-cli.ts docs
git commit -m "Re-pin bottleneck's tier 10 after unmade-payer advice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

The report gives:
- the gate's time;
- the moved pins (old → new);
- the explicit `greedy`/`casual` diff result;
- confirmation that `bottleneck` tiers 1–9 are unchanged;
- the dead time.
