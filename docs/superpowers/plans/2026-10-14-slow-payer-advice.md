# Slow-Payer Advice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an advised purchase's cost item would take longer than half an offline window to afford, the bottleneck reporter advises one machine for that item's active recipe instead. `bottleneck` then finishes tier 10.

**Architecture:**
- **Task 1:** a third check in `payable` (`packages/engine/src/solve/bottleneck.ts`), after the storage-cap and drained-payer checks. It redirects to the slow payer's recipe and loops through the same checks. Test-first.
- **Task 2:** the gate re-pin and the docs.

**Tech Stack:** TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-14-slow-payer-advice-design.md`

## Global Constraints

- Work in `.claude/worktrees/phase-1-engine`, branch `slow-payer-advice`, cut from `main` at `961bfa1`. Never work in the top-level checkout.
- The horizon is exactly `0.5` offline windows, as an exported named constant `SLOW_PAYER_HORIZON_COLLECTIONS`, multiplied by `content.offlineCapMs`.
- The redirect is an ordinary `{ kind: "recipe", recipeId, limitingTarget, machinesToClear: 1 }`. No new `Bottleneck` kind.
- `greedy` and `casual` gate pins must stay byte-identical. Neither reads the reporter, and the spec measured this.
- `packages/engine` is pure (lint-enforced).
- Never run `pnpm format`. Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another in the foreground. Never `pgrep -f` a pattern that matches your own wait loop; for long runs, use the Bash tool's `run_in_background` and its completion notification.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **Loop termination.** Each redirect adds the slow payer to `visited`, and a payer already visited stops the redirect. Covered structurally: the four tests terminate, and so does the full gate run.
- **Order of the checks.** The storage cap comes first, then the drained payer, then the slow payer. A payer that is short and not growing is the drained check's job, not this one's. Covered by the existing reserve tests staying green.
- **Unit consistency.** Net rates are per second and `offlineCapMs` is in milliseconds. The time to afford is `(shortfall / net) * 1000` ms. Covered by Task 1 test 1 versus test 2.
- **The fresh fixture's advice.** It is a machine (`recipe` kind). The tests assert that as a precondition.

---

### Task 1: The slow-payer check, test-first

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts` (`payable`, plus a new helper and constant)
- Test: `packages/engine/src/solve/bottleneck.test.ts` (append one `describe`)

