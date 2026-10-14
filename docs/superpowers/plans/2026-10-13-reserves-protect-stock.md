# Reserves Protect Stock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reserve banks its share even when consumers would drain the item, and keeps that stock away from consumers. The bottleneck reporter advises a reserve when a purchase is priced in a drained item, and `bottleneck` follows the advice.

**Architecture:**
- **Task 1 (engine):** three rules in `packages/engine/src/solve/waterfall.ts`.
  - Reserve entries are never R32 candidates.
  - Every walk treats reserved items as pinned EMPTY.
  - `effectivePriority` injects no reserve for a FULL item.
- **Task 2 (advice):**
  - a `reserve` advice kind emitted by `payable` in `bottleneck.ts`;
  - the `bottleneck` policy following and clearing it;
  - the status display and run classification;
  - docs, then the gate and re-pinning.

**Tech Stack:** TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-13-reserves-protect-stock-design.md`

## Global Constraints

- Work in `.claude/worktrees/phase-1-engine`, branch `reserves-protect-stock`. It is cut from `tier10-structural` (PR #8), whose `bottleneck` stall this addresses. Never work in the top-level checkout.
- `packages/engine` is pure: no `Date`, `performance`, `Math.random` or `Math.pow` outside the existing display exemptions (lint-enforced).
- Nothing may change when no reserve is set. `greedy` and `casual` gate pins must stay byte-identical, since neither ever reserves.
- The advised percent is exactly `0.25`, as a named constant.
- Never run `pnpm format`. Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another in the foreground, never during a gate run. Never `pgrep -f` a pattern that matches your own wait loop.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **R32's re-runs** (`runPasses` with an alternate pin set) must also include the reserved items, or a re-run would let consumers draw reserved stock and mis-judge R32's verdict. Covered by Task 1: the walk change applies to both vector builders.
- **An advice loop.** An item already reserved and still not growing must not be advised again. Covered by Task 2's reporter test.
- **Exhaustiveness.** Every `switch`/chain on `Bottleneck["kind"]` must handle `"reserve"`. Covered by the typecheck, plus the explicit `run.ts` case in Task 2 (a ternary chain the compiler does not check).
- **Reserves a human set by hand** in `sim play` are also cleared by `bottleneck`'s cleanup, but only when `bottleneck` is the policy driving. No change to `sim play`'s manual mode. Stated in the code comment.
- **The 10th-rig stall** stays out of scope (spec). It is recorded, not fixed.

---

### Task 1: The engine — a reserve protects the stock it banks

**Files:**
- Modify: `packages/engine/src/solve/waterfall.ts` (`effectivePriority`; `runWaterfall`'s vector building and R32 candidate loop)
- Test: `packages/engine/src/solve/waterfall.test.ts` (append one `describe`)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§C.3 amendment, text in the spec's "The §C.3 amendment")

**Interfaces:**
- Produces: no new exports. Behaviour changes only when a `reserve:` entry with `targetRate > 0` is live.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/solve/waterfall.test.ts`. It already imports `runWaterfall`, `effectivePriority`, `computeCapacity`, `initialWorld` and the `entry`/`base`/`vectorsFor` helpers. Add `D` from `../numbers/decimal.js` and `liquidCap` from `../economy/storage.js` if they are not imported.

