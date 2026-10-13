# Milestone-Aware Bottleneck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bottleneck reporter name what blocks the next milestone instead of what limits throughput of the top priority item, so `bottleneck` stops advising a player with 2.3M iron plate and no assemblers to buy more miners.

**Architecture:** One new branch in `computeBottleneck`, between the power branch and the existing priority scan, plus a recursive `resolveBlocker` helper. No new `Bottleneck` kind — a recipe with zero machines genuinely IS the binding constraint, so `kind: "recipe"` already says it. Reporter-only: the waterfall, priority semantics and allocation are untouched, so no recalibration.

**Tech Stack:** TypeScript, vitest, pnpm workspaces. Engine package is pure (no content import).

**Spec:** `docs/superpowers/specs/2026-09-19-milestone-aware-bottleneck-design.md`

## Global Constraints

- **Determinism (spec A.5):** iterate in authored order everywhere — milestone `requires` order, and `inputPerSecond` key order (a Map, insertion-ordered from the authored recipe). Never sort by a float, never iterate a Set built from unordered input.
- **No floats added (spec E.4):** the walk introduces no arithmetic. Do not call `Math.pow`, `exp` or `log` anywhere in it.
- **Engine purity (spec A.2):** `packages/engine` must not import from `@manufactory/content`. Everything the walk needs is already on `IndexedContent`.
- **Never run `pnpm format`** — it rewrites ~69 files and buries the diff.
- **Never run `pnpm lint` or `pnpm typecheck` while `pnpm test` is running** — turbo rewrites `dist/` underneath them and produces failures that do not reproduce.
- Run engine tests with `cd packages/engine && npx vitest run` (per-package `npx vitest`, not `pnpm test` through turbo).

---

### Task 1: Milestone branch and the zero-capacity blocker

This is the task that fixes the observed stall. `resolveBlocker` starts minimal — only the zero-capacity branch — and Task 2 adds the rest.

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts`
- Test: `packages/engine/src/solve/bottleneck.test.ts`
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§4.5 amendment)
- Modify: `docs/superpowers/specs/2026-09-19-milestone-aware-bottleneck-design.md` (one correction)

**Interfaces:**
- Consumes: `IndexedContent.milestoneByTier: Map<number, MilestoneDef>`, `MilestoneDef.requires: { item: ItemId; amount: number }[]`, `CapacityTable.unitsByRecipe: Map<RecipeId, number>`, `liquid(state, itemId): Dec` from `../economy/storage.js`, `isLiveRecipe(content, recipeId, tier, activeRecipe): boolean`.
- Produces: `resolveBlocker(content, capacity, entries, state, itemStates, itemId, targetId, visited): Bottleneck` — module-private, used only by `computeBottleneck`. `itemId` is where the walk currently is; `targetId` is the milestone requirement it started from and is what every returned `limitingTarget` names. Task 2 extends its body.

- [ ] **Step 1: Write the failing tests**

Add to `packages/engine/src/solve/bottleneck.test.ts`. First add this line directly below the existing `const content = indexContent(loadBundleDir(fixtureDir));`:

```typescript
const fixtureBundle = loadBundleDir(fixtureDir);
```

Then append this block to the end of the file:

```typescript
// Phase 2, 2026-09-19. `bottleneck` stalled at tier 1 of the vertical slice for 120
// simulated days holding 2,307,820 iron_plate and 430,367 screw, owning zero
// assemblers, needing 200 reinforced_iron_plate -- and was told to buy three iron ore
// miners. Two causes: the scan ranked by authored priority, and a target with no
// machines reports `limitedBy: null`, so it was invisible to a scan looking for
// limited entries.
describe("the milestone branch", () => {
  // refine_plastic unlocks at tier 2 and the fixture's start machines are all iron,
  // so at tier 2 this recipe is LIVE and has exactly zero machines -- the shape of
  // the stall, reproduced on a bundle that solves instantly.
  const plasticMilestone = indexContent({
    ...fixtureBundle,
    milestones: [
      { tier: 3, name: "Plastics", requires: [{ item: "plastic", amount: 100 }], laneMultipliers: {} },
    ],
  });

  it("names the recipe of a milestone item that nothing is making", () => {
    const state = { ...initialWorld(plasticMilestone, 1, 0), tier: 2 };
    const sol = solve(state, plasticMilestone, NO_FLOOR);
    // Precondition: the recipe really is live-with-no-machines, not merely locked.
    expect(sol.capacity.unitsByRecipe.get("refine_plastic") ?? 0).toBe(0);
    expect(sol.bottleneck).toEqual({
      kind: "recipe",
      recipeId: "refine_plastic",
      limitingTarget: "item:plastic",
      machinesToClear: 1,
    });
  });

  it("falls back to the priority scan when every requirement is met", () => {
    const base = initialWorld(plasticMilestone, 1, 0);
    // 150 plastic against a requirement of 100, and under the 200 storage cap so the
    // item is not FULL either. The milestone branch must decline entirely.
    const state = {
      ...base,
      tier: 2,
      stored: { ...base.stored, plastic: D(150) },
    };
    const sol = solve(state, plasticMilestone, NO_FLOOR);
    // The authored priority list starts at iron_plate, so a working fallback names
    // that. Without the fallback this would still be talking about plastic.
    expect(sol.bottleneck?.limitingTarget).toBe("item:iron_plate");
  });
});
```

Add `D` and `initialWorld` to the existing imports if not already present. The file already imports `initialWorld`; add `D`:

```typescript
import { D } from "../numbers/decimal.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/engine && npx vitest run src/solve/bottleneck.test.ts -t "milestone branch"`