**Interfaces:**
- Produces: `export const SLOW_PAYER_HORIZON_COLLECTIONS = 0.5;`. `computeBottleneck`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/solve/bottleneck.test.ts`. Add `SLOW_PAYER_HORIZON_COLLECTIONS` to the import from `./bottleneck.js`. `indexContent`, `initialWorld`, `solve`, `computeBottleneck` and `machineCostRange` are already imported; `content` is the fixture.

```ts
// Spec 2026-10-14 (slow-payer advice): a purchase whose payer would take longer than
// half an offline window to afford becomes one more machine for that payer's recipe.
// Measured cause: bottleneck stopped at tier 9 told to buy a rig ~22.6 h of beam
// production away.
describe("computeBottleneck — a slow payer gets production advice", () => {
  const start = initialWorld(content, 1, 0);
  const sol = solve(start, content, NO_FLOOR);
  const firstAdvice = computeBottleneck(content, sol.capacity, sol.entries, sol.power, start, sol.itemStates, sol.itemRates);
  const payer = (() => {
    if (firstAdvice?.kind !== "recipe") return undefined;
    const recipe = content.recipes.get(firstAdvice.recipeId)!;
    return [...machineCostRange(content, recipe.machineClass, 1, 0, 1)][0]?.[0];
  })();
  // The payer grows at `net`/s and is otherwise as the fresh fixture has it.
  const advise = (state: WorldState, net: number, c = content, s = sol) => {
    const rates = new Map(s.itemRates);
    rates.set(payer!, { production: net + 1, consumption: 1, net });
    return computeBottleneck(c, s.capacity, s.entries, s.power, state, s.itemStates, rates);
  };

  it("redirects to the slow payer's recipe", () => {
    // Preconditions: the fresh fixture advises a machine priced in an item it is short of.
    expect(firstAdvice?.kind).toBe("recipe");
    expect(payer).toBeDefined();
    // 1e-6/s is far slower than half an offline window allows.
    expect(advise(start, 1e-6)).toEqual({
      kind: "recipe",
      recipeId: start.activeRecipe[payer!],
      limitingTarget: firstAdvice!.limitingTarget,
      machinesToClear: 1,
    });
  });

  it("leaves the advice alone when the payer affords it within the horizon", () => {
    expect(SLOW_PAYER_HORIZON_COLLECTIONS).toBe(0.5);
    expect(advise(start, 1e9)).toEqual(firstAdvice);
  });

  it("leaves the advice alone when the slow payer has no active recipe", () => {
    const { [payer!]: _dropped, ...activeRecipe } = start.activeRecipe;
    expect(advise({ ...start, activeRecipe }, 1e-6)).toEqual(firstAdvice);
  });

  it("sends a redirect whose own price overflows on to storage advice", () => {
    // A variant where the payer's producing machine costs far more than anything can hold.
    const recipeId = start.activeRecipe[payer!]!;
    const machineClass = content.recipes.get(recipeId)!.machineClass;
    const bundle = content.bundle;
    const pricey = indexContent({
      ...bundle,
      machineClasses: bundle.machineClasses.map((cls) =>
        cls.id !== machineClass
          ? cls
          : { ...cls, marks: cls.marks.map((m) => ({ ...m, buildCost: m.buildCost.map((b) => ({ ...b, amount: 1e12 })) })) },
      ),
    } as never);
    const s = solve(start, pricey, NO_FLOOR);
    // Precondition: the variant still advises the same first purchase.
    expect(computeBottleneck(pricey, s.capacity, s.entries, s.power, start, s.itemStates, s.itemRates)).toMatchObject({
      kind: "recipe",
      recipeId: (firstAdvice as { recipeId: string }).recipeId,
    });
    expect(advise(start, 1e-6, pricey, s)).toMatchObject({ kind: "storage" });
  });
});
```

(If the first advice's machine class is the same as the payer's producing machine's class, test 4's variant also changes the first purchase's price. In that case, if the precondition fails, STOP and report it: pick a payer or state where the two differ, and say which.)

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/bottleneck.test.ts 2>&1 | grep -E "×|Tests |Error|expected"
```

Expected: a compile/import failure (`SLOW_PAYER_HORIZON_COLLECTIONS` is not exported), or tests 1 and 4 fail. Tests 2 and 3 may pass already; they pin behaviour that must not change.

- [ ] **Step 3: Implement**

In `bottleneck.ts`, next to `RESERVE_ADVICE_PERCENT`:

```ts
/**
 * Spec 2026-10-14: a payer that would take longer than this many offline windows to
 * afford the advised purchase gets production advice instead. Measured on the slice:
 * 0.5 finishes tier 10 soonest with the shortest dead stretches (1 is slower, 0.25
 * buys 66 more machines for a later finish).
 */
export const SLOW_PAYER_HORIZON_COLLECTIONS = 0.5;
```

And a helper beside `drainedPayer`:

```ts
/**
 * Spec 2026-10-14: the cost item that would take longest to afford at its current net
 * rate, if that is longer than SLOW_PAYER_HORIZON_COLLECTIONS offline windows; else
 * null. Only short, growing items count -- a short item that is not growing is
 * drainedPayer's case, and one that already covers its share is not waiting on anything.
 */
function slowPayer(walk: WalkContext, costs: ReadonlyMap<ItemId, Dec>): ItemId | null {
  const { content, state, itemRates } = walk;
  let slowest: ItemId | null = null;
  let worstMs = SLOW_PAYER_HORIZON_COLLECTIONS * content.offlineCapMs;
  for (const [itemId, amount] of costs) {
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    const shortfall = amount.minus(liquid(state, itemId).plus(bound)).toNumber();
    if (!(shortfall > 0)) continue;
    const net = itemRates.get(itemId)?.net ?? 0;
    if (!(net > FLOW_TOLERANCE)) continue;
    const ms = (shortfall / net) * 1000;
    if (ms > worstMs) {
      worstMs = ms;
      slowest = itemId;
    }
  }
  return slowest;
}
```

