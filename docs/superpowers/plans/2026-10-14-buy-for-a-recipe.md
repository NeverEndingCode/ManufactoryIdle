# Buy for a Recipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `BUY_MACHINE` may name the recipe its machines are for. The `bottleneck` policy and `sim buy --recipe` use it, so a machine bought on recipe advice lands on the advised recipe.

**Architecture:**
- **Task 1:** an optional `recipeId` on the `BUY_MACHINE` action, validated and applied in `applyBuyMachine` (`packages/engine/src/actions/machines.ts`).
- **Task 2:** the two callers, the `bottleneck` policy and the `sim` `buy` command.
- **Task 3:** spec Part 2, a blocked-payer check in the reporter's `payable` (`packages/engine/src/solve/bottleneck.ts`). With Tasks 1–2 alone, `bottleneck` stalls at tier 7.
- **Task 4:** measurement, the gate re-pin and the docs.

**Tech Stack:** TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-14-buy-for-a-recipe-design.md`

## Global Constraints

- Work in `.claude/worktrees/phase-1-engine`, branch `advice-lands-on-recipe`, cut from `main` at `06324be`. Never work in the top-level checkout.
- The field is optional, `recipeId?: RecipeId`. Without it, `BUY_MACHINE` behaves exactly as today.
- Rejection messages, verbatim:
  - `unknown recipe "<id>"`
  - `recipe "<id>" does not run on <machineClass> in <lane>`
  - `recipe "<id>" is not live`
- Liveness is `isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)`.
- `greedy`, `casual` and `optimal` never pass `recipeId`. Their gate pins must stay byte-identical.
- `packages/engine` is pure (lint-enforced).
- Never run `pnpm format`. Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another in the foreground. Never `pgrep -f` a pattern that matches your own wait loop; for long runs, use the Bash tool's `run_in_background` and its completion notification.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **Validation before payment.** A rejected `recipeId` must leave the state untouched, with nothing spent. Covered by Task 1's rejection tests, which compare stored stock.
- **The batch abort.** A rejected action aborts the whole batch (§D.1), which would drop the policy's idle reassignments and reserve clears. The policy checks liveness first and omits `recipeId` if the recipe isn't live. Covered by Task 2's not-live test.
- **The test discriminates.** In Task 1's landing test, the same purchase without `recipeId` must go to the sibling. The test asserts both.
- **The lane in `sim buy --recipe`.** With no `--lane`, the lane comes from the recipe, not from the first lane that has the class. Covered by Task 2's command test on the oil lane.

---

### Task 1: The action names its recipe, test-first

**Files:**
- Modify: `packages/engine/src/actions/types.ts` (the `BUY_MACHINE` member of `Action`)
- Modify: `packages/engine/src/actions/machines.ts` (`applyBuyMachine`)
- Test: `packages/engine/src/actions/machines.test.ts` (inside `describe("BUY_MACHINE")`)

**Interfaces:**
- Produces: `{ type: "BUY_MACHINE"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number; recipeId?: RecipeId }`.

- [ ] **Step 1: Write the failing tests**

Inside `describe("BUY_MACHINE", ...)` in `machines.test.ts`, after the `describe("auto-assignment follows the priority list", ...)` block, add the block below. It reuses that block's world: tier 3 makes the oil refinery live with two recipes. The fixture ranks `refine_plastic` above `residual_fuel`, so auto-assignment picks plastic. `refineryWorld` is local to the earlier describe, so this block defines its own `oilWorld`.

```ts
  // Spec 2026-10-14 (buy for a recipe): a purchase may name the recipe its machines
  // are for. Measured cause: 105 of 339 bottleneck purchases made on recipe advice
  // went to a sibling recipe ranked higher in the priority list.
  describe("a purchase that names its recipe", () => {
    function oilWorld(): WorldState {
      const w = { ...rich(), tier: 3 };
      return { ...w, installed: { ...w.installed }, assignment: { ...w.assignment } };
    }
    const buy = (recipeId?: string) => ({
      type: "BUY_MACHINE" as const,
      lane: "oil",
      machineClass: "refinery",
      mark: 1,
      count: 2,
      ...(recipeId === undefined ? {} : { recipeId }),
    });

    it("lands on the named recipe even when a sibling ranks higher", () => {
      // Without a recipe the same purchase goes to plastic, the higher-ranked sibling.
      const unnamed = expectAccepted(applyBuyMachine(oilWorld(), content, buy()));
      expect(unnamed.assignment.refine_plastic).toBe(2);
      expect(unnamed.assignment.residual_fuel ?? 0).toBe(0);

      const result = applyBuyMachine(oilWorld(), content, buy("residual_fuel"));
      const named = expectAccepted(result);
      expect(named.assignment.residual_fuel).toBe(2);
      expect(named.assignment.refine_plastic ?? 0).toBe(0);
      expect(result.rejected ? [] : result.effects).toContainEqual({ kind: "assigned", recipeId: "residual_fuel", count: 2 });
    });

    it("adds to the named recipe's existing assignment", () => {
      const base = oilWorld();
      const w: WorldState = {
        ...base,
        installed: { ...base.installed, oil: { ...base.installed.oil, refinery: [3] } },
        assignment: { ...base.assignment, residual_fuel: 3 },
      };
      const next = expectAccepted(applyBuyMachine(w, content, buy("residual_fuel")));
      expect(next.assignment.residual_fuel).toBe(5);
    });

    const rejects: [string, (w: WorldState) => WorldState, string, RegExp][] = [
      ["an unknown recipe", (w) => w, "no_such_recipe", /^unknown recipe "no_such_recipe"$/],
      ["a recipe on another lane or class", (w) => w, "make_plate", /^recipe "make_plate" does not run on refinery in oil$/],
      [
        "a recipe that is not live",
        (w) => {
          const { fuel: _dropped, ...activeRecipe } = w.activeRecipe;
          return { ...w, activeRecipe };
        },
        "residual_fuel",
        /^recipe "residual_fuel" is not live$/,
      ],
    ];
    for (const [name, prepare, recipeId, reason] of rejects) {
      it(`rejects ${name} and spends nothing`, () => {
        const w = prepare(oilWorld());
        const result = applyBuyMachine(w, content, buy(recipeId));
        expect(result.rejected).toBe(true);
        expect(result.rejected ? result.reason : "").toMatch(reason);
        // Rejected means the caller keeps its own state; nothing was paid.
        expect(result.rejected ? undefined : result.state).toBeUndefined();
      });
    }
  });
