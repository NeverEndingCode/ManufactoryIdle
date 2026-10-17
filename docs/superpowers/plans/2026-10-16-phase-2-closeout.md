# Phase 2 close-out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Phase 2 (calibrated content). That means fixing the two calibrator bugs found while recalibrating in PR #17, finishing the one Task 3 "still to do" item that is still open, and making the Phase 2 plan, the handoff and the README say what is true.

**Architecture:**
- **Task 1:** the calibrator CLI and search, in `apps/sim/src/calibrate-cli.ts`, `apps/sim/src/calibrate.ts` and `apps/sim/src/bin.ts`.
- **Task 2:** docs, plus one engine test fix.

**Tech Stack:** TypeScript ESM, vitest, tsx, pnpm + turbo.

**Spec:** no separate spec. This is close-out work on existing tools, and the rulings below are recorded in this plan. The plan of record being closed is `docs/superpowers/plans/2026-09-06-phase-2-calibrated-content.md`. The user's standing instruction (2026-10-16) is to work autonomously through the milestones.

## Rulings

- **C-1. A partial write must not truncate.** `--max-tier N --write`, where N is below the bundle's highest milestone tier, is refused with an error that names `--merge`. With `--merge`, the write keeps the existing `derived.yaml`'s milestone amounts for tiers above N, and sets their `observedCollectionsToTier` entries to `null`, because they were not measured in this run. Tiers 1..N and every other derived field come from this run. *Why:* the PR #17 recalibration lost tiers 5–10 this way. *Cost if wrong:* one flag.
- **C-2. Say what `--no-solve-reff` holds, and give the current scale a one-flag form.** `--no-solve-reff` holds the **authored** r_eff, which is scale 1.0. That is not the scale the current `derived.yaml` was solved at. Add `--scale <s>` as shorthand for `--scales <s> --no-refine`, and document both in `sim --help`. *Why:* the PR #17 recalibration used `--no-solve-reff`, expected the current scale, and got 1.0, which changed every machine's cost ratio. *Cost if wrong:* none; it's additive.
- **C-3. Overshoot short-circuit (Task 3 "still to do" item 3).** If the amounts search for a tier bisects downward toward the floor, one run at the floor answers "even the minimum overshoots", and the search should stop there. Check the current code first. If this already short-circuits (the unreachable case is said to), add a test that pins it. If not, implement it and test it.

## Global Constraints

