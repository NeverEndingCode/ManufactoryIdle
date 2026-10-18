# Phase 4b: the buy drawer, the priority list, the power dock and the tap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every D.1 action is reachable from the browser, and the vertical slice is playable to tier 10 in it (spec decomposition row 4b).

**Architecture:**
- **Task 1:** the carried hygiene minors, all small and independent: `scheduleDetail` tier-8 goldens and an unmutated-input check, the memoised content body, the duplicate "8a" title, the draining `storageTransition` case, and the W-4 lint gaps (bare Node builtins, dynamic `import()`).
- **Task 2:** the pure spend layer in `apps/web/src/ui/`: `quote.ts` (cost and refund, mirroring the reducers; affordability for any action), `preview.ts` (W-13), `machines.ts` (the drawer model: ladder progress, marks, consolidation, assignment, storage, QS, recipes), and the frame's widened action set and scarcest-input framing.
- **Task 3:** the buy drawer, the W-19 pane layout and bottom sheet, rows that open the drawer, the frame's storage/QS/reserve buttons, and the shared `fakeStore` test helper.
- **Task 4:** the priority list: the model (visible entries, the reorder payload), drag, keyboard and button reorder, Simple/Advanced, pinned power with its warning, reserves, and optimistic controls (W-13, W-21).
- **Task 5:** taps in the store (hold, flush cadence, keepalive), the power dock, the header tier readout and the tier-up toast; the GET-4xx polling pin.
- **Task 6:** the acceptance pins: a jsdom test that drives each of the eleven D.1 actions through the real components, and a "UI player" that reaches tier 6 in `pnpm test` and tier 10 in a new `web-play` CI job, using only the client's own builders.
- **Task 7:** four Playwright specs (drawer buy, priority drag, tap hold, injected failures), the README.

**Tech Stack:** as 4a, with no new dependencies: TypeScript ESM, React 18.3.1, Vite 8.2.2, vitest 4 + jsdom + Testing Library, `@playwright/test` 1.64.1 (Chromium), Fastify 5 + PGlite on the API side. Drag is hand-rolled (W-21).

