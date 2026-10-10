# Payable advice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every answer the bottleneck reporter returns names a purchase that can eventually be paid for: when a cost exceeds its item's liquid cap, the reporter names storage for that payer instead.

**Architecture:** All logic in `packages/engine/src/solve/bottleneck.ts`. The current `computeBottleneck` body is renamed `adviseBottleneck` (unchanged); a new exported `computeBottleneck` with the same signature calls it and passes the answer through one final step, `payable`, which prices the implied purchase and steps back through payers while a cost overflows. `cheaperUpgrade` prefers an upgrade that fits. No new `Bottleneck` kind, no solver or policy change.

**Tech Stack:** TypeScript (ESM), vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-10-payable-advice-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/phase-1-engine`, branch `worktree-phase-2-content`.
- **Never run `pnpm format`.** Match surrounding style by hand.
- **Never run `pnpm lint` / `pnpm typecheck` while any test run is going.** Run checks serially.
- Run tests per package with `npx vitest run` from the package directory, not through turbo.
- Typecheck: `npx tsc -p packages/engine/tsconfig.json --noEmit`, `npx tsc -p apps/sim/tsconfig.json --noEmit` (from the worktree root). Lint touched files: `npx eslint <files>`.
- The engine is pure (spec A.5): no `Date`, `performance`, `Math.random` under `packages/engine/`.
- Do not push.
- Every commit message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE`
- Comments say *why*, cite the measurement behind a rule, match `bottleneck.ts`'s voice.
- Never use bare `git stash`.

## Review Focus

Inputs the spec implies but its acceptance list does not exercise, most likely to bite first. Each has a test in Task 1.

1. **Power advice for a generator whose next machine overflows** a payer's cap: must redirect like recipe advice, keeping `limitingTarget: "power"`. Test: "names payer storage for a generator it can never pay for".
2. **A cost exactly equal to the cap** fits (`>` not `>=`): a player holding exactly the cost can pay. Test: the boundary case inside "leaves advice the player can afford later alone".
3. **Unaffordable now, within the cap** must be unchanged -- waiting for income is the right advice. Test: "leaves advice the player can afford later alone".
4. **A payer whose own upgrades also overflow** must end at `upgrade: null`, not loop. Test: "ends at no upgrade when nothing anywhere fits".
5. **Gridlock-walk answers** (storage for `fuel`, a drain recipe) pass through the same step. The existing gridlock tests keep their expectations, since the fixture's 50/500 `iron_plate` level costs fit under 1,500.

---

## File Structure

- Modify `packages/engine/src/solve/bottleneck.ts` -- pricing helpers, `payable`, `cheaperUpgrade`'s filter, the rename and wrapper.
- Modify `packages/engine/src/solve/bottleneck.test.ts` -- new `describe("payable advice")`.
- Modify `docs/superpowers/specs/2026-09-01-engine-core-design.md` -- §4.5 amendment (Task 2).
- Modify `apps/sim/src/gate-cli.ts` -- re-pin `bottleneck` (Task 2).
- Modify `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` and the design spec's Status line (Task 2).

---