Expected: FAIL. The first test names `mine_iron` (or whatever limits `iron_plate`) with `limitingTarget: "item:iron_plate"` instead of `refine_plastic`, because the priority scan runs and `iron_plate` is priority[0].

- [ ] **Step 3: Add the walk and the milestone branch**

In `packages/engine/src/solve/bottleneck.ts`, extend the existing import from `../economy/storage.js` to bring in `liquid` alongside the existing `type ItemStateTag`:

```typescript
import { liquid, type ItemStateTag } from "../economy/storage.js";
```

Add this function directly above `export function computeBottleneck`:

```typescript
/**
 * What is stopping `itemId`, or null if nothing is.
 *
 * `visited` is shared across one call's whole sweep rather than reset per
 * requirement: an item that returned null once returns null again, so sharing is
 * exact and saves re-walking a chain two requirements have in common. It is also
 * what bounds the walk -- ruling R6 keeps in-cycle recipes from ever being live, so
 * the live subgraph is acyclic today, but a set is a cheaper guarantee than a
 * property of content that a later phase may relax.
 */
function resolveBlocker(
  content: IndexedContent,
  capacity: CapacityTable,
  entries: readonly EntryAllocation[],
  state: WorldState,
  itemStates: ReadonlyMap<ItemId, ItemStateTag>,
  itemId: ItemId,
  /**
   * The milestone requirement this walk started from. Every blocker reports it as
   * `limitingTarget`, NOT the item the walk happens to have reached: the advice has
   * to read "this is what is stopping the thing you need", not name an intermediate
   * the player never asked for. The blocker's own identity travels in `recipeId` or
   * `itemId`, so both halves are still recoverable.
   */
  targetId: ItemId,
  visited: Set<ItemId>,
): Bottleneck {
  if (visited.has(itemId)) return null;
  visited.add(itemId);

  const recipeId = activeRecipeOf(state.activeRecipe, itemId);
  if (recipeId === undefined) return null;
  // A locked recipe is not advice. The player cannot buy a machine for a recipe that
  // has not unlocked, and `unitsByRecipe` only carries live recipes, so without this
  // guard every locked recipe downstream would read as a zero-capacity blocker.
  if (!isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) return null;

  // Zero machines is not "limited" -- nothing is constraining it, it has no capacity
  // at all, and its waterfall entry reports `limitedBy: null`. That is exactly why
  // the priority scan could never name it.
  if ((capacity.unitsByRecipe.get(recipeId) ?? 0) <= 0) {
    return {
      kind: "recipe",
      recipeId,
      limitingTarget: `item:${targetId}`,
      // One, deliberately, and not from `machinesToClearRecipe` -- that returns 0
      // when `limitedBy` is null, which this case always is. One machine is the
      // honest minimum and the caller re-solves after buying, the same argument the
      // storage branch makes for only ever recommending one level.
      machinesToClear: 1,
    };
  }

  return null;
}
```

