# R32 for Coupled EMPTY Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `iron_plate`/`screw` pin/unpin cycle by making ruling R32 test EMPTY items jointly, and bring the pacing gate under CI's 90-minute cap.

**Architecture:** One change inside `runWaterfall`'s R32 block (`packages/engine/src/solve/waterfall.ts`): the per-entry, independent disqualification test becomes a per-item test iterated to a stable set, starting from every candidate held and only releasing. Then measure, re-pin, and record.

**Tech Stack:** TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-10-coupled-empty-pins-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/phase-1-engine`, branch `worktree-phase-2-content`. Never on the top-level checkout (it is stale).
- Never run `pnpm format` (it rewrites the whole repo).
- Never run `pnpm lint` / `pnpm typecheck` while `pnpm test` (or a gate) is running in the background: turbo builds race.
- `packages/engine` is pure: no `Date`, `performance`, `Math.random`, `Math.pow` (lint-enforced, spec E.4/A.5).
- R32's pre-checks, its `-1e-9` threshold, `forceDisqualified` reuse and share-mode's exemption are unchanged (spec "What this does not change").
- Do not push. Commit locally only.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE
  ```

## Review Focus

- **Sibling entries for one item** (an ordinary entry plus a `reserve:` entry): must be held or released together; a per-entry version broke `fuzz.test.ts` and `properties.test.ts` on exactly this shape. Covered by the existing suite (Task 1 Step 6).
- **A lone candidate** (no other candidate exists): behaviour must be byte-identical to today -- its re-run excludes nothing. Covered by the existing R32 tests in `waterfall.test.ts` ("does not hand a bottlenecked recipe's owner a trickle", "still lets an item's own entry draw its share").
- **Over-holding**: an item whose surplus is genuinely sustainable must be released, not held because it started held. Covered by Task 1's "releases the item whose spare really is spare".
- **Termination**: the loop must end even if every candidate is released in one round or none ever is. Each round either releases at least one item or ends the loop; covered structurally by the `changed` flag and by the full suite not hanging.
- **Reconciliation pass**: `forceDisqualified` is passed by `solvePass`'s second `runWaterfall` call; the new loop must not run there. Unchanged `if (forceDisqualified)` branch; covered by the existing suite.

---

### Task 1: Joint R32 test, test-first

**Files:**
- Create: `packages/engine/src/resolve/fixtures/slice-tier-8.world.json`
- Modify: `packages/engine/src/solve/waterfall.ts` (the R32 comment block and the `else` branch of `if (forceDisqualified)`, currently around lines 523-592)
- Test: `packages/engine/src/solve/waterfall.test.ts`, `packages/engine/src/resolve/resolve.test.ts`

**Interfaces:**
- Consumes: `runWaterfall(args)` returning `{ disqualified: ReadonlySet<string>, usedUnits, entries, ... }`; `computeFlows(content, capacityUnits, clocks)` from `./fixpoint.js`; `resolve(state, content, elapsedMs)` returning `{ state, events, summary: { guardTripped, ... } }`; `deserializeWorld(text)` from `../state/serialize.js`.
- Produces: no new exports. `WaterfallResult.disqualified` keeps its type and meaning; only which entries land in it changes.

- [ ] **Step 1: Add the frozen world fixture**

The saved tier-8 checkpoint holds the measured case. Its `state` field is already a serialized world string; write that string out as the fixture:

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
mkdir -p packages/engine/src/resolve/fixtures
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2], j.state)' \
  /tmp/claude-1000/-home-nec-Code-Manufactorty-Idle/36bcc901-3574-48ce-acb4-54f223421a5d/scratchpad/cps-pay/tier-8.json \
  packages/engine/src/resolve/fixtures/slice-tier-8.world.json