```ts
// Spec 2026-10-13 (reserves protect stock). A reserve is "divert a share of this
// target's output to storage rather than to consumers" (original 4.1). R32 used to give
// a reserve on an item its consumers would drain 0, and consumers drew whatever it
// banked straight back out of stock.
describe("runWaterfall — a reserve protects the stock it banks", () => {
  const reserve = (itemId: string, targetRate: number): PriorityEntry => ({
    id: `reserve:${itemId}`,
    kind: "item",
    itemId,
    mode: "guaranteed",
    share: 1,
    targetRate,
    paused: false,
  });

  it("banks its share even when the item's consumers would drain it", () => {
    // iron_ingot pinned EMPTY; plate's walk would drain any ingot stock (0.5/s at one
    // constructor unit) faster than the reserve's 0.2/s refills it, so R32 used to
    // disqualify the reserve.
    const state = base();
    const capacity = computeCapacity(content, state);
    const result = runWaterfall({
      content,
      vectors: vectorsFor(state),
      activeRecipe: state.activeRecipe,
      capacityUnits: capacity.unitsByRecipe,
      entries: [reserve("iron_ingot", 0.2), entry("iron_plate")],
      pinnedEmpty: ALL_EMPTY,
      reserveFloor: 0,
    });
    expect(result.entries.find((e) => e.entryId === "reserve:iron_ingot")!.allocated).toBeCloseTo(0.2, 9);
  });

  it("makes other entries walk through a reserved item's recipe, not its stock", () => {
    // iron_ingot has stock, so it is NOT pinned EMPTY: without a reserve, plate's walk
    // draws ingot from stock and never touches smelt_iron.
    const state = base();
    const capacity = computeCapacity(content, state);
    const run = (entries: PriorityEntry[]) =>
      runWaterfall({
        content,
        vectors: vectorsFor(state),
        activeRecipe: state.activeRecipe,
        capacityUnits: capacity.unitsByRecipe,
        entries,
        pinnedEmpty: new Set(["iron_ore"]),
        reserveFloor: 0,
      });
    // Precondition: without a reserve, plate does not use the smelters.
    expect(run([entry("iron_plate")]).allocations.get("smelt_iron")?.get("item:iron_plate") ?? 0).toBe(0);
    // With a reserve on iron_ingot, plate must make its ingot through smelt_iron.
    const reserved = run([reserve("iron_ingot", 0.2), entry("iron_plate")]);
    expect(reserved.allocations.get("smelt_iron")?.get("item:iron_plate") ?? 0).toBeGreaterThan(0);
  });

  it("injects no reserve for an item that is FULL", () => {
    const start = base();
    const capacity = computeCapacity(content, start);
    const withReserve: WorldState = { ...start, reserve: { ...start.reserve, iron_ingot: 0.25 } };
    // Precondition: not FULL, the reserve is injected.
    expect(effectivePriority(content, withReserve, capacity, 0).some((e) => e.id === "reserve:iron_ingot")).toBe(true);
    const full: WorldState = {
      ...withReserve,
      quantum: { ...withReserve.quantum, iron_ingot: liquidCap(content, withReserve, "iron_ingot") },
    };
    expect(effectivePriority(content, full, capacity, 0).some((e) => e.id === "reserve:iron_ingot")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/waterfall.test.ts 2>&1 | grep -E "×|Tests |expected"
```

Expected: all three new tests fail, each on its main assertion. Each **precondition** must pass. If a precondition fails, or a main assertion already passes, STOP and report: the fixture does not reproduce the spec's measured shape, and the test needs a different setup. Do not weaken the assertion.

- [ ] **Step 3: Implement**

In `effectivePriority` (`waterfall.ts`), inside the reserves loop, right after `if (percent <= 0) continue;`, add:

```ts
    // Spec 2026-10-13: nowhere to bank into. Without this a reserve would claim a FULL
    // item's recipe, the FULL sweep would stop it, and every consumer walking through
    // that recipe (rule below) would get nothing.
    if (itemStateTag(content, state, itemId) === "FULL") continue;
```

Add `import { itemStateTag } from "../economy/storage.js";` to the imports.

In `runWaterfall`, immediately after `const live = entries.filter((entry) => !entry.paused);`, add:

