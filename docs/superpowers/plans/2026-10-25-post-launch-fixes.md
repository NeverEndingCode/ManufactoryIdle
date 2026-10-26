# Post-launch fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two fixes for the live game:
- a player who follows the bottleneck advice is never deadlocked (PL-1);
- a world GET on a tier-8 world costs milliseconds, not about 0.5 s (PL-2's exact part).

Neither fix may move a gate pin or change a replay byte.

**Architecture:**
- **PL-1:** an engine helper chooses the advised mark, and the Bottleneck carries it. The web and the sim read that mark.
- **PL-2:** a resumable prefix cache for `resolve` (an optional engine API with a caller key), plus a `capAtLevel` memo. The API wires a per-process LRU keyed by world and state version.

**Tech Stack:** TypeScript, vitest, the sim's gate.

**Spec:** `docs/superpowers/specs/2026-10-25-post-launch-fixes-design.md`. Evidence and repro probes are in `/home/nec/.claude/jobs/56686703/tmp/postlaunch/`; `p1-frame-only.mts` and `p2-variant.mts` hold the prototypes, and `engcopy/` holds the prototype engine edits.

## Global Constraints
- Work in `.claude/worktrees/phase-4c` on branch `post-launch`, from `main` at c0066e8.
- **Exactness is the bar.**
  - The `VERTICAL_SLICE_GATE` pins must not move. Run `pnpm --filter @manufactory/sim run gate:smoke`. Also run the bottleneck gate the CI `pacing` job runs; check `.github/workflows/ci.yml` for the exact command.
  - The play.test pins must not move.
  - The engine golden and replay tests stay byte-identical.
- Never run `pnpm format`. Run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, sequentially, in the foreground. Don't run anything in the background. Never `pkill -f`. No containers.
- Commit with these trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ`. Do not push.

## Review Focus
- **PL-1:**
  - the step-down fires only for a dead payer, meaning short AND unmade;
  - a single-mark class is unchanged;
  - the redirect chain is untouched.
- **PL-2:**
  - a cache hit is byte-identical to a cold resolve for every window length, at or after the cached point;
  - a different key never hits;
  - the cache is bounded.

---

### Task 1: PL-1, advise a mark that can be paid

**Files:**
- engine `solve/bottleneck.ts`, plus a new helper beside `economy/capacity.ts`'s `bestUnlockedMark`;
- the Bottleneck type;
- `apps/web/src/ui/derive.ts` (`machineBuy`);
- `apps/sim/src/policies.ts` (~434);
- tests in each package.

Steps:
- [ ] **The helper.** `adviceMark(content, state, itemRates, machineClass, lane): number`.
  - It returns the best unlocked mark, unless that mark's one-machine price has a dead payer: an item with liquid + bound < price AND production ≤ `FLOW_TOLERANCE`.
  - In that case it returns the best lower unlocked mark with no dead payer.
  - If no such mark exists, it returns the best mark.
- [ ] **Apply it to the final answer only.** Apply it only to the answer `payable` returns, and put `mark` on the recipe and power Bottleneck kinds.
- [ ] **Read the mark everywhere.** The web's `machineBuy` and the sim's bottleneck policy read `bottleneck.mark`.
- [ ] **Tests, written first:**
  - **Engine unit tests:**
    - a dead best mark steps down;
    - a merely short best mark (one that is being produced) does NOT step down;
    - a single-mark class is unchanged.
  - **The real stuck state:** reproduce it with `p1-frame-only.mts`'s frame-only player, then build it as an engine fixture or test. The advice must be Mk2 on steel pipe or steel beam.
  - **A frame-only player test in `apps/web`:** add a `MODE`-like variant to the play test. It must pass tier 6 in `pnpm test`; tier 10 runs only under `WEB_PLAY_TIER=10`.
- [ ] **Mutation:** return `bestUnlockedMark` from the helper. The frame-only test must fail.
- [ ] **Exactness:** the gates and the play pins are unchanged. Commit "Engine: advise a machine mark that can be paid, so following the advice never deadlocks (PL-1)".

### Task 2: PL-2, a resumable prefix cache and the cap memo

**Files:**
- engine `resolve/index.ts`, `economy/storage.ts` (`capAtLevel`), and their tests;
- `apps/api/src/worlds.ts`, plus a small LRU module.

Steps:
- [ ] **The `capAtLevel` memo.** It must be exact. Test that it's byte-identical on both tier-8 fixtures.
- [ ] **`resolve`'s options.** `resolve(state, content, elapsedMs, opts?)` accepts `{ prefixCache?: PrefixCache; cacheKey?: string }`.
  - When the fine-step loop reaches `MAX_EVENTS` without any step being clipped by `remaining`, store `{ state, cursor, events, stepSizes, solves summary }` under the key.
  - A later call with the same key and a window ≥ the cached prefix's span resumes from it.
  - The engine stays pure and deterministic: the cache is supplied by the caller.
- [ ] **Tests, written first:**
  - for both tier-8 fixtures and windows of 5 s, 60 s, 1 h, 8 h and 24 h, a cold resolve equals a cached resolve, byte for byte (`serializeWorld`, events, schedule);
  - a shorter window than the cached prefix ignores the cache;
  - a different key misses;
  - the LRU evicts.
- [ ] **Mutation:** skip re-deriving `remaining` on resume. The equality test must fail.
- [ ] **API wiring.** `viewWorld` and `applyActions` pass a per-process LRU (for example 256 entries) with the key `${worldId}:${stateVersion}:${contentChecksum}`. `replayWorld` passes none.
- [ ] **Measure.**
  - The GET timing on the reinforced-full fixture, cold and warm, through `buildServer`/`inject`.
  - Report the numbers.
  - Expect warm ≤ 25 ms on this box.
- [ ] **Exactness:** the gates, the replay tests and the API suite stay green. Commit "Engine and API: a resumable resolve prefix and a cap memo cut tier-8 GETs to milliseconds (PL-2)".
