# Tier 10 Capstone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tier 10 asks for a capstone product, `heavy_modular_frame`, made on a new `assembly_rig` class whose cost doubles per machine. Recalibration then lands `greedy`'s tier 10 within ±5% of its 25-collection target.

**Architecture:** Content only, plus one recalibration.
- Task 1 authors the item, class, recipe, milestone and priority entry. It drops `derived.yaml`'s now-stale tier-10 patch in the same commit, because `applyDerived` throws on a patch for an item the milestone no longer asks for.
- Task 2 runs the normal `sim calibrate --write`, re-pins the gate, and records the result.

**Tech Stack:** YAML content bundles, TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-13-tier10-capstone-design.md`

## Global Constraints

- Work in `.claude/worktrees/phase-1-engine`, branch `tier10-structural`. It is cut from `policy-milestone-reorder` (PR #7), because tier 10 is calibrated against the milestone-first `greedy`. Never work in the top-level checkout.
- Content seeds are exactly the spec's:
  - **`heavy_modular_frame`:** lane iron, tier 9, terminal, caps 200 / 800.
  - **`assembly_rig`:** ladder step 1.5 / interval 10, **`costRatio: 2.0` and no `rEff`**. Mk.1 is rateMultiplier 1, buildCostMultiplier 1, powerDraw 55, build cost 200 `smart_plating` + 200 `encased_industrial_beam`, unlock tier 9.
  - **`make_heavy_modular_frame`:** class `assembly_rig`, lane iron, unlock tier 9. Inputs `modular_frame` 10, `steel_pipe` 30, `encased_industrial_beam` 10, `screw` 200. Output `heavy_modular_frame` 0.1.
  - **Milestone 10:** requires only `heavy_modular_frame`, authored seed amount 30000.
- `bundles/calibration-fixture/` is NOT changed (it is a frozen copy; see its README).
- Never hand-edit `derived.yaml` except Task 1's single deletion of its tier-10 milestone patch; Task 2 regenerates it.
- Never run `pnpm format`. Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another, never concurrently, and never while a calibration or gate runs.
- Do not `pgrep -f` a pattern that matches your own wait loop. Prefer foreground commands; a background command is fine when its completion notifies you.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **The rig's cost growth surviving calibration.** It must still read `costRatio: 2.0` after `calibrate --write`. Covered by Task 2 Step 3's check on the regenerated `derived.yaml` (the rig must not appear under `costRatios`).
- **Check 9 and the headroom test** ("leaves every fitted milestone real headroom under its storage ceiling"): once tier 10 is fitted, its amount must sit at or below 60% of `maxAttainableCap(heavy_modular_frame, 9)`. Covered by the existing test after Task 2.
- **A `bottleneck` stall at tier 10.** A rig that doubles in cost is where advice can become unpayable. Task 2 reports it with the advice it gave; it is not pinned silently.
- **Tiers 1–9 moving in recalibration.** Nothing below tier 10 changed, so a tier leaving its ±5% band is reported, not re-pinned quietly.
- **Sim tests that run the slice to tier 10.** After Task 1, tier 10 runs on the seed amount until Task 2 calibrates it. If such a test fails in Task 1, report it rather than editing its expectation; Task 2's calibration is what fixes the number.

---

### Task 1: Author the capstone, test-first

**Files:**
- Modify: `packages/content/bundles/vertical-slice/items.yaml`, `machines.yaml`, `recipes.yaml`, `milestones.yaml`, `start.yaml`
- Modify: `packages/content/bundles/vertical-slice/derived.yaml` (delete only the `- tier: 10` entry under `derived.milestones`)
- Test: `packages/content/src/validate/slice.test.ts` (append inside `describe("the vertical slice", ...)`)

**Interfaces:**
- Produces: a slice that loads (with derived applied) and validates with only the known check-6 warning; milestone 10 at its authored seed until Task 2.

- [ ] **Step 1: Write the failing test**

Append inside `describe("the vertical slice", () => { ... })` in `packages/content/src/validate/slice.test.ts`:

```ts
  // Spec 2026-10-13 (tier 10's capstone). Tier 10 was storage-capped: it asked for
  // items the player already makes at scale, and milestones are paid from stock. It now
  // asks for one capstone, made on a class whose cost doubles per machine -- measured as
  // the only lever that makes tier-10 time grow with the amount rather than its log.
  it("builds tier 10 toward a capstone on a steeply priced class of its own", () => {
    const b = bundle();
    const item = b.items.find((i) => i.id === "heavy_modular_frame");
    expect(item?.terminal).toBe(true);

    const rig = b.machineClasses.find((c) => c.id === "assembly_rig");
    expect(rig?.costRatio).toBe(2);
    // Authored outside the r_eff scan, so calibration cannot flatten it.
    expect(rig?.rEff).toBeUndefined();

    expect(recipe("make_heavy_modular_frame").machineClass).toBe("assembly_rig");
    // Producible during tier 9: a milestone's requirement must exist before it unlocks.
    expect(recipe("make_heavy_modular_frame").unlockTier).toBe(9);
    expect(outputIds("make_heavy_modular_frame")).toEqual(["heavy_modular_frame"]);

    const tier10 = b.milestones.find((m) => m.tier === 10)!;
    expect(tier10.requires.map((r) => r.item)).toEqual(["heavy_modular_frame"]);
    expect(b.start.priority).toContain("heavy_modular_frame");
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/packages/content"
npx vitest run src/validate/slice.test.ts 2>&1 | grep -E "×|Tests |expected"
```

Expected: the new test fails (`expected undefined to be true`: the item does not exist yet).

- [ ] **Step 3: Author the content**

`items.yaml`: after the `smart_plating` line, add

```yaml
  - { id: heavy_modular_frame,    lane: iron,   tier: 9,  name: Heavy Modular Frame,    baseStorageCap: 200, baseQuantumCap: 800, terminal: true }
```

`machines.yaml`: after the `manufacturer` class block, add

```yaml

  # Spec 2026-10-13: tier 10's capstone is built here. Its cost growth IS the pacing
  # lever -- each rig costs twice the last, so buying more stops answering a bigger
  # requirement -- so it authors costRatio directly and no rEff, which keeps it out of
  # calibration's single r_eff scale (calibrate.ts withREffScale / deriveCostRatios).
  - id: assembly_rig
    name: Assembly Rig
    ladder: { step: 1.5, interval: 10 }
    costRatio: 2.0
    marks:
      - { mark: 1, name: Assembly Rig Mk.1, rateMultiplier: 1, buildCostMultiplier: 1, powerDraw: 55, buildCost: [{ item: smart_plating, amount: 200 }, { item: encased_industrial_beam, amount: 200 }], unlockTier: 9 }
```

`recipes.yaml`: after the `make_smart_plating` line, add

```yaml
  - { id: make_heavy_modular_frame, name: Heavy Modular Frame, lane: iron, machineClass: assembly_rig, inputs: [{ item: modular_frame, rate: "10" }, { item: steel_pipe, rate: "30" }, { item: encased_industrial_beam, rate: "10" }, { item: screw, rate: "200" }], outputs: [{ item: heavy_modular_frame, rate: "0.1" }], unlockTier: 9 }
```

`milestones.yaml`: change tier 10's `requires` line to

```yaml
    requires: [{ item: heavy_modular_frame, amount: 30000 }]
```

Keep its name and `laneMultipliers` unchanged. If its comment block mentions `smart_plating` / `encased_industrial_beam` as tier 10's requirement, add one line: `# 2026-10-13: tier 10 now asks for the capstone; see specs/2026-10-13-tier10-capstone-design.md.`

`start.yaml`: append `heavy_modular_frame` as the last entry of `priority` (after `smart_plating`).

`derived.yaml`: delete the whole `- tier: 10` entry under `derived.milestones` (its `requires` lists `smart_plating` 7663000 and `encased_industrial_beam` 5747250). Leave everything else. Task 2 regenerates the file.

- [ ] **Step 4: Run the tests and the validator**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
(cd packages/content && npx vitest run src/validate/slice.test.ts 2>&1 | grep -E "×|Tests ")
pnpm content:check 2>&1 | grep -E "warning|error|v1:"
```

Expected:
- **The slice tests pass.** The headroom test does not apply to tier 10 yet: its run's observed tier 10 is still the old 20.87, outside 5% of 25, so tier 10 is not "fitted".
- **`content:check`:** the slice shows only the check-6 warning, and the calibration fixture and fixture are unchanged.
- **If check 9 or 12 errors on the new item,** STOP and report: the spec measured base caps as sufficient.

- [ ] **Step 5: Full suite, lint, typecheck**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
```

Expected: green. If a sim test that runs the slice past tier 9 fails on a tier-10 number, do NOT edit it; report it (Review Focus), since Task 2's calibration changes that number.

- [ ] **Step 6: Commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
git add packages/content/bundles/vertical-slice packages/content/src/validate/slice.test.ts
git commit -m "Author tier 10's capstone on a steeply priced assembly rig

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

---

### Task 2: Recalibrate, re-pin, record

**Files:**
- Modify: `packages/content/bundles/vertical-slice/derived.yaml` (regenerated by the calibrator, never hand-edited)
- Modify: `apps/sim/src/gate-cli.ts` (pins that moved)
- Modify: `docs/superpowers/specs/2026-09-01-engine-core-design.md` (§B.7 note)
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md` (item 3)
- Modify: `docs/superpowers/specs/2026-10-13-tier10-capstone-design.md` (Status line)

**Interfaces:**
- Consumes: Task 1's commit.

- [ ] **Step 1: Recalibrate**

This takes about an hour, so run it in the background and let it notify you. Nothing else may run meanwhile.

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=${CLAUDE_JOB_DIR:-/tmp}/tier10; mkdir -p "$S"
( time npx tsx src/bin.ts calibrate --content ../../packages/content/bundles/vertical-slice \
    --policy greedy --seed 42 --max-tier 10 --tolerance 0.05 --scales 0.5 --write ) > $S/calibrate.out 2>&1; echo "exit $?" >> $S/calibrate.out
```

Expected: exit 0, and `derived.yaml` rewritten. Record the printed tier table (target vs observed for tiers 1–10) and the total time.

- [ ] **Step 2: Judge the calibration**

From `derived.yaml`'s `run.observedCollectionsToTier` against `targetCollectionsToTier`:
- **Tier 10** should be within 5% of 25. If it is not, STOP and report the observed value and the solved amount. Do not retune seeds by hand.
- **Tiers 1–9** should each still be within 5%, as before. Any that is not gets reported by tier, with its old and new values.

- [ ] **Step 3: Check the rig kept its cost growth**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
grep -n "assembly_rig" packages/content/bundles/vertical-slice/derived.yaml || echo "rig not in derived: authored costRatio stands"
```

Expected: `rig not in derived: authored costRatio stands`. If the rig appears under `costRatios`, STOP and report: the spec's premise failed.

- [ ] **Step 4: Validate and test**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
pnpm content:check 2>&1 | grep -E "warning|error|v1:"
pnpm test 2>&1 | grep -E "Tests |×|FAIL"
pnpm lint 2>&1 | tail -n 3
pnpm typecheck 2>&1 | tail -n 3
```

Expected: all green. The headroom test now covers tier 10: the solved amount must be at most 60% of `maxAttainableCap(heavy_modular_frame, 9)`. If it fails, STOP and report the percentage.

- [ ] **Step 5: Gate, and re-pin**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine/apps/sim"
S=${CLAUDE_JOB_DIR:-/tmp}/tier10
( time npx tsx src/bin.ts gate --content ../../packages/content/bundles/vertical-slice --max-days 120 --emit-pins ) > $S/gate.out 2>&1; echo "exit $?" >> $S/gate.out
```

Update `VERTICAL_SLICE_GATE` in `apps/sim/src/gate-cli.ts` from the emitted block:
- **`greedy`:** if tier 10 is now within ±5% of 25, remove its tier-10 `knownRed` pin (the gate holds it to target). Re-pin any other greedy tier that moved outside tolerance, though Step 2 should have caught that.
- **`casual` and `bottleneck`:** replace the pins that moved with the emitted values. Keep each `why` text, update the numbers it quotes, and append `Re-measured 2026-10-13 after tier 10 became the assembly-rig capstone.`
- **If `bottleneck` now stalls at tier 10** (`stalled at tier N` in the emitted block): pin it with `reachesTier` as the gate prints, AND record in the report what `bottleneck` was advising when it stalled. Re-run it alone to find out: `npx tsx src/bin.ts run --policy bottleneck --content ../../packages/content/bundles/vertical-slice --until tier:10 --max-days 120 --report text`, and read its binding constraints.

Then re-run the gate without `--emit-pins` and confirm it exits 0 with no findings.

- [ ] **Step 6: Record**

In `docs/superpowers/specs/2026-09-01-engine-core-design.md` §B.7, after the paragraph about `r_eff` being solved as a single scale, add:

```markdown
**Amended 2026-10-13: a class outside the scale.** A class may author `costRatio`
directly and no `rEff` when its cost growth is itself the pacing lever. The scan
then leaves it alone (`withREffScale`, `deriveCostRatios`). The slice's `assembly_rig`
does this, for tier 10's capstone: each rig costs twice the last, which is what makes
tier-10 time grow with its requirement instead of with the requirement's logarithm.
See `specs/2026-10-13-tier10-capstone-design.md`.
```

In `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`, prefix item 3's heading ("**3. Tier 10 — the only off-target tier, and now honestly measured.**") with `**DONE 2026-10-13** —`. Under the heading, add one line: the capstone design, tier 10's new observed value, and the solved amount.

In the capstone spec, change Status to `**Status:** implemented 2026-10-13.`

- [ ] **Step 7: Commit**

```bash
cd "/home/nec/Code/Manufactorty Idle/.claude/worktrees/phase-1-engine"
git add packages/content/bundles/vertical-slice/derived.yaml apps/sim/src/gate-cli.ts docs
git commit -m "Recalibrate for tier 10's capstone, and re-pin the gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ"
```

The report gives:
- the calibration's tier table and total time;
- tier 10's solved amount and its headroom percentage;
- the gate's time and every moved pin (old → new);
- any `bottleneck` stall, with the advice it gave.