```ts
  // Spec 2026-10-13 (reserves protect stock): while an item has an active reserve, every
  // walk treats it as pinned EMPTY, drawing through its recipe rather than from its
  // stock, so the stock the reserve banks stays banked. With no reserve set this is the
  // identity, and nothing changes.
  const reservedItems = new Set<ItemId>();
  for (const entry of live) {
    if (entry.id.startsWith("reserve:") && entry.itemId !== null && (entry.targetRate ?? 0) > 0) {
      reservedItems.add(entry.itemId);
    }
  }
  const withReserved = (pins: ReadonlySet<ItemId>): ReadonlySet<ItemId> =>
    reservedItems.size === 0 ? pins : new Set([...pins, ...reservedItems]);
```

In the initial `vectorOf` loop, change the `requirementVector(..., pinnedEmpty, memo)` argument to `withReserved(pinnedEmpty)`. Compute it once before the loop (`const walkPins = withReserved(pinnedEmpty);`) and pass `walkPins`, so the shared `memo` stays valid.

In `runPasses`'s fresh-vector branch, change the `pinnedEmptyForPass` argument to `requirementVector` likewise: compute `const passPins = withReserved(pinnedEmptyForPass);` once before that loop and pass `passPins`.

In R32's candidate loop, right after `if (entry.mode !== "guaranteed" || entry.itemId === null) continue;`, add:

```ts
      // Spec 2026-10-13: a reserve's whole job is to bank; R32 must never stop it.
      if (entry.id.startsWith("reserve:")) continue;
```

- [ ] **Step 4: Run them to verify they pass, then the engine suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/waterfall.test.ts 2>&1 | grep -E "×|Tests "
npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: all pass. The engine suite is 396 plus 3.

- [ ] **Step 5: Mutation-check**

Make each edit, run the waterfall tests, confirm the named test fails, then undo the edit by hand:

| edit | must fail |
|---|---|
| delete the R32 `reserve:` skip | "banks its share even when…" |
| make `withReserved` return `pins` unconditionally | "makes other entries walk through…" |
| delete the FULL `continue` in `effectivePriority` | "injects no reserve for an item that is FULL" |

- [ ] **Step 6: §C.3 amendment**

In `docs/superpowers/specs/2026-09-01-engine-core-design.md` §C.3, after the last existing `**Amended …**` paragraph in §C.3 (before the `**Bottleneck** returns` paragraph), insert the spec's "The §C.3 amendment" blockquote text as a paragraph. Remove the `> ` prefixes.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
git add packages/engine/src/solve/waterfall.ts packages/engine/src/solve/waterfall.test.ts docs/superpowers/specs/2026-09-01-engine-core-design.md
git commit -m "Let a reserve bank past R32 and keep its stock from consumers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 2: Reserve advice, `bottleneck` follows it, re-pin

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts` (`Bottleneck` type, `priceOf`, `payable`)
- Test: `packages/engine/src/solve/bottleneck.test.ts`
- Modify: `apps/sim/src/policies.ts` (`bottleneck` policy)
- Test: `apps/sim/src/policies.test.ts`
- Modify: `apps/sim/src/commands.ts` (`renderStatus`, plus any other switch on `kind`)
- Test: `apps/sim/src/commands.test.ts`
- Modify: `apps/sim/src/run.ts` (binding-constraint key)
- Modify: `apps/sim/src/gate-cli.ts` (bottleneck pins)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§4.5 amendment, §E.2 note)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` (item 1, the 10th-rig follow-up)
- Modify: `docs/superpowers/specs/2026-10-13-reserves-protect-stock-design.md` (Status)

**Interfaces:**
- Consumes: Task 1's engine behaviour.
- Produces:
  - `Bottleneck` gains `| { kind: "reserve"; itemId: ItemId; percent: number; limitingTarget: string }`;
  - `export const RESERVE_ADVICE_PERCENT = 0.25` from `bottleneck.ts`.

- [ ] **Step 1: Write the failing tests**

`packages/engine/src/solve/bottleneck.test.ts`, appended:

