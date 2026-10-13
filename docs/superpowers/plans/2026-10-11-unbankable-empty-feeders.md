# Unbankable EMPTY Feeders Implementation Plan

> **SUPERSEDED 2026-10-12.** This approach was implemented (8a7caec), reverted
> (d8d87a1) after the gate showed it stalled `bottleneck` at tier 1, and two redesigns
> prototyped after it also failed the gate. The cycle it targeted is now cheap rather
> than gone: `resolve` caches `solve` per item-state configuration (engine spec §C.7,
> 2026-10-12). Kept as the record of what was tried and why it failed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `screw`-only pin/unpin cycle that starts once `reinforced_iron_plate` is FULL. The R6 FULL sweep will also throttle the producers of a pinned EMPTY item that no entry may bank.

**Architecture:** One change inside `solvePass`'s downstream-first FULL sweep (`packages/engine/src/solve/fixpoint.ts`). The sweep now also visits an item that meets three conditions: it is pinned EMPTY, no entry may bank it (every live entry for it is R32-disqualified, or it has none), and it is every producer's only output. Then measure, re-pin, and record.

**Tech Stack:** TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md`

## Global Constraints

- Work in the worktree `.claude/worktrees/phase-1-engine`, branch `worktree-phase-2-content`. Never on the top-level checkout (it is stale).
- Never run `pnpm format` (it rewrites the whole repo).
- Never run `pnpm lint` / `pnpm typecheck` while `pnpm test` (or a gate) is running in the background: turbo builds race.
- **Before Task 1 edits any engine source**, no `sim gate` may be running from this worktree. A confirmation gate was started on 2026-10-11. Check with `pgrep -af "src/bin.ts gate"`, and wait until it prints nothing.
- `packages/engine` is pure: no `Date`, `performance`, `Math.random`, `Math.pow` (lint-enforced, spec E.4/A.5).
- R6's FULL branch, the R30 EMPTY sweep, R32, and the R31 reconciliation pass are unchanged (spec "What this does not change").
- Do not push. Commit locally only.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE
  ```

## Review Focus

- **A `reserve:` sibling.** An item with an ordinary entry and a `reserve:` entry is "bankable" if either one is live and not disqualified. R32 gives both entries one verdict, so they agree. Covered by the existing suite (`fuzz.test.ts`, `properties.test.ts`, which exercise that shape).
- **Share-mode entries.** R32 never disqualifies these, so a live share-mode entry for the item always counts as "may bank", and the item keeps today's behaviour. No new test: this is the conservative fallback, and the spec excludes share mode.
- **The reconciliation pass.** A throttled feeder's producers are added to `sweepTouched`, so the second `runWaterfall` treats their capacity as already final. The reported `entries`/`allocations` must then agree with the clocks. Covered by the existing R31 tests and by Task 1's test 1, which reads clocks and flows from the same `solvePass` result.
- **The `pinnedEmpty` condition.** It cannot be reached for a stocked item, because a walk draws that item from stock and never runs its producer. No test can pin it. The code comment says so. Do not write a test that "covers" it by asserting today's behaviour: Task 1 checked, and such a test passes with or without the condition.
- **Determinism.** The fixture world below must regenerate byte-identically: SHA-256 `98659a4904ea0e045a0c51be2c88d8cd7b2371f048035e17bf9729aa42321ad3`. A mismatch means the slice content or the engine drifted, and you should stop and report rather than commit a different world.

---

### Task 1: The sweep throttles unbankable EMPTY feeders, test-first

**Files:**
- Create: `packages/engine/src/resolve/fixtures/slice-tier-8-reinforced-full.world.json` (generated, not hand-written)
- Modify: `packages/engine/src/solve/fixpoint.ts` (the R6 sweep, currently around lines 165-185)
- Test: `packages/engine/src/solve/fixpoint.test.ts` (append two `describe` blocks)
- Test: `packages/engine/src/resolve/resolve.test.ts` (append one `describe` block)
- Modify: `docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md` (Status line)