```

**Fixture facts to check before running.** If any is wrong, STOP and report it; do not guess.
- The refinery world's recipes are `refine_plastic` and `residual_fuel`, on lane `oil` and class `refinery`.
- `residual_fuel`'s primary output id is `fuel`. Read the fixture bundle, or `content.recipes.get("residual_fuel")!.primaryOutput`, and use the real id in the not-live case.
- `make_plate` runs on `constructor` in `iron`.
- `installed.oil.refinery` is an array indexed by mark − 1. Check `withInstalled` or `installedAt` in `state/world.ts`. In the existing-assignment test, prefer `withInstalled(base, "oil", "refinery", 1, 3)` if hand-building the shape is wrong.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/actions/machines.test.ts 2>&1 | grep -E "×|✓ .*names|Tests |error" | head -20
```

Expected:
- **The landing tests fail:** they get plastic, or the typecheck rejects `recipeId`. Vitest doesn't typecheck, so expect assertion failures.
- **The rejection tests fail,** because the purchase is accepted.

- [ ] **Step 3: Implement**

In `types.ts`, change the `BUY_MACHINE` member to:

```ts
  | { type: "BUY_MACHINE"; lane: LaneId; machineClass: MachineClassId; mark: number; count: number; recipeId?: RecipeId }
```