### Task 1: Price every answer, and step back to a payer that fits

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts`
- Test: `packages/engine/src/solve/bottleneck.test.ts`

**Interfaces:**
- Consumes (all existing): `liquidCap(content, state, itemId): Dec` from `../economy/storage.js`; `levelCostRange(curve, level, levels)` and `machineCostRange(content, machineClass, mark, fromCount, count): Map<ItemId, Dec>` from `../economy/curves.js`; `bestUnlockedMark(content, machineClass, tier): number | null` from `../economy/capacity.js`; `installedAt(state, lane, machineClass, mark): number` from `../state/world.js`; `WalkContext` and `cheaperUpgrade` already in `bottleneck.ts`.
- Produces: `computeBottleneck` -- same exported signature as today, now returning payable advice. Module-private: `overflowingPayer`, `upgradeCost`, `machinePrice`, `priceOf`, `payable`, `adviseBottleneck`.

- [ ] **Step 1: Write the failing tests**

Add `liquidCap` to the existing `../economy/storage.js` import in `bottleneck.test.ts`, and add `import { levelCostRange, machineCostRange } from "../economy/curves.js";`. Append:

```ts
describe("payable advice", () => {
  // Measured 2026-10-10 on the vertical slice: `bottleneck` stalled at tier 7 told to
  // buy a Quantum Storage level costing 4,473 iron_plate while iron_plate could hold
  // 4,000. Purchases are paid from liquid stock (ruling R7), so that advice could never
  // be followed. One iron_plate storage level, 90, was the way out.
  //
  // Fixture numbers these tests stand on: iron_plate's liquid cap is 1,500 at storage
  // and QS level 0; storage levels cost 50 * 1.5^L iron_plate, Quantum Storage levels
  // 500 * 1.55^L. The grid is raised so no setup reaches the power branch by accident.
  const variant = (over: Partial<typeof fixtureBundle>) =>
    indexContent({
      ...fixtureBundle,
      baseGridCapacityMw: 100_000,
      milestones: [
        {
          tier: 3,
          name: "Plastics",
          requires: [{ item: "plastic", amount: 100_000 }],
          laneMultipliers: {},
        },
      ],
      ...over,
    });

  /** One extractor and one refinery on refine_plastic, so plastic's recipe has capacity
   *  and a FULL plastic reaches the storage branch rather than the zero-machines one. */
  function oilWorld(c: ReturnType<typeof variant>, refineries = 1): WorldState {
    let w: WorldState = { ...initialWorld(c, 1, 0), tier: 2 };
    w = withInstalled(w, "oil", "extractor", 1, 2 * refineries);
    w = withInstalled(w, "oil", "refinery", 1, refineries);
    return {
      ...w,
      assignment: { ...w.assignment, extract_oil: 2 * refineries, refine_plastic: refineries },
    };
  }

  const withLevels = (
    w: WorldState,
    storage: Record<string, number>,
    qs: Record<string, number>,
  ): WorldState => ({
    ...w,
    storageLevel: { ...w.storageLevel, ...storage },
    qsLevel: { ...w.qsLevel, ...qs },
  });

  const cost = (m: Map<string, { toNumber(): number }>, item: string) => m.get(item)!.toNumber();

  it("names storage for the payer when the advised level costs more than it can hold", () => {
    const c = variant({});
    let w = withLevels(oilWorld(c), { plastic: 9 }, { oil: 3 });
    w = atCap(w, "plastic");
    // Preconditions: both of plastic's next levels overflow iron_plate's cap.
    const ironCap = liquidCap(c, w, "iron_plate").toNumber();
    expect(ironCap).toBe(1500);
    expect(cost(levelCostRange(c.bundle.storage, 9, 1), "iron_plate")).toBeGreaterThan(ironCap);
    expect(cost(levelCostRange(c.bundle.quantumStorage, 3, 1), "iron_plate")).toBeGreaterThan(ironCap);

    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      // Still "what is stopping your plastic".
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });
  });

  it("picks the dearer upgrade when the cheaper one can never be paid for", () => {
    // Quantum Storage paid in heavy_oil_residue, which can hold 500: its 600 level is
    // cheaper than storage's 854 iron_plate, and can never be bought.
    const c = variant({
      quantumStorage: { ...fixtureBundle.quantumStorage, baseCostItem: "heavy_oil_residue", baseCostAmount: 600 },
    });
    let w = withLevels(oilWorld(c), { plastic: 7 }, {});
    w = atCap(w, "plastic");
    expect(liquidCap(c, w, "heavy_oil_residue").toNumber()).toBe(500);
    expect(cost(levelCostRange(c.bundle.quantumStorage, 0, 1), "heavy_oil_residue")).toBe(600);
    expect(cost(levelCostRange(c.bundle.storage, 7, 1), "iron_plate")).toBeLessThanOrEqual(1500);

    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "plastic",
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });
  });

  it("names payer storage for a machine it can never pay for", () => {
    // Refinery #31 costs 3,595 iron_plate against a cap of 1,500 -- the refinery-#51
    // shape the gridlock spec set aside.
    const c = variant({ milestones: [{ tier: 3, name: "Plastics", requires: [{ item: "plastic", amount: 100 }], laneMultipliers: {} }] });
    const w = oilWorld(c, 30);
    expect(cost(machineCostRange(c, "refinery", 1, 30, 1), "iron_plate")).toBeGreaterThan(
      liquidCap(c, w, "iron_plate").toNumber(),
    );
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });
  });

  it("names payer storage for a generator it can never pay for", () => {
    // Hand-built brownout at tier 3, where burn_fuel is the active generator: 25
    // installed, so generator #26 costs 1,725 iron_plate against 1,500.
    const c = variant({ milestones: [] });
    let w: WorldState = { ...initialWorld(c, 1, 0), tier: 3 };
    w = withInstalled(w, "oil", "generator", 1, 25);
    w = { ...w, assignment: { ...w.assignment, burn_fuel: 25 } };
    const sol = solve(w, c, NO_FLOOR);
    const ironCap = liquidCap(c, w, "iron_plate").toNumber();
    expect(sol.capacity.unitsByRecipe.get("burn_fuel") ?? 0).toBeGreaterThan(0);
    expect(cost(machineCostRange(c, "generator", 1, 25, 1), "iron_plate")).toBeGreaterThan(ironCap);
    const b = computeBottleneck(
      c,
      sol.capacity,
      [
        {
          entryId: "power",
          itemId: POWER_ITEM,
          requested: 400,
          allocated: 0,
          // The generator itself, so the branch gives generator advice, not supplier advice.
          limitedBy: "burn_fuel",
          limitingPerUnit: 1,
          runnerUpRate: Number.POSITIVE_INFINITY,
        },
      ],
      { demandMw: 200, fullDemandMw: 400, supplyMw: 200, ratio: 0.5, passes: 1 },
      w,
      sol.itemStates,
      sol.itemRates,
    );
    expect(b).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "power",
      upgrade: "storage",
    });
  });

  it("ends at no upgrade when nothing anywhere fits", () => {
    // Cost curves that outgrow capacity (costGrowth 3): plastic's next levels overflow
    // iron_plate's cap, and so do iron_plate's own.
    const c = variant({
      storage: { ...fixtureBundle.storage, costGrowth: 3 },
      quantumStorage: { ...fixtureBundle.quantumStorage, costGrowth: 3 },
    });
    let w = withLevels(oilWorld(c), { plastic: 6, iron_plate: 6 }, { oil: 3, iron: 3 });
    w = atCap(w, "plastic");
    const ironCap = liquidCap(c, w, "iron_plate").toNumber();
    expect(cost(levelCostRange(c.bundle.storage, 6, 1), "iron_plate")).toBeGreaterThan(ironCap);
    expect(cost(levelCostRange(c.bundle.quantumStorage, 3, 1), "iron_plate")).toBeGreaterThan(ironCap);

    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "item:plastic",
      upgrade: null,
    });
  });

  it("leaves advice the player can afford later alone", () => {
    // Next storage level 380 iron_plate, within the 1,500 cap, with NO iron_plate in
    // stock: waiting for income is the right advice, so it is unchanged.
    const c = variant({});
    let w = withLevels(oilWorld(c), { plastic: 5 }, {});
    w = atCap(w, "plastic");
    w = { ...w, stored: { ...w.stored, iron_plate: D(0) }, quantum: { ...w.quantum, iron_plate: D(0) } };
    expect(solve(w, c, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "plastic",
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });

    // Boundary: a cost EXACTLY equal to the cap fits -- a player holding it can pay. A
    // variant storage curve makes plastic's level-5 cost exactly 1,500 against
    // iron_plate's 1,500 cap, and QS(oil) level 3 (1,862) overflows, so storage is the
    // only upgrade that can fit. With `>=` it would not, and the advice would move to
    // iron_plate.
    const tight = variant({ storage: { ...fixtureBundle.storage, baseCostAmount: 1500 / Math.pow(1.5, 5) } });
    let t = withLevels(oilWorld(tight), { plastic: 5 }, { oil: 3 });
    t = atCap(t, "plastic");
    expect(liquidCap(tight, t, "iron_plate").toNumber()).toBe(1500);
    expect(cost(levelCostRange(tight.bundle.storage, 5, 1), "iron_plate")).toBe(1500);
    expect(cost(levelCostRange(tight.bundle.quantumStorage, 3, 1), "iron_plate")).toBeGreaterThan(1500);
    expect(solve(t, tight, NO_FLOOR).bottleneck).toEqual({
      kind: "storage",
      itemId: "plastic",
      limitingTarget: "item:plastic",
      upgrade: "storage",
    });
  });
});
```

Note on the boundary case: `1500 / 1.5^5` may not reproduce exactly 1,500 through `levelCostRange`'s arithmetic. If `toBe(1500)` fails because the arithmetic lands a hair off 1,500, replace the boundary case with a direct unit check that `overflowingPayer` (exported for the test, see Step 3) treats `amount === cap` as fitting, and say so in the report. Do not loosen `>` to `>=`.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/engine`): `npx vitest run src/solve/bottleneck.test.ts -t "payable advice"`
Expected: FAIL for the first five tests. Today's answers, measured while planning: the first returns `storage plastic upgrade quantum`, the second `storage plastic upgrade quantum`, the third `recipe refine_plastic machinesToClear 780`, the fifth `storage plastic upgrade quantum`; the generator test returns `kind: "power"`. "leaves advice the player can afford later alone" PASSES (it pins unchanged behaviour). If a precondition `expect` fails instead, STOP and report: the fixture no longer produces the state.