**Interfaces:**
- Consumes: `WaterfallResult.disqualified: ReadonlySet<string>` (already returned by `runWaterfall`); `IndexedContent.producersOf`, `IndexedContent.recipes.get(id).outputPerSecond: Map<ItemId, number>`; `PriorityEntry.paused`, `.itemId`, `.id`.
- Produces: no new exports. `solvePass`'s signature is unchanged.

- [ ] **Step 1: Confirm no gate is running**

```bash
pgrep -af "src/bin.ts gate" || echo "no gate running"
```

Expected: `no gate running`. If a gate is listed, wait for it to finish. Do not kill it.

- [ ] **Step 2: Generate the fixture world, before touching any source**

Write this script **outside the repo** (e.g. `$S=${CLAUDE_JOB_DIR:-/tmp}/r6-feeders`) and run it:

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
S=${CLAUDE_JOB_DIR:-/tmp}/r6-feeders; mkdir -p "$S"
cat > "$S/gen-fixture.mts" <<'EOF'
// Usage: npx tsx gen-fixture.mts <worktree root> <out file>
// slice-tier-8.world.json stepped 19 x 120 s forward with no purchases.
import { readFileSync, writeFileSync } from "node:fs";
const root = process.argv[2];
const { loadBundleDir } = await import(`${root}/packages/content/src/index.ts`);
const { indexContent } = await import(`${root}/packages/engine/src/graph/index-content.ts`);
const { deserializeWorld, serializeWorld } = await import(`${root}/packages/engine/src/state/serialize.ts`);
const { resolve } = await import(`${root}/packages/engine/src/resolve/index.ts`);
const slice = indexContent(loadBundleDir(`${root}/packages/content/bundles/vertical-slice`));
let w = deserializeWorld(readFileSync(`${root}/packages/engine/src/resolve/fixtures/slice-tier-8.world.json`, "utf8"));
for (let i = 0; i < 19; i++) w = resolve(w, slice, 120_000).state;
writeFileSync(process.argv[3], serializeWorld(w));
EOF
npx tsx "$S/gen-fixture.mts" "$PWD" packages/engine/src/resolve/fixtures/slice-tier-8-reinforced-full.world.json
sha256sum packages/engine/src/resolve/fixtures/slice-tier-8-reinforced-full.world.json
```

Expected: `98659a4904ea0e045a0c51be2c88d8cd7b2371f048035e17bf9729aa42321ad3`. If it differs, stop and report it (see Review Focus).

- [ ] **Step 3: Write the failing unit tests**

In `packages/engine/src/solve/fixpoint.test.ts`, change the waterfall import:

```ts
import { effectivePriority, runWaterfall } from "./waterfall.js";
```

Then append at the end of the file:

```ts
describe("solvePass — unbankable EMPTY feeders of a FULL item (R6)", () => {
  // iron_plate at cap with nothing consuming it, so the FULL sweep stops make_plate.
  // One smelter unit makes 0.5 ingot/s, exactly what one constructor unit draws, so
  // iron_ingot -- pinned EMPTY -- is balanced in the waterfall's output: its only
  // production is item:iron_plate's walk, sized to feed make_plate. Pausing
  // item:iron_ingot leaves no entry that may bank it.
  function plateAtCap(pauseIngot: boolean): WorldState {
    const base = initialWorld(content, 1, 0);
    return {
      ...base,
      quantum: { ...base.quantum, iron_plate: liquidCap(content, base, "iron_plate") },
      assignment: { ...base.assignment, smelt_iron: 1 },
      priority: base.priority.map((entry) =>
        entry.id === "item:iron_ingot" ? { ...entry, paused: pauseIngot } : entry,
      ),
    };
  }
  const pinned = new Set(["iron_ore", "iron_ingot"]);

  it("throttles a feeder nobody may bank down with its throttled consumer", () => {
    const args = setup(plateAtCap(true));
    // Preconditions: the waterfall alone balances iron_ingot at 0.5/s, and plate is FULL.
    const unswept = runWaterfall({
      content,
      vectors: args.vectors,
      activeRecipe: args.state.activeRecipe,
      capacityUnits: args.capacityUnits,
      entries: args.entries,
      pinnedEmpty: pinned,
      reserveFloor: 0,
    });
    const smeltUnits = args.capacityUnits.get("smelt_iron")!;
    expect(unswept.usedUnits.get("smelt_iron")! / smeltUnits).toBeCloseTo(1, 12);
    expect(unswept.usedUnits.get("make_plate")!).toBeCloseTo(1, 12);

    const result = solvePass({ ...args, pinnedEmpty: pinned });
    expect(result.itemStates.get("iron_plate")).toBe("FULL");
    expect(result.itemStates.get("iron_ingot")).toBe("EMPTY");
    expect(result.clocks.get("make_plate")).toBeCloseTo(0, 12);
    // The fix: smelting follows make_plate down instead of piling up a surplus on an
    // item pinned EMPTY, which would un-pin it and start a pin/unpin cycle.
    expect(result.clocks.get("smelt_iron")).toBeCloseTo(0, 12);
    expect(result.flows.get("iron_ingot")!.net).toBeCloseTo(0, 12);
  });

  it("leaves a feeder alone when its own entry may still bank it", () => {
    const args = setup(plateAtCap(false));
    const result = solvePass({ ...args, pinnedEmpty: pinned });
    // Precondition: item:iron_ingot is live and R32 did not disqualify it.
    expect(result.waterfall.disqualified.has("item:iron_ingot")).toBe(false);
    expect(result.clocks.get("make_plate")).toBeCloseTo(0, 12);
    // The freed smelter banks ingot for the next entry in line: net +0.5/s.
    expect(result.clocks.get("smelt_iron")).toBeCloseTo(1, 12);
    expect(result.flows.get("iron_ingot")!.net).toBeCloseTo(0.5, 12);
  });
});