- **Where to work:** `.claude/worktrees/phase-1-engine`, branch `phase-2-closeout`, stacked on `greedy-storage-offers` (PR #17). Never work in the top-level checkout. Never touch the `phase-3-api` worktree.
- **No content numbers change.** Don't run the calibrator with `--write` on the vertical slice. The gate pins must not move.
- **Commands:**
  - Never run `pnpm format`.
  - Run `pnpm test`, `pnpm lint` and `pnpm typecheck` one after another in the foreground; never run anything in the background.
  - Never `pkill -f`; no `pgrep -f` loops.
- **Commit trailers:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **The merge keeps exactly the higher tiers' amounts** and nulls their observed values, and the loader still accepts the merged file. Covered by Task 1's merge test, which loads the result through `loadBundleDir`.
- **The partial-write refusal fires before anything is written.** Covered by Task 1's refusal test, which checks the file is unchanged.

---

### Task 1: Calibrator fixes, test-first

**Files:**
- Modify: `apps/sim/src/calibrate-cli.ts`, `apps/sim/src/bin.ts` (flags and help), and `apps/sim/src/calibrate.ts` (only for C-3)
- Test: `apps/sim/src/calibrate.test.ts`, or a new `calibrate-cli.test.ts` if CLI tests live better there; read how the existing tests drive the calibrator (they use the frozen `calibration-fixture` bundle and `withTargets`)

- [ ] **Step 1: Write the failing tests.**
  1. **The refusal (C-1).** In a temp copy of a small bundle (the `calibration-fixture` or `fixture`, whichever the existing calibrate tests use), `runCalibration({ contentDir: tmp, maxTier: 1, write: true, ... })` with no merge throws or returns an error naming `--merge`, and `derived.yaml` is unchanged (byte-compare before and after, including "did not exist").
  2. **The merge (C-1).** Given a temp bundle whose `derived.yaml` has milestones for every tier, run with `maxTier: 1`, `write: true`, `merge: true`. Then:
     - tiers above 1 keep their previous amounts exactly;
     - their `observedCollectionsToTier` entries are `null`;
     - tier 1 has this run's values;
     - `loadBundleDir(tmp)` loads the result.

     Keep the run cheap (tier 1 only, or a tiny bundle). If `observedCollectionsToTier` can't hold `null` in the derived schema, STOP and report; don't change the schema without saying so.
  3. **`--scale` (C-2).** Parsing `--scale 0.5` gives `scales: [0.5]` and `refine: false`. Test the arg parser in `bin.ts`, or wherever flags are parsed.
  4. **The overshoot short-circuit (C-3).** With a target the tier can't reach even at the floor amount (it overshoots at the minimum), the amounts search for that tier makes at most 2 evaluations, read from the result's per-tier `evaluations`. Use `withTargets` for the target, as the existing mechanics tests do.
- [ ] **Step 2:** run them and record RED. Test 4 may already pass; if so, say so, because that's C-3's "already short-circuits" case.
- [ ] **Step 3: Implement.**
  - **Merge:** in `runCalibration`, read the existing `derived.yaml` with the content package's existing derived parser (find it next to `serialiseDerived`).
  - **Refusal:** compare `options.maxTier` with the bundle's highest milestone tier.
  - **Flags:** add `--merge` and `--scale` to `bin.ts`, and update the help text, which must say "`--no-solve-reff` holds the authored r_eff (scale 1.0), not the scale `derived.yaml` was solved at; use `--scale <s>` for that".
- [ ] **Step 4:** the tests pass, and the sim suite passes.
- [ ] **Step 5: Mutation.** Remove the refusal; test 1 must fail. Undo by hand.
- [ ] **Step 6:** run lint and typecheck, then commit: `Calibrator: refuse truncating partial writes, add --merge and --scale`.

---

### Task 2: Close the Phase 2 docs, and one test fix

**Files:**
- Modify: `docs/superpowers/plans/2026-09-06-phase-2-calibrated-content.md`
- Modify: `docs/superpowers/plans/2026-09-16-phase-2-handoff.md`
- Modify: `README.md`
- Modify: `packages/engine/src/solve/solve.test.ts` (the brownout test's hard-coded `1.47`)

- [ ] **Step 1: The brownout test.** In `solve.test.ts`, the brownout reserve-sizing test hard-codes `fullPower = 1.47`. Derive it: compute the full-power reserve-free production in the test the same way `solve` does (one item pass at power ratio 1, with no power demand, using what the engine exports), or from the same state with power capacity raised so that `power.ratio === 1`. Assert the derived value matches the reserve's `requested / percent`. The test must still fail if `solve` sizes against the full solve: re-run that mutation by hand, then undo it.
- [ ] **Step 2: The Phase 2 plan.** In `2026-09-06-phase-2-calibrated-content.md`:
  - **Task 3:** mark it **DONE**, with a one-line summary of what shipped (the calibrator, `derived.yaml`, all ten tiers fit, `greedy` tier 1 a known red since PR #17).
  - **Task 4:** mark it **DONE** (the pacing gate and the smoke gate in CI).
  - **"Still to do" items 1–5:** mark each as done, superseded, or still open, in place, with one line and a reference:
    1. targets reconciled: all ten tiers within 5% until PR #17's storage guard made tier 1 a staircase;
    2. affordable: a full ten-tier calibration takes about 3 minutes;
    3. this plan's C-3;
    4. `storageBindingCadence` deleted in PR #7, and the storage cost curves stay authored by decision;
    5. `SET_RESERVE` is emitted by `bottleneck` since PR #9, and `REORDER_PRIORITY` by `greedy` and `optimal` (milestone-first) since PR #7.
  - **The "Carried forward" table:** for each row, mark it still open, done, or moved to Phase 3, with a reason. The SuperTokens pin moves to Phase 3c. Check each claim against the code.
  - **Top of the file:** add a "Phase 2 status: complete (2026-10-16)" line.
- [ ] **Step 3: The handoff.**
  - The header paragraph "State: …" and the cost table go to the current state: the gate's time (2m19s locally) and its fit, with tier 1 a known red.
  - Mark the two calibrator follow-ups (C-1, C-2) done, citing this branch.
  - Add a line at the top saying Phase 2 is complete and pointing to the Phase 3 spec (`docs/superpowers/specs/2026-10-16-phase-3-server-design.md`, being built on branch `phase-3a-api`).
- [ ] **Step 4: The README.** The Status paragraph says Phases 0–2 are complete and Phase 3 (server) is in progress, and the build-order table marks phase 2 done. Keep the no-test-count rule.
- [ ] **Step 5:** run `pnpm test` (foreground), then `pnpm lint` and `pnpm typecheck`, and confirm the smoke gate passes: `pnpm --filter @manufactory/sim run gate:smoke`. Commit: `Close Phase 2: plan statuses, handoff, README; derive the brownout test's full-power figure`.

The report gives:
- every test count;
- C-3's finding (whether the search already short-circuited);
- each "still to do" and "carried forward" verdict, in one line each.