Then, inside `computeBottleneck`, insert this block immediately after the power branch's closing `}` and before `if (firstLimited === null || firstLimited.limitedBy === null) return null;`:

```typescript
  // Spec §4.5 as amended 2026-09-19: what blocks the next milestone outranks what
  // limits the top priority item. Falls through when the milestone is satisfied,
  // when nothing in it is blocked, or at the last tier.
  const nextMilestone = content.milestoneByTier.get(tier + 1);
  if (nextMilestone !== undefined) {
    const visited = new Set<ItemId>();
    for (const requirement of nextMilestone.requires) {
      // Ruling R7 pays deliveries from liquid stock, so liquid is the right measure.
      if (liquid(state, requirement.item).gte(requirement.amount)) continue;
      const blocker = resolveBlocker(
        content, capacity, entries, state, itemStates,
        requirement.item, requirement.item, visited,
      );
      if (blocker !== null) return blocker;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/engine && npx vitest run src/solve/bottleneck.test.ts`

Expected: PASS, including the two pre-existing storage-kind tests — those must not regress.

- [ ] **Step 5: Run the whole engine suite**

Run: `cd packages/engine && npx vitest run`

Expected: PASS. If a solve test now reports a different bottleneck, read it before changing it: a test whose premise was "the reporter names the priority target" may be asserting the old behaviour, in which case update the test and say so in the commit. A test about allocation or clocks changing is NOT expected and means the branch is doing more than reporting.

- [ ] **Step 6: Amend the spec**

In `docs/superpowers/specs/2026-09-01-engine-core-design.md`, directly after the block that begins `**Amended 2026-09-06 (Phase 2 task 0): a third, storage-shaped kind.**` and its closing paragraph, add:

```markdown
**Amended 2026-09-19 (Phase 2): the scan is milestone-first.**

§4.5 originally returned the constraint limiting the highest-priority *limited* target.
Two measured defects follow from that wording. A target with zero machines has
`limitedBy: null` and is invisible to the scan, since a recipe with no capacity is not
limited by anything. And ranking by the authored priority list answers a question a
stalled player is not asking.

Measured on the vertical slice: `bottleneck` stalled at tier 1 for 120 simulated days
holding 2,307,820 `iron_plate` and 430,367 `screw`, owning zero assemblers, needing 200
`reinforced_iron_plate` — and was advised to buy three iron ore miners.

The reporter now resolves the next milestone's unmet requirements first, walking each
item's input chain to the first genuine blocker, and falls back to the priority scan
when the milestone is satisfied or nothing in it is blocked. The returned kinds are
unchanged: a zero-capacity recipe is reported as `kind: "recipe"`, because it genuinely
is the binding constraint.
```

Also correct the design doc: in `docs/superpowers/specs/2026-09-19-milestone-aware-bottleneck-design.md`, replace the paragraph beginning `` `machinesToClear` for the zero-capacity case comes out of the existing `` with:

```markdown
`machinesToClear` for the zero-capacity case is the literal 1, not a call to
`machinesToClearRecipe`. That function returns 0 immediately when `entry.limitedBy` is
null, which for a zero-capacity entry it always is. One machine is the honest minimum
and the caller re-solves after buying — the same argument the storage branch already
makes for only ever recommending one level.
```

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts docs/superpowers/specs/
git commit -m "Name what blocks the milestone, not what limits the priority list