In `payable`, replace the drained-payer return:

```ts
      const drained = drainedPayer(walk, costs);
      return drained === null
        ? current
        : { kind: "reserve", itemId: drained, percent: RESERVE_ADVICE_PERCENT, limitingTarget: answer.limitingTarget };
```

with:

```ts
      const drained = drainedPayer(walk, costs);
      if (drained !== null) {
        return { kind: "reserve", itemId: drained, percent: RESERVE_ADVICE_PERCENT, limitingTarget: answer.limitingTarget };
      }
      // Spec 2026-10-14: payable, but a payer is too slow to get there soon. Advise one
      // more machine for it, and price that through this same loop. One redirect per
      // payer (`visited`), and none when its recipe is not live.
      const slow = slowPayer(walk, costs);
      if (slow === null || visited.has(slow)) return current;
      const recipeId = activeRecipeOf(state.activeRecipe, slow);
      if (recipeId === undefined || !isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) return current;
      visited.add(slow);
      current = { kind: "recipe", recipeId, limitingTarget: answer.limitingTarget, machinesToClear: 1 };
      continue;
```

Also update `payable`'s doc comment with one sentence about the slow-payer step.

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
| `if (slow === null \|\| visited.has(slow)) return current;` → `return current;` | "redirects to the slow payer's recipe" |
| in `slowPayer`, set `worstMs` to `0` | "leaves the advice alone when the payer affords it within the horizon" |

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts
git commit -m "Advise production for a payer too slow to afford the purchase soon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 2: Gate, re-pin, record

**Files:**
- Modify: `apps/sim/src/gate-cli.ts` (bottleneck entry)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§4.5 amendment)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` (bottleneck item 1)
- Modify: `docs/superpowers/specs/2026-10-14-slow-payer-advice-design.md` (Status)

**Interfaces:**
- Consumes: Task 1's commit.

- [ ] **Step 1: Full suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
```

Expected: green. A sim test that pinned `bottleneck`'s stall gets reported, not edited.

- [ ] **Step 2: Gate with pins emitted**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=${CLAUDE_JOB_DIR:-/tmp}/slow-payer; mkdir -p "$S"
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate.out 2>&1; echo "exit $?" >> $S/gate.out
```

Expected, per the spec's prototype:
- **`greedy` and `casual`:** identical to the committed pins. If either moves at all, STOP and report BLOCKED.
- **`bottleneck`:** "reached tier 10"; tiers 1–6 unchanged; tiers 7–9 about 1.3573, 1.7369 and 2.4785; tier 10 about 12.4274; dead time about 0.61.

- [ ] **Step 3: Re-pin `bottleneck`**

In `VERTICAL_SLICE_GATE`'s bottleneck entry:
- remove `reachesTier: 9`;
- update the moved tier values from the emitted block;
- add a tier-10 pin with the emitted value, a `why` giving the target (25) and the miss, and noting that `bottleneck` now finishes tier 10 because of slow-payer advice;
- on every moved pin, change the trailing re-measure sentence to `Re-measured 2026-10-14 after the reporter advised production for slow payers.`;
- rewrite the comment above the entry, which describes the tier-9 stall and its 22.6 h beam wait: say it is fixed (2026-10-14, slow-payer advice), and give the new dead time.

Then re-run the gate without `--emit-pins` and confirm exit 0 with no findings.

- [ ] **Step 4: Docs**

- **§4.5:** in `docs/superpowers/specs/2026-09-01-engine-core-design.md`, after the 2026-10-13 drained-payer amendment, insert the spec's "The §4.5 amendment" text, without the `> ` prefixes.
- **The handoff:** in `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` item 1 (the `bottleneck` regression), add a dated line saying the 12th-rig beam wait is fixed by slow-payer advice. Include the measured tier 10 and dead time, and that `bottleneck` now finishes all ten tiers.
- **The spec's Status:** `**Status:** implemented 2026-10-14.`

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add apps/sim/src/gate-cli.ts docs
git commit -m "Re-pin bottleneck now that it finishes tier 10

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

The report gives:
- the gate's time;
- every moved pin (old → new);
- confirmation that `greedy` and `casual` are identical;
- `bottleneck`'s dead time.