In `machines.ts` `applyBuyMachine`:
- destructure `recipeId` with the rest;
- after the `validCount` check and before computing `owned` and `costs` (so before anything is paid), add:

```ts
  // Spec 2026-10-14: a purchase may name the recipe its machines are for, so acting on
  // the reporter's recipe advice puts the machine where the advice said.
  if (recipeId !== undefined) {
    const recipe = content.recipes.get(recipeId);
    if (!recipe) return reject(`unknown recipe "${recipeId}"`);
    if (recipe.lane !== lane || recipe.machineClass !== machineClass) {
      return reject(`recipe "${recipeId}" does not run on ${machineClass} in ${lane}`);
    }
    if (!isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) {
      return reject(`recipe "${recipeId}" is not live`);
    }
  }
```

and replace the auto-assignment line:

```ts
  const target = autoAssignTarget(content, next, lane, machineClass);
```

with:

```ts
  const target = recipeId ?? autoAssignTarget(content, next, lane, machineClass);
```

Also update the file's header comment, which says BUY_MACHINE auto-assigns by the priority list. Add: "unless the action names its recipe (spec 2026-10-14)".

- [ ] **Step 4: Run the tests, then the engine suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/actions/machines.test.ts 2>&1 | grep -E "×|Tests "
npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: all pass.

- [ ] **Step 5: Mutation-check**

Edit by hand, run `machines.test.ts`, then undo by hand:

| edit | must fail |
|---|---|
| `recipeId ?? autoAssignTarget(...)` → `autoAssignTarget(...)` | "lands on the named recipe…" and "adds to the named recipe's…" |
| delete the lane/class check | "rejects a recipe on another lane or class…" |
| delete the `isLiveRecipe` check | "rejects a recipe that is not live…" |

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add packages/engine/src/actions
git commit -m "Let a machine purchase name the recipe it is for

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 2: The callers, `bottleneck` and `sim buy --recipe`