A recipe with zero machines reports limitedBy: null, so the priority scan could
never name it -- and the scan was ranked by the authored priority list anyway.
computeBottleneck now resolves the next milestone's unmet requirements first and
falls back to the priority scan when nothing in the milestone is blocked.

No new Bottleneck kind: a recipe with no machines genuinely is the binding
constraint, so kind: \"recipe\" already says it and no consumer changes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The remaining blocker branches

`resolveBlocker` currently returns null for anything that is not zero-capacity, so a FULL milestone item or a limited one falls through to the priority scan. Fix that.

**Files:**
- Modify: `packages/engine/src/solve/bottleneck.ts`
- Test: `packages/engine/src/solve/bottleneck.test.ts`

**Interfaces:**
- Consumes: `resolveBlocker` from Task 1, `cheaperUpgrade(content, state, itemId): StorageUpgrade | null` and `machinesToClearRecipe(capacity, entry): number`, both already module-private in this file.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("the milestone branch", …)` block:

```typescript
  it("names the cap when the milestone item is at its cap", () => {
    // Tier 2 of the fixture needs 2000 iron_plate; the liquid cap at level 0 is
    // 300 + 1200 = 1500, so the requirement is unmet AND the item is FULL.
    const state = { ...atCap(initialWorld(content, 1, 0), "iron_plate"), tier: 1 };
    const sol = solve(state, content, NO_FLOOR);
    expect(sol.itemStates.get("iron_plate")).toBe("FULL");
    expect(sol.bottleneck).toEqual({
      kind: "storage",
      itemId: "iron_plate",
      limitingTarget: "item:iron_plate",
      upgrade: "storage",
    });
  });

  it("names the limiting recipe when the milestone item is merely constrained", () => {
    // Tier 1 of the fixture needs 200 iron_plate. Production is live and below cap,
    // so the walk must reach the limited branch rather than returning null.
    const sol = solve(initialWorld(content, 1, 0), content, NO_FLOOR);
    expect(sol.bottleneck?.kind).toBe("recipe");
    expect(sol.bottleneck?.limitingTarget).toBe("item:iron_plate");
  });
```

- [ ] **Step 2: Run to verify the first fails**

Run: `cd packages/engine && npx vitest run src/solve/bottleneck.test.ts -t "at its cap"`

Expected: FAIL — the milestone branch returns null for a FULL item, so the priority
scan answers instead.

It may instead PASS, because `iron_plate` is also priority[0] and the old path reaches
the same object. That is a weak test, not a passing one. Make it discriminating before
continuing: move `iron_plate` to the end of the priority list in the test state, so the
priority scan cannot name it and only the milestone branch can.

```typescript
const state = {
  ...atCap(initialWorld(content, 1, 0), "iron_plate"),
  tier: 1,
  priority: [
    ...initialWorld(content, 1, 0).priority.filter((e) => e.itemId !== "iron_plate"),
    ...initialWorld(content, 1, 0).priority.filter((e) => e.itemId === "iron_plate"),
  ],
};
```

- [ ] **Step 3: Add the FULL and limited branches**

In `resolveBlocker`, replace the final `return null;` with:

```typescript
  // A cap is a constraint no machine can clear. Ordered ahead of the limited branch
  // for the same reason the priority scan orders it that way: a FULL item's producer
  // is limited by backpressure, and naming the recipe would advise a purchase that
  // cannot help.
  if (itemStates.get(itemId) === "FULL") {
    return {
      kind: "storage",
      itemId,
      limitingTarget: `item:${targetId}`,
      upgrade: cheaperUpgrade(content, state, itemId),
    };
  }

  const entry = entries.find((candidate) => candidate.itemId === itemId);
  if (entry !== undefined && entry.limitedBy !== null) {
    return {
      kind: "recipe",
      recipeId: entry.limitedBy,
      limitingTarget: `item:${targetId}`,
      machinesToClear: machinesToClearRecipe(capacity, entry),
    };
  }

  // Producing, uncapped, and getting everything it asked for: this requirement is
  // not blocked, it is merely not banked yet. Recurse into the inputs in case one of
  // THEM is stopped, and otherwise report nothing so the priority scan runs.
  const recipe = content.recipes.get(recipeId);
  if (recipe !== undefined) {
    for (const inputId of recipe.inputPerSecond.keys()) {
      const upstream = resolveBlocker(
        content, capacity, entries, state, itemStates, inputId, targetId, visited,
      );
      if (upstream !== null) return upstream;
    }
  }
  return null;
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/engine && npx vitest run src/solve/bottleneck.test.ts`

Expected: PASS.

- [ ] **Step 5: Check whether the recursion branch is reachable at all**

The waterfall's `limitedBy` already points at the deepest limiting recipe, so the
recursion may be dead code. Find out rather than shipping it on faith. Add a
temporary `console.error("RECURSED", itemId)` as the first line of the input loop,
then run:

```bash
cd apps/sim && npx tsx src/bin.ts run --policy bottleneck \
  --content ../../packages/content/bundles/vertical-slice \
  --seed 42 --until tier:10 --max-days 30 --report json 2>&1 >/dev/null | sort -u | head