describe("solvePass — an unbankable EMPTY feeder with a multi-output producer (R6)", () => {
  // The same world as above, but smelt_iron also emits heavy_oil_residue as a byproduct.
  // Throttling it would cut that output too, for a reason that has nothing to do with
  // it, so the sweep leaves a feeder with a multi-output producer alone, as before.
  const bundle = loadBundleDir(fixtureDir);
  const twoOutputs = indexContent({
    ...bundle,
    recipes: bundle.recipes.map((recipe) =>
      recipe.id === "smelt_iron"
        ? {
            ...recipe,
            outputs: [
              ...recipe.outputs,
              { ...recipe.outputs[0]!, item: "heavy_oil_residue", byproduct: true },
            ],
          }
        : recipe,
    ),
  });

  it("does not throttle a producer that also makes something else", () => {
    const base = initialWorld(twoOutputs, 1, 0);
    const state: WorldState = {
      ...base,
      quantum: { ...base.quantum, iron_plate: liquidCap(twoOutputs, base, "iron_plate") },
      assignment: { ...base.assignment, smelt_iron: 1 },
      priority: base.priority.map((entry) =>
        entry.id === "item:iron_ingot" ? { ...entry, paused: true } : entry,
      ),
    };
    const capacity = computeCapacity(twoOutputs, state);
    const result = solvePass({
      content: twoOutputs,
      vectors: computeExpansion(twoOutputs, state.tier, state.activeRecipe),
      state,
      capacityUnits: capacity.unitsByRecipe,
      entries: effectivePriority(twoOutputs, state, capacity, 0),
      reserveFloor: 0,
      pinnedEmpty: new Set(["iron_ore", "iron_ingot"]),
    });
    // Preconditions: smelt_iron really has two outputs, and make_plate was stopped.
    expect(twoOutputs.recipes.get("smelt_iron")!.outputPerSecond.size).toBe(2);
    expect(result.clocks.get("make_plate")).toBeCloseTo(0, 12);
    expect(result.clocks.get("smelt_iron")).toBeCloseTo(1, 12);
  });
});
```

- [ ] **Step 4: Write the failing resolve test**

Append at the end of `packages/engine/src/resolve/resolve.test.ts`. Every import it needs is already there: `readFileSync`, `fileURLToPath`, `loadBundleDir`, `indexContent`, `deserializeWorld`, `resolve`.

```ts
describe("resolve — a FULL consumer's EMPTY feeder settles (R6)", () => {
  // The measured case: slice-tier-8.world.json stepped 2,280 s forward with no
  // purchases, saved 2026-10-11. reinforced_iron_plate fills 38.75 s into the next
  // 120 s. Before the FULL sweep throttled unbankable EMPTY feeders, screw -- pinned
  // EMPTY, R32-held -- was then left a surplus by make_reinforced_iron_plate's
  // throttle and cycled: 4,999 drains and the MAX_EVENTS guard.
  const sliceDir = fileURLToPath(new URL("../../../content/bundles/vertical-slice", import.meta.url));
  const slice = indexContent(loadBundleDir(sliceDir));
  const worldFile = fileURLToPath(
    new URL("./fixtures/slice-tier-8-reinforced-full.world.json", import.meta.url),
  );

  it("fills reinforced_iron_plate without cycling screw", () => {
    const start = deserializeWorld(readFileSync(worldFile, "utf8"));
    const out = resolve(start, slice, 120_000);
    expect(out.summary.guardTripped).toBe(false);
    expect(out.events.some((e) => e.kind === "fill" && e.itemId === "reinforced_iron_plate")).toBe(true);
    expect(out.events.filter((e) => e.kind === "drain" && e.itemId === "screw")).toHaveLength(0);
    expect(out.events.length).toBeLessThan(20);
  });
});
```

- [ ] **Step 5: Run the new tests to verify they fail as predicted**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/fixpoint.test.ts src/resolve/resolve.test.ts 2>&1 | grep -E "✓|×|Tests " | grep -E "×|Tests |feeder|multi-output|cycling screw"
```