head -c 120 packages/engine/src/resolve/fixtures/slice-tier-8.world.json
```

Expected: starts with `{"schemaVersion":1,"contentVersion":"slice.v1",` and contains `"tier":8`. (~12 KB.)

- [ ] **Step 2: Write the failing waterfall tests**

In `packages/engine/src/solve/waterfall.test.ts`, add this import directly after `import { computeExpansion } from "../graph/expand.js";`:

```ts
import { computeFlows } from "./fixpoint.js";
```

Append at the end of the file:

```ts

describe("runWaterfall — R32 for coupled EMPTY items", () => {
  // Measured 2026-10-10 on the vertical slice: iron_plate and screw, both pinned EMPTY
  // and both feeding make_reinforced_iron_plate, cycled 6,668 times in a 120 s resolve.
  // R32 tested each item with every OTHER item's entry still banking, so the shared
  // consumer stayed starved and each item looked sustainable on its own. Neither was
  // disqualified; both banked, un-pinned, and drained.
  //
  // The fixture has no two-input recipe, so these use the slice with capacity handed in
  // directly. Rates per unit, per minute:
  //   make_iron_plate             -> 20 plate
  //   make_screw                  -> 40 screw
  //   make_reinforced_iron_plate  30 plate + 60 screw ->
  //   make_rotor                  100 screw (+ rods, not pinned) ->
  // A second consumer of screw is what makes the pair unstable: with one shared
  // consumer only, "plate drains while screws cap it" and "screw drains while plate
  // caps it" contradict each other.
  const sliceDir = fileURLToPath(new URL("../../../content/bundles/vertical-slice", import.meta.url));
  const slice = indexContent(loadBundleDir(sliceDir));

  function coupled(units: Record<string, number>) {
    // Tier 3: make_rotor unlocks there.
    const state = { ...initialWorld(slice, 1, 0), tier: 3 };
    const capacityUnits = new Map(Object.entries(units));
    const result = runWaterfall({
      content: slice,
      vectors: computeExpansion(slice, state.tier, state.activeRecipe),
      activeRecipe: state.activeRecipe,
      capacityUnits,
      entries: ["iron_plate", "screw", "reinforced_iron_plate", "rotor"].map((itemId) => entry(itemId)),
      pinnedEmpty: new Set(["iron_plate", "screw"]),
      reserveFloor: RESERVE_FLOOR,
    });
    const clocks = new Map<string, number>();
    for (const [recipeId, u] of capacityUnits) clocks.set(recipeId, (result.usedUnits.get(recipeId) ?? 0) / u);
    const flows = computeFlows(slice, capacityUnits, clocks);
    return { result, net: (itemId: string) => flows.get(itemId)!.net };
  }

  it("disqualifies both entries when each item drains once the other's entry is held", () => {
    // Plate 1/3 per s, screw 2 per s. Screw's entry held, plate un-pinned: the shared
    // consumer takes the screws and wants ~1 plate/s, so plate drains. Plate's entry
    // held, screw un-pinned: rotor alone wants 3.3 screw/s, so screw drains.
    const { result, net } = coupled({
      make_iron_plate: 1,
      make_screw: 3,
      make_reinforced_iron_plate: 10,
      make_rotor: 2,
    });
    expect([...result.disqualified].sort()).toEqual(["item:iron_plate", "item:screw"]);
    // Neither pinned item banks a surplus: a positive net is what un-pins it.
    expect(net("iron_plate")).toBeCloseTo(0, 9);
    expect(net("screw")).toBeCloseTo(0, 9);
  });

  it("releases the item whose spare really is spare", () => {
    // Twenty plate constructors make 6.7 plate/s; the screws cap the shared consumer at
    // ~1 plate/s. Plate's surplus survives with screw's entry held, so plate is
    // released and its entry keeps banking; only screw is disqualified.
    const { result, net } = coupled({
      make_iron_plate: 20,
      make_screw: 3,
      make_reinforced_iron_plate: 10,
      make_rotor: 2,
    });
    expect([...result.disqualified]).toEqual(["item:screw"]);
    expect(net("iron_plate")).toBeGreaterThan(1);
    expect(net("screw")).toBeCloseTo(0, 9);
  });
});
```

- [ ] **Step 3: Write the failing resolve test**

In `packages/engine/src/resolve/resolve.test.ts`, add as the first line:

```ts
import { readFileSync } from "node:fs";
```

and directly before `import { buildWorld } from "../testing/arbitrary.js";`:

```ts
import { deserializeWorld } from "../state/serialize.js";
```

Append at the end of the file:

```ts

describe("resolve — coupled EMPTY items settle (R32)", () => {
  // The measured case itself: the vertical slice at tier 8 as `bottleneck` left it,
  // saved 2026-10-10. Over the next 120 s iron_plate and screw both drain to zero.
  // Before R32 tested items jointly, the pair then cycled at microsecond spacing --
  // 6,668 events and the MAX_EVENTS guard. Now each drains once and stays pinned.
  // The world is frozen data: if the slice's content changes underneath it, this test
  // may stop reaching the coupled state, but it cannot start passing for a wrong reason.
  const sliceDir = fileURLToPath(new URL("../../../content/bundles/vertical-slice", import.meta.url));
  const slice = indexContent(loadBundleDir(sliceDir));
  const worldFile = fileURLToPath(new URL("./fixtures/slice-tier-8.world.json", import.meta.url));

  it("drains each item once instead of cycling", () => {
    const start = deserializeWorld(readFileSync(worldFile, "utf8"));
    const out = resolve(start, slice, 120_000);
    expect(out.summary.guardTripped).toBe(false);
    const drains = out.events.filter((e) => e.kind === "drain").map((e) => e.itemId);
    expect(drains).toContain("iron_plate");
    expect(drains).toContain("screw");
    expect(out.events.length).toBeLessThan(20);
  });
});
```

- [ ] **Step 4: Run the new tests, verify they fail for the right reason**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/waterfall.test.ts src/resolve/resolve.test.ts 2>&1 | grep -E "×|Tests |AssertionError"
```

Expected (measured while writing this plan):
- `× disqualifies both entries ...` with `expected [ 'item:screw' ] to deeply equal [ 'item:iron_plate', 'item:screw' ]`
- `× drains each item once instead of cycling` with `expected true to be false` (the guard tripped; this test takes ~15 s today)
- `releases the item whose spare really is spare` PASSES today -- it guards against over-holding, and is mutation-checked in Step 7.
- `Tests  2 failed | 48 passed (50)`

- [ ] **Step 5: Implement the joint test**

In `packages/engine/src/solve/waterfall.ts`, replace the `else` branch of `if (forceDisqualified) { ... } else { ... }` -- currently:

```ts
  } else {
    const computed = new Set<string>();
    for (const entry of live) {
      if (entry.mode !== "guaranteed" || entry.itemId === null) continue;
      if (!pinnedEmpty.has(entry.itemId)) continue;
      if ((content.consumersOf.get(entry.itemId) ?? []).length === 0) continue;
      const ownRecipe = activeRecipeOf(activeRecipe, entry.itemId);
      if (ownRecipe === undefined) continue;
      if ((touchCount.get(ownRecipe) ?? 0) < 2) continue;

      const pinnedWithoutX = new Set(pinnedEmpty);
      pinnedWithoutX.delete(entry.itemId);
      const alt = runPasses(pinnedWithoutX, new Set());
      const altClocks = new Map<RecipeId, number>();
      for (const [recipeId, units] of capacityUnits) {
        altClocks.set(recipeId, units > 0 ? (alt.usedUnits.get(recipeId) ?? 0) / units : 0);
      }
      if (netForItem(content, entry.itemId, capacityUnits, altClocks) < -1e-9) {
        computed.add(entry.id);
      }
    }
    disqualified = computed;
  }
```

with:

```ts
  } else {
    // The pre-checks are per entry; the test itself is per item (see "Asked jointly"
    // above), so an item's entries -- ordinary and `reserve:` -- share one verdict.
    const candidates: { id: string; itemId: ItemId }[] = [];
    for (const entry of live) {
      if (entry.mode !== "guaranteed" || entry.itemId === null) continue;
      if (!pinnedEmpty.has(entry.itemId)) continue;
      if ((content.consumersOf.get(entry.itemId) ?? []).length === 0) continue;
      const ownRecipe = activeRecipeOf(activeRecipe, entry.itemId);
      if (ownRecipe === undefined) continue;
      if ((touchCount.get(ownRecipe) ?? 0) < 2) continue;
      candidates.push({ id: entry.id, itemId: entry.itemId });
    }

    // Start with every candidate item held and only ever release, so this ends in at
    // most one round per candidate item.
    const candidateItems = [...new Set(candidates.map((c) => c.itemId))];
    const held = new Set<ItemId>(candidateItems);
    for (let changed = true; changed; ) {
      changed = false;
      for (const itemId of candidateItems) {
        if (!held.has(itemId)) continue;
        const pinnedWithoutX = new Set(pinnedEmpty);
        pinnedWithoutX.delete(itemId);
        const othersHeld = new Set<string>();
        for (const c of candidates) if (c.itemId !== itemId && held.has(c.itemId)) othersHeld.add(c.id);
        const alt = runPasses(pinnedWithoutX, othersHeld);
        const altClocks = new Map<RecipeId, number>();
        for (const [recipeId, units] of capacityUnits) {
          altClocks.set(recipeId, units > 0 ? (alt.usedUnits.get(recipeId) ?? 0) / units : 0);
        }
        if (netForItem(content, itemId, capacityUnits, altClocks) >= -1e-9) {
          held.delete(itemId);
          changed = true;
        }
      }
    }

    const computed = new Set<string>();
    for (const c of candidates) if (held.has(c.itemId)) computed.add(c.id);
    disqualified = computed;
  }
```

`ItemId` is already imported as a type at the top of the file (`import type { ItemId, RecipeId } from "../content/types.js";`).

Then extend the R32 comment block above `let disqualified` -- insert this paragraph immediately before the line `// Scoped to \`mode === "guaranteed"\`: no share-mode entry in the fixture or`:

```ts
  //
  // **Asked jointly (2026-10-10, Phase 2).** "Were X not pinned" is asked with every
  // OTHER item R32 is holding still held -- their entries excluded from the re-run --
  // starting from every candidate held and releasing each item whose net survives,
  // until a round releases nothing. Asked one item at a time with nobody else excluded,
  // two coupled items each look sustainable only because the other's entry is still
  // starving their shared consumer: measured on the vertical slice, iron_plate and
  // screw (both feeding make_reinforced_iron_plate) escaped disqualification together,
  // both banked, both un-pinned, and the pair cycled 6,668 times in a 120 s resolve.
  // The verdict is per item, not per entry: an item's ordinary and `reserve:` entries
  // bank the same stock, and excluding one sibling from the other's re-run broke two
  // fuzz properties on exactly that shape.
```

- [ ] **Step 6: Run the tests, verify they pass, then the full suite**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/waterfall.test.ts src/resolve/resolve.test.ts 2>&1 | grep -E "×|Tests "
cd ../.. && pnpm test 2>&1 | grep -E "Tests |Test Files|×|FAIL"
```

Expected: `Tests  50 passed (50)`; then every package green (measured with this exact change: rational 67, content 136, engine 391, sim 193 -- engine is 388 + the 3 new tests). If anything else fails, report it by name; do not adjust existing test expectations.

- [ ] **Step 7: Mutation-check each guard**

Each must make at least one of the three new tests fail; revert after each with `git checkout -p` or by hand:

1. Pass `new Set()` instead of `othersHeld` to `runPasses` -> "disqualifies both entries" fails (back to today's behaviour).
2. Delete `held.delete(itemId); changed = true;` (never release) -> "releases the item whose spare really is spare" fails.
3. Remove `c.itemId !== itemId && ` from the `othersHeld` loop (so the item's own entries, siblings included, are excluded from its own re-run) -> run the FULL engine suite (`npx vitest run`), not just the two files, and record which tests fail. The per-item grouping exists for `fuzz.test.ts` / `properties.test.ts`'s reserve-sibling shape; if no test fails under this mutation, say so in the report rather than inventing a test.

Run after each mutation:

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/waterfall.test.ts src/resolve/resolve.test.ts 2>&1 | grep -E "×|Tests "
```

Confirm `git diff --stat` shows only the intended files before committing.

- [ ] **Step 8: Lint and typecheck (nothing else running)**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm lint 2>&1 | tail -5 && pnpm typecheck 2>&1 | tail -5
```

Expected: both clean.

- [ ] **Step 9: Commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
git add packages/engine/src/solve/waterfall.ts packages/engine/src/solve/waterfall.test.ts \
  packages/engine/src/resolve/resolve.test.ts packages/engine/src/resolve/fixtures/slice-tier-8.world.json
git commit -m "Ask R32 jointly for coupled EMPTY items

iron_plate and screw, both pinned EMPTY and both feeding
make_reinforced_iron_plate, each looked sustainable only while the other's
entry still starved the shared consumer, so R32 disqualified neither and
the pair cycled 6,668 times in a 120 s resolve of the vertical slice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE"
```

---

### Task 2: Measure, re-pin and record

**Files:**
- Modify: `apps/sim/src/gate-cli.ts` (`VERTICAL_SLICE_GATE` pins, only if a measurement moved)
- Modify: `.github/workflows/ci.yml` (the `pacing` job's comment above `timeout-minutes: 90`)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§C.3 amendment)
- Modify: `docs/superpowers/specs/2026-10-10-coupled-empty-pins-design.md` (Status line)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` (the "Superseded 2026-10-10 (payable advice)" notes)

**Interfaces:**
- Consumes: Task 1's commit.
- Produces: measured numbers only; no code interfaces.

- [ ] **Step 1: Re-measure the 120 s resolve from the checkpoint**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
S=/tmp/claude-1000/-home-nec-Code-Manufactorty-Idle/36bcc901-3574-48ce-acb4-54f223421a5d/scratchpad
npx tsx $S/events.mts "$PWD" $S/cps-pay/tier-8.json 2>&1 | head -4
```

Expected: `events 2`, one `drain iron_plate`, one `drain screw` (was 6,668).

- [ ] **Step 2: Run the full gate, timed, with pins emitted**

Nothing else may run while it does (no lint, typecheck or tests). Run it in the background and keep its output in a file:

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=/tmp/claude-1000/-home-nec-Code-Manufactorty-Idle/36bcc901-3574-48ce-acb4-54f223421a5d/scratchpad
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate-coupled.out 2>&1; echo "exit $?" >> $S/gate-coupled.out
```

Record: each policy's wall time (from its progress lines), the total `real` time, the exit status, every finding, and the emitted pin block. If the run exceeds 90 minutes of wall time, let it finish anyway -- the number is the deliverable -- and report it.

- [ ] **Step 3: Re-pin only what moved**

Compare the emitted block with `VERTICAL_SLICE_GATE` in `apps/sim/src/gate-cli.ts`. For every policy whose `knownRed` tier values, `reachesTier`, or findings changed, replace that policy's entry with the emitted values, keeping each pin's `why` text and appending one sentence: `Re-measured 2026-10-10 after R32 was asked jointly (coupled EMPTY items).` Do not touch a policy whose numbers did not move. If `greedy` or `casual` moved, say so prominently in the report: neither reads the reporter, so a move there is the solver change itself.

If any pin changed, re-run the gate (Step 2's command with output to `$S/gate-coupled-2.out`) and confirm it exits 0 with no findings. If no pin changed, Step 2's run must already have exited 0; if it did not, stop and report.

- [ ] **Step 4: Record the cost in CI and the handoff**

In `.github/workflows/ci.yml`, append a paragraph to the `pacing` job's comment, after the `SUPERSEDED 2026-10-10 (payable advice)` paragraph and before `timeout-minutes: 90`, of this shape, with the measured numbers filled in:

```yaml
    #
    # FIXED 2026-10-10 (R32 asked jointly): most of bottleneck's 135 minutes was one
    # solver cycle -- iron_plate and screw pinning and un-pinning 6,668 times per 120 s
    # resolve, tripping the MAX_EVENTS guard -- not simulation the gate needed. With it
    # gone the gate takes <TOTAL> locally (greedy <G>, casual <C>, bottleneck <B>,
    # determinism rerun <D>). The slowest two-core lane is about <LANE> locally,
    # ~<CI> minutes at the 2.43x runner factor, under the 90-minute cap.
```

If the CI estimate does NOT fit under 90, write that instead, leave `timeout-minutes` unchanged, and flag it in the report.

In `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, under each of the two `Superseded 2026-10-10 (payable advice)` notes (one in the follow-ups section, one in the item-1 section near line 422), append:

```markdown
>
> **Fixed 2026-10-10 (R32 asked jointly):** the 135 minutes was a solver cycle, not
> needed simulation -- see `docs/superpowers/specs/2026-10-10-coupled-empty-pins-design.md`.
> The gate now takes <TOTAL> locally (greedy <G>, casual <C>, bottleneck <B>,
> determinism rerun <D>).
```

- [ ] **Step 5: The §C.3 amendment and the spec status**

In `docs/superpowers/specs/2026-09-01-engine-core-design.md` §C.3, insert this after the `**Cost.**` paragraph (the one ending `An 8-hour resolve with 20 events is 20 of those.`) and before the `**Bottleneck** returns` paragraph, with a blank line either side:

```markdown
**Amended 2026-10-10 (Phase 2): R32 for coupled EMPTY items.** Ruling R32 disqualifies
an entry from drawing on its own item's producing recipe when that item is pinned
EMPTY and, were it not pinned, would drain -- a surplus there un-pins the item and
starts a pin/unpin limit cycle. The question is asked jointly: each candidate item is
tested with every other disqualified item's entries still disqualified, starting from
all candidates and releasing until stable, with an item's entries (ordinary and
`reserve:`) treated as one. Measured cause: `iron_plate` and `screw`, both feeding
`make_reinforced_iron_plate`, each looked sustainable only while the other's entry
starved the shared consumer; neither was disqualified, and the pair cycled 6,668 times
in 120 s of the vertical slice, which made the pacing gate take 135 minutes.
```

In `docs/superpowers/specs/2026-10-10-coupled-empty-pins-design.md`, change the Status line to:

```markdown
**Status:** implemented 2026-10-10 (commit <Task 1's short SHA>).
```

- [ ] **Step 6: Verify and commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
git add apps/sim/src/gate-cli.ts .github/workflows/ci.yml docs/superpowers/specs/2026-09-01-engine-core-design.md \
  docs/superpowers/specs/2026-10-10-coupled-empty-pins-design.md docs/superpowers/plans/2026-09-16-phase-2-handoff.md
git commit -m "Re-measure the pacing gate after R32 for coupled EMPTY items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE"
```

Expected: all suites green. In the report, give the gate's total wall time, per-policy times, CI estimate, and which pins (if any) moved.
