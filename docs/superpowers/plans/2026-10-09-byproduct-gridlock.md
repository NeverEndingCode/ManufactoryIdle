# Byproduct-gridlock walk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before the bottleneck reporter names a recipe, check whether a FULL output is holding that recipe at its drain rate; if so, walk forward to the consumer that is missing, too slow, or blocked further on, or name storage when nothing consumes the item.

**Architecture:** All new logic lives in `packages/engine/src/solve/bottleneck.ts`: a `WalkContext` bundling what the walk reads, and three helpers (`heldAtCap`, `heldOutputOf`, `drainBlocker`) behind one trigger, `jamBlocker`, called at every recipe-shaped return. `computeBottleneck` gains one parameter, `itemRates`, fed from `items.pass.flows` at its single call site in `solve.ts`. No new `Bottleneck` kind, no solver change.

**Tech Stack:** TypeScript (ESM), vitest, pnpm workspaces. Engine package `@manufactory/engine`; content bundles under `packages/content/bundles/`.

**Spec:** `docs/superpowers/specs/2026-10-09-byproduct-gridlock-design.md` -- read it, including the "Refinements found while planning" section, which supersedes the earlier rules where they differ.

## Global Constraints

- Work in the worktree `.claude/worktrees/phase-1-engine`, branch `worktree-phase-2-content`. The top-level checkout's `main` is stale.
- **Never run `pnpm format`.** It rewrites ~69 files. Match surrounding style by hand.
- **Never run `pnpm lint` / `pnpm typecheck` while any test run is going.** Turbo rewrites `dist/` underneath them. Run checks serially.
- Run tests per package with `npx vitest run` from the package directory, not through turbo.
- Typecheck one package: `npx tsc -p packages/engine/tsconfig.json --noEmit` (from the worktree root). Lint touched files: `npx eslint <files>`.
- The engine is pure (spec A.5): no `Date`, `performance`, `Math.random` under `packages/engine/`. The lint rule enforces it.
- **Do not push.** The pacing gate is re-pinned once, after the per-policy budget work that follows this plan (agreed 2026-10-09). Commit locally only.
- Every commit message ends with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Comment density and voice: match `bottleneck.ts` -- comments say *why*, cite the measurement that motivated a rule, and name what would go wrong without it.

## Review Focus

Inputs the spec implies but its acceptance list does not exercise, most likely to bite first. Each has a test in the task that owns it.