- [ ] **Step 3: Implement**

In `packages/engine/src/solve/bottleneck.ts`, extend the imports:

```ts
import { liquid, liquidCap, type ItemStateTag } from "../economy/storage.js";
import { levelCostRange, machineCostRange } from "../economy/curves.js";
import { bestUnlockedMark } from "../economy/capacity.js";
import { installedAt, type WorldState } from "../state/world.js";
```

(`type CapacityTable` stays imported from `../economy/capacity.js`; merge into one import line per module.)

Add, directly above `cheaperUpgrade`:

```ts
/**
 * The first item in `costs` -- in the map's order, which is the curve's or the mark's
 * authored order -- whose amount is more than that item can ever be held, or null if
 * every one fits. Its liquid cap, not its stock: ruling R7 pays from liquid stock, so
 * waiting fixes a shortfall of stock and only storage fixes a cap. `>` and not `>=`: a
 * player holding exactly the cost can pay it.
 */
export function overflowingPayer(
  content: IndexedContent,
  state: WorldState,
  costs: ReadonlyMap<ItemId, Dec>,
): ItemId | null {
  for (const [itemId, amount] of costs) {
    if (amount.gt(liquidCap(content, state, itemId))) return itemId;
  }
  return null;
}

/** What one more level of `upgrade` for `itemId` costs. */
function upgradeCost(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
  upgrade: StorageUpgrade,
): Map<ItemId, Dec> {
  if (upgrade === "storage") {
    return levelCostRange(content.bundle.storage, levelOf(state.storageLevel, itemId), 1);
  }
  const lane = content.items.get(itemId)!.lane;
  return levelCostRange(content.bundle.quantumStorage, levelOf(state.qsLevel, lane), 1);
}
```