Expected: exactly 2 failures.
- **"throttles a feeder nobody may bank down with its throttled consumer"** fails with `expected 1 to be close to +0` (`smelt_iron` stays at clock 1).
- **"fills reinforced_iron_plate without cycling screw"** fails with `expected true to be false` (the guard trips; this test takes about 17 s while it fails).
- "leaves a feeder alone when its own entry may still bank it" and "does not throttle a producer that also makes something else" **pass** today. They pin behaviour that must not change.

- [ ] **Step 6: Implement the sweep change**

In `packages/engine/src/solve/fixpoint.ts`, replace:

```ts
  // Spec 3.3's backpressure, discharged in one downstream-first sweep (ruling R6).
  for (let i = content.topologicalItems.length - 1; i >= 0; i -= 1) {
    const itemId = content.topologicalItems[i]!;
    if (itemId === POWER_ITEM) continue;
    if (itemStates.get(itemId) !== "FULL") continue;

    const flows = computeFlows(content, capacityUnits, clocks);
```

with:

```ts
  // Spec 3.3's backpressure, discharged in one downstream-first sweep (ruling R6).
  for (let i = content.topologicalItems.length - 1; i >= 0; i -= 1) {
    const itemId = content.topologicalItems[i]!;
    if (itemId === POWER_ITEM) continue;
    const full = itemStates.get(itemId) === "FULL";
    // **Unbankable EMPTY feeders (2026-10-11, Phase 2).** A FULL item's throttle cuts what
    // its consumers draw from their inputs. An input pinned EMPTY was produced only to
    // feed them -- unless an entry banks it -- so with no entry that may bank it (none
    // live, or every one R32-disqualified) the cut leaves a surplus only this sweep made.
    // That surplus lifts the item off zero, un-pins it, and restarts R32's pin/unpin
    // cycle: measured on the vertical slice, screw cycled ~5,000 times per 120 s once
    // reinforced_iron_plate filled. So such an item is throttled here like a FULL one.
    // Producers with other outputs are left alone: throttling them would cut those too.
    // `pinnedEmpty` is a statement of scope, not a reachable guard: a stocked item's
    // producer only ever runs for its own entries, and here none may run.
    if (!full) {
      if (!pinnedEmpty.has(itemId)) continue;
      const bankable = entries.some(
        (entry) => !entry.paused && entry.itemId === itemId && !waterfall.disqualified.has(entry.id),
      );
      if (bankable) continue;
      const soleOutput = (content.producersOf.get(itemId) ?? []).every(
        (recipeId) => (content.recipes.get(recipeId)?.outputPerSecond.size ?? 0) <= 1,
      );
      if (!soleOutput) continue;
    }

    const flows = computeFlows(content, capacityUnits, clocks);
```