1. **Float noise on a held item's net rate** (e.g. `net = -1e-12`): must count as held, or the walk flickers on and off between solves. Test in Task 1 (`tolerance`).
2. **A FULL item that is genuinely draining** (`net` clearly negative): must NOT trigger the walk; today's advice stands. Test in Task 1 (T3b).
3. **The requirement item is itself one of the recipe's outputs** (always true for its own active recipe): the walk must skip it and still inspect the recipe's other outputs, or a held byproduct listed after the primary output is never seen. Covered by `visited` containing the target; T1 exercises it (plastic is `refine_plastic`'s first output, residue its second).
4. **The waterfall names a recipe that is running fine** (zero-ratio tie-break): the target's own active recipe must be checked first. T1 and the priority-scan test exercise it (`limitedBy` is `extract_oil` at clock 1).
5. **A cycle in the walk** (an item reached twice): must terminate and fall back to storage. The real-content termination test (existing) runs the walk at every tier of the vertical slice, whose content includes a genuine SCC.

---

## File Structure

- Modify `packages/engine/src/solve/bottleneck.ts` -- the walk, its trigger, and the four call sites. Stays one file: every helper is private to the reporter and they change together.
- Modify `packages/engine/src/solve/solve.ts:121-128` -- pass `items.pass.flows` as the new last argument.
- Modify `packages/engine/src/solve/bottleneck.test.ts` -- new `describe("the gridlock walk")` block (Task 1) and three tests for the other call sites (Task 2).
- Modify `docs/superpowers/specs/2026-09-01-engine-core-design.md` -- the §4.5 amendment (Task 3).
- Modify `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` -- close item 8b, update item 1 (Task 3).

---

### Task 1: The walk, wired into the milestone branch

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts`
- Modify: `packages/engine/src/solve/solve.ts:121-128`
- Test: `packages/engine/src/solve/bottleneck.test.ts`

**Interfaces:**
- Consumes: `FLOW_TOLERANCE` and `type ItemFlow` from `packages/engine/src/solve/fixpoint.ts` (both already exported). `content.consumersOf: Map<ItemId, RecipeId[]>` (built in bundle order, which is `content.recipeIds` order).
- Produces (all module-private in `bottleneck.ts` unless noted):
  - `interface WalkContext { content: IndexedContent; capacity: CapacityTable; state: WorldState; itemStates: ReadonlyMap<ItemId, ItemStateTag>; itemRates: ReadonlyMap<ItemId, ItemFlow> }`
  - `function jamBlocker(walk: WalkContext, recipeIds: readonly (RecipeId | null | undefined)[], limitingTarget: string, visited: Set<ItemId>): Bottleneck` -- returns `null` when no listed recipe has a held output outside `visited`.
  - `resolveBlocker(walk: WalkContext, entries: readonly EntryAllocation[], itemId: ItemId, targetId: ItemId, visited: Set<ItemId>): Bottleneck` -- replaces the old 8-parameter signature.
  - **Exported, changed:** `computeBottleneck(content, capacity, entries, power, state, itemStates, itemRates: ReadonlyMap<ItemId, ItemFlow>): Bottleneck` -- new last parameter.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/solve/bottleneck.test.ts`. Add `computeBottleneck` to the imports from `./bottleneck.js` (add the import line `import { computeBottleneck } from "./bottleneck.js";` if none exists) -- it is used by the tolerance test.

```ts
describe("the gridlock walk", () => {
  // Measured 2026-10-09 on the vertical slice: at tier 6 the oil lane gridlocked --
  // fuel had no consumer, residue filled, and the FULL sweep held both refineries at
  // clock 0 -- while the reporter kept naming refine_rubber. `bottleneck` bought 50
  // refineries into it. The fixture's oil lane is the same chain in miniature:
  //   extract_oil -> crude_oil -> refine_plastic -> plastic + heavy_oil_residue
  //   (byproduct) -> residual_fuel -> fuel -> burn_fuel (unlocks at tier 3)
  // The grid is raised so no setup browns out and lands in the power branch instead.
  const oilContent = (milestoneTier: number | null) =>
    indexContent({
      ...fixtureBundle,
      baseGridCapacityMw: 100_000,
      milestones:
        milestoneTier === null
          ? []
          : [
              {
                tier: milestoneTier,
                name: "Plastics",
                requires: [{ item: "plastic", amount: 100 }],
                laneMultipliers: {},
              },
            ],
    });

  interface OilMachines {
    extract_oil?: number;
    refine_plastic?: number;
    residual_fuel?: number;
    burn_fuel?: number;
  }

  function oilWorld(c: ReturnType<typeof oilContent>, tier: number, m: OilMachines): WorldState {
    const extract = m.extract_oil ?? 0;
    const refineries = (m.refine_plastic ?? 0) + (m.residual_fuel ?? 0);
    const generators = m.burn_fuel ?? 0;
    let w: WorldState = { ...initialWorld(c, 1, 0), tier };
    if (extract > 0) w = withInstalled(w, "oil", "extractor", 1, extract);
    if (refineries > 0) w = withInstalled(w, "oil", "refinery", 1, refineries);
    if (generators > 0) w = withInstalled(w, "oil", "generator", 1, generators);
    return {
      ...w,
      assignment: {
        ...w.assignment,
        extract_oil: extract,
        refine_plastic: m.refine_plastic ?? 0,
        residual_fuel: m.residual_fuel ?? 0,
        burn_fuel: generators,
      },
    };
  }

  /** Residue and fuel at cap, refineries stopped: the slice's gridlock. */
  function gridlocked(milestoneTier: number, tier: number) {
    const c = oilContent(milestoneTier);
    let w = oilWorld(c, tier, { extract_oil: 1, refine_plastic: 1, residual_fuel: 1 });
    w = atCap(atCap(w, "heavy_oil_residue"), "fuel");
    return { c, w, sol: solve(w, c, NO_FLOOR) };
  }

  it("names storage for the item nothing drains, past the byproduct it fills", () => {
    const { sol } = gridlocked(3, 2);
    // Preconditions: the gridlock is real -- residue and fuel held at cap, both
    // refinery recipes stopped -- and the waterfall blames extract_oil, a recipe
    // running at full clock (the zero-ratio tie-break), so only checking the
    // target's OWN recipe can see the jam.
    expect(sol.itemStates.get("heavy_oil_residue")).toBe("FULL");
    expect(sol.itemStates.get("fuel")).toBe("FULL");
    expect(sol.itemRates.get("heavy_oil_residue")!.net).toBe(0);
    expect(sol.clocks.get("refine_plastic")).toBe(0);
    expect(sol.clocks.get("residual_fuel")).toBe(0);
    expect(sol.entries.find((e) => e.itemId === "plastic")!.limitedBy).toBe("extract_oil");

    const b = sol.bottleneck;
    if (b === null || b.kind !== "storage") throw new Error(`expected storage, got ${JSON.stringify(b)}`);
    expect(b.itemId).toBe("fuel");
    // Still "what is stopping your plastic", not "what is wrong with fuel".
    expect(b.limitingTarget).toBe("item:plastic");
    expect(b.upgrade).not.toBeNull();
  });

  it("names the drain when it is unlocked but unbuilt", () => {
    // Tier 3 unlocks burn_fuel, and the fixture's only generator recipe is the
    // active power recipe, so it is live -- with zero machines.
    const { c, w, sol } = gridlocked(4, 3);
    expect(isLiveRecipe(c, "burn_fuel", w.tier, w.activeRecipe)).toBe(true);
    expect(sol.capacity.unitsByRecipe.get("burn_fuel") ?? 0).toBe(0);
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "burn_fuel",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("names the drain that cannot keep up", () => {
    // Eight plastic refineries emit residue faster than one residual_fuel plant
    // takes it, so residue is held at cap while fuel flows freely.
    const c = oilContent(3);
    let w = oilWorld(c, 2, { extract_oil: 3, refine_plastic: 8, residual_fuel: 1 });
    w = atCap(w, "heavy_oil_residue");
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.itemStates.get("heavy_oil_residue")).toBe("FULL");
    expect(sol.itemRates.get("heavy_oil_residue")!.net).toBe(0);
    expect(sol.itemStates.get("fuel")).not.toBe("FULL");
    expect(sol.clocks.get("residual_fuel")).toBe(1);
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "residual_fuel",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("leaves a FULL item that is draining alone", () => {
    // One refinery each way: residue starts at cap but residual_fuel takes it far
    // faster than refine_plastic makes it, so nothing is throttled.
    const c = oilContent(3);
    let w = oilWorld(c, 2, { extract_oil: 1, refine_plastic: 1, residual_fuel: 1 });
    w = atCap(w, "heavy_oil_residue");
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.itemStates.get("heavy_oil_residue")).toBe("FULL");
    expect(sol.itemRates.get("heavy_oil_residue")!.net).toBeLessThan(0);
    expect(sol.clocks.get("refine_plastic")).toBe(1);
    // Exactly the advice this branch gave before the walk existed.
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "refine_plastic",
      limitingTarget: "item:plastic",
      machinesToClear: 3,
    });
  });

  it("treats float noise on a held item's rate as held (tolerance)", () => {
    const { c, w, sol } = gridlocked(3, 2);
    const withResidueNet = (net: number) =>
      computeBottleneck(
        c,
        sol.capacity,
        sol.entries,
        sol.power,
        w,
        sol.itemStates,
        new Map([...sol.itemRates, ["heavy_oil_residue", { production: 0, consumption: 0, net }]]),
      );
    expect(withResidueNet(-1e-12)).toMatchObject({ kind: "storage", itemId: "fuel" });
    // Clearly draining: no walk, so the advice falls back to the waterfall's name.
    expect(withResidueNet(-0.5)).toMatchObject({ kind: "recipe", recipeId: "extract_oil" });
  });
});
```

Add `isLiveRecipe` to the file's imports: `import { indexContent, isLiveRecipe } from "../graph/index-content.js";` (replacing the existing `indexContent` import).

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/engine`): `npx vitest run src/solve/bottleneck.test.ts -t "gridlock walk"`
Expected: the T3b test ("leaves a FULL item that is draining alone") PASSES -- it pins today's behaviour. The other four FAIL: the first two with `expected storage` / a `recipe extract_oil` result, the third with `refine_plastic` and `machinesToClear: 6`, the tolerance test on its first assertion. If any precondition `expect` fails instead, stop: the fixture no longer produces the gridlock and the test needs a new setup, not a code change.

- [ ] **Step 3: Implement the walk**

In `packages/engine/src/solve/bottleneck.ts`, add to the imports:

```ts
import { FLOW_TOLERANCE, type ItemFlow } from "./fixpoint.js";
```

Insert after `cheaperUpgrade` (before the `resolveBlocker` doc comment):

```ts
/** What the gridlock walk reads. Bundled because every helper below needs all five. */
interface WalkContext {
  content: IndexedContent;
  capacity: CapacityTable;
  state: WorldState;
  itemStates: ReadonlyMap<ItemId, ItemStateTag>;
  itemRates: ReadonlyMap<ItemId, ItemFlow>;
}

/**
 * FULL and held there: the FULL sweep is scaling this item's producers to its drain
 * rate. FULL alone is not enough -- measured on the fixture, residue at cap with one
 * refinery feeding it and one residual-fuel plant drawing it nets -0.833/s and runs
 * both at clock 1. A draining tank throttles nothing. The tolerance is the solver's
 * own, so float noise on a held item reads as held rather than flickering.
 */
function heldAtCap(walk: WalkContext, itemId: ItemId): boolean {
  if (walk.itemStates.get(itemId) !== "FULL") return false;
  return (walk.itemRates.get(itemId)?.net ?? 0) >= -FLOW_TOLERANCE;
}

/**
 * The first output of `recipeId` -- byproducts included, in authored order -- that is
 * held at its cap, skipping anything already in `exclude`. `exclude` is how the
 * requirement item itself is never treated as a jam: it is always its own recipe's
 * output, it is always in the walk's `visited` set, and a FULL requirement is already
 * answered by storage for it. Skipping rather than stopping matters: residue is
 * `refine_plastic`'s SECOND output, after the plastic the player asked for.
 */
function heldOutputOf(
  walk: WalkContext,
  recipeId: RecipeId,
  exclude: ReadonlySet<ItemId>,
): ItemId | null {
  const recipe = walk.content.recipes.get(recipeId);
  if (!recipe) return null;
  for (const itemId of recipe.outputPerSecond.keys()) {
    if (itemId === POWER_ITEM || exclude.has(itemId)) continue;
    if (heldAtCap(walk, itemId)) return itemId;
  }
  return null;
}

/**
 * What would drain `itemId`, which is held at its cap. Consumers are taken in
 * `content.consumersOf` order, which is bundle order, so the answer is deterministic.
 * A consumer with no machines is named first among equals because a drain is
 * permanent and storage only postpones the next fill. `machinesToClear` is 1 on every
 * answer here: `machinesToClearRecipe` closes a gap to a waterfall runner-up, and a
 * drain has no runner-up; the caller re-solves after buying, the argument the
 * zero-capacity and storage branches already make.
 */
function drainBlocker(
  walk: WalkContext,
  itemId: ItemId,
  limitingTarget: string,
  visited: Set<ItemId>,
): NonNullable<Bottleneck> {
  visited.add(itemId);
  const { content, capacity, state } = walk;
  for (const consumerId of content.consumersOf.get(itemId) ?? []) {
    if (!isLiveRecipe(content, consumerId, state.tier, state.activeRecipe)) continue;
    if ((capacity.unitsByRecipe.get(consumerId) ?? 0) <= 0) {
      return { kind: "recipe", recipeId: consumerId, limitingTarget, machinesToClear: 1 };
    }
    const next = heldOutputOf(walk, consumerId, visited);
    // Running and nothing downstream is full: it is simply too slow for what it drains.
    if (next === null) {
      return { kind: "recipe", recipeId: consumerId, limitingTarget, machinesToClear: 1 };
    }
    return drainBlocker(walk, next, limitingTarget, visited);
  }
  // Nothing live consumes it -- the vertical slice's `fuel` at tier 6 -- or every
  // consumer leads back into the walk. Storage is the only purchase that moves it.
  return {
    kind: "storage",
    itemId,
    limitingTarget,
    upgrade: cheaperUpgrade(content, state, itemId),
  };
}

/**
 * The trigger, called before any recipe-shaped advice. For each listed recipe in
 * order, if one of its outputs is held at cap, buying that recipe cannot help -- the
 * FULL sweep holds it at the drain rate -- so walk forward from that output instead.
 * Callers list the target item's OWN active recipe before the one they would name:
 * measured on the fixture gridlock, the waterfall's `limitedBy` for `plastic` is
 * `extract_oil`, running at clock 1, by the zero-ratio tie-break `resolveBlocker`
 * documents, and only `refine_plastic` -- the recipe actually making plastic -- shows
 * the jam.
 */
function jamBlocker(
  walk: WalkContext,
  recipeIds: readonly (RecipeId | null | undefined)[],
  limitingTarget: string,
  visited: Set<ItemId>,
): Bottleneck {
  for (const recipeId of recipeIds) {
    if (recipeId === null || recipeId === undefined) continue;
    const held = heldOutputOf(walk, recipeId, visited);
    if (held !== null) return drainBlocker(walk, held, limitingTarget, visited);
  }
  return null;
}
```

Replace `resolveBlocker`'s signature and body. New signature (the `targetId` JSDoc stays where it is; delete the `content`, `capacity`, `state`, `itemStates` parameters):

```ts
function resolveBlocker(
  walk: WalkContext,
  entries: readonly EntryAllocation[],
  itemId: ItemId,
  /** ...existing targetId JSDoc, unchanged... */
  targetId: ItemId,
  visited: Set<ItemId>,
): Bottleneck {
  if (visited.has(itemId)) return null;
  visited.add(itemId);
  const { content, capacity, state, itemStates } = walk;
  const limitingTarget = `item:${targetId}`;
```

Then, in the body:
- Every `` `item:${targetId}` `` becomes `limitingTarget`.
- The zero-capacity branch returns `jamBlocker(walk, [recipeId], limitingTarget, visited) ?? { ...the existing object literal... }`.
- Between the FULL-target storage branch and `const entry = entries.find(...)`, nothing changes. Immediately after `const entry = ...`, insert:

```ts
  // Before trusting the waterfall's name for this blocker, check that neither the
  // recipe making the target nor the one about to be named is held by a full output.
  const jam = jamBlocker(walk, [recipeId, entry?.limitedBy], limitingTarget, visited);
  if (jam !== null) return jam;
```

Update the `visited` paragraph of `resolveBlocker`'s doc comment: delete "so the guard is currently dormant, not load-bearing. It is kept anyway, at no cost, because ruling R6 keeping the live subgraph acyclic today is a property of content, not a guarantee, should recursion return." and replace it with: "The gridlock walk (`drainBlocker`) shares the same set, and there it IS load-bearing: it is what bounds the forward walk at one visit per item, and what keeps the requirement item itself from ever being walked from."

In `computeBottleneck`: add the parameter `itemRates: ReadonlyMap<ItemId, ItemFlow>,` after `itemStates`. As the first statement after `const firstLimited = ...`, add:

```ts
  const walk: WalkContext = { content, capacity, state, itemStates, itemRates };
```

and change the milestone loop's call to:

```ts
      const blocker = resolveBlocker(walk, entries, requirement.item, requirement.item, visited);
```

In `packages/engine/src/solve/solve.ts`, the `computeBottleneck(` call (lines 121-128) gains `items.pass.flows,` as its last argument, after `items.pass.itemStates,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/engine`): `npx vitest run src/solve/bottleneck.test.ts`
Expected: all tests in the file PASS, including the existing milestone and storage tests.

- [ ] **Step 5: Mutation-check each guard**

For each mutation below: make it, run `npx vitest run src/solve/bottleneck.test.ts -t "gridlock walk"`, confirm the named test fails, then restore the line exactly (`git diff` on the file must show only the Task 1 changes afterwards).

| mutation | must fail |
|---|---|
| in `heldAtCap`, return `true` right after the FULL check (drop the net test) | "leaves a FULL item that is draining alone" |
| in `heldAtCap`, compare `>= 0` instead of `>= -FLOW_TOLERANCE` | "treats float noise ... (tolerance)" |
| in `resolveBlocker`'s jam call, pass `[entry?.limitedBy]` (drop `recipeId`) | "names storage for the item nothing drains ..." |
| in `drainBlocker`, delete the zero-capacity `return` | "names the drain when it is unlocked but unbuilt" |
| in `drainBlocker`, replace the `next === null` return with `continue` | "names the drain that cannot keep up" |

- [ ] **Step 6: Run the whole engine suite, then typecheck and lint**

Run (from `packages/engine`): `npx vitest run`
Expected: all test files pass (371 tests before this task, plus 5 new). Then, from the worktree root, serially:
`npx tsc -p packages/engine/tsconfig.json --noEmit` -- expected: no output.
`npx eslint packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts packages/engine/src/solve/solve.ts` -- expected: no output.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts packages/engine/src/solve/solve.ts
git commit -m "Walk forward from a held output before naming its recipe

At tier 6 of the vertical slice the oil lane gridlocks: fuel has no consumer,
residue fills, and the FULL sweep holds both refineries at clock 0, while the
reporter kept naming refine_rubber. bottleneck bought 50 refineries into it.

Before resolveBlocker names a recipe, it now checks the target's own recipe and
the named one for an output held at cap (FULL, net >= -FLOW_TOLERANCE). If one
is, it walks forward: an unbuilt consumer, a consumer too slow to drain, or
storage when nothing live consumes the item. computeBottleneck takes itemRates
for the held test. Wired into the milestone branch here; the priority scan and
the power branch follow.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The priority scan, the power branch, and the named recipe

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts` (`computeBottleneck` only)
- Test: `packages/engine/src/solve/bottleneck.test.ts` (inside the Task 1 `describe("the gridlock walk")` block, reusing `oilContent`, `oilWorld`, `gridlocked`)

**Interfaces:**
- Consumes: `WalkContext`, `jamBlocker(walk, recipeIds, limitingTarget, visited)`, and the `walk` constant in `computeBottleneck`, all from Task 1. `POWER_ITEM` from `../content/types.js`.
- Produces: no new names. Behaviour only.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("the gridlock walk", ...)`. Add `POWER_ITEM` to the test file's imports: `import { POWER_ITEM } from "../content/types.js";`.

```ts
  it("walks from the priority scan too, when no milestone is pending", () => {
    // No milestones, so the reporter falls through to the priority scan. Plastic is
    // moved to the top of the list, as a player who wants plastic would.
    const c = oilContent(null);
    let w = oilWorld(c, 2, { extract_oil: 1, refine_plastic: 1, residual_fuel: 1 });
    w = atCap(atCap(w, "heavy_oil_residue"), "fuel");
    w = {
      ...w,
      priority: [
        ...w.priority.filter((e) => e.itemId === "plastic"),
        ...w.priority.filter((e) => e.itemId !== "plastic"),
      ],
    };
    const sol = solve(w, c, NO_FLOOR);
    const first = sol.entries.find((e) => e.limitedBy !== null)!;
    expect(first.entryId).toBe("item:plastic");
    expect(first.limitedBy).toBe("extract_oil");
    expect(sol.bottleneck).toMatchObject({
      kind: "storage",
      itemId: "fuel",
      limitingTarget: "item:plastic",
    });
  });

  it("checks the recipe it is about to name, not only the target's own", () => {
    // Hand-built, because the named recipe holding a FULL output while the target's
    // own recipe does not is a tie-break artifact no fixture state produces on demand.
    // Crude is held at cap; the waterfall names extract_oil for plastic; refine_plastic
    // (plastic's own recipe) has no held output. The walk from crude names the drain.
    const c = oilContent(3);
    const w = oilWorld(c, 2, { extract_oil: 1, refine_plastic: 1 });
    const sol = solve(w, c, NO_FLOOR);
    const entries = [
      {
        entryId: "item:plastic",
        itemId: "plastic",
        requested: Number.POSITIVE_INFINITY,
        allocated: 0,
        limitedBy: "extract_oil",
        limitingPerUnit: 1,
        runnerUpRate: Number.POSITIVE_INFINITY,
      },
    ];
    const b = computeBottleneck(
      c,
      sol.capacity,
      entries,
      sol.power,
      w,
      new Map([["crude_oil", "FULL" as const]]),
      new Map([["crude_oil", { production: 1, consumption: 1, net: 0 }]]),
    );
    expect(b).toEqual({
      kind: "recipe",
      recipeId: "refine_plastic",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("walks from a starved generator's supplier when that supplier is jammed", () => {
    // Hand-built: neither bundle has a fuel maker with a byproduct, so this shape
    // cannot arise on shipped content yet. The grid browns out with a generator
    // installed, the waterfall blames refine_plastic for the power shortfall, and
    // refine_plastic's residue is held at cap. Naming refine_plastic would buy into
    // a jam; the walk names residual_fuel, which drains residue and is running.
    const c = oilContent(null);
    const w = oilWorld(c, 3, { extract_oil: 1, refine_plastic: 1, residual_fuel: 1, burn_fuel: 1 });
    const sol = solve(w, c, NO_FLOOR);
    expect(sol.capacity.unitsByRecipe.get("burn_fuel") ?? 0).toBeGreaterThan(0);
    const b = computeBottleneck(
      c,
      sol.capacity,
      [
        {
          entryId: "power",
          itemId: POWER_ITEM,
          requested: 400,
          allocated: 0,
          limitedBy: "refine_plastic",
          limitingPerUnit: 1,
          runnerUpRate: Number.POSITIVE_INFINITY,
        },
      ],
      { demandMw: 200, fullDemandMw: 400, supplyMw: 200, ratio: 0.5, passes: 1 },
      w,
      new Map([["heavy_oil_residue", "FULL" as const]]),
      new Map([["heavy_oil_residue", { production: 1, consumption: 1, net: 0 }]]),
    );
    expect(b).toEqual({
      kind: "recipe",
      recipeId: "residual_fuel",
      limitingTarget: "power",
      machinesToClear: 1,
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/engine`): `npx vitest run src/solve/bottleneck.test.ts -t "gridlock walk"`
Expected: the five Task 1 tests PASS. "walks from the priority scan" FAILS (got `recipe extract_oil`). "walks from a starved generator's supplier" FAILS (got `recipe refine_plastic`). "checks the recipe it is about to name" PASSES already -- the milestone branch's jam call from Task 1 lists `entry?.limitedBy`; this test pins that half, and its mutation check is in Step 5.

- [ ] **Step 3: Implement the two remaining call sites**

In `computeBottleneck`, move `const walk: WalkContext = ...` (added in Task 1) above the power branch if it is not already there -- it must be defined before the `if (power.ratio < 1 - 1e-9)` block.

In the power branch's starved-generator block (the `if (live !== null && ... powerEntry.limitedBy !== live)` added on 2026-10-09), immediately after `const starvedBy = powerEntry.limitedBy;` insert:

```ts
      // The supplier can itself be held by a full output; naming it would then buy
      // into a jam. No shipped fuel maker has a byproduct yet, so this is defence for
      // content, pinned by a hand-built test rather than a measured stall.
      const jam = jamBlocker(walk, [starvedBy], powerEntry.entryId, new Set<ItemId>());
      if (jam !== null) return jam;
```

In the priority-scan tail, immediately before the final `return { kind: "recipe", recipeId: firstLimited.limitedBy, ... }`, insert:

```ts
  // The same gridlock check the milestone branch makes, with the scanned item standing
  // in for the requirement: in `visited` from the start, so it is never walked from.
  const jam = jamBlocker(
    walk,
    [activeRecipeOf(activeRecipe, firstLimited.itemId), firstLimited.limitedBy],
    firstLimited.entryId,
    new Set<ItemId>([firstLimited.itemId]),
  );
  if (jam !== null) return jam;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `packages/engine`): `npx vitest run src/solve/bottleneck.test.ts`
Expected: all PASS.

- [ ] **Step 5: Mutation-check**

Same procedure as Task 1 Step 5.

| mutation | must fail |
|---|---|
| delete the priority-scan `if (jam !== null) return jam;` | "walks from the priority scan too ..." |
| delete the power branch's `if (jam !== null) return jam;` | "walks from a starved generator's supplier ..." |
| in `resolveBlocker`'s jam call, pass `[recipeId]` (drop `entry?.limitedBy`) | "checks the recipe it is about to name ..." |

- [ ] **Step 6: Run the engine suite, the sim suite, typecheck, lint -- serially**

From `packages/engine`: `npx vitest run` -- expected: all pass.
From `apps/sim`: `npx vitest run` -- expected: all pass (~10 minutes; 189 tests before this plan). `policies.test.ts` exercises the `bottleneck` policy on the fixture; if a test there fails, read what it asserts before touching it -- it may be pinning advice the walk now correctly changes, in which case update the assertion and say why in a comment, or it may have found a defect.
Then from the worktree root: `npx tsc -p packages/engine/tsconfig.json --noEmit` and `npx tsc -p apps/sim/tsconfig.json --noEmit` -- expected: no output. `npx eslint packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts` -- expected: no output.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts
git commit -m "Run the gridlock walk from the priority scan and the power branch

The priority scan had the same gap as the milestone branch: with plastic first
in priority and the oil lane jammed, it named extract_oil. It now checks the
scanned item's own recipe and the named one, as resolveBlocker does. The power
branch's starved-generator advice gets the same check on the supplier it names,
pinned by a hand-built test, since no shipped fuel maker has a byproduct yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Measure on the vertical slice, and record it

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (after the "Amended 2026-09-19" block, around line 701)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`

**Interfaces:**
- Consumes: the finished walk from Tasks 1-2. Two throwaway scripts and saved checkpoints in the session scratchpad, `SCRATCH=/tmp/claude-1000/-home-nec-Code-Manufactorty-Idle/36bcc901-3574-48ce-acb4-54f223421a5d/scratchpad`: `$SCRATCH/step-from.mts` (resumes the `bottleneck` policy from a checkpoint and prints the reporter's advice, purchases, and milestone requirements per step) and `$SCRATCH/cps-patched/tier-6-step-80.json` (the gridlocked state from the spec's table). Neither is committed.
- Produces: measured numbers for the handoff. No code.

- [ ] **Step 1: Confirm the advice on the measured stall**

From `apps/sim`:

```bash
npx tsx $SCRATCH/step-from.mts "$(cd ../.. && pwd)" $SCRATCH/cps-patched/tier-6-step-80.json 12 1
```

Expected: step 0 prints `bn={"kind":"storage","itemId":"fuel","limitingTarget":"item:rubber",...}` (the spec's prediction; before this plan it printed `refine_rubber`), and within the 12 steps `rubber`'s `net` leaves 0 after the policy buys fuel storage. Record the first step where rubber's net is positive and the rubber amount at step 11.

If step 0 prints anything else, stop and compare against the spec's walk on the probe numbers in the spec's table before changing code.

- [ ] **Step 2: Run the policy further from tier 6**

```bash
npx tsx $SCRATCH/step-from.mts "$(cd ../.. && pwd)" $SCRATCH/cps-patched/tier-6.json 400 40 > $SCRATCH/after-walk.out 2>&1
```

This takes several minutes (steps slow as the factory grows). Record: whether `tier=` reaches 7, the advice (`bn=`) at each sampled step, and what binds at the last sample. A new stall is an expected outcome, not a failure: the spec's acceptance does not require reaching tier 10.

- [ ] **Step 3: Add the §4.5 amendment**

In `docs/superpowers/specs/2026-09-01-engine-core-design.md`, after the paragraph block that starts `**Amended 2026-09-19 (Phase 2): the scan is milestone-first.**` and its following paragraphs, add the amendment text from the design spec's "The §4.5 amendment" section verbatim, followed by one sentence: "The trigger is FULL **and held** (net ≥ −`FLOW_TOLERANCE`), and checks the target's own active recipe before the recipe the branch would name; see `specs/2026-10-09-byproduct-gridlock-design.md`."

- [ ] **Step 4: Update the handoff**

In `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`:
- In the blockquote under item 1 (starts `> **Investigated 2026-10-09; three causes`), change cause (2)'s "Designed in" sentence to "FIXED -- the forward walk (`specs/2026-10-09-byproduct-gridlock-design.md`)." and append the Step 1-2 measurements: the step where rubber's net left zero, and whether and where `bottleneck` stalls next.
- In item 8, second bullet (starts `**The milestone branch checks FULL on the requirement item only`), prefix: "**CLOSED 2026-10-09** by the gridlock walk, which checks every output of the recipe it would name." Leave the original text below it.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-01-engine-core-design.md docs/superpowers/plans/2026-09-16-phase-2-handoff.md
git commit -m "Record the gridlock walk in spec 4.5 and what it measured

<one paragraph: the advice on the step-80 state, the step rubber started moving,
and where bottleneck goes from tier 6 now -- the numbers from Steps 1-2>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Replace the angle-bracket line with the measured paragraph before committing.

---

## After this plan

Per the sequencing agreed on 2026-10-09, the next plan is the pacing gate's per-policy day budget plus running gate policies in parallel (handoff "Follow-ups" section). One full gate run and `--emit-pins` re-pin then covers the power-branch fix, this walk, and the budget together, and only then is the branch pushed.