(`overflowingPayer` is exported only so a test can pin the boundary if Step 1's note applies; it is not added to `solve/index.ts`.)

Replace `cheaperUpgrade`'s body after the `storageOpen` / `qsOpen` computation with:

```ts
  if (!storageOpen && !qsOpen) return null;
  if (!qsOpen) return "storage";
  if (!storageOpen) return "quantum";

  // Both open. Prefer one whose next level can ever be paid for -- measured on the
  // slice at tier 7, both of packaged_fuel's overflowed iron_plate's 4,000 cap, and on a
  // bundle that pays the two curves in different items the cheaper one can overflow
  // while the dearer fits. When neither fits, the cheaper is still named and the final
  // `payable` step redirects to the payer.
  const storageCost = levelCostRange(content.bundle.storage, storageLevel, 1);
  const qsCost = levelCostRange(content.bundle.quantumStorage, qsLevel, 1);
  const storageFits = overflowingPayer(content, state, storageCost) === null;
  const qsFits = overflowingPayer(content, state, qsCost) === null;
  if (storageFits !== qsFits) return storageFits ? "storage" : "quantum";

  // Each curve names a single cost item, and they need not be the same one, so compare
  // the amounts that are there.
  const total = (costs: Map<ItemId, Dec>): Dec =>
    [...costs.values()].reduce((sum, amount) => sum.plus(amount), D(0));
  return total(qsCost).lt(total(storageCost)) ? "quantum" : "storage";
```

Keep the existing doc comment, and add one sentence to it: "Of the open curves, one whose next level fits under its cost item's liquid cap is preferred over one that never can."

Add, directly above `computeBottleneck`:

```ts
/** The cost of one machine of `recipeId`'s class at the best unlocked mark, or null. */
function machinePrice(
  content: IndexedContent,
  state: WorldState,
  recipeId: RecipeId,
): Map<ItemId, Dec> | null {
  const recipe = content.recipes.get(recipeId);
  if (!recipe) return null;
  const mark = bestUnlockedMark(content, recipe.machineClass, state.tier);
  if (mark === null) return null;
  const owned = installedAt(state, recipe.lane, recipe.machineClass, mark);
  return machineCostRange(content, recipe.machineClass, mark, owned, 1);
}

/**
 * The purchase an answer implies, priced the way the `bottleneck` policy prices it:
 * one level for storage advice, ONE machine for recipe and generator advice (the
 * policy falls back to one when it cannot afford more, so one is what must be
 * possible). Null when the answer implies no purchase.
 */
function priceOf(walk: WalkContext, answer: NonNullable<Bottleneck>): Map<ItemId, Dec> | null {
  const { content, state } = walk;
  switch (answer.kind) {
    case "storage":
      return answer.upgrade === null ? null : upgradeCost(content, state, answer.itemId, answer.upgrade);
    case "recipe":
      return machinePrice(content, state, answer.recipeId);
    case "power":
      return answer.generatorRecipeId === null ? null : machinePrice(content, state, answer.generatorRecipeId);
  }
}

/**
 * The final step every answer passes through (spec §4.5, amended 2026-10-10). A
 * purchase that costs more of some item than that item can be held can never be made,
 * so the advice becomes storage for that payer -- priced the same way, so a payer whose
 * own upgrade overflows steps back again. Measured cause: `bottleneck` stalled at tier 7
 * of the vertical slice told to buy a 4,473 iron_plate Quantum Storage level while
 * iron_plate could hold 4,000; one iron_plate storage level, 90, was the way out.
 * `visited` bounds the steps at one per payer; reaching one twice, or a payer with both
 * curves maxed, ends at `upgrade: null` -- the honest wall, which check 12 makes
 * unreachable at the deepest tier but not before it.
 */
function payable(walk: WalkContext, answer: Bottleneck): Bottleneck {
  if (answer === null) return null;
  const { content, state } = walk;
  const visited = new Set<ItemId>();
  let current: NonNullable<Bottleneck> = answer;
  for (;;) {
    const costs = priceOf(walk, current);
    if (costs === null) return current;
    const payer = overflowingPayer(content, state, costs);
    if (payer === null) return current;
    if (visited.has(payer)) {
      return { kind: "storage", itemId: payer, limitingTarget: answer.limitingTarget, upgrade: null };
    }
    visited.add(payer);
    current = {
      kind: "storage",
      itemId: payer,
      limitingTarget: answer.limitingTarget,
      upgrade: cheaperUpgrade(content, state, payer),
    };
  }
}
```

Rename the existing `export function computeBottleneck(` to `function adviseBottleneck(` (body unchanged), and add after it:

```ts
export function computeBottleneck(
  content: IndexedContent,
  capacity: CapacityTable,
  entries: readonly EntryAllocation[],
  power: PowerReport,
  state: WorldState,
  itemStates: ReadonlyMap<ItemId, ItemStateTag>,
  itemRates: ReadonlyMap<ItemId, ItemFlow>,
): Bottleneck {
  const answer = adviseBottleneck(content, capacity, entries, power, state, itemStates, itemRates);
  return payable({ content, capacity, state, itemStates, itemRates }, answer);
}
```

Update the file header comment (top of `bottleneck.ts`): add one sentence after the existing description: "Every answer is then priced, and one that can never be paid for -- a cost above its item's liquid cap -- becomes storage advice for that payer."

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/engine`): `npx vitest run src/solve/bottleneck.test.ts`
Expected: all PASS, including every existing storage, milestone and gridlock test.

- [ ] **Step 5: Mutation-check each guard**

For each: make it, run `npx vitest run src/solve/bottleneck.test.ts -t "payable advice"`, confirm the named test fails, restore exactly.

| mutation | must fail |
|---|---|
| `computeBottleneck` returns `answer` without `payable` | "names storage for the payer when the advised level costs more..." |
| in `cheaperUpgrade`, delete the `storageFits !== qsFits` line | "picks the dearer upgrade when the cheaper one can never be paid for" |
| in `priceOf`, return `null` for `case "recipe"` | "names payer storage for a machine it can never pay for" |
| in `priceOf`, return `null` for `case "power"` | "names payer storage for a generator it can never pay for" |
| in `payable`, delete the `visited.has(payer)` return | "ends at no upgrade when nothing anywhere fits" (it must fail by timeout or wrong answer, not hang the suite -- run that one test alone with `--testTimeout 5000`) |
| in `overflowingPayer`, `.gt(` -> `.gte(` | the boundary case in "leaves advice the player can afford later alone" (or the direct unit check, if Step 1's note applied) |

- [ ] **Step 6: Run the engine suite, the sim suite, typecheck, lint -- serially**

From `packages/engine`: `npx vitest run` -- expected: all pass (381 before this plan, plus 6).
From `apps/sim`: `npx vitest run` -- expected: all pass (193 before this plan; ~10 minutes). If a `policies.test.ts` test changes, read what it asserts before touching it and report it.
From the worktree root: `npx tsc -p packages/engine/tsconfig.json --noEmit`, `npx tsc -p apps/sim/tsconfig.json --noEmit`, `npx eslint packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts` -- expected: no output.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts
git commit -m "Name a payer's storage when advice can never be paid for

bottleneck stalled at tier 7 of the vertical slice told to buy a Quantum Storage
level costing 4,473 iron_plate while iron_plate could hold 4,000. Purchases are
paid from liquid stock, so it could never be followed. Every answer now passes
through payable(): the implied purchase -- one level, or one machine at the
best unlocked mark -- is priced, and a cost above its item's liquid cap turns
the advice into storage for that payer, stepping back again if that overflows
too, ending at upgrade: null only when nothing fits. cheaperUpgrade prefers an
upgrade that fits over a cheaper one that never can.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE"
```

---

### Task 2: Measure, re-pin the gate, and record it

**Files:**
- Modify: `apps/sim/src/gate-cli.ts` (`VERTICAL_SLICE_GATE`'s `bottleneck` entry)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (after the "Amended 2026-10-09" block)
- Modify: `docs/superpowers/specs/2026-10-10-payable-advice-design.md` (Status line)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`

**Interfaces:**
- Consumes: Task 1's `computeBottleneck`. Throwaway scripts and checkpoints in `SCRATCH=/tmp/claude-1000/-home-nec-Code-Manufactorty-Idle/36bcc901-3574-48ce-acb4-54f223421a5d/scratchpad`: `$SCRATCH/probe-t7.mts` (steps the `bottleneck` policy from a checkpoint and prints milestone requirements, the advice, and the next storage/QS costs) and `$SCRATCH/cps-walk/tier-7.json` (the tier-7 state, saved from a run of the code as of commit ae06198). Not committed.
- Produces: measured numbers and the re-pinned gate.

- [ ] **Step 1: Confirm the advice at the stall**

From `apps/sim`: `npx tsx $SCRATCH/probe-t7.mts "$(cd ../.. && pwd)" $SCRATCH/cps-walk/tier-7.json 120`
Expected: the "after 120 steps" block shows `bottleneck {"kind":"storage","itemId":"iron_plate",...,"limitingTarget":"item:packaged_fuel"...}` or later progress (the policy may now get further within 120 steps, in which case the tier line changes -- record what it shows). Before this plan it showed storage for `packaged_fuel`, upgrade quantum.

- [ ] **Step 2: Run the gate and the pins, in parallel**

From `apps/sim`, both at once: `npm run -s gate > $SCRATCH/gate-pay.out 2> $SCRATCH/gate-pay.err` and `npm run -s gate -- --emit-pins > $SCRATCH/pins-pay.out 2> $SCRATCH/pins-pay.err`. About 15 minutes; progress streams to the `.err` files.
Expected: `greedy` and `casual` tier times unchanged from the current pins (neither reads the reporter). The gate FAILS only on `bottleneck` findings (stale `reachesTier`, tier drift, or a new stall), because its pins describe the old stall. Any finding on `greedy` or `casual` is a defect: stop and report.

- [ ] **Step 3: Re-pin `bottleneck`**

In `apps/sim/src/gate-cli.ts`, replace the `bottleneck` entry's `reachesTier` and `knownRed` from `$SCRATCH/pins-pay.out`'s bottleneck block, keeping the existing entry's style: every tier gets a `why` naming target, measured value and percentage, and the last tier's `why` names where and why it stops (from the gate's finding text and the progress lines). If `bottleneck` now reaches tier 10, delete `reachesTier` and keep only tiers that genuinely miss their target (the "pins only tiers that genuinely miss their target" test enforces that). Update the comment above `reachesTier` with the date and what stops it now.
Then from `apps/sim`: `npx vitest run src/gate.test.ts` -- expected: all pass -- and run `npm run -s gate` once more. Expected: `gate PASSED`.

- [ ] **Step 4: Docs**

- `2026-09-01-engine-core-design.md`: add the amendment text from the design spec's "The §4.5 amendment" section verbatim, as its own block after the whole "Amended 2026-10-09" block (after the line ending that block's last sentence -- do not split a sentence).
- `2026-10-10-payable-advice-design.md`: Status -> "implemented 2026-10-10 (commits <Task 1's SHA> onward)."
- Handoff item 1: add a paragraph after the "Gate-confirmed 2026-10-10" paragraph: the advice at the tier-7 stall is now storage for `iron_plate`, and where `bottleneck` stops next with its binding constraint (from Step 2-3). Retitle item 1 to the new stopping tier.

- [ ] **Step 5: Commit**

```bash
git add apps/sim/src/gate-cli.ts docs/superpowers/specs/2026-09-01-engine-core-design.md docs/superpowers/specs/2026-10-10-payable-advice-design.md docs/superpowers/plans/2026-09-16-phase-2-handoff.md
git commit -m "Re-pin the gate after payable advice, and record where bottleneck stops

<one paragraph: the tier-7 advice now, the tier bottleneck reaches, what stops it,
greedy/casual unchanged, gate PASSED -- numbers from Steps 1-3>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE"
```

Replace the angle-bracket line with the measured paragraph before committing.