```

If nothing prints, the branch never fires on real content: **delete the recursion
block**, keep the `visited` set (it still guards the entry point), and say so in the
commit message. If it prints, keep it. Remove the `console.error` either way.

- [ ] **Step 6: Run the whole engine suite**

Run: `cd packages/engine && npx vitest run`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/solve/bottleneck.ts packages/engine/src/solve/bottleneck.test.ts
git commit -m "Let the milestone walk name caps and constrained recipes too

resolveBlocker returned null for anything that was not zero-capacity, so a FULL
or merely-limited milestone item fell through to the priority scan. Adds both
branches, ordered cap-before-recipe for the reason the priority scan already
orders them that way.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Termination on real content

**Files:**
- Test: `packages/engine/src/solve/bottleneck.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2. No production code changes expected.

- [ ] **Step 1: Write the test**

Append to `packages/engine/src/solve/bottleneck.test.ts`:

```typescript
// The slice ships a deliberate recipe cycle (alt_recycled_plastic ->
// alt_recycled_rubber, the known-acceptable check 6 warning). Ruling R6 keeps
// in-cycle recipes from ever being live, so the walk should not reach it -- this
// asserts that holds on the real bundle at every tier rather than by argument.
describe("the milestone walk on real content", () => {
  const sliceDir = fileURLToPath(new URL("../../../content/bundles/vertical-slice", import.meta.url));
  const slice = indexContent(loadBundleDir(sliceDir));

  it("terminates at every tier of the vertical slice", () => {
    for (let tier = 0; tier <= slice.maxTier; tier += 1) {
      const state = { ...initialWorld(slice, 1, 0), tier };
      expect(() => solve(state, slice, NO_FLOOR), `tier ${tier}`).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/engine && npx vitest run src/solve/bottleneck.test.ts -t "real content"`

Expected: PASS, and in well under vitest's default 5s timeout. A hang here means the
`visited` set is not covering a path — do not raise the timeout, find the cycle.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/solve/bottleneck.test.ts
git commit -m "Assert the milestone walk terminates on the bundle that ships a cycle

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Measure the result and re-pin the gate

The acceptance criterion is a number, not a claim. Task 0 declared this class of defect fixed once already on evidence that did not hold.

**Files:**
- Modify: `apps/sim/src/gate-cli.ts`
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`

**Interfaces:**
- Consumes: `VERTICAL_SLICE_GATE: readonly PolicyGate[]` in `apps/sim/src/gate-cli.ts`, whose `bottleneck` entry currently carries `reachesTier: 1`, a tier-1 pin at `observed: 0.0927`, and `deadTimePin: { collections: 102.8917 }`.

- [ ] **Step 1: Measure `bottleneck` on the slice**

```bash
cd apps/sim && npx tsx src/bin.ts run --policy bottleneck \
  --content ../../packages/content/bundles/vertical-slice \
  --seed 42 --until tier:10 --max-days 120 --report json > /tmp/bn.json 2>/dev/null