The rest of the loop body (the flow checks, `factor`, scaling producers, `sweepTouched`) is unchanged.

- [ ] **Step 7: Run the new tests to verify they pass**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/engine"
npx vitest run src/solve/fixpoint.test.ts src/resolve/resolve.test.ts 2>&1 | grep -E "×|Tests "
```

Expected: no `×`; all pass.

- [ ] **Step 8: Mutation-check each condition**

Make each edit to `fixpoint.ts` in turn, run Step 7's command, and confirm the named test fails. Then revert the edit with `git checkout -p packages/engine/src/solve/fixpoint.ts`, answering `y` only to that edit's hunk, or undo it by hand.

| edit | must fail |
|---|---|
| `if (bankable) continue;` → delete the line | "leaves a feeder alone when its own entry may still bank it" |
| `if (!soleOutput) continue;` → delete the line | "does not throttle a producer that also makes something else" |
| `if (!full) {` → `if (!full) { continue;` | "throttles a feeder nobody may bank…" and "fills reinforced_iron_plate without cycling screw" |

After all three, `git diff packages/engine/src/solve/fixpoint.ts` must show exactly Step 6's change.

- [ ] **Step 9: Full engine suite, then lint and typecheck (sequentially)**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
pnpm lint 2>&1 | tail -5
pnpm typecheck 2>&1 | tail -5
```

Expected: all suites green. The engine has 395 tests (391 + 4 new). Lint and typecheck are clean. The existing C.2 test "throttles producers of an item at cap so its net rate is zero" passes **unchanged**: `mine_iron` stays at clock 1.

- [ ] **Step 10: Mark the spec implemented**

In `docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md`, change the Status line to `**Status:** implemented 2026-10-11.` (Task 2 adds the commit SHA.)

- [ ] **Step 11: Commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
git add packages/engine/src/solve/fixpoint.ts packages/engine/src/solve/fixpoint.test.ts \
  packages/engine/src/resolve/resolve.test.ts \
  packages/engine/src/resolve/fixtures/slice-tier-8-reinforced-full.world.json \
  docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md
git commit -m "Throttle unbankable EMPTY feeders in the FULL sweep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE"
```

---

### Task 2: Measure, re-pin and record

**Files:**
- Modify: `apps/sim/src/gate-cli.ts` (`VERTICAL_SLICE_GATE` pins, only where a measurement moved)
- Modify: `.github/workflows/ci.yml` (the `pacing` job's comment above `timeout-minutes: 90`)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§C.3 amendment)
- Modify: `docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md` (Status line)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` (the "Next follow-up: a second cycle remains" note)

**Interfaces:**
- Consumes: Task 1's commit.
- Produces: measured numbers only; no code interfaces.

- [ ] **Step 1: Run the full gate, timed, with pins emitted**

Nothing else may run while it does (no lint, typecheck, tests, or probes: they skew the timings). Run it in the background and keep its output:

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=${CLAUDE_JOB_DIR:-/tmp}/r6-feeders; mkdir -p "$S"
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate-feeders.out 2>&1; echo "exit $?" >> $S/gate-feeders.out
```

Record each policy's wall time (from its progress lines), the total `real` time, the exit status, every finding, and the emitted pin block. If it runs past 90 minutes, let it finish: the number is the deliverable.

- [ ] **Step 2: Re-pin only what moved**

Compare the emitted block with `VERTICAL_SLICE_GATE` in `apps/sim/src/gate-cli.ts`. For each policy whose `knownRed` tier values, `reachesTier`, or findings changed:
- Replace that policy's entry with the emitted values.
- Keep each pin's `why` text, updating any number it quotes (purchases, dead time, `greedy`/`casual` tier-10 days).
- Append one sentence: `Re-measured 2026-10-11 after the FULL sweep throttled unbankable EMPTY feeders.`

Do not touch a policy whose numbers did not move. If `greedy` or `casual` moved, say so prominently in the report and in the handoff note (Step 4). Neither reads the reporter, so a move there is the solver change itself.

If any pin changed, re-run the gate (Step 1's command, output to `$S/gate-feeders-2.out`) and confirm it exits 0 with no findings. If no pin changed, Step 1's run must already have exited 0; if it did not, stop and report.

- [ ] **Step 3: Record the cost in CI**

In `.github/workflows/ci.yml`, append a paragraph to the `pacing` job's comment, after the `PARTLY FIXED 2026-10-10 (R32 asked jointly)` paragraph and before `timeout-minutes: 90`. Use this shape, with the measured numbers filled in:

```yaml
    #
    # FIXED 2026-10-11 (unbankable EMPTY feeders): the screw-alone cycle above is gone --
    # the FULL sweep now throttles an EMPTY feeder no entry may bank. The gate takes
    # <TOTAL> locally (greedy <G>, casual <C>, bottleneck <B>, determinism rerun <D>).
    # The slowest two-core lane is about <LANE> locally, ~<CI> minutes at the 2.43x
    # runner factor, <under | STILL over> the 90-minute cap.
```

If the CI estimate is still over 90, write that, leave `timeout-minutes` unchanged, and flag it in the report. If it fits, leave `timeout-minutes` unchanged too: the spec says the cap is re-checked, not re-chosen.

- [ ] **Step 4: Record it in the handoff**

In `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, directly under the blockquote paragraph that starts `> **Next follow-up: a second cycle remains.**`, append:

```markdown
>
> **Fixed 2026-10-11 (unbankable EMPTY feeders):** the cause was the R6 FULL sweep, not
> R32 -- see `docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md`. The
> gate now takes <TOTAL> locally (greedy <G>, casual <C>, bottleneck <B>, determinism
> rerun <D>), ~<CI> minutes in CI. <One sentence: which pins moved, or "No pins moved.">
```

- [ ] **Step 5: The §C.3 amendment and the spec status**

In `docs/superpowers/specs/2026-09-01-engine-core-design.md` §C.3, the R32 amendment ends with:

```markdown
in 120 s of the vertical slice, part of why the pacing gate took 135 minutes (it now
takes 85). Not yet covered: once `reinforced_iron_plate` is FULL, `screw` alone still
cycles (~5,000 events per 120 s resolve); see the Phase 2 handoff.
```

Replace the last two lines with the line below, keeping the first line of that block:

```markdown
in 120 s of the vertical slice, part of why the pacing gate took 135 minutes (it now
takes 85). A second cycle of the same kind came from the FULL sweep; see the next amendment.
```

Then insert the amendment text from the spec's "The C.3 amendment" section after it, with a blank line on either side. It goes before the `**Bottleneck** returns` paragraph. Copy the blockquoted paragraph from the spec without its `> ` prefixes.

In `docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md`, change the Status line to:

```markdown
**Status:** implemented 2026-10-11 (commit <Task 1's short SHA>).
```

- [ ] **Step 6: Verify and commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
git add apps/sim/src/gate-cli.ts .github/workflows/ci.yml docs/superpowers/specs/2026-09-01-engine-core-design.md \
  docs/superpowers/specs/2026-10-11-full-sweep-empty-feeders-design.md docs/superpowers/plans/2026-09-16-phase-2-handoff.md
git commit -m "Re-measure the pacing gate after throttling unbankable EMPTY feeders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0199BUtPnAk63wBUiaaxZ1hE"
```

Expected: all suites green. The report gives:
- the gate's total wall time and per-policy times;
- the CI estimate, and whether it fits under 90;
- which pins moved, calling out any `greedy` or `casual` move.