**Files:**
- Modify: `apps/sim/src/policies.ts` (the `bottleneck` policy's machine purchase, ~line 409–435)
- Modify: `apps/sim/src/commands.ts` (`buy` verb ~line 475; usage line ~68)
- Test: `apps/sim/src/policies.test.ts`, `apps/sim/src/commands.test.ts`

**Interfaces:**
- Consumes: Task 1's `recipeId?` on `BUY_MACHINE`, with its rejection rules.

- [ ] **Step 1: Write the failing tests**

**`policies.test.ts`.** The existing test "bottleneck buys the machine the reporter names (spec 4.5, E.2)" (~line 244) expects `{ type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 }`. Change it to include `recipeId: "make_plate"`. This is the intended behaviour change, so record it in the report. Then add, right after it:

```ts
  it("bottleneck buys for the advised recipe only while that recipe is live (spec 2026-10-14)", () => {
    // A not-live recipe would make the purchase reject and abort the decision's batch,
    // so the policy omits the recipe and lets auto-assignment place the machine.
    const ctx = funded();
    const { iron_plate: _dropped, ...activeRecipe } = ctx.state.activeRecipe;
    const stale: PolicyContext = { ...ctx, state: { ...ctx.state, activeRecipe } };
    const buys = getPolicy("bottleneck").decide(stale).filter((a) => a.type === "BUY_MACHINE");
    expect(buys).toEqual([{ type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 }]);
  });
```

Check the fixture: `make_plate`'s output must be `iron_plate`. If deleting `activeRecipe.iron_plate` changes `funded()`'s purchase (for example, the policy buys nothing), STOP and report.

Search `policies.test.ts` for every other `toEqual` that includes a `bottleneck` `BUY_MACHINE`. Each one is made on recipe or power advice, so it now carries `recipeId`: update those expectations to include the advised recipe and list them in the report. Do not change any `greedy`, `casual` or `optimal` expectation. If one of those fails, STOP and report it.

**`commands.test.ts`.** Inside `describe("action commands route through the engine reducers (spec A.2)", ...)`, add:

```ts
  it("buys for a named recipe, taking the lane from it (spec 2026-10-14)", () => {
    let s = rich();
    s = run(s, "tier 3");
    s = run(s, "buy refinery 1 --recipe residual_fuel");
    expect(s.actionLog.at(-1)).toEqual({
      type: "BUY_MACHINE",
      lane: "oil",
      machineClass: "refinery",
      mark: 1,
      count: 1,
      recipeId: "residual_fuel",
    });
    expect(s.state.assignment.residual_fuel).toBe(1);
  });

  it("refuses an unknown recipe", () => {
    const result = runCommand(rich(), "buy constructor 1 --recipe no_such_recipe");
    expect(result.output.join("\n")).toMatch(/unknown recipe "no_such_recipe"/);
    expect(result.session.actionLog).toHaveLength(0);
  });
```

Check that `rich()` in `commands.test.ts` can afford a refinery at tier 3. The fixture's refinery mk1 build cost is in an oil-lane item. If `rich()` doesn't fund it, add that item to the session's stored stock in the test, the same way `rich()` does. If `tier 3` isn't a command, find how the other tests raise the tier (`run(s, "tier 1")` exists at ~line 166).

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
npx vitest run src/policies.test.ts src/commands.test.ts 2>&1 | grep -E "×|Tests " | head -20
```

Expected:
- the updated "buys the machine the reporter names" test fails (no `recipeId` yet);
- the not-live test passes, because today never passes a recipe; that's fine, it guards Step 3;
- the two command tests fail.

- [ ] **Step 3: Implement**

In `policies.ts`, the `bottleneck` policy's purchase loop builds `{ type: "BUY_MACHINE", lane: recipe.lane, machineClass: recipe.machineClass, mark, count }`. Add `isLiveRecipe` to the `@manufactory/engine` import if it isn't there, and change the action to:

```ts
          {
            type: "BUY_MACHINE",
            lane: recipe.lane,
            machineClass: recipe.machineClass,
            mark,
            count,
            // Spec 2026-10-14: buy for the advised recipe, so the machine lands where
            // the advice said rather than wherever auto-assignment ranks first. Only
            // while it is live: a rejected purchase would abort the whole batch.
            ...(isLiveRecipe(ctx.content, recipeId, ctx.state.tier, ctx.state.activeRecipe) ? { recipeId } : {}),
          },
```

In `commands.ts`, in the `case "buy": case "dismantle":` branch, for `buy` only:
- if `flags.recipe` is set, look the recipe up; if it's unknown, return `none([\`unknown recipe "${flags.recipe}"\`])`;
- when `--lane` is not given, use `recipe.lane` instead of `laneOf(...)`;
- add `recipeId: flags.recipe` to the dispatched `BUY_MACHINE`.

The engine rejects a wrong class or a not-live recipe, and that rejection surfaces through `dispatch` as today. `dismantle` ignores `--recipe`. Update the usage line to `"buy <class> [count] [--lane L] [--mark M] [--recipe R]"`.

- [ ] **Step 4: Run the tests, then the sim suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
npx vitest run src/policies.test.ts src/commands.test.ts 2>&1 | grep -E "×|Tests "
npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: all pass. A failing sim test that pinned a `bottleneck` run's outcome (for example a `run.test.ts` purchase count) gets reported by name, not edited. Task 3 re-measures.

- [ ] **Step 5: Mutation-check**

| edit | must fail |
|---|---|
| drop the `...(isLiveRecipe(...) ? { recipeId } : {})` line | "bottleneck buys the machine the reporter names" |
| replace the `isLiveRecipe(...)` condition with `true` | "…only while that recipe is live" |
| in `commands.ts`, use `laneOf(...)` even when `--recipe` is set | "buys for a named recipe, taking the lane from it" |

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add apps/sim/src
git commit -m "Buy for the advised recipe in bottleneck and sim buy --recipe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 3: A payer blocked by its own output, test-first (spec Part 2)

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts` (`payable`, plus a new helper `blockedPayerOutput`)
- Test: `packages/engine/src/solve/bottleneck.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: nothing from Tasks 1–2. `computeBottleneck`'s signature is unchanged.

**Background.** With Tasks 1–2, `bottleneck` stalled at tier 7. The advised purchase was priced in rubber, and rubber's production was exactly 0: its refinery was stopped because its byproduct (`heavy_oil_residue`) was FULL. `payable`'s two payer checks miss this case. `drainedPayer` requires the item to be made; `slowPayer` requires it to be growing. This task adds the check between them.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/solve/bottleneck.test.ts`. The tests use a content variant in which `smelt_iron` also emits `heavy_oil_residue` as a byproduct, so the first advice's payer (`iron_ingot`, made by `smelt_iron`) can be blocked by a FULL byproduct. All of these are already imported in the file: `indexContent`, `initialWorld`, `solve`, `computeBottleneck`, `machineCostRange`, `levelCostRange`, `D`.

```ts
// Spec 2026-10-15 (buy for a recipe, Part 2): a payer short of the price and not made at
// all, because its own recipe has a FULL output, gets storage advice for that output.
// Measured cause: bottleneck stalled at tier 7 told to buy a packager priced in rubber
// while every oil refinery sat at clock 0 behind a FULL heavy_oil_residue.
describe("computeBottleneck — a payer blocked by its own output gets storage", () => {
  // smelt_iron also emits heavy_oil_residue, so the ingot recipe can back up on it.
  const bundle = content.bundle;
  const blockable = indexContent({
    ...bundle,
    recipes: bundle.recipes.map((r) =>
      r.id !== "smelt_iron" ? r : { ...r, outputs: [...r.outputs, { item: "heavy_oil_residue", rate: "10", byproduct: true }] },
    ),
  } as never);
  const start = initialWorld(blockable, 1, 0);
  const sol = solve(start, blockable, NO_FLOOR);
  const firstAdvice = computeBottleneck(blockable, sol.capacity, sol.entries, sol.power, start, sol.itemStates, sol.itemRates);
  // `production` is the payer's production; `residue` is the byproduct's tag.
  const advise = (production: number, residue: "EMPTY" | "FLOWING" | "FULL", c = blockable, s = sol) => {
    const rates = new Map(s.itemRates);
    rates.set("iron_ingot", { production, consumption: production, net: 0 });
    const states = new Map(s.itemStates);
    states.set("heavy_oil_residue", residue);
    return computeBottleneck(c, s.capacity, s.entries, s.power, start, states, rates);
  };

  it("advises storage for the FULL output that stops the payer's recipe", () => {
    // Preconditions: the variant advises make_plate, priced in iron_ingot, which is short.
    expect(firstAdvice).toMatchObject({ kind: "recipe", recipeId: "make_plate", limitingTarget: "item:iron_plate" });
    expect(advise(0, "FULL")).toMatchObject({
      kind: "storage",
      itemId: "heavy_oil_residue",
      limitingTarget: "item:iron_plate",
    });
  });

  it("leaves the advice alone when the output is not FULL", () => {
    expect(advise(0, "FLOWING")).toMatchObject({ kind: "recipe", recipeId: "make_plate" });
  });

  it("does not treat a payer that is made as blocked", () => {
    // Made and not growing is drainedPayer's case: reserve advice, as before.
    expect(advise(5, "FULL")).toMatchObject({ kind: "reserve", itemId: "iron_ingot" });
  });

  it("prices the storage it advises through the same loop", () => {
    // A variant whose storage levels cost far more than anything can hold: the residue
    // storage overflows its own payer and steps on to storage for that payer instead.
    const pricey = indexContent({
      ...blockable.bundle,
      storage: { ...blockable.bundle.storage, baseCost: blockable.bundle.storage.baseCost.map((b) => ({ ...b, amount: 1e12 })) },
    } as never);
    const s = solve(start, pricey, NO_FLOOR);
    const advice = advise(0, "FULL", pricey, s);
    expect(advice).toMatchObject({ kind: "storage" });
    expect(advice).not.toMatchObject({ itemId: "heavy_oil_residue" });
  });
});
```

**Fixture facts to check before running.** If any is wrong, STOP and report it; do not guess.
- `heavy_oil_residue` is a fixture item, and `indexContent` accepts it as a byproduct of an iron-lane recipe. If it rejects that (for example, by a lane rule), use any fixture item it accepts, and say which.
- With the fresh variant world, `iron_ingot` is short of a constructor's 20 (the existing slow-payer tests rely on this).
- **Test 4's variant:** read the storage curve's shape in the bundle (`bundle.storage`; check the field names in `packages/content` types) and make every storage level cost far more than any cap. If quantum storage is cheaper and gets chosen instead, raise its cost the same way. The assertion only needs storage advice for an item other than `heavy_oil_residue`, or `upgrade: null` for it. If the shape makes this impractical, STOP and report.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/bottleneck.test.ts 2>&1 | grep -E "×|Tests |Error" | head -20
```

Expected: tests 1 and 4 fail, getting `make_plate`. Tests 2 and 3 pass already; they pin behaviour that must not change.

- [ ] **Step 3: Implement**

In `bottleneck.ts`, beside `drainedPayer`:

```ts
/**
 * Spec 2026-10-15: an item the purchase is priced in that is short of the price and not
 * made at all, because its live active recipe has a FULL output (byproducts included)
 * -- returns that output, the first in recipe order not yet visited; else null. It sits
 * between drainedPayer (which names only a made item) and slowPayer (which names only a
 * growing one): a payer whose own recipe is backed up is neither.
 */
function blockedPayerOutput(walk: WalkContext, costs: ReadonlyMap<ItemId, Dec>, visited: ReadonlySet<ItemId>): ItemId | null {
  const { content, state, itemRates, itemStates } = walk;
  for (const [itemId, amount] of costs) {
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    if (liquid(state, itemId).plus(bound).gte(amount)) continue;
    if ((itemRates.get(itemId)?.production ?? 0) > FLOW_TOLERANCE) continue;
    const recipeId = activeRecipeOf(state.activeRecipe, itemId);
    if (recipeId === undefined || !isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) continue;
    for (const output of content.recipes.get(recipeId)!.def.outputs) {
      if (itemStates.get(output.item) === "FULL" && !visited.has(output.item)) return output.item;
    }
  }
  return null;
}
```

In `payable`, between the drained-payer return and the slow-payer comment, add:

```ts
      // Spec 2026-10-15: a payer not made at all because its own recipe has a FULL output
      // waits on room for that output. Advise storage for it, priced through this loop.
      const blocked = blockedPayerOutput(walk, costs, visited);
      if (blocked !== null) {
        visited.add(blocked);
        current = { kind: "storage", itemId: blocked, limitingTarget: answer.limitingTarget, upgrade: cheaperUpgrade(content, state, blocked) };
        continue;
      }
```

Also add one sentence about the blocked-payer step to `payable`'s doc comment.

- [ ] **Step 4: Run the tests, then the engine suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/bottleneck.test.ts 2>&1 | grep -E "×|Tests "
npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: all pass. If an existing test fails because the new check fires in its hand-fed state, report it with its name and why. Do not change its assertions.

- [ ] **Step 5: Mutation-check**

Edit by hand, run the bottleneck tests, then undo by hand:

| edit | must fail |
|---|---|
| `if (blocked !== null) {` → `if (false) {` | "advises storage for the FULL output…" |
| drop the `production > FLOW_TOLERANCE` skip | "does not treat a payer that is made as blocked" |
| drop `visited.add(blocked);` | the suite still terminates; record which tests, if any, fail. `visited` bounds the loop, so if a test hangs, report it |

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts
git commit -m "Advise storage for the output that blocks a payer's own recipe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 4: Measure, re-pin, record

**Files:**
- Modify: `apps/sim/src/gate-cli.ts` (bottleneck entry)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§D.1 amendment)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` (follow-ups)
- Modify: `docs/superpowers/specs/2026-10-14-buy-for-a-recipe-design.md` (Status)
- Possibly modify: `.github/workflows/ci.yml` (timing note, only if the gate time moves by more than 20%)

**Interfaces:**
- Consumes: Tasks 1, 2 and 3.

- [ ] **Step 1: Full suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
```

Expected: green. Report any failure by name.

- [ ] **Step 2: The probe**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
npx tsx /home/nec/.claude/jobs/56686703/tmp/land/probe.mts 2>&1 | tail -n 20
```

The probe runs `bottleneck` to tier 10 (about 2 minutes). For every purchase made on recipe advice, it reports where the machine landed. Expected: `misplaced: 0`. A row whose advised recipe wasn't live (and so carried no `recipeId`) is acceptable; report each row it prints.

- [ ] **Step 3: Gate with pins emitted**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=${CLAUDE_JOB_DIR:-/home/nec/.claude/jobs/56686703}/buy-for-recipe; mkdir -p "$S"
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate.out 2>&1; echo "exit $?" >> $S/gate.out
```

Expected:
- **`greedy` and `casual`:** identical to the committed pins. If either moves at all, STOP and report BLOCKED.
- **`bottleneck`:** if it doesn't reach tier 10, STOP and report BLOCKED with its last tier and dead time. Do not re-pin to a stall.
- **Expected `bottleneck` values,** from spec Part 2's prototype: tiers 1–2 unchanged; t3 0.2965, t4 0.4496, t5 0.5172, t6 0.7622, t7 1.0315, t8 1.4204, t9 2.2693, t10 10.5551; dead about 0.609. A different value is not a stop condition, but report any tier that differs by more than 1%.

- [ ] **Step 4: Re-pin `bottleneck`**

In `VERTICAL_SLICE_GATE`'s bottleneck entry:
- update every moved tier value from the emitted block;
- on each moved pin, end its `why` with `Re-measured 2026-10-15 after bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer.`;
- update the comment above the entry with the new tier-10 value and dead time.

Re-run the gate without `--emit-pins`, and confirm exit 0 with no findings. If the gate's wall time moved by more than 20% from 2m15s, update the dated note in `.github/workflows/ci.yml`.

- [ ] **Step 5: Docs**

- **§D.1:** in `docs/superpowers/specs/2026-09-01-engine-core-design.md`, change the action-list line to `BUY_MACHINE       { lane, machineClass, mark, count, recipeId? }`. Under the list, insert the spec's "The §D.1 amendment" text without the `> ` prefixes.
- **§4.5:** in the same file, after the 2026-10-14 slow-payer amendment, insert the spec's Part 2 "The §4.5 amendment" text without the `> ` prefixes.
- **The handoff:** in `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, mark the follow-up "recipe advice is bought as a lane/class machine and auto-assignment can place it elsewhere" as fixed (2026-10-14), with the measured misplaced count (105 → the probe's number). Add a new follow-up: the reporter can advise a recipe already running below nameplate (16 of 339 purchases, mostly `mine_coal`). Give its moved pins in one line.
- **The spec's Status:** `**Status:** implemented 2026-10-14.`

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add apps/sim/src/gate-cli.ts docs .github
git commit -m "Re-pin bottleneck now that it buys for the advised recipe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

The report gives:
- the probe's output;
- the gate's time;
- every moved pin (old → new);
- confirmation that `greedy` and `casual` are identical;
- `bottleneck`'s dead time.