**Spec:** `docs/superpowers/specs/2026-10-17-phase-4-web-client-design.md`: the 4b row, W-1 items 2–4 (plus the header tier readout from W-1's "Also"), W-12, W-13, W-19, W-20, W-21, W-23's 4b specs, and the errata (P-1 satisfaction, P-2 one frame, P-4 plateau). The 4a plan (`docs/superpowers/plans/2026-10-17-phase-4a-web-shell.md`) rulings P-1 to P-16 stand unless a Q-ruling below says otherwise.

## Rulings made in this plan

Measured with `npx tsx` probes against the real engine and the slice bundle (`/home/nec/.claude/jobs/56686703/tmp/phase4/probe4b-*.mts`).

- **Q-1. A preview credits the shortfall to `bound`, not the whole cost.** For each cost item, `credit = max(0, cost − liquid − bound − refund)`, all read from `snapshot.display.state`. Then `applyBatch`, then `scheduleDetail`, then the diff (W-13).
  - *Why:* crediting the whole cost means the spend never touches liquid stock, even when the player can pay. A spend that drains a FULL item turns it FLOWING, and that changes rates. Measured on `slice-tier-8.world.json`: one Constructor Mk3 for iron (`steel_pipe` 2,000 → 1,926, FULL → FLOWING) previews `screw` 8.7/s away from what the server will actually do. With the shortfall rule, an affordable preview **is** the real purchase: the credit is empty, and the state deep-equals `apply`'s. An unaffordable preview is the purchase at the moment it becomes affordable, on today's rates: the cost items are drained to zero, which is what that purchase does.
  - The credit still sits in `bound`, which changes no rate. Measured: adding 1e6 `bound` to every item on both tier-8 fixtures leaves every `itemRates` net and the bottleneck bit-identical. A test pins that, so W-13's "cost if wrong" stays covered.
  - *Cost if wrong:* one function, `creditFor`. The full-cost rule is one line away.
- **Q-2. Previews are client-against-client, one at a time, memoised per snapshot.**
  - The base is `snapshot.display.state`, which is already advanced past unpins, and the "before" is `snapshot.display.solution`. Both come from this engine, so no cross-engine `Math.pow` noise appears in the diff. Rates on the lane rows still come only from the server's `schedule` (W-8).
  - A preview costs 4–13 ms (apply plus one `scheduleDetail`, measured). The drawer previews only the **selected** action, keyed by `JSON.stringify(actions)` in a `WeakMap<Snapshot, Map<string, Preview>>`. It is never recomputed at 4 Hz.
  - *Cost if wrong:* if a phone is slow, the preview moves into `requestIdleCallback`; the interface doesn't change.
- **Q-3. `quote()` mirrors the five spend reducers exactly, and a test pins it against their own effects.** For each spend, `quote(...).cost` equals the reducer's `spent` effect and `.refund` its `refunded` effect, string for string (`costEffect` emits canonical strings).
  - Affordability counts the refund for `UPGRADE_MARK`, because the reducer refunds before it spends. 4a's BUY-only `affordability` moves to `quote.ts` and takes any `Action`.
  - *Cost if wrong:* a reducer change that `quote` doesn't follow fails that test, not a player.
- **Q-4. Ladder progress counts machines of the best unlocked mark, and shows the next step's relative gain.**
  - `nextAt = (floor(input / interval) + 1) × interval`.
  - `more = ceil((nextAt − input) / bestMark.rateMultiplier)`.
  - The text is `"${more} more ${className(more)} → ×${format(next / now)}"`, where `now` and `next` are `ladderMultiplier` at the current and the next step (softcapped).
  - `format(D(1.5), "hybrid")` is "1.50", so the text reads "×1.50" (F.1 writes "×1.5"). Measured: a fresh world's iron Miners read "8 more Miners → ×1.50". Tier-8 iron Constructors (input 85, best Mk3 at ×4) read "2 more Constructors → ×1.50". The drawer also shows the ladder's current total (×25.6 there).
  - *Cost if wrong:* the text lives in `ladderProgress`.
- **Q-5. The frame gets the sim `bottleneck` policy's other three actions, frames a generator's scarcest input, and stays on the row for a power bottleneck.**
  - `storage` with `upgrade: "storage"` → `BUY_STORAGE { itemId, levels: 1 }`.
  - `storage` with `upgrade: "quantum"` → `BUY_QS { lane: item.lane, levels: 1 }`.
  - `upgrade: null` → no button.
  - `reserve` → `SET_RESERVE { itemId, percent }`, only while `state.reserve[itemId] !== percent`.
  - These are `apps/sim/src/policies.ts:396-427`, verbatim. `BottleneckModel.buy` becomes `action: FrameAction | null`.
  - **Generator framing (carried minor 3):** among the generator's stock inputs that render as rows, frame the one with the lowest P-1 satisfaction. Ties go to the lower storage fraction at `atMs`, then to authored input order. `burn_coal` has two inputs (`coal`, `water`).
  - **§13.2 says a power bottleneck's frame "moves" to the dock.** It doesn't here. The one frame (P-2) stays on the fuel row, because it carries the buy. The dock's grid bar takes `.state-bottleneck` and reads "Power limits production". It never shows a second "bottleneck" label, so F.1's single frame and the 4a e2e's `getByText("bottleneck", { exact: true })` count of 1 both hold.
  - *Cost if wrong:* moving the frame later touches `BottleneckFrame` and `PowerDock`.
- **Q-6. The drawer offers every D.1 machine verb, and every unlocked mark.** Tapping a row's first line opens the drawer for that item (§13.1). It holds:
  - **The machine section** for the lane-class of the item's active recipe:
    - per mark: owned, Buy ×1 / ×10 / ×max (with the best mark preselected), Dismantle ×1 / ×all-of-mark, and Upgrade;
    - pool and assignment;
    - ladder progress.
  - **Recipe select**, only when two or more recipes have the item as primary output.
  - **Storage +1** for the item, and **QS +1** for its lane.
  - **Upgrade** is the reducer's own: the whole stock of `fromMark` in that lane-class, shown as `"${owned} Mk${m} → ${floor(owned × rate_m / rate_{m+1})} Mk${m+1}"` (measured on tier 8: "11 Mk1 → 5 Mk2", "3 Mk2 → 1 Mk3").
  - **Why every mark, and assignment:** measured, a player who only presses the frame stalls for good at **tier 5**. The advice is a Constructor Mk3 for `make_steel_pipe`, priced in `steel_pipe`, which nothing makes yet (net 0). What gets past it is the sim's `idleReassignments` move: idle coal Constructors moved to `make_steel_pipe`. With it, plus milestone-first ordering, the same player reaches tier 10 (Q-14). So the assignment section shows each recipe's assigned count, running/idle (clock ≤ 1e-9, the sim's `IDLE_CLOCK`) and starved state. It offers steppers, plus one **"Move N idle <class> to <recipe>"** button, with N and the donor chosen by the sim's rule restricted to this lane-class. Each move is one batch, `[ASSIGN donor, ASSIGN receiver]`, donor first.
  - *Cost if wrong:* the drawer is one component over one pure model.
- **Q-7. The W-19 layout.**
  - **> 1000 px:** three panes (lanes | detail | priority).
  - **600–1000 px:** two panes (lanes | detail), with a Factory/Priority switch above the left pane.
  - **< 600 px:** one column, the bottom tab bar (Factory, Priority), the dock above it, and the drawer as a bottom sheet.
  - The dock is fixed at the bottom at every width. With the drawer closed, the detail pane shows a one-line hint.
  - The Handbook tab arrives in 4c. The 320 px e2e pass stays 4c, but nothing here may scroll horizontally at 320 px.
  - *Cost if wrong:* CSS and one `App` switch.
- **Q-8. The priority list shows only unlocked entries, and a reorder keeps hidden entries where they are.**
  - The slice's list has **32 entries from tier 0** (`start.priority` names every item so nothing is unprioritizable), against §13.3's "eight to twelve".
  - **Visible** entries are power, plus items with `item.tier <= state.tier` in an unlocked lane. A fresh world shows 6.
  - `REORDER_PRIORITY` needs the full permutation. Hidden entries keep their absolute indices, and the visible entries fill the remaining slots in their new order.
  - *Cost if wrong:* one pure function, `reorderVisible`.
- **Q-9. Power: move only, behind an inline confirm.**
  - The power row has no pause, mode, target or reserve controls. The engine allows them, but pausing power is the C.4 death spiral, and `SET_PRIORITY_MODE` is still reachable on every item entry.
  - Any move that takes power off index 0, or puts an entry above it, first shows an inline confirm: "Generators lose first call on fuel; a brownout can starve them (C.4). Move anyway?" It is a real `<div role="alertdialog">` with Move / Cancel buttons, not `window.confirm`, so it is accessible and Playwright can drive it. The confirm comes once per move (W-21).
  - **Simple** offers reorder and pause. **Advanced** adds mode (guaranteed/share), share weight, target rate and reserve % (0–50%, `MAX_RESERVE_PERCENT`) inline. In Simple, a row with any non-default advanced setting shows a "⋯" indicator with `aria-label="advanced settings in effect"`, and tapping it switches to Advanced (§4.1: "never hide a setting that is still in effect").
  - The Simple/Advanced choice is a per-viewer convenience in `localStorage` under `mi.priorityView`, wrapped in try/catch, with Simple as the default.
- **Q-10. Optimistic settings live in the component, not the store.**
  - `usePendingSetting` shows the requested value from the moment the intent is sent until **its** `send()` promise settles.
  - `send()` resolves after the response's snapshot is adopted (4a's outbox awaits `onOutcome`), so the control then simply falls back to the server's value: the new one on 200, the old one on 409. A GET snapshot that lands meanwhile doesn't move the control.
  - The numbers (split bars, satisfaction) only ever come from snapshots (W-13).
  - *Cost if wrong:* one hook.
- **Q-11. Taps live in the store, and two flushes are always at least 1 s apart** (carried minor 1).
  - **The hold:** `pressTap()` counts one tap at once and repeats every `TAP_REPEAT_MS` (100 ms) on the `ClientClock`. `releaseTap()` stops the repeat.
  - **The flush timer.** One timer; `lastFlushAt` starts at −∞, and a flush with nothing pending sends nothing and doesn't count.
    - While held, it sits at `max(lastFlushAt, pressAt) + TAP_FLUSH_EVERY_MS`, set on press and again after each flush. A hold from 0 flushes at 1,000, 2,000, 3,000 ….
    - On release with taps pending, it moves to `max(releaseAt + TAP_FLUSH_AFTER_RELEASE_MS, lastFlushAt + TAP_FLUSH_EVERY_MS)`.
    - A re-arm only ever moves the timer earlier, and never below `lastFlushAt + TAP_FLUSH_EVERY_MS`.
  - So tap-release-tap-release can't beat 1/s, which W-12's literal "300 ms after release" alone would allow. The last flush still lands within 1 s of the last release.
  - A flush is `TapAccumulator.take()` as its own one-action batch, labelled `"tap"`: never `count: 0`, never merged with a spend.
  - **On hidden or `pagehide`:** the store sends the pending taps at once, **bypassing the outbox**, with `fetch(…, { keepalive: true })` and a fresh key. A queued request can't outlive the page.
    - If the page survives (it was only hidden) and the outcome is `retry` or `paused`, the batch goes into the outbox **with the same key** (`Outbox.enqueue` gains an optional `key`).
    - Otherwise the response is handled like any POST.
  - The keepalive flush is the one exception to the 1 s floor.
  - *Cost if wrong:* a lost flush costs at most one second of taps (W-12).
- **Q-12. The dock's readouts.**
  - **Grid:** `display.solution.power.demandMw` against `supplyMw`, with `fullDemandMw` shown as "needs N MW" while `ratio < 1`. The bar is `role="meter"`.
  - **Stacks** (optimistic): `min(maxStacks, tapStacks + pending)`.
  - **Kick:** `tapMultiplier(content, { ...display.state, tapStacks: shownStacks })`, shown as "×1.50".
  - **Remaining:** the later of the server's `tap-expiry` timer (`TAP_TIMER_ID`, mapped through `localTimeOf`) and `lastTapAt + tap.durationSeconds × 1000`, counted down at 4 Hz.
  - **Injection:** "+25 MW" while the shown stacks are above 0.
  - **The tap target:** 58 px, `aria-label="Tap: hold to keep the kick"`. It holds by pointer (`pointerdown` with `setPointerCapture`; `pointerup`, `pointercancel` and `lostpointercapture` release), and by held Space or Enter, where `keydown` ignores `e.repeat` and `keyup` and `blur` release (W-20).
- **Q-13. The header tier readout moves into 4b from 4c**, because "playable to tier 10" without seeing the tier isn't playable.
  - It reads `Tier N · next: <milestone name>`, with one compact progress line per requirement: `shownStock / amount` (milestones deliver from liquid, R7), or "Tier 10 · complete" when `nextMilestoneCost` is null.
  - The store raises a `tier-up` toast ("Tier N reached.") when an adopted snapshot's `state.tier` is above the previous one's. That is the one celebration W-18 allows, in the polite live region.
- **Q-14. "Playable to tier 10" is proven in process, not in real time.**
  - **Real time is out of reach.** Measured: a frame-plus-drawer player reaches tier 1 at 1.5 h of game time and tier 10 at 132 h. The API has no fast clock, and a k× server under a 1× client was rejected in P-10. So **there is no "play to tier N" e2e.**
  - **The proof instead:** `ui/play.test.ts` is a scripted player that decides **only** from the client's own builders:
    - the frame's `action`;
    - the drawer's `idleMove`/`moveMachines`;
    - the priority list's `reorderVisible`, moving the next milestone's items to just below power.
  - It applies each action to engine state, and advances time with `resolve` by `affordability(...).inMs`, capped at 30 min.
  - Measured with the equivalent probe: tier 10 at 132 h game time, 718 actions, 1,098 decisions, 47 s wall locally. Tier 6 is at 9.2 h.
  - **Where it runs:**
    - `pnpm test` runs it to **tier 6**, in about 2 s;
    - a new CI job, `web-play`, runs it to **tier 10** (`WEB_PLAY_TIER=10`, about 2 min at the 2.43× runner factor, `timeout-minutes: 10`).
  - It is backed by Task 6's D.1 coverage test.
  - *Cost if wrong:* a UI-only stall that the scripted player avoids. The coverage test and the e2e specs bound that.
- **Q-15. Four e2e specs, each on its own guest.** Measured on a fresh world:
  - a Miner ×1 is affordable at 18 s;
  - the 4a Constructor at 43 s.

  The specs:
  - `drawer-buy`: about 25 s.
  - `priority-drag`: free actions.
  - `tap-hold`: about 4 s of hold.
  - `injected-failures`: `page.route` aborts and fulfils, plus `page.clock` for the GET case.

  Every wait is on the DOM or on a request (P-9). The one real-time wait is affordability. The job's `timeout-minutes: 15` stays.
- **Q-16. The content route memoises its serialised body per checksum** (carried minor 4, taken).
  - It is a `Map<string, string>` in `buildServer`'s closure, filled on the first 200 and never on a 404, and sent with `content-type: application/json`. Bundles are immutable under their checksum, and there are a handful per process.
  - *Cost if wrong:* a stale body is impossible by construction. Memory is about 29 KB per checksum.
- **Q-17. The W-4 lint ban covers bare Node builtins and dynamic `import()`** (carried minor 5). `builtinModules` from `node:module` gives the exact `paths` list (`fs`, `crypto`, `fs/promises`, …), and `no-restricted-syntax` bans `ImportExpression` in browser `src`. Nothing in the client lazy-loads today; a later code-split chunk takes a one-line exception.
- **Q-18. A GET answered with an unexpected 4xx stops polling until focus, visible or online** (4a behaviour, now pinned; carried minor 2).
  - W-11 says "drop, log, re-sync" for a POST. Re-syncing a failed GET would loop on the same 4xx.
  - The store already leaves the boundary timer unarmed after a GET `client-bug`. 4b exposes that as `StoreView.polling: boolean`, mirrored to `data-polling="armed|off"` on the root, and pins it in a unit test and in the e2e.

## Global Constraints

- **Where to work:** `.claude/worktrees/phase-4b` only, on branch **`phase-4b-play`**, already cut from `phase-4-web` at ab31179 (PR 4a, #23). 4b is stacked on 4a. Never work in the top-level checkout, which is stale, or in the `phase-4-web` worktree.
- **Commands:**
  - Never run `pnpm format`. It rewrites the whole repo.
  - Verify with `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, one at a time in the foreground. Never run lint or typecheck while a test run is going, and never run anything in the background: turbo builds race.
  - Never `pkill -f`. No `pgrep -f` loops.
  - No containers: no Docker, no compose. The dev server and e2e use PGlite.
- **No new dependencies, no migrations, no schema or action changes.** The engine gains no code in 4b (Task 1 touches only its tests). The API gains only Q-16's memo.
- **Browser code** never imports `@manufactory/content`, `@manufactory/api`, `@manufactory/sim` or a Node builtin, and never uses `import()`. That is lint-enforced (W-4, P-13, Q-17; Task 1 adds the `@manufactory/sim` group). Tests don't import `apps/sim` either: `play.test.ts` builds its player from the client's own builders (Q-14). `apps/web` gains no dependency on `@manufactory/sim`.
- **Rates on screen come from the server's `schedule`.** The engine is called only for the per-snapshot display solve (W-8) and previews (Q-2), and never at 4 Hz.
- **Motion:** only `transform` and `opacity` animate (the drag ghost is `translateY`, the sheet is `translateY`, bars are `scaleX`), all inside `prefers-reduced-motion: no-preference`. State colours are only referenced under `.state-*` or `.frame` selectors (4a test 8a).
- **Spends are pessimistic and settings are optimistic** (W-13). One intent is one batch, never merged (W-10).
- **Commit trailers, exactly:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **Preview honesty (Q-1 to Q-3):** `quote` equals the reducers' own `spent`/`refunded` effects; an affordable preview deep-equals `apply`; the shortfall credit drains to zero; `bound` changes no rate. Task 2 tests 1–4.
- **The tap's cadence (Q-11):** flushes are ≥ 1,000 ms apart, never `count: 0`, never merged with a spend; the hidden/pagehide flush uses `keepalive` and falls back to the outbox with the same key. Task 5 tests 1–4, and the e2e.
- **The reorder payload (Q-8, Q-9):** it is always a full permutation with hidden entries in place; the control is optimistic and reverts on 409; power moves only after the confirm. Task 4 tests 1–6.
- **Reachability (Q-6, Q-14):** each of the eleven D.1 actions is sent by real components, and the builder-only player reaches tier 10. Task 6.
- **Still one frame (Q-5):** the dock never adds a second "bottleneck" label. Task 5 test 6 and the 4a e2e.

---

### Task 1: the carried hygiene minors, test-first

**Files:**
- Modify: `packages/engine/src/resolve/schedule.test.ts`, `apps/api/src/server.ts`, `apps/api/src/server.test.ts`, `apps/web/src/styles/tokens.test.ts`, `apps/web/src/sync/interpolate.test.ts`, `eslint.config.js`

**Interfaces:**
- Consumes:
  - `schedule`, `scheduleDetail`, `serializeWorld`, `deserializeWorld` (engine);
  - `buildServer` (`apps/api/src/server.ts:185`, the content route);
  - `storageTransition` (`apps/web/src/sync/interpolate.ts:41`);
  - `builtinModules` (`node:module`).
- Produces no new exports. The content route's contract is unchanged (200 body, `cache-control: public, max-age=31536000, immutable`, 404 `{ error: "unknown content" }`). Only its implementation memoises:

```ts
// server.ts, inside buildServer
const contentBodies = new Map<string, string>(); // checksum → JSON body (Q-16)
// hit: reply.header("cache-control", …).type("application/json").send(contentBodies.get(checksum))
```

- [ ] **Step 1: Write the failing tests.**
  1. **`schedule.test.ts`, tier-8 goldens.** Add `GOLDEN_TIER_8` and `GOLDEN_TIER_8_REINFORCED_FULL`: the exact `JSON.stringify(schedule(fixture, slice))` strings, and assert them.
     - A probe confirmed that the pre-refactor engine at `fec8408^` produces byte-identical output on both fixtures (`probe4b-golden.mts`; lengths 1,877 and 1,798; `atMs` 48802190.91156746 and 51082190.91156746).
     - So paste today's output and say so in a comment: "equal to fec8408^'s schedule(), checked 2026-10-18".
  2. **`schedule.test.ts`, input unmutated.** For each of the four `detailWorlds`: `const before = serializeWorld(s); scheduleDetail(s, c); expect(serializeWorld(s)).toBe(before)`.
  3. **`server.test.ts`, the memo.** Wrap the test db's `query` in a counting spy. Two `GET /api/content/<current>` calls make exactly one `select bundle from content_versions` query, and both bodies are byte-equal with the same `cache-control`. Then two misses (`"0".repeat(64)`) make two queries: misses are not memoised.
  4. **`interpolate.test.ts`, draining.** Use a negative-net item from `slice-tier-8-reinforced-full.world.json` whose empty time comes before the boundary (pick it in the test by scanning `schedule.items` for `netPerSecond < 0` with `stock / −net × 1000 < nextBoundaryAtMs − atMs`). Then `storageTransition(...).to === 0`, and `durationMs` is the time to empty, ±1 ms.
  5. **`tokens.test.ts`:** retitle the second `"8a."` (line 155, "the matcher takes whole class tokens") to `"8c. the state-class matcher takes whole class tokens"`. Add a test, `"titles are unique"`, that reads this file's own source and fails on any repeated `it("NN.` prefix.
- [ ] **Step 2:** run `npx vitest run src/resolve/schedule.test.ts` in `packages/engine`, then `npx vitest run src/server.test.ts` in `apps/api`, then `pnpm --filter @manufactory/web test`. Tests 1, 2 and 4 pass at once (they pin existing behaviour). Test 3 fails (two queries). Test 5 fails until the retitle.
- [ ] **Step 3: Implement.**
  - The memo (Q-16).
  - The retitle.
  - **ESLint (Q-17):** in the browser block (`files: ["apps/web/src/**/*.{ts,tsx}"]`, with the same `ignores`), add to `@typescript-eslint/no-restricted-imports` a `paths: builtinModules.map((name) => ({ name, message: "W-4: browser code (a Node builtin)" }))`. Add a `group: ["@manufactory/sim", "@manufactory/sim/*"]` pattern ("the simulator is a Node app"). Add `"no-restricted-syntax": ["error", { selector: "ImportExpression", message: "Q-17: no dynamic import() in browser code; it bypasses the W-4 import ban" }]`.
- [ ] **Step 4:** run the three suites again, all green.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - Memoise misses too (cache the 404): test 3 fails.
  - At the end of `scheduleDetail`, write `state.lastResolvedAt = atMs` onto the input: test 2 fails on the fresh worlds, which step past an unpin.
  - **Lint:** add `import { readFileSync } from "fs";` to `apps/web/src/main.tsx`. `pnpm lint` must fail with the W-4 builtin message. Replace it with `void import("@manufactory/content");`, which must fail with the Q-17 message. Undo both.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Hygiene: tier-8 schedule goldens, memoised content body, draining bar, unique test titles, W-4 lint gaps`.

---

### Task 2: the pure spend layer: quote, preview, the drawer model and the frame's actions, test-first

**Files:**
- Create: `apps/web/src/ui/quote.ts`, `apps/web/src/ui/preview.ts`, `apps/web/src/ui/machines.ts`
- Modify: `apps/web/src/ui/derive.ts` (`BottleneckModel.action`, `FrameAction`, scarcest input; `affordability` moves out), `apps/web/src/ui/BottleneckFrame.tsx` (imports only; the UI change is Task 3)
- Test: `apps/web/src/ui/quote.test.ts`, `apps/web/src/ui/preview.test.ts`, `apps/web/src/ui/machines.test.ts`, `apps/web/src/ui/derive.test.ts` (update)

**Interfaces:**
- Consumes, all verified against `packages/engine/src`:
  - `apply(state, content, action, seed)` and `applyBatch(state, content, actions, seed)` (`actions/index.ts`);
  - `machineCostRange(content, machineClass, mark, fromCount, count)` and `levelCostRange(curve, fromLevel, levels)` (`economy/curves.ts:153,181`);
  - `ladderInput` and `ladderMultiplier(content, state, lane, machineClass)` (`curves.ts:69,88`);
  - `bestUnlockedMark(content, machineClass, tier)` (`economy/capacity.ts:61`);
  - `isLiveRecipe(content, recipeId, tier, activeRecipe)` and `getMark` (`graph/index-content.ts:65,73`);
  - `installedAt`, `installedMachines`, `assignedTotal`, `POWER_ENTRY_ID` (`state/world.ts`);
  - `liquid`, `liquidCap`, `storageCap`, `quantumCap`, `canAffordBuild` (`economy/storage.ts`);
  - `scheduleDetail` (`resolve/index.ts:291`);
  - `MAX_ACTION_COUNT = 1000` (`actions/types.ts:10`);
  - `MAX_RESERVE_PERCENT = 0.5` (`actions/economy.ts:14`);
  - the types `Effect`, `Bottleneck`, `PowerReport`, `Solution`;
  - `content.recipesByLaneClass` (keys `laneClassKey(lane, class)` = `"lane::class"`), `content.producersOf`, `recipe.primaryOutput`, `recipe.inCycle`, `recipe.def.unlockTier`, `content.bundle.storage` and `.quantumStorage` (`maxLevel` 22 and 16 on the slice).

  The reducers these mirror (`actions/machines.ts`, `actions/economy.ts`):
  - `BUY_MACHINE` cost is `machineCostRange(class, mark, installedAt(mark), count)`;
  - `DISMANTLE` refund is `machineCostRange(class, mark, owned − count, count)`;
  - `UPGRADE_MARK` refund is `machineCostRange(class, from, 0, owned)` **then** cost `machineCostRange(class, from + 1, installedAt(from + 1), floor(owned × r_from / r_to))`, and it upgrades the **whole** stock of `fromMark`;
  - `BUY_STORAGE` and `BUY_QS` cost `levelCostRange(curve, level, levels)`;
  - builds spend bound → quantum → stored, then `settleBound` (`economy/storage.ts:320`).
- Produces:

```ts
// quote.ts
export type SpendAction = Extract<Action, { type: "BUY_MACHINE" | "UPGRADE_MARK" | "DISMANTLE" | "BUY_STORAGE" | "BUY_QS" }>;
export interface Quote { cost: Map<ItemId, Dec>; refund: Map<ItemId, Dec> }
export function isSpend(a: Action): a is SpendAction;
/** Exactly the reducer's spent/refunded amounts; empty maps for settings and TAP (Q-3). Never throws:
 *  an action the reducer would reject (unknown mark, count 0) gets empty maps. */
export function quote(content: IndexedContent, state: WorldState, action: Action): Quote;
/** Q-1: per cost item, max(0, cost − liquid − bound − refund). */
export function creditFor(state: WorldState, q: Quote): Map<ItemId, Dec>;
export type Affordability = { affordable: true } | { affordable: false; inMs: number | null /* null = not on current rates */ };
/** 4a's affordability, widened to any Action: have = shownStock + bound + refund, at serverMs (4 Hz). */
export function affordability(s: Snapshot, action: Action, serverMs: number): Affordability;
/** The largest count in 0..MAX_ACTION_COUNT affordable at serverMs (binary search on machineCostRange). */
export function maxAffordableCount(s: Snapshot, lane: LaneId, machineClass: MachineClassId, mark: number, serverMs: number): number;

// preview.ts (W-13, Q-1, Q-2)
export interface RateDelta { itemId: ItemId; before: number; after: number }
export type Preview =
  | { ok: true; credit: Map<ItemId, Dec>; effects: Effect[]; state: WorldState; solution: Solution;
      deltas: RateDelta[];                       // |after − before| > 1e-9 · max(1, |before|), largest relative change first
      power: { before: PowerReport; after: PowerReport };
      bottleneck: { before: Bottleneck; after: Bottleneck } }
  | { ok: false; reason: string };               // the reducer's own rejection text
/** base = s.display.state; credit = creditFor(base, quote(base, spend)); applyBatch(base + credit in bound); scheduleDetail.
 *  At most one SpendAction in `actions` (throws otherwise). Memoised per (snapshot, JSON.stringify(actions)). */
export function preview(s: Snapshot, actions: readonly Action[]): Preview;
/** Plain lines for the drawer: "Iron Plate +0.333/s → +0.667/s", "Power 22.0 / 200 MW → 26.0 / 200 MW" (engine `format`, "hybrid"),
 *  "Clears the bottleneck" (when after differs from before), or "No change to rates now" (pillar 4). Lane's items first, at most 4 rate lines. */
export function previewLines(s: Snapshot, p: Preview, laneId: LaneId): string[];

// machines.ts: the drawer model, pure, once per (snapshot, itemId)
export interface LadderProgress { input: number; nextAt: number; more: number; multiplier: number; nextMultiplier: number; text: string } // Q-4
export interface MarkRow { mark: number; name: string; owned: number; unlocked: boolean;
  upgrade: Extract<Action, { type: "UPGRADE_MARK" }> | null;   // null when mark+1 is missing or locked, or owned is 0
  consolidation: { from: number; to: number; toMark: number } | null; // floor(owned × r_m / r_{m+1}); to may be 0 → upgradeBlocked
  upgradeBlocked: string | null }                               // "need at least 2 to upgrade", mirroring the reducer
export interface AssignRow { recipeId: RecipeId; name: string; assigned: number; live: boolean; idle: boolean; starved: boolean }
export interface MachineSection { lane: LaneId; machineClass: MachineClassId; className: string; recipeId: RecipeId | null;
  pool: number; unassigned: number; bestMark: number | null; marks: MarkRow[]; ladder: LadderProgress | null; assign: AssignRow[] }
export interface LevelSection<A> { level: number; maxLevel: number; cap: Dec; nextCap: Dec | null; buy: A | null /* null at maxLevel */ }
export interface RecipeChoice { recipeId: RecipeId; name: string; active: boolean; unlockTier: number; inCycle: boolean;
  select: Extract<Action, { type: "SELECT_RECIPE" }> | null }
export interface DrawerModel { itemId: ItemId; name: string; laneId: LaneId;
  machines: MachineSection | null;               // the lane-class of the item's active recipe; null if the item has no producer
  recipes: RecipeChoice[];                       // [] unless ≥ 2 recipes have the item as primaryOutput
  storage: LevelSection<Extract<Action, { type: "BUY_STORAGE" }>>;
  qs: LevelSection<Extract<Action, { type: "BUY_QS" }>> }
export function drawerModel(s: Snapshot, itemId: ItemId): DrawerModel;
export function ladderProgress(s: Snapshot, lane: LaneId, machineClass: MachineClassId): LadderProgress | null;
export function buyAction(sec: MachineSection, mark: number, count: number): Extract<Action, { type: "BUY_MACHINE" }>; // recipeId while live
export function dismantleAction(sec: MachineSection, mark: number, count: number): Extract<Action, { type: "DISMANTLE" }>;
/** One batch, donor first (ASSIGN_MACHINES sets a count and rejects an oversubscribed pool). */
export function moveMachines(sec: MachineSection, from: RecipeId, to: RecipeId, n: number): [Action, Action];
/** The sim's idleReassignments rule, for this lane-class only: the best-ranked starved live recipe,
 *  and the donor with the most machines whose clock ≤ 1e-9; n = max(1, floor(held / 2)), none if n ≥ held. */
export function idleMove(s: Snapshot, sec: MachineSection): { from: RecipeId; to: RecipeId; n: number } | null;

// derive.ts (changed)
export type FrameAction = BuyMachine | Extract<Action, { type: "BUY_STORAGE" | "BUY_QS" | "SET_RESERVE" }>;
export interface BottleneckModel { laneId: LaneId | null; itemId: ItemId | null; text: string; action: FrameAction | null } // `buy` → `action` (Q-5)
```

- [ ] **Step 1: Write the failing tests.** Fixtures come from `ui/test-fixtures.ts`: `loadSlice`, `snapshotOf`, `freshState`, `fixtureState`. `t8` is `snapshotOf(slice, fixtureState("slice-tier-8.world.json"))`, and `fresh` is `snapshotOf(slice, freshState(slice))`.
  1. **`quote` = the reducer** (`quote.test.ts`). For each action, on `t8.display.state`, `apply(...)` is accepted and:
     - `Object.fromEntries([...quote.cost].map(([k, v]) => [k, v.toString()]))` equals its `spent` effect's `items`;
     - likewise `refund` against `refunded`.

     The actions: `BUY_MACHINE` power/collector/mk2 ×10; `BUY_MACHINE` iron/constructor/mk3 ×1; `DISMANTLE` iron/constructor/mk1 ×1; `UPGRADE_MARK` iron/constructor from 1; `UPGRADE_MARK` iron/miner from 1; `BUY_STORAGE` iron_plate ×1; `BUY_QS` iron ×1.

     A settings action and `TAP` give empty maps.
  2. **An affordable preview is the real purchase** (Q-1). For `BUY_MACHINE` iron/constructor/mk3 ×1 on `t8`:
     - `creditFor` is empty;
     - `preview(...).state` deep-equals `apply(t8.display.state, …).state`;
     - every `deltas` entry matches `scheduleDetail(real).solution`.
  3. **An unaffordable preview drains the shortfall exactly.** On a fresh world, `BUY_MACHINE` iron/constructor/mk1 ×1 with `recipeId: "make_iron_plate"`:
     - `credit.get("iron_ingot")` ≈ 21.3138 (the cost minus a liquid of 4.8e-10);
     - in `preview.state`, `liquid + bound` of `iron_ingot` is ≤ `21.31 × 1e-9`, and `bound.iron_ingot` is 0;
     - every other item's `stored`, `quantum` and `bound` equals the base's;
     - `deltas` include `iron_plate` 0.3333 → 0.6667 and `iron_ingot` 0.5 → 0;
     - `power.after.demandMw` is about 26 against 22 before.
  4. **Bound changes no rate** (W-13's guard). On both tier-8 fixtures, `solve({ ...s, bound: every stock item → D(1e6) })` has the same `itemRates` net for every item, and the same `bottleneck`, as `solve(s)`. Measured identical.
  5. **`preview` passes rejections through, and memoises.**
     - On a fresh world, `UPGRADE_MARK` iron/constructor from 1 gives `{ ok: false, reason: "\"constructor\" mk2 unlocks at tier 2" }`.
     - Two calls with equal actions return the same object, and a new snapshot recomputes.
     - Two spends in one call throw.
  6. **`affordability`, widened.**
     - 4a's derive test 6 moves here unchanged: about 42.6 s, then affordable at +60 s.
     - `UPGRADE_MARK` counts its refund.
     - `SET_RESERVE` is always affordable.
     - `maxAffordableCount` on `t8` for power/collector/mk2 is ≥ 10 and < `MAX_ACTION_COUNT`. It is exact: count n is affordable and n + 1 is not.
  7. **`machines.ts`** (`machines.test.ts`):
     - fresh `iron_ore` → `machines.machineClass === "miner"`, `ladder.text === "8 more Miners → ×1.50"`;
     - `t8` `iron_plate` → constructor section, `ladder.text === "2 more Constructors → ×1.50"`, `ladder.multiplier` ≈ 25.63;
     - marks: Mk1 `consolidation` `{ from: 11, to: 5, toMark: 2 }`, Mk2 `{ from: 3, to: 1, toMark: 3 }`, Mk3 `upgrade: null`;
     - a fresh Constructor Mk1 has `upgrade: null` (Mk2 unlocks at tier 2);
     - consolidations equal the counts in `preview([upgrade]).effects`' `removed`/`installed`;
     - `recipes` for `t8` `plastic` has `refine_plastic` and `refine_residual_plastic` (both unlocked at tier 8), and one is `active`;
     - `iron_plate` has `recipes: []` (its alt is a different item);
     - `storage.buy` on a fresh world is `BUY_STORAGE { iron_ore, levels: 1 }`, and is null at `maxLevel`;
     - `qs.buy` is `BUY_QS { lane: "iron", levels: 1 }`;
     - `buyAction(sec, 1, 1)` on fresh `iron_plate` includes `recipeId: "make_iron_plate"`.
  8. **`idleMove`.** Build a tier-5 state (`{ ...freshState(slice), tier: 5 }`, then `withInstalled(…, "coal", "constructor", 1, 6)`).
     - Assignment: all 6 on `make_concrete`.
     - `concrete` and `steel_beam` are both at their liquid cap, through `stored`. FULL `concrete` gives `make_concrete` clock 0, so it is the donor. FULL `steel_beam` keeps `make_steel_beam` (which ranks above pipe in `start.priority`) out of the starved list.
     - `make_steel_pipe` has 0 assigned, so it is starved.

     The move is `{ from: "make_concrete", to: "make_steel_pipe", n: 3 }`, and `moveMachines` gives `[ASSIGN make_concrete 3, ASSIGN make_steel_pipe 3]`. `applyBatch` accepts it. Call this state `STARVED_PIPE` and export it from `test-fixtures.ts` for Task 3.
  9. **The frame's actions** (`derive.test.ts`). Rename `buy` → `action` throughout the existing tests, then:
     - a stub `storage` bottleneck with `upgrade: "storage"` gives `BUY_STORAGE { itemId, levels: 1 }`;
     - `upgrade: "quantum"` gives `BUY_QS { lane: item.lane, levels: 1 }`;
     - `upgrade: null` gives null;
     - `reserve` with `percent: 0.25` gives `SET_RESERVE { itemId, percent: 0.25 }`, and null once `state.reserve[itemId] === 0.25`.
  10. **Scarcest input** (carried minor 3). A stub `power` bottleneck with `generatorRecipeId: "burn_coal"`, on a tier-6 state where `water` is short (satisfaction below `coal`'s), frames `water` in lane `oil`. Flipped so `coal` is short, it frames `coal`. Replace the existing title "a generator frames its first stock input" with "a generator frames its scarcest stock input".
- [ ] **Step 2:** run `pnpm --filter @manufactory/web test`. The new tests fail: the modules don't exist, and `action` isn't a field.
- [ ] **Step 3: Implement** to the interfaces.
  - `previewLines` formats rates with 4a's `rateText` and power with `format(D(mw), "hybrid")`.
  - `BottleneckFrame.tsx` changes only its imports here, plus a temporary narrowing (`model.action?.type === "BUY_MACHINE"`), so the build stays green. Task 3 renders the other actions.
- [ ] **Step 4:** run the web tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - `creditFor` returns the whole cost: test 2 fails (`steel_pipe` stays at 2,000).
  - `quote` for `UPGRADE_MARK` uses `installedAt(from)` as the Mk+1 starting count: test 1 fails.
  - `ladderProgress` divides by Mk1's rate instead of the best mark's: test 7 fails ("5 more", not "2 more").
  - Frame a generator's first input: test 10 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: quote, preview and the drawer model; the frame's storage, QS and reserve actions (W-1, W-13)`.

---

### Task 3: the buy drawer, the pane layout, and the frame's new buttons

**Files:**
- Create: `apps/web/src/ui/Drawer.tsx` + `Drawer.module.css`, `apps/web/src/ui/Projection.tsx`, `apps/web/src/ui/Layout.module.css`
- Modify: `apps/web/src/ui/App.tsx` (the layout, `openItem` state, the Factory/Priority switch with an empty Priority slot until Task 4, and a dock slot until Task 5), `apps/web/src/ui/ItemRow.tsx` (the first line becomes the open button), `apps/web/src/ui/LaneView.tsx`, `apps/web/src/ui/BottleneckFrame.tsx` (renders any `FrameAction`), `apps/web/src/ui/test-fixtures.ts` (gains `fakeStore`, moved from `LaneView.test.tsx` and extended), `apps/web/src/styles/base.css`
- Test: `apps/web/src/ui/Drawer.test.tsx` (jsdom), `apps/web/src/ui/LaneView.test.tsx` (now imports `fakeStore`)

**Interfaces:**
- Consumes: Task 2's `drawerModel`, `preview`, `previewLines`, `affordability`, `maxAffordableCount`, `buyAction`, `dismantleAction`, `moveMachines` and `idleMove`; `GameStore.send`, `GameStore.now` and `StoreView.pending`.
- Produces:

```ts
// Drawer.tsx
export interface DrawerProps { store: Pick<GameStore, "now" | "send">; snapshot: Snapshot; itemId: ItemId;
  pending: readonly Batch[]; onClose(): void }
export function Drawer(p: DrawerProps): JSX.Element;
// Batch labels, so a spend's button is busy while its batch is pending (W-13, pessimistic):
export const drawerLabel = (itemId: ItemId, verb: "buy" | "dismantle" | "upgrade" | "storage" | "qs" | "recipe" | "assign") => `drawer:${itemId}:${verb}`;
// Projection.tsx: renders previewLines for the selected action; aria-live="off"; data-preview
export function Projection(p: { snapshot: Snapshot; actions: readonly Action[] | null; laneId: LaneId }): JSX.Element;
// ItemRow gains: onOpen?: (itemId: ItemId) => void; the name/rate line is <button aria-expanded aria-controls="detail">
// test-fixtures.ts
export function fakeStore(snapshot: Snapshot | null, opts?: { now?: number }): FakeStore; // + pressTap/releaseTap/flushTaps vi.fn() for Task 5
```

**UI rules:**
- **The drawer** is `<section id="detail" aria-labelledby="drawer-title" data-drawer={itemId}>`. Escape and a Close button close it. Focus moves to the title on open, and back to the row's button on close.
  - Under 600 px it is a bottom sheet, `position: fixed`, with a `translateY` entrance inside the reduced-motion guard. It is `role="dialog" aria-modal="false"`.
- **Action picker:** a segmented control over Buy / Upgrade / Dismantle / Recipe / Storage / Assign. It holds only the sections the model has. One `Projection` shows the selected action's preview (Q-2).
- **Buy:**
  - a mark select (unlocked marks only; best preselected);
  - count buttons ×1 / ×10 / ×max (the max is `maxAffordableCount`, at least 1 for display);
  - the cost list with `format(…, "hybrid")`, each item red when short;
  - the "affordable in 43s" countdown (4 Hz, `useTick`);
  - the ladder line;
  - "Buy N <class>": disabled until affordable, then `aria-busy` while its label is pending.
- **Upgrade:** one row per owned mark with an upgrade, reading "11 Mk1 → 5 Mk2", with the cost and a button. `upgradeBlocked` text shows when it applies.
- **Dismantle:** per mark, ×1 or all, with the refund shown ("refunds 21.3 Iron Ingot; to Quantum Storage first, then BOUND", C.5 in one line).
- **Recipe:** a radio group of `RecipeChoice`. A locked or in-cycle choice is disabled, with its reason. Selecting sends `SELECT_RECIPE`. It is optimistic (Q-10): the radio holds while the batch is pending.
- **Storage / QS:** the level as "Lv 4 / 22", cap now → next, the cost, and a +1 button.
- **Assign:** a row per recipe in the lane-class: name, assigned, "running/idle/starved", and − / + steppers (each sends one `ASSIGN_MACHINES`, disabled when the result would oversubscribe the pool or go below 0). Above them, the one-click `idleMove` button when one exists. All optimistic (Q-10).
- **The frame** renders any `FrameAction`:
  - "Buy N <class>" (as 4a);
  - "Buy storage for <item>";
  - "Buy Quantum Storage for <lane>";
  - "Reserve 25% of <item>" (always enabled; optimistic).

  All are labelled `BOTTLENECK_BUY_LABEL` for the busy state. The 4a text "bottleneck" label is unchanged.
- **Layout (Q-7):** `App` renders `header`, `Notices`, then `<div class="layout" data-panes="1|2|3">`. The pane count comes from a `matchMedia` hook. The lanes pane (tabs + `LaneView`), the detail pane (`Drawer`, or a hint "Tap a row to buy, upgrade or store"), and the priority slot (Task 4) sit inside it. `data-panes` is for e2e and tests only.

- [ ] **Step 1: Write the failing tests** (`Drawer.test.tsx`, `// @vitest-environment jsdom`, fed `fakeStore`).
  1. **Open and close.**
     - Clicking the fresh `iron_ore` row's button renders `[data-drawer="iron_ore"]`, with "Miner" and "8 more Miners → ×1.50".
     - Escape closes it, and focus returns to the row button.
     - The frame's own buy button does **not** open the drawer.
  2. **Projection before purchase.** On fresh `iron_plate` with Buy ×1 selected, `[data-preview]` contains "Iron Plate" with "+0.667/s", and a "Power" line.
  3. **Buy is pessimistic and exact.**
     - At `atMs + 60 s`, clicking "Buy 1 Constructor" calls `send` once with `[{ type: "BUY_MACHINE", lane: "iron", machineClass: "constructor", mark: 1, count: 1, recipeId: "make_iron_plate" }]` and label `drawer:iron_plate:buy`.
     - With that label pending, the button is disabled and `aria-busy="true"`.
     - The owned count doesn't change until a new snapshot is set.
  4. **Upgrade and dismantle on tier 8.**
     - `iron_plate`'s Upgrade tab lists "11 Mk1 → 5 Mk2" and "3 Mk2 → 1 Mk3". Clicking the first sends `UPGRADE_MARK { lane: "iron", machineClass: "constructor", fromMark: 1 }`.
     - Dismantle ×1 at Mk1 sends `DISMANTLE … mark: 1, count: 1`, and shows a refund line.
  5. **Storage, QS and recipe.**
     - The storage +1 sends `BUY_STORAGE`, and QS +1 sends `BUY_QS { lane: "iron", levels: 1 }`.
     - On tier-8 `plastic`, choosing `refine_residual_plastic` sends `SELECT_RECIPE`. The radio stays on the new choice while pending, and returns to the server's choice once `send` resolves with `{ kind: "rejected" }` and the view is unchanged.
  6. **Assign.** On `STARVED_PIPE` (Task 2 test 8), the drawer for `steel_pipe` shows "Move 3 idle Constructors to Steel Pipe", and clicking it sends both `ASSIGN_MACHINES` in **one** `send` call, donor first.
  7. **Frame buttons.**
     - A stub reserve bottleneck renders "Reserve 25% of Iron Ingot", and clicking it sends `SET_RESERVE`.
     - A stub storage-upgrade bottleneck renders "Buy storage for Iron Plate".
     - Still exactly one frame label.
  8. **Layout.** With `matchMedia` stubbed to 1200 px, `data-panes="3"`; at 800, `"2"`; at 400, `"1"`, with the Factory/Priority tab bar present. At 400 the open drawer has `role="dialog"`.
- [ ] **Step 2:** run the web tests. The new ones fail.
- [ ] **Step 3: Implement.** Move `fakeStore` into `test-fixtures.ts` and update `LaneView.test.tsx`'s import. The 4a tests must pass unchanged in substance. The only edit allowed is `buy` → `action` where they assert P-3's buy.
- [ ] **Step 4:** run the web tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - Make the buy optimistic, bumping the owned count on click: test 3 fails.
  - Send the two `ASSIGN_MACHINES` as two `send` calls: test 6 fails.
  - Give the dismantle button the buy's label: test 3's busy check fails, or test 4's busy check does.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: the buy drawer, projected effect and ladder progress, the pane layout, the frame's storage and reserve buttons (W-1, W-13, W-19)`.

---

### Task 4: the priority list, test-first

**Files:**
- Create: `apps/web/src/ui/priority-model.ts`, `apps/web/src/ui/PriorityList.tsx` + `PriorityList.module.css`, `apps/web/src/ui/use-pending.ts`
- Modify: `apps/web/src/ui/App.tsx` (fills the priority slot/tab), `apps/web/src/ui/ItemRow.tsx` (the split bar becomes a button that focuses that item's entry in the list, §13.1)
- Test: `apps/web/src/ui/priority-model.test.ts`, `apps/web/src/ui/PriorityList.test.tsx` (jsdom)

**Interfaces:**
- Consumes:
  - `state.priority: PriorityEntry[]` (`{ id, kind: "power" | "item", itemId, mode: "guaranteed" | "share", share, targetRate, paused }`, `state/world.ts:25`);
  - `POWER_ENTRY_ID = "power"`;
  - `state.reserve`, `MAX_RESERVE_PERCENT`;
  - P-1's `satisfaction`, and `display.solution.power.ratio`;
  - the reducers' rules:
    - `REORDER_PRIORITY` needs the exact permutation (`actions/economy.ts:22`);
    - `SET_PRIORITY_MODE` needs `mode` and rejects `share ≤ 0` in share mode and a negative or non-finite target;
    - `SET_RESERVE` rejects `percent > 0.5`.
- Produces:

```ts
// priority-model.ts
export interface PriorityRowModel { entryId: string; kind: "power" | "item"; itemId: ItemId | null; name: string;
  satisfaction: number;             // P-1 for items; min(1, power.ratio) for power
  mode: PriorityMode; share: number; targetRate: number | null; paused: boolean; reserve: number;
  nonDefault: boolean }             // mode !== "guaranteed" || share !== 1 || targetRate !== null || reserve > 0 (paused is Simple-visible)
export function visiblePriority(s: Snapshot): PriorityRowModel[];           // Q-8: power + unlocked items, in list order
/** Q-8: the full permutation after moving `id` to visible index `to`; hidden ids keep their absolute indices. */
export function reorderVisible(all: readonly string[], visible: readonly string[], id: string, to: number): string[];
/** Q-9: true when `after` takes power off index 0, or puts an entry above it, and `before` had it at 0. */
export function powerMoveNeedsConfirm(before: readonly string[], after: readonly string[]): boolean;
/** The drop slot for a pointer at clientY over rows with these vertical midpoints (W-21's drag, testable without layout). */
export function dropIndex(midpoints: readonly number[], clientY: number): number;

// use-pending.ts (Q-10)
export function usePendingSetting<T>(server: T): { shown: T; run(next: T, send: () => Promise<Outcome>): void };
//   shown = the latest `next` while its promise is unsettled, else `server`; a newer run supersedes an older one

// PriorityList.tsx
export function PriorityList(p: { store: Pick<GameStore, "send">; snapshot: Snapshot; pending: readonly Batch[];
  focusEntry?: string | null }): JSX.Element;
export const PRIORITY_LABEL = "priority";
```

**UI rules:**
- The list is `<ol aria-label="Output priority">`. Each row is `<li data-entry={entryId}>` with:
  - a drag handle (`<button aria-label="Drag to reorder <name>">`);
  - the name;
  - the satisfaction chip (`NN%`, `paused`, or `idle`, with a state class as 4a's `stateClass`);
  - ▲ / ▼ buttons;
  - pause (items only);
  - in Advanced, a second line of inline controls:
    - a mode toggle chip ("guaranteed" / "share N");
    - a share weight `<input type=number min=0.1 step=0.1>`;
    - a target `<input type=number min=0>`, empty meaning null;
    - a reserve `<input type=range min=0 max=50 step=5>` showing "NN%".
- **Drag (W-21):**
  - `pointerdown` on the handle calls `setPointerCapture`;
  - `pointermove` sets the row's `transform: translateY(dy)`, which is the ghost, and marks the drop slot from `dropIndex` over the rows' midpoints, read once at `pointerdown`;
  - `pointerup` drops, and `pointercancel` reverts.
- **Keyboard:** Alt+↑ / Alt+↓ on a focused row moves it one place, and focus follows it.
- **Each move is one intent → one `REORDER_PRIORITY` batch** with `reorderVisible`'s payload, behind the Q-9 confirm where `powerMoveNeedsConfirm` says so.
- **Pause and Advanced edits** each send one `SET_PRIORITY_MODE`, always with `mode`, plus the changed field. A reserve change sends one `SET_RESERVE`, committed on `change`, not on every `input`.
- **The list is optimistic** (Q-10): the order, pause and mode show at once, and revert when the batch settles without adoption. The satisfaction chips change only with snapshots.

- [ ] **Step 1: Write the failing tests.**
  1. **`visiblePriority`:**
     - a fresh world gives `["power", "item:iron_plate", "item:iron_rod", "item:iron_ingot", "item:iron_ore", "item:biomass"]`, in that order, out of 32 entries;
     - tier 8 gives every entry whose item is unlocked;
     - power's satisfaction on tier 8 is ≈ 0.163 (the fixture's ratio).
  2. **`reorderVisible`:**
     - moving `item:iron_rod` to visible index 1 on a fresh world swaps it with `item:iron_plate`, and leaves all 26 hidden ids at their indices;
     - the result is always a permutation (a property test over random moves on the fresh and tier-8 lists, with a fixed seed);
     - `apply(REORDER_PRIORITY)` accepts it.
  3. **`powerMoveNeedsConfirm`:** it is true for power moving to index 1, and for an item moving to index 0. It is false for a move between items 1 and 2, and for any move when power was already off index 0.
  4. **`dropIndex`:** for midpoints `[10, 30, 50]`, y 0 → 0, 20 → 1, 45 → 2, 99 → 3.
  5. **Keyboard reorder (jsdom).**
     - Focus `item:iron_rod`'s row and press Alt+↑. `send` is called once with `[{ type: "REORDER_PRIORITY", entries: <test 2's payload> }]` and label `"priority"`.
     - While its promise is pending, the DOM order shows `iron_rod` above `iron_plate`.
     - After it resolves `{ kind: "rejected" }` with the snapshot unchanged, the DOM order is back.
  6. **The power warning.**
     - Alt+↓ on power shows `role="alertdialog"` with "C.4", and `send` is not called.
     - Cancel sends nothing, and the order is unchanged.
     - Move sends the reorder once.
     - A second move of an item between items 1 and 2 shows no dialog.
  7. **Simple / Advanced.**
     - In Simple there are no mode or target inputs.
     - A tier-8 entry given `mode: "share"` in a hand-built state shows the "advanced settings in effect" indicator, and clicking it switches to Advanced.
     - In Advanced, switching mode sends `SET_PRIORITY_MODE { entryId, mode: "share" }`.
     - Setting the target to 5 sends `{ …, mode: <current>, targetRate: 5 }`, and clearing it sends `targetRate: null`.
     - The reserve slider at 25 sends `SET_RESERVE { itemId, percent: 0.25 }`, and its `max` is 50.
     - The power row has none of these controls, and no pause.
  8. **Pause** sends `SET_PRIORITY_MODE { entryId, mode, paused: true }`, and the row shows "paused" at once (optimistic).
- [ ] **Step 2:** run the web tests. The new ones fail.
- [ ] **Step 3: Implement.** `App` mounts `PriorityList` in the third pane at 3 panes, and behind the Priority tab or switch otherwise. Clicking a split bar sets `focusEntry`, and the list scrolls that row into view and focuses it.
- [ ] **Step 4:** run the web tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - `reorderVisible` sends only the visible ids: test 2's `apply` rejects ("expected 32 entries").
  - `usePendingSetting` keeps `next` after a rejected settle: test 5 fails.
  - Skip the confirm: test 6 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: the priority list: drag, keyboard and buttons, Simple/Advanced, pinned power, reserves (W-1, W-13, W-21)`.

---

### Task 5: taps in the store, the power dock, the tier readout, and the GET-4xx pin

**Files:**
- Modify: `apps/web/src/sync/store.ts`, `apps/web/src/sync/outbox.ts` (`enqueue` takes an optional key), `apps/web/src/sync/constants.ts` (`TAP_LABEL = "tap"`), `apps/web/src/main.tsx` (`pagehide` and the hidden flush), `apps/web/src/ui/App.tsx` (the dock, the readout, `data-polling`), `apps/web/src/ui/Notices.tsx` (the `tier-up` toast, added to `TOASTS` so it is dismissable), `apps/web/src/ui/test-fixtures.ts` (`fakeStore`'s `taps` and `polling`)
- Create: `apps/web/src/ui/dock-model.ts`, `apps/web/src/ui/PowerDock.tsx` + `PowerDock.module.css`, `apps/web/src/ui/TierReadout.tsx`
- Test: `apps/web/src/sync/store.test.ts` (extend), `apps/web/src/sync/outbox.test.ts` (extend), `apps/web/src/ui/PowerDock.test.tsx` (jsdom), `apps/web/src/ui/dock-model.test.ts`

**Interfaces:**
- Consumes:
  - `TapAccumulator` (`sync/taps.ts`), and `TAP_REPEAT_MS`, `TAP_FLUSH_EVERY_MS` and `TAP_FLUSH_AFTER_RELEASE_MS` (`sync/constants.ts`);
  - `TAP_TIMER_ID` and `TAP_MIN_INTERVAL_MS` (`actions/economy.ts:17,20`);
  - `tapMultiplier(content, state)` (`curves.ts:127`);
  - `content.bundle.tap` (slice: `{ kickPerStack: 0.05, durationSeconds: 30, maxStacks: 10, powerInjectionMw: 25 }`);
  - `Solution.power: { demandMw, fullDemandMw, supplyMw, ratio }` (`solve/power.ts:24`; `supplyMw` already includes the tap injection, `solve.ts:111`);
  - `nextMilestoneCost(content, state)` (`resolve/index.ts:92`), and `content.milestoneByTier`.
- Produces:

```ts
// outbox.ts
enqueue(actions: Action[], label: string, opts?: { key?: string }): Promise<Outcome>;   // key defaults to newIdempotencyKey()

// store.ts
export interface Notice { kind: /* 4a's kinds */ | "tier-up"; text: string; retryAt?: number }
export interface StoreView { /* 4a's fields */
  taps: { pending: number; lastTapAt: number | null; holding: boolean };
  /** The boundary timer is armed (Q-18). Mirrored as data-polling="armed|off". */
  polling: boolean }
export class GameStore { /* 4a's API */
  pressTap(): void;                                  // tap now, start the TAP_REPEAT_MS repeat (Q-11)
  releaseTap(): void;                                // stop the repeat; pull the flush to max(now+300, lastFlush+1000)
  flushTaps(opts?: { keepalive?: boolean }): void;   // keepalive: send now, bypassing the outbox and the 1 s floor; else flush now only if now ≥ lastFlushAt + 1000, otherwise leave the timer
}

// dock-model.ts
export interface DockModel { demandMw: number; supplyMw: number; fullDemandMw: number; ratio: number;
  limited: boolean;                 // kind "power", or kind "recipe" whose limitingTarget is power (derive.ts isPowerTarget) (Q-5)
  stacks: number; maxStacks: number; kick: number; remainingMs: number; injectionMw: number }
export function dockModel(s: Snapshot, taps: StoreView["taps"], clientNow: number): DockModel;   // Q-12

// PowerDock.tsx, TierReadout.tsx
export function PowerDock(p: { store: Pick<GameStore, "pressTap" | "releaseTap" | "now">; snapshot: Snapshot;
  taps: StoreView["taps"] }): JSX.Element;   // root carries data-stacks={stacks}
export function TierReadout(p: { snapshot: Snapshot; now: () => number }): JSX.Element;
```

- `main.tsx`: `window.addEventListener("pagehide", () => store.flushTaps({ keepalive: true }))`. In `syncVisibility`, when hidden, call `store.releaseTap()` and then `store.flushTaps({ keepalive: true })` before `setVisible(false)`.

- [ ] **Step 1: Write the failing tests** (`store.test.ts`, the rig with `FakeClientClock`). Add `keepalive: init?.keepalive` to the `Logged` entry. Add a knob `fakeGetStatus: number | null` that answers the next `GET /api/world` with that status and `{"error":"x"}`.
  1. **Hold cadence.**
     - `pressTap()`, then `rig.advance` 3,500 ms in 100 ms steps, then `releaseTap()`, then advance 2,000 ms.
     - TAP POSTs are sent at +1,000, +2,000, +3,000, and then the release flush at `max(3,500 + 300, 3,000 + 1,000) = 4,000`.
     - Every gap is ≥ 1,000 ms.
     - The counts sum to 36: one at press, then one per 100 ms, the repeat due at 3,500 firing inside the advance, before the release. Don't assert how taps due at the same instant as a flush split between batches.
     - Each action is `{ type: "TAP", count: n > 0, clientElapsedMs }`, and each batch has exactly one action.
     - After the first adoption, the snapshot's `state.tapStacks` is 10.
  2. **Tap-release bursts can't beat 1/s.**
     - Press and release every 400 ms, 6 times.
     - Gaps between TAP POSTs are ≥ 1,000 ms.
     - No flush has `count: 0`.
     - The last flush lands ≤ 1,000 ms after the last release.
  3. **Never merged.** With a spend in flight (`rig.fetch.hold`), a tap flush queues as its own batch with its own key, and the spend's batch still has one action.
  4. **Keepalive.**
     - After four press/release pairs within 200 ms (so the release flush, due at about +310 ms, hasn't fired), `flushTaps({ keepalive: true })` sends `count: 4` at once, with `keepalive: true`, while the outbox holds another batch in flight (so it bypassed the queue). The world's `tapStacks` > 0 after it lands.
     - With `rig.fetch.dropNextResponse = true`, the dropped keepalive flush is retried through the outbox with the **same** `idempotencyKey`, and the db has one action-log row for it.
  5. **GET 4xx stops polling until focus** (Q-18).
     - `fakeGetStatus = 418`, then `onFocus()` past `MIN_REPOLL_MS`. A `client-bug` notice appears, and `getView().polling === false`.
     - `rig.advance(4_100_000)` (past the fresh boundary at 4,000 s) makes **zero** GETs.
     - `onFocus()` makes exactly one GET, which adopts. `polling` is true again.
  6. **Tier-up.** Adopting a snapshot with a higher `state.tier` (a world written into the db with `tier + 1` through `rig.db`, as 4a test 4 does) raises one `tier-up` notice, "Tier 1 reached."
  7. **`outbox.test.ts`:** `enqueue(actions, label, { key: "k-1" })` sends `idempotencyKey: "k-1"`. Without the option the key is fresh.
  8. **`dock-model.test.ts`:**
     - on tier 8: `demandMw` ≈ 472.5, `supplyMw` ≈ 477.3, `fullDemandMw` ≈ 2,898.5, `limited === true` (its bottleneck is `collect_biomass` for power, a `recipe` kind whose target is power, so it is `limited` as P-2's `isPowerTarget` reads it);
     - a fresh world with `taps.pending = 5` gives `stacks` 5, `kick` 1.25, `injectionMw` 25, and `remainingMs` = 30,000 at `lastTapAt`;
     - a snapshot with a `tap-expiry` timer 12 s out and no pending taps gives `remainingMs` ≈ 12,000.
  9. **`PowerDock.test.tsx` (jsdom):**
     - `pointerDown` on the tap calls `pressTap`, and `pointerUp`, `pointerCancel` or `lostPointerCapture` calls `releaseTap`;
     - Space `keyDown` calls `pressTap` once even with `repeat: true` events after it, and `keyUp` releases;
     - the grid meter has `role="meter"`;
     - with `limited`, the bar has `.state-bottleneck` and reads "Power limits production", and there is still **exactly one** "bottleneck" text in the App (the frame's);
     - `TierReadout` on tier 8 shows "Tier 8" and both requirements (`smart_plating` 512,000, `polymer_resin` 2,048,000); on a `tier: 10` state it shows "complete".
- [ ] **Step 2:** run the web tests. The new ones fail.
- [ ] **Step 3: Implement.**
  - The store owns one `TapAccumulator(() => clock.now(), clock.now())`, a repeat timer and a flush timer, on the `ClientClock`. `stop()` clears both.
  - `#adopt` compares the tiers for `tier-up`.
  - `polling` is `#boundaryTimer !== null` in `#makeView`, and `#arm` and `#clearBoundary` emit when it changes.
  - The keepalive path runs `classify`, then `#handle(o, "post", …)`. On `retry` or `paused` it calls `this.#outbox.enqueue([action], TAP_LABEL, { key })`.
- [ ] **Step 4:** run the web tests until they pass.
- [ ] **Step 5: Mutation checks, each undone by hand.**
  - The release flush ignores `lastFlushAt` (`now + 300` only): test 2 fails.
  - The keepalive path enqueues into the outbox instead of sending: test 4 fails (no `keepalive: true`, or it is behind the held batch).
  - The keepalive retry makes a new key: test 4 fails (two log rows).
  - After a GET `client-bug`, re-arm the boundary: test 5 fails.
  - Label the dock bar "bottleneck": test 9 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: the holdable tap with a 1 s flush floor and keepalive, the power dock, the tier readout (W-12, W-20, Q-11 to Q-13)`.

---

### Task 6: the acceptance pins: every D.1 action, and a builder-only player to tier 10

**Files:**
- Create: `apps/web/src/ui/d1-coverage.test.tsx` (jsdom), `apps/web/src/ui/play.test.ts` (node)
- Modify: `.github/workflows/ci.yml` (the `web-play` job)

**Interfaces:**
- Consumes:
  - Tasks 2–5's components and builders;
  - `resolve(state, content, elapsedMs)` and `apply`/`applyBatch` (engine, test-only use);
  - `snapshotOf` and `loadSlice` (`test-fixtures.ts`).
- Produces: no exports. The CI job:

```yaml
  # Q-14: the builder-only player to tier 10 (~47 s locally, ~2 min on a runner). pnpm test runs it
  # to tier 6; this is the "playable to tier 10" pin. A hang guard, not a budget.
  web-play:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @manufactory/web exec vitest run src/ui/play.test.ts
        env:
          WEB_PLAY_TIER: "10"
```

- [ ] **Step 1: Write `d1-coverage.test.tsx`.** It has one `it` per action type. Each mounts `App` over `fakeStore`, drives **only** the DOM (clicks, keys, inputs), and asserts:
  - `send` was called with exactly one batch containing an action of that type;
  - `applyBatch(snapshot.display.state, content, batch, seed)` is **accepted**.

  The eleven:
  - `BUY_MACHINE`: the drawer, on tier 8 power/collector.
  - `DISMANTLE`: the drawer.
  - `UPGRADE_MARK`: the drawer, tier 8 iron constructor Mk1.
  - `ASSIGN_MACHINES`: a drawer stepper.
  - `SELECT_RECIPE`: the drawer, tier 8 `plastic`.
  - `REORDER_PRIORITY`: the priority list, Alt+↓ on an item.
  - `SET_PRIORITY_MODE`: Advanced mode, the chip.
  - `SET_RESERVE`: the Advanced slider.
  - `BUY_STORAGE`: the drawer.
  - `BUY_QS`: the drawer.
  - `TAP`: `pointerDown` then `pointerUp` on the tap, asserting `pressTap`/`releaseTap`. Then build the store's flush from `TapAccumulator` and check `apply` accepts it, because the fake store has no flush.

  A final `it` asserts that the set of covered types equals all eleven members of the `Action["type"]` union, enumerated with a `satisfies Record<Action["type"], true>` literal, so a twelfth action fails to compile here.
- [ ] **Step 2: Write `play.test.ts`.** `const TARGET = Number(process.env.WEB_PLAY_TIER ?? 6)`, with `{ timeout: TARGET >= 10 ? 300_000 : 60_000 }`. The loop, starting from `initialWorld(slice.content, 1, 0)` at `t = 0`:
  1. `s = snapshotOf(slice, state, { receivedAt: CLIENT_T0 })`.
  2. **Reorder.** If the next milestone's items aren't directly under power in `visiblePriority(s)`, apply one `REORDER_PRIORITY` per out-of-place item, from `reorderVisible`, moving each to visible index 1, 2, … in `requires` order.
  3. **Idle moves.** For every lane-class with installed machines, from `drawerModel(s, <an item of a recipe in it>).machines`: if `idleMove` returns a move, apply `moveMachines(...)` as one batch.
  4. **The frame.** `const m = bottleneckRow(s)`. If `m?.action` exists and `affordability(s, m.action, s.schedule.atMs).affordable`, apply it and `continue`.

  Every action is applied to `s.display.state`, the state the client's own numbers describe, with `apply`/`applyBatch`, and the result becomes `state`.
  5. **Wait.** Advance `state = resolve(state, content, wait).state`, where `wait = clamp(affordability.inMs ?? 30 min, 1_000, 30 min)`.

  The loop stops at `state.tier >= TARGET` or at 400 h of game time. Assert:
  - the tier was reached;
  - no applied action was rejected;
  - for tier 6, the game time is ≤ 24 h (measured 9.2 h);
  - for tier 10, ≤ 300 h (measured 132 h).

  Log the tier times with `console.info`, for the CI record.
- [ ] **Step 3:** run `npx vitest run src/ui/d1-coverage.test.tsx src/ui/play.test.ts` in `apps/web`. They pass if Tasks 2–5 are right. If the player stalls, **do not tune the player**. Find which UI builder is missing a move the probe made (`probe4b-frameplay.mts … mf idle`), and fix the builder, or report it. Then run `WEB_PLAY_TIER=10 npx vitest run src/ui/play.test.ts` once in the foreground, and record its wall time in the CI comment.
- [ ] **Step 4: Mutation checks, each undone by hand.**
  - Remove the drawer's idle-move button: the `ASSIGN_MACHINES` coverage case must still pass through the stepper.
  - Make `idleMove` always return null: `play.test.ts` stalls at tier 5 (measured) and fails at tier 6.
  - Delete the QS +1 button: the `BUY_QS` case fails.
- [ ] **Step 5:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: every D.1 action through the UI, and a builder-only player to tier 10 with its web-play CI job (Q-14)`.

---

### Task 7: the 4b e2e specs and the README

**Files:**
- Create: `apps/web/e2e/drawer-buy.spec.ts`, `apps/web/e2e/priority-drag.spec.ts`, `apps/web/e2e/tap-hold.spec.ts`, `apps/web/e2e/injected-failures.spec.ts`, `apps/web/e2e/helpers.ts`
- Modify: `README.md`, `.github/workflows/ci.yml` (the `web-e2e` comment: the new specs and their measured times)

**Interfaces:**
- Consumes:
  - `playwright.config.ts`, unchanged: the Desktop Chrome viewport is 1280 wide, so three panes;
  - the DOM contract from Tasks 3–5: `[data-sync]`, `[data-state-version]`, `[data-polling]`, `[data-drawer]`, `[data-preview]`, `li[data-entry]`, `[data-stacks]`, `[data-notice]`, and button names.
- Produces, in `e2e/helpers.ts`:

```ts
export async function startGuest(page: Page): Promise<{ root: Locator }>;   // goto("/"), wait for data-sync="ready"
export function actionPosts(page: Page): { at: number; body: ActionsRequest }[]; // page.on("request") log of POST /api/actions
```

- [ ] **Step 1: Write the specs.** Each test starts a fresh guest (a new context per test is Playwright's default).
  1. **`drawer-buy`:**
     - click the `iron_ore` row's button; `[data-drawer="iron_ore"]` shows "8 more Miners → ×1.50", and `[data-preview]` is non-empty **before** any purchase;
     - `getByRole("button", { name: /^Buy 1 Miner/ })` becomes enabled within 60 s (Q-15: 18 s measured), then click it;
     - `data-state-version` is "1", and the drawer's Mk1 owned count reads 3;
     - no `rejected` notice.
  2. **`priority-drag`:**
     - In the priority pane, drag `li[data-entry="item:iron_rod"]`'s handle above `item:iron_plate` with `page.mouse` (down, a 5-step move, up).
     - The DOM order changes at once (optimistic), then `data-state-version` is "1".
     - Reload: the order persists.
     - Then drag `power` down one place: the `alertdialog` appears; Cancel; no new POST, and the order is unchanged.
     - Then Alt+↓ on `item:iron_ore`: version "2".
  3. **`tap-hold`:**
     - Hover the tap and `mouse.down()`.
     - `waitForRequest` twice for TAP posts, then `mouse.up()`, then `waitForRequest` once more.
     - Between consecutive TAP posts, `at` differs by ≥ 900 ms (1,000 ms in the page, less observation jitter; Task 5 pins it exactly).
     - Every body has `actions.length === 1` with `count > 0`.
     - `[data-stacks]` reaches "10", and the dock shows a kick "×1.50" and a remaining time over 20 s.
  4. **`injected-failures`** (carried minor 2: W-11's stuck-outbox clause):
     - **(a) A lost POST, same key.**
       - `page.route("**/api/actions", (r) => r.abort("failed"))`. Pause `item:iron_ore` in Simple mode; it shows "paused" at once.
       - After the 2nd failed attempt, `[data-notice="offline"]` is visible.
       - `page.unroute(...)`. The next retry succeeds: `data-state-version` "1", the banner is gone, and every captured attempt carried the **same** `idempotencyKey`.
     - **(b) 429 then resend.** Fulfil the next `POST /api/actions` once with `429`, `retry-after: 1`. Unpause: the resend comes ≥ 1 s later with the same key, and the version is "2".
     - **(c) A GET 4xx stops polling until focus** (Q-18).
       - `page.clock.install()` before `goto`.
       - After ready, `page.route("**/api/world", (r) => r.fulfill({ status: 418, body: '{"error":"x"}' }), { times: 1 })`.
       - `page.clock.fastForward(6_000)`, then dispatch `focus` on `window`. `[data-notice="client-bug"]` is visible, and `data-polling` is "off".
       - Note the GET count, then `page.clock.fastForward(4_100_000)`. Still "off", and the GET count is unchanged, read after an `expect(root)` round trip.
       - Dispatch `focus`: exactly one more GET, and `data-polling` is "armed".
- [ ] **Step 2: Run them locally.** Run `pnpm --filter @manufactory/web exec playwright install chromium`, then `pnpm --filter @manufactory/web e2e`, in the foreground. All five specs (4a's too) must pass.
  - If Chromium is unavailable, follow the 4a plan's Task 6 Step 2 rule: never fake a pass. `playwright test --list`, re-read every selector against the components, and say "unrun locally; first run is CI's web-e2e" in the commit and the hand-off.
  - Record each spec's wall time in the `web-e2e` comment.
- [ ] **Step 3: Mutation checks, if the specs ran.** Each is undone by hand.
  - The outbox makes a new key per retry: 4a's same-key assertion fails.
  - The tap flush floor is dropped (`releaseTap` flushes at `now + 300`): `tap-hold`'s ≥ 900 ms check is still met while holding. This is a reminder that the floor's real pin is Task 5 test 2. Note it in the commit; don't weaken the spec.
- [ ] **Step 4: README.**
  - Phase 4's cell becomes `A game other people can play — **in progress** (4a: shell and lane view; 4b: drawer, priority, dock and tap)`.
  - Add one sentence: "Every D.1 action is playable in the browser; `web-play` in CI proves tier 10 through the client's own builders."
- [ ] **Step 5:** run `pnpm test`, `pnpm lint` and `pnpm typecheck` in the foreground, in that order. Commit: `Web: e2e for the drawer buy, priority drag, tap hold and injected failures; README (W-11, W-23)`.

---

## Deferred to 4c (do not build here)

- The handbook, and its tab in the W-19 tab bar.
- Accounts: `supertokens-web-js`, sign-up/sign-in, claim, sign-out, password reset, `websiteBasePath: "/account"`, `DEV_FAKE_SESSIONS`.
- Settings: notation and the theme toggle.
- Motion polish: sweeps, number tweens, the conveyor.
- The 320 px overflow e2e on every view, the reduced-motion e2e, and the contrast check.
- `infra/Caddyfile`, and the footer source link.
- **Not planned:** a per-lane bottleneck (errata P-2), the Power detail screen (§13.2's second paragraph, out of scope by W-1), and "while you were away" (OQ2).

## Spec-vs-code notes found while planning 4b

- **W-13's whole-cost credit** makes an affordable preview differ from the real purchase (measured 8.7/s on `screw`, tier 8, a Constructor Mk3). Refunds (`UPGRADE_MARK`, `DISMANTLE`) also land in `bound`, so "the credit is spent exactly" can't be pinned as "bound unchanged". Ruled in Q-1.
- **§13.3's "eight to twelve entries".** The slice's list carries all 32 entries from tier 0, because `start.priority` names every item. Ruled in Q-8.
- **§13.2's "the bottleneck framing moves here"** conflicts with 4a's P-2 single frame on the fuel row. Ruled in Q-5.
- **W-12 / spec "Every TAP, `count: 0` included, refreshes the expiry"** holds only while `tapStacks > 0`: `applyTap` pushes the timer only `if (stacks > 0)`. The client never sends `count: 0` anyway.
- **F.1's "45 Mk1 → 15 Mk2"** implies ×3 marks. The slice's marks are ×2, except Collector Mk2 at ×3. Also, `UPGRADE_MARK` has no count: it upgrades the whole stock of a mark.
- **The header tier readout** is in W-1's scope but the 4a plan deferred it to 4c. 4b needs it (Q-13).
- **Not a spec error, but it shapes 4b:** following the frame alone deadlocks at tier 5 (an advised Mk3 Constructor priced in an item nothing makes), so the drawer's assignment and mark choice are load-bearing (Q-6).