```ts
// Spec 2026-10-13 (reserves protect stock): a purchase priced in an item whose stock is
// short and not growing can never be paid while consumers take every unit made. The
// advice becomes a reserve on that item.
describe("computeBottleneck — a drained payer gets a reserve", () => {
  const start = initialWorld(content, 1, 0);
  const sol = solve(start, content, NO_FLOOR);
  const advise = (state: WorldState, net: number) => {
    const rates = new Map(sol.itemRates);
    for (const [itemId] of priceItems) rates.set(itemId, { production: 0, consumption: 0, net });
    return computeBottleneck(content, sol.capacity, sol.entries, sol.power, state, sol.itemStates, rates);
  };
  // What the fresh fixture's advice costs: its machine's build cost items.
  const firstAdvice = computeBottleneck(content, sol.capacity, sol.entries, sol.power, start, sol.itemStates, sol.itemRates);
  const priceItems: [string, unknown][] = (() => {
    if (firstAdvice?.kind !== "recipe") return [];
    const recipe = content.recipes.get(firstAdvice.recipeId)!;
    return [...machineCostRange(content, recipe.machineClass, 1, 0, 1)];
  })();

  it("names a reserve on the payer when it is short and not growing", () => {
    // Preconditions: the fresh fixture advises a machine, priced in something it holds
    // too little of.
    expect(firstAdvice?.kind).toBe("recipe");
    expect(priceItems.length).toBeGreaterThan(0);
    expect(advise(start, 0)).toMatchObject({
      kind: "reserve",
      itemId: priceItems[0]![0],
      percent: RESERVE_ADVICE_PERCENT,
      limitingTarget: firstAdvice!.limitingTarget,
    });
  });

  it("leaves the advice alone when the payer is growing", () => {
    expect(advise(start, 0.5)).toMatchObject({ kind: "recipe" });
  });

  it("does not advise a reserve twice for the same payer", () => {
    const reserved: WorldState = {
      ...start,
      reserve: Object.fromEntries(priceItems.map(([itemId]) => [itemId, 0.25])),
    };
    expect(advise(reserved, 0)).toMatchObject({ kind: "recipe" });
  });
});
```