python3 -c "
import json; r=json.load(open('/tmp/bn.json'))
print('reachedTier', r['reachedTier'], 'purchases', r['purchases'])
print('deadTime collections', r['maxDeadTimeMs']/(8*3600000))
for t in r['tierTimes']: print(' tier', t['tier'], round(t['collections'],4))
"
```

Record the numbers. Compare against `greedy`'s tier times in
`packages/content/bundles/vertical-slice/derived.yaml`'s `observedCollectionsToTier`.

- [ ] **Step 2: Confirm nothing else moved**

```bash
cd apps/sim && npx tsx src/bin.ts run --policy greedy \
  --content ../../packages/content/bundles/vertical-slice \
  --seed 42 --until tier:10 --max-days 120 --report json 2>/dev/null \
  | python3 -c "import json,sys; [print(t['tier'], t['collections']) for t in json.load(sys.stdin)['tierTimes']]"
```

Expected: byte-identical to `derived.yaml`'s observed column — 0.417824, 0.798024,
1.192738, 1.836638, 2.964915, 4.422714, 6.847262, 10.756569, 15.490440, 20.872241.
**If any of these moved, the change is not reporter-only and Task 1's design claim is
wrong.** Stop and investigate rather than re-pinning.

- [ ] **Step 3: Update the gate pins to the measured values**

In `apps/sim/src/gate-cli.ts`, update the `bottleneck` entry of `VERTICAL_SLICE_GATE`
using the Step 1 numbers:

- If it now reaches tier 10, delete `reachesTier` entirely.
- If it reaches tier N < 10, set `reachesTier: N`.
- Replace the tier-1 `knownRed` entry's `observed` with the measured tier-1 time, and
  add a `knownRed` entry per tier that is still outside 5% of its target, each with a
  `why` naming the measured miss.
- If dead time is now under the 2-collection threshold, delete `deadTimePin`; otherwise
  set `collections` to the measured value.

Rewrite each `why` string: the current ones describe a stall that no longer exists.

- [ ] **Step 4: Run both gate depths**

```bash
cd apps/sim && npm run gate:smoke
cd apps/sim && npm run gate
```

Expected: both PASS. `gate` takes ~16 minutes locally. A `stale-pin` finding means a
pin from Step 3 is wrong — fix the pin, not the threshold.

- [ ] **Step 5: Update the handoff**

In `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, rewrite the
`` **`bottleneck` stalls at tier 1, and it is an ADVICE defect.** `` paragraph and the
`**1. `bottleneck`'s advice defect — now the biggest open item.**` item to say what was
done and where it landed. Update the three-policy table's `bottleneck` row. If it still
does not land near `greedy`, say so plainly and say what the remaining gap looks like —
an honest partial result is the deliverable, not a claim of success.

- [ ] **Step 6: Full verification**

Run serially, never concurrently:

```bash
cd packages/engine && npx vitest run
cd packages/content && npx vitest run
cd apps/sim && npx vitest run
cd "$(git rev-parse --show-toplevel)" && pnpm lint
cd "$(git rev-parse --show-toplevel)" && pnpm typecheck
cd "$(git rev-parse --show-toplevel)" && pnpm content:check
```

Expected: all green; `content:check` shows only the known check 6 cycle warning.

- [ ] **Step 7: Commit and push**

```bash
git add apps/sim/src/gate-cli.ts docs/superpowers/plans/2026-09-16-phase-2-handoff.md
git commit -m "Re-pin the gate against what bottleneck now does

Write the Step 1 measurements into this message before committing: the tier it
reaches, its dead time in collections, and which tiers remain outside 5%. A
re-pin commit whose message does not carry the numbers it pinned is unreviewable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push origin worktree-phase-2-content
```