(Import `RESERVE_ADVICE_PERCENT` from `./bottleneck.js` and `type WorldState` if not already imported. `machineCostRange` and `solve` are already imported. If the fresh fixture's first advice is not `kind: "recipe"`, STOP and report: pick a state that advises a machine and say which.)

`apps/sim/src/policies.test.ts`, appended:

```ts
describe("bottleneck and reserve advice (spec 2026-10-13)", () => {
  const advice = { kind: "reserve", itemId: "iron_ingot", percent: 0.25, limitingTarget: "item:iron_plate" } as const;

  it("sets the reserve it is advised to", () => {
    const base = rich();
    const ctx: PolicyContext = { ...base, solution: { ...base.solution, bottleneck: advice } };
    expect(getPolicy("bottleneck").decide(ctx)).toContainEqual({ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0.25 });
  });

  it("clears a reserve the advice no longer names", () => {
    const base = rich();
    const state: WorldState = { ...base.state, reserve: { ...base.state.reserve, iron_ingot: 0.25 } };
    const solution = solve(state, content);
    // Precondition: the advice is not a reserve on iron_ingot.
    expect(solution.bottleneck).not.toMatchObject({ kind: "reserve", itemId: "iron_ingot" });
    expect(getPolicy("bottleneck").decide({ ...base, state, solution })).toContainEqual({
      type: "SET_RESERVE",
      itemId: "iron_ingot",
      percent: 0,
    });
  });

  it("is the only policy that ever reserves", () => {
    const base = rich();
    const ctx: PolicyContext = { ...base, solution: { ...base.solution, bottleneck: advice } };
    for (const name of ["greedy", "casual", "optimal"] as const) {
      expect(getPolicy(name).decide(ctx).some((a) => a.type === "SET_RESERVE")).toBe(false);
    }
  });
});
```

(Import `type WorldState` from `@manufactory/engine` if not already imported.)

`apps/sim/src/commands.test.ts`, inside `describe("status and lane views", ...)`, appended (mirroring the existing storage-advice tests):

```ts
  it("renders reserve advice as a share to set aside", () => {
    const base = session();
    const s: Session = {
      ...base,
      solution: {
        ...base.solution,
        bottleneck: { kind: "reserve", itemId: "steel_pipe", percent: 0.25, limitingTarget: "item:heavy_modular_frame" },
      },
    };
    expect(renderStatus(s).join("\n")).toContain(
      "BOTTLENECK  reserve 25% of steel_pipe so it can bank toward item:heavy_modular_frame",
    );
  });
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
(cd packages/engine && npx vitest run src/solve/bottleneck.test.ts 2>&1 | grep -E "×|Tests |Error")
(cd apps/sim && npx vitest run src/policies.test.ts src/commands.test.ts 2>&1 | grep -E "×|Tests |Error")
```

Expected: the new tests fail. The type errors and the missing `RESERVE_ADVICE_PERCENT` export count as failures here.

- [ ] **Step 3: Implement the reporter**

In `bottleneck.ts`:
- Add the `reserve` member to the `Bottleneck` union, with a comment citing the spec.
- Add `export const RESERVE_ADVICE_PERCENT = 0.25;` with a one-line comment: measured on the slice, under the 50% maximum.
- In `priceOf`, add `case "reserve": return null;`, since setting a reserve costs nothing.
- Add a helper:

```ts
/**
 * Spec 2026-10-13: an item a purchase is priced in whose stock (plus bound) is short of
 * the price, whose net rate is not positive, and which has no reserve yet. Its consumers
 * take every unit made, so the purchase can never be paid until something banks it. An
 * item already reserved and still not growing is not named again: the reserve is not
 * helping, and naming it again would loop.
 */
function drainedPayer(walk: WalkContext, costs: ReadonlyMap<ItemId, Dec>): ItemId | null {
  const { state, itemRates } = walk;
  for (const [itemId, amount] of costs) {
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    if (liquid(state, itemId).plus(bound).gte(amount)) continue;
    if ((Object.hasOwn(state.reserve, itemId) ? state.reserve[itemId]! : 0) > 0) continue;
    if ((itemRates.get(itemId)?.net ?? 0) > FLOW_TOLERANCE) continue;
    return itemId;
  }
  return null;
}
```

(Use the tolerance constant the file already uses for "held" rates if there is one, e.g. the gridlock walk's. Otherwise import `FLOW_TOLERANCE` from `./fixpoint.js`, after checking that does not create an import cycle; if it would, define a local `1e-9` with a comment. `liquid` and `D` are already imported in this file; check.)

- In `payable`, change `if (payer === null) return current;` to:

```ts
    if (payer === null) {
      // The price fits the cap. Spec 2026-10-13: it may still never be payable, if a
      // consumer drains the item it is priced in.
      const drained = drainedPayer(walk, costs);
      return drained === null
        ? current
        : { kind: "reserve", itemId: drained, percent: RESERVE_ADVICE_PERCENT, limitingTarget: answer.limitingTarget };
    }
```

- [ ] **Step 4: Implement the policy, status and run key**

In `apps/sim/src/policies.ts`, `bottleneck.decide`, right after `const report = ctx.solution.bottleneck;`, add:

```ts
    // Spec 2026-10-13: a reserve lasts only while the reporter asks for it. Clear every
    // other reserve, including one a human set by hand if this policy is driving.
    const clears: Action[] = [];
    for (const [itemId, percent] of Object.entries(ctx.state.reserve)) {
      if (percent > 0 && !(report?.kind === "reserve" && report.itemId === itemId)) {
        clears.push({ type: "SET_RESERVE", itemId, percent: 0 });
      }
    }
    if (report?.kind === "reserve") {
      const already = (Object.hasOwn(ctx.state.reserve, report.itemId) ? ctx.state.reserve[report.itemId]! : 0) === report.percent;
      return already ? [...moves, ...clears] : [...moves, ...clears, { type: "SET_RESERVE", itemId: report.itemId, percent: report.percent }];
    }
```

Then make every later `return moves` / `return [...moves, ...]` in that function also include `...clears`, immediately after `moves`. Change `if (report === null) return moves;` accordingly.

In `apps/sim/src/commands.ts` `renderStatus`, add a branch before the storage branches:

```ts
  } else if (bottleneck.kind === "reserve") {
    lines.push(
      `BOTTLENECK  reserve ${Math.round(bottleneck.percent * 100)}% of ${bottleneck.itemId} ` +
        `so it can bank toward ${bottleneck.limitingTarget}`,
    );
```

Also fix any other `switch`/`case` on bottleneck kind in `commands.ts` (around line 515) that the typecheck flags; give `"reserve"` the same wording.

In `apps/sim/src/run.ts`, where `bound` is derived from `bottleneck.kind`, add an explicit reserve case before the power fallback: `bottleneck.kind === "reserve" ? \`reserve:${bottleneck.itemId}\` : …`.

- [ ] **Step 5: Run the tests to verify they pass; then the full suite, lint and typecheck**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
(cd packages/engine && npx vitest run src/solve/bottleneck.test.ts 2>&1 | grep -E "×|Tests ")
(cd apps/sim && npx vitest run src/policies.test.ts src/commands.test.ts 2>&1 | grep -E "×|Tests ")
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
```

Expected: all green.

- [ ] **Step 6: Mutation-check**

| edit | must fail |
|---|---|
| in `payable`, always `return current` when `payer === null` | "names a reserve on the payer…" |
| in `drainedPayer`, delete the existing-reserve `continue` | "does not advise a reserve twice…" |
| in `bottleneck.decide`, drop `...clears` everywhere | "clears a reserve the advice no longer names" |

- [ ] **Step 7: Gate and re-pin**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=${CLAUDE_JOB_DIR:-/tmp}/reserves; mkdir -p "$S"
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate.out 2>&1; echo "exit $?" >> $S/gate.out
```

Compare the emitted pins with `VERTICAL_SLICE_GATE`:
- **`greedy` or `casual` moving at all:** STOP and report. They never reserve, so Task 1's identity guarantee would be broken.
- **`bottleneck`:** re-pin the moved values. Keep the `why` texts, and record the new stall point and cause.
  - The spec expects the last purchase near 6.6 collections, still `reachesTier: 9`.
  - Find the advice at the new stall the same way as the PR #8 probe: run `bottleneck` and read its last binding constraints. Write what you find into the comment.

Re-run without `--emit-pins` and confirm exit 0 with no findings.

- [ ] **Step 8: Docs**

- **§4.5:** in `docs/superpowers/specs/2026-09-01-engine-core-design.md`, after the 2026-10-10 payable-advice amendment, insert the spec's "The §4.5 amendment" text, without the `> ` prefixes.
- **§E.2:** under the table, add one line: `**Amended 2026-10-13:** bottleneck also follows reserve advice (SET_RESERVE), and clears a reserve once the advice no longer names it; no other policy reserves.`
- **The handoff:** in `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` item 1 (the bottleneck regression), add a dated line:
  - the drained-payer stall is fixed by reserve advice (stall moved from ~3.49 to the new value);
  - the new stall is the next follow-up: name it with what Step 7 found, e.g. the 10th assembly rig at 102,400 `smart_plating` + 102,400 `encased_industrial_beam`.
- **The spec's Status:** `**Status:** implemented 2026-10-13.`

- [ ] **Step 9: Commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
git add packages/engine/src/solve apps/sim/src docs
git commit -m "Advise a reserve for a drained payer, and have bottleneck follow it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

The report gives:
- the gate's time;
- every moved pin (old → new);
- confirmation that `greedy` and `casual` are byte-identical;
- `bottleneck`'s new stall point, with its advice.
