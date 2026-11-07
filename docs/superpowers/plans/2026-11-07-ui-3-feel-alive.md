# UI-3: feel alive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the spec's UI-3 row (U-9 and U-8c's remaining rows), limited to the feel-alive ideas the user approved for this PR. When it lands:
- **the factory talks back.** A factory log shows what happened: purchases with their effect, storage filling up, the bottleneck moving, and tier-ups. On desktop and tablet it's a 96 px `tail -f` box. On the phone it's a one-line ticker that opens a sheet.
- **each row has a trend.** A ten-minute sparkline sits in the desktop TREND column and in the drawer's meta line on the phone and tablet, and the row's accessible name says "rising", "falling" or "steady".
- **the terminal glows.** There's a phosphor glow and scanlines under the content, in the terminal theme only, with a CRT setting to turn them off.
- **a tier-up is celebrated.** A `*** TIER 3 REACHED · ROTOR unlocked ***` banner shows for 8 s over the tier readout.
- **the advice types itself out** in the terminal, and is runnable the instant it appears.
- **a follow-up from UI-2:** the tablet command bar's prompt shrinks to `$`, so the command reads at 600–1000 px.

**Out of this PR (the spec's "Deferred", ~1182, and the user's call):**
- idea 3, welcome back (the boot screen, which needs `GET /api/world`'s `summary`);
- idea 7, sound;
- idea 8, haptics;
- idea 9, the `:` command palette;
- idea 10, the ASCII flow tree in the handbook.

Nothing in this plan builds, stubs or reserves any of them.

**Architecture:**
- **Task 1:** the store gains `onAdopt` (U-9f) and `later` (one-shot timers on its `ClientClock`). `FakeStore` mirrors both, and `ui/feel.ts` creates one log book and one trend book per store.
- **Task 2:** the command bar. The prompt is `$` below desktop (L-1). `useTyped` types the advice out (U-9e), and a geometry e2e covers the command's width.
- **Task 3:** `ui/factory-log.ts`, the pure model and the book: the events, the dedupe, the 200-entry ring, the reset. It also adds `unlockedAt`.
- **Task 4:** the log in the shell: the desktop and tablet box, the phone ticker and its modal log sheet, and the key and modal wiring.
- **Task 5:** `ui/trend.ts` (the buckets, `sparkline` and `trendWord`), the TREND column, the drawer's meta line, and the trend word in the option name.
- **Task 6:** the glow, the scanlines and the CRT setting. Then the tier banner, with the tier-up toast replaced by a hidden announcement that names the unlocks.
- **Task 7:** `feel-alive.spec` (the log, the trend, the glow, the frame timing), the `reduced-motion` and `themes` additions, the U-8c audit, and the README.

**Tech Stack:** TypeScript ESM, React 18.3.1, Vite, vitest 4 + jsdom + Testing Library, `@playwright/test` 1.64 (Chromium; `emulateMedia` supports `reducedMotion` and `contrast`). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-ui-terminal-redesign-design.md`:
- U-9 (~919): entire, bar the deferred ideas above;
- U-8a / U-8c (~859): the live-region rules and the reduced-motion table's remaining rows (the typing advice, the tier banner, the glow and scanlines);
- U-1c / U-1i: the glow tokens, and the `mi.crt` checkbox (UI-1's V-8 deferred it here);
- U-2b / U-2d: the factory log and the log ticker blocks;
- U-3b: the TREND column;
- Testing (~1082): the "Feel alive" and "Sync" bullets, and the `reduced-motion` and `layout-320` rows.

The Phase 4 rulings, the post-launch rulings, the U-rulings, UI-1's V-rulings and UI-2's K-rulings all stand, unless an L-ruling below supersedes one; each supersession is named in its ruling.

## Rulings made in this plan

- **L-1. The command bar's prompt is `$` below desktop (a UI-2 follow-up; amends U-4a).**
  - **The rule.** In the shell voice, `CommandBar` shows `operator@manufactory:~$` when the layout mode is `desktop` (above 1000 px), and `$` when it's `tablet`. The plain voice keeps `Next` at every width. The phone's split bar already shows `$` (U-4b).
  - **How.** The prompt is chosen in React from a new `mode` prop, so jsdom can test it. There's no CSS media trick.
  - **The geometry rule.** At 600, 640, 820 and 1000 px, in every theme a production build can select (terminal, Clean Dark, Clean OLED, Clean Light), `[data-command]`'s `.command` box is at least 20 `ch` of its own font wide. At 1280 px the full prompt shows and the same holds. `themes.spec` measures it (Task 2).
  - *Why:* at 640 px the 23-character prompt left the command `b…`. The command is what the player reads, and the prompt is decoration.
  - *Cost if wrong:* a tablet terminal player sees `$` and not the full prompt. Changing it is one string.
- **L-2. The store gets two small public methods, and no protocol change.**
  - `onAdopt(fn: (e: AdoptEvent) => void): () => void` is U-9f. `AdoptEvent` is `{ prev: Snapshot | null; next: Snapshot; settled: Batch | null }`.
    - It's called once per adopted snapshot.
    - It's called after the swap, the tier-up notice and `#arm()`, and before `#emit()`, so no frame shows the new snapshot with the old log.
    - Each listener is wrapped in `try/catch` with `console.error`, so a throwing listener never breaks adoption.
    - `settled` is the `Batch` itself. `#handle`/`#adopt` take `settling?: Batch` in place of `settling?: number`, and `#settlingId = settling.id`; the outbox's `onOutcome` already has `b`.
  - `later(fn: () => void, ms: number): () => void` is a one-shot timer on the store's `ClientClock`, and it returns its cancel. U-9e says "`setTimeout` through the store's `ClientClock`", and this is the only way to reach it.
  - *Why:* the books and the timers need nothing else. The wire, the outbox and the polling are untouched.
- **L-3. One feel pair per store, created before the first adoption.** `feelOf(store)` (`ui/feel.ts`) keeps a `WeakMap<object, Feel>`.
  - On first use it creates `{ log, trend }` and subscribes both books to `store.onAdopt` for the store's lifetime.
  - `main.tsx` calls it right after `new GameStore(…)`, and `App` reads it through `feelOf(store)` (idempotent), handing it down via `FeelContext`.
  - *Why:* outside React, so StrictMode's double mount can't subscribe twice or miss the first adoption.
- **L-4. A world change resets the books on the next adoption with `prev === null`.**
  - `#resetWorld` sets `#snapshot = null` on `newFactory`, sign-in (claim), sign-out and expiry, so the next `AdoptEvent` has `prev === null`. Both books treat that event as "reset, and log nothing" (U-9a's "first snapshot of a session").
  - Until then the game isn't rendered (`snapshot === null` shows "Loading your factory…"), so the old world's lines are never on screen.
  - *Why:* one rule covers the first snapshot and every world change, with no new store signal.
- **L-5. Log lines have two voices.**
  - **The fields.** `LogEntry` is `{ seq, atLocalMs, tone, key, text, said }`. `text` is the shell voice with ids (`bought 4 CONSTRUCTOR_MK1 (IRON) · ROTOR +0.4 → +1.2/s`). `said` is the plain voice with content names (`Bought 4 Constructor Mk.1 (Iron) · Rotor +0.4 → +1.2/s`).
  - **What shows.** Terminal shows `text` through `Spoken`, so a reader hears `said`. The plain themes show `said`.
  - **When numbers are fixed.** They're formatted with `fmt` at creation, in the notation of that moment.
  - *Supersedes:* U-9a's `LogEntry.text`-only shape. U-1h requires the content name for screen readers.
- **L-6. The purchase line comes from the batch's first spend action. The item comes from the label.**
  - **Spends:** `BUY_MACHINE`, `DISMANTLE`, `UPGRADE_MARK`, `BUY_STORAGE` and `BUY_QS`. A batch with none (a setting, including the command bar's `SET_RESERVE`, which shares `BOTTLENECK_BUY_LABEL`) logs nothing.
  - **The item** (`itemOfLabel`):
    - `drawer:<item>:<verb>` → `<item>`;
    - `BOTTLENECK_BUY_LABEL` → `bottleneckRow(prev)?.itemId`;
    - `power:<class>:<verb>` → a generator (K-12);
    - anything else → `null`.
  - **The lines:**

    | Action | `text` |
    |---|---|
    | `BUY_MACHINE` (item) | `bought 4 CONSTRUCTOR_MK1 (IRON) · ROTOR +0.4 → +1.2/s` |
    | `DISMANTLE` (item) | `dismantled 2 CONSTRUCTOR_MK1 (IRON) · ROTOR +1.2 → +0.4/s` |
    | `UPGRADE_MARK` (item) | `upgraded CONSTRUCTOR_MK1 → CONSTRUCTOR_MK2 (IRON) · ROTOR +0.4 → +0.6/s` |
    | generator (`power:` label) | `bought 1 BIOMASS_BURNER_MK1 (POWER) · grid 30 → 60 MW` (`display.solution.power.supplyMw`, `mwText`) |
    | `BUY_STORAGE` | `storage +1 IRON_PLATE · cap 10.0k → 15.0k` (`liquidCap` on `prev` and `next`) |
    | `BUY_QS` | `qs +1 --lane IRON` |
    | machine action, item `null` | the line without the `· <rate>` clause |

  - **Rates** are `rateText` of `prev.schedule` and `next.schedule`, joined with ` → `: `+0.4 → +1.2/s` (one `/s`).
  - **Never deduped.** The key is `buy:<batch.id>`, so a player's action always shows (a narrowing of U-9a's 60 s rule, which is for automatic events).
  - **A stale response** (`isAdoptable` false) reports nothing (U-9f), so that buy has no line. That's rare, and it's accepted.
- **L-7. The bottleneck lines use `bottleneckKey` and the shown name.**
  - `bottleneckKey` moves from `App.tsx` to `derive.ts` (exported, unchanged), so the announcer and the log agree.
  - **The name** is the item's (U-1h). For a frameless model it's `power` when `display.solution.bottleneck.kind === "power"`, else `unlisted`. *Why:* frameless means no row carries it, so there's no row name to give.
  - **The lines:** `bottleneck moved: SCREW → ROTOR`, `bottleneck: ROTOR`, `bottleneck cleared`.
  - **The keys:** `bottleneck:<to-key or none>`, so A→B→A→B inside 60 s logs A→B and B→A, then drops the second A→B (the EPSILON flip).
- **L-8. Dedupe and the reset run on the client's monotonic clock. Display time is the wall clock.**
  - The book takes `now` (`store.now`) for the windows: 60 s per key, and 10 min for `full:<item>`. It takes `wallNow` (default `Date.now`) for `atLocalMs`.
  - **The order within one adoption:** the purchase, the tier-up, storage-full (in content order), then the bottleneck.
  - **The ring** keeps the newest 200 (`LOG_CAP`).
- **L-9. The log never speaks, and never takes a key.**
  - **Desktop and tablet:** `section[aria-label="Factory log"][aria-live="off"][data-factory-log]`, with no `role=log` (U-8a).
  - **Its keys.** When its list overflows it gets `tabIndex=0` (a scrollable region must be reachable, WCAG 2.1.1). `focusKind` reports `"arrows"` for `[data-factory-log]`, so ↑/↓ scroll it natively and never move the rows. Enter there does nothing, since the focus isn't at rest.
  - *Supersedes:* K-18's "no new tab stop", for this one region, as U-9a asks.
- **L-10. Short viewports and the phone get the ticker, not the box.**
  - **Where the box shows:** desktop and tablet, with a viewport at least 700 px tall (`(min-height: 700px)`). Below that, the tablet gets the phone's ticker and sheet. U-9a's arithmetic (eight 44 px rows at 820 px) assumes a tall viewport, and a 1000×600 landscape tablet would lose half its rows.
  - **On the phone** the ticker is 24 px on a fine pointer. Under `pointer: coarse`, K-16's rule makes it 44 px. U-8d wins over U-9a's 24 px, because it's a button.
  - **No ticker** with no entries (U-9a).
  - **Visibility.** The ticker shows on the factory tab only, beside the command bar.
- **L-11. The log sheet is a modal sheet, the phone's third.**
  - **The host.** `[data-log-host]` joins `MODAL_HOSTS` after `[data-next-buy-host]`. `scopeOf` gains `log: boolean` (with `phone`, it's `"sheet"`).
  - **Inside:** `role=dialog`, `aria-modal="true"`, the `--scrim` backdrop, `trapTab`, and closing by `x`, backdrop or Esc. Focus returns to the ticker.
  - **Its surface** is `--s2` (U-4c style). Its class `logSheet` goes into `ON_SURFACE`, and its lines use `--t2`, never `--t3`.
  - **A layout change away from the phone** closes it. If focus was inside, `refocusRows` takes it.
  - **One modal at a time** (K-5). The ticker is inert under any other sheet.
- **L-12. The sparkline re-renders on adoption and once a server minute, never at 4 Hz.**
  - **The book.** It has `subscribe` and `version()`. It bumps on each `record` and on a minute timer (`later`, armed only while it has subscribers, re-armed at each server-minute boundary).
  - **The rows.** `RowList` reads `useTrend(book)` (`useSyncExternalStore`) and computes the lane's `RowTrend`s in one `useMemo` keyed on `[version, snapshot, ids]`. `Row` gets a `trend` prop. The `Trend` cell is a `memo` component that takes strings only.
  - **No `useTick`** anywhere in the trend or log code. A test counts renders.
- **L-13. The trend book never double-counts.**
  - **The fence.** It keeps `committedTo`, the furthest server ms credited. Every credit, committed or open, starts at `max(start, committedTo)`. A POST response whose `atMs` trails the last GET's (allowed by `isAdoptable`) adds nothing twice.
  - **Bucket values** are time-weighted means over the covered ms. A bucket with no coverage is unknown (`null`, drawn `·`).
- **L-14. Sparkline colours, and `--t3` on the selected row.**
  - **The cell's colours:** `.trend` is `--t3`, `.trend.down` is `--rate-down`, and `.trend:global(.state-bottleneck)` is `--state-bottleneck` (a state class, 8a). Unknown cells are `.unknown` in `--t3`.
  - **On the selected row** (`--s-hi`, where terminal `--t3` is barred, U-1f), `.row[aria-selected="true"] .trend` and `… .unknown` are `--t2`. The `down` and bottleneck colours keep their own.
  - **The test.** The contrast checker reads selectors only, so a new `contrast.test` case 6 requires every `--t3` colour on a row cell class in `Row.module.css` to have a `.row[aria-selected="true"]` override.
- **L-15. The trend word comes before ", bottleneck".** The option name is `…, 41 percent satisfied, rising, bottleneck`. `reduced-motion.spec` and others match `aria-label$=", bottleneck"`. With fewer than two known buckets there's no word.
- **L-16. The glow is static and comes from tokens. CRT is `mi.crt` and `data-crt`.**
  - **Where it applies:**
    - `.app` gets `text-shadow: var(--glow-text)` and `background-image: var(--scanlines)`, so the scanlines are under the content (U-1f);
    - the titles get `--glow-title`;
    - the command bar and the NEXT_BUY card keep `--glow-advice`;
    - the banner gets `--glow-banner`;
    - the TAP keeps `--glow-tap`.
  - **The off switches,** in `tokens.css` after the phone block:
    - `@media (prefers-reduced-motion: reduce) { :root { --glow-*: none } }` (the scanlines stay, U-8c);
    - `@media (prefers-contrast: more) { :root { --glow-*: none; --scanlines: none } }`;
    - `:root[data-crt="off"] { --glow-*: none; --scanlines: none }`.

    `css-walk`'s `block()` reads top-level blocks only, so 8b/8d still read the plain `:root`.
  - **No animation.** Nothing animates `text-shadow`, and 7a still holds.
  - **Solid fills.** Every rule that fills with `--accent` or `--advice-fill` sets `text-shadow: none` (as `Delight` does). New `tokens.test` 12a.
  - **The setting.**
    - `theme.ts` gains `crtOn()`, `setCrt(on)` (`mi.crt`: `"off"` or absent; default on) and `useCrt()`. It applies `data-crt="off"` on `<html>` when off.
    - `index.html`'s inline script sets it before first paint, and `theme.test` runs that script as it does for the theme.
  - **The checkbox.** Settings gets "Glow and scanlines" under the theme list. It's natively `disabled` outside terminal, with the visible note "Retro terminal only".
- **L-17. The tier-up announcement stays in the one region, hidden. The banner is its picture.**
  - **The announcement.** `Notices` no longer draws the tier-up toast (U-9d). It renders the `tier-up` notice inside the region as `<span class="visually-hidden" data-notice="tier-up">`, with the text `tierUpSaid(s, tier)` = `Tier 3 reached. Rotor unlocked.` (U-8a), from `unlockedAt`.
  - **The store's text is unchanged.** `sync/` never imports `ui/`.
  - **The banner** (`TierBanner`) shows while it holds a tier-up notice object it hasn't finished with.
    - It starts at the first render that sees a new `tier-up` notice object (by identity).
    - It ends 8 s later (`later`), or on a click. Either way it calls `store.dismiss("tier-up")`, which removes the hidden span (removals aren't announced).
  - **What it is.** It's `aria-hidden`, not focusable, has no role, and never takes focus. The 8 s timer is the keyboard's dismissal. The log keeps the line.
- **L-18. The banner is an overlay and never moves the header.**
  - **Placement.** It's `position: absolute; inset: 0` inside a new `[data-tier-slot]` wrapper (`position: relative`) around the tier readout on desktop and tablet, and around `.readouts` on the phone.
  - **Fill and text.** It's filled with `--bg` and ellipsized. A test pins the header's height with and without it.
  - **With motion:** opacity in over 200 ms (an animation), and out over 400 ms (a `data-out` state with an opacity transition, unmounted 400 ms later by `later`).
  - **Under reduced motion** it mounts and unmounts at once (U-8c).
- **L-19. Typing is purely visual.**
  - **What types.** `useTyped(text, enabled, clock)` returns `{ shown, done, finish }`. It types only when the text changes (it keys on `commandText`, never on the run label).
  - **The run button** is rendered from the model as today, so it's live before the first character. `[data-run]`'s batch never waits on `done`.
  - **Enter.** `CommandBar`'s section has `onClickCapture={finish}`. A click, or Enter's `.click()` (K-4), both runs and completes the text.
  - **What a reader hears.** The typed span stays `aria-hidden`. `[data-command-text]` holds the complete plain words from the first render, so a reader hears the final text once, through the bottleneck announcement (U-8a), never character by character.
  - **Instant** (no typing) when any of these hold:
    - `prefersReducedMotion()`;
    - `document.visibilityState === "hidden"`;
    - the plain voice (it crossfades: a 150 ms `opacity` animation keyed on the text, inside no-preference);
    - the card, a phone sheet, help or Settings is open (`instant` from App).
- **L-20. Frame timing is measured on the guest world, not the tier-8 fixture.**
  - The e2e has no way to load a tier-8 world without an API or a fixture-server change, both out of scope.
  - W-19 renders only the visible lane, so the rows on screen are bounded by a lane, not by the tier, and the guest's iron lane at 1280×820 is the same kind of DOM.
  - **The check.** `feel-alive.spec` records `longtask` entries over 5 s, with glow on and then with CRT off, and asserts none above 50 ms with glow on. The median rAF interval goes in a test annotation.
  - **Tier-8 is covered in jsdom.** A `RowList` render-count test on tier-8 pins that the 4 Hz tick doesn't re-render the trend cells or the log.
  - *Cost if wrong:* a heavy-lane glow cost goes unmeasured in a browser.
- **L-21. No new keys.** The log, trend, glow and banner add nothing to `KEYMAP`, the hints or `?`. *Why:* the help stays true by construction (K-7), and the brief adds no key.
- **L-22. E2E in every task** (K-23 stands). Each task runs the full sequence, and fixes the specs it breaks:
  - Task 4 updates `layout-320` (the log sheet);
  - Task 6 updates `themes` (CRT) and `reduced-motion` (`text-shadow`);
  - Task 2 updates `themes` (geometry) and `reduced-motion` (the command complete at once).

## Global Constraints

- Work only in `.claude/worktrees/ui3` on branch `ui-3`.
- Never run `pnpm format`.
- Verify with `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, then `pnpm --filter @manufactory/web e2e`, sequentially in the foreground. Never run lint or typecheck while tests run.
  - A single suite: `pnpm --filter @manufactory/web exec vitest run <path>`.
- Never `pkill -f`. No containers.
- Heavy suites (anything rendering `App`, tier-8 fixtures) get explicit vitest timeouts, `describe(name, { timeout: 60_000 }, …)`, because CI is 10–20× slower. That covers `FactoryLog.test.tsx`, `TierBanner.test.tsx`, `RowList.test.tsx`, `CommandBar.test.tsx` (it renders App), `Shell.test.tsx`, `Drawer.test.tsx`, `Settings.test.tsx` and `store.test.ts`.
- No new npm dependencies.
- No API, engine, content or sync-protocol change. A store hook that observes adoptions is fine: `onAdopt`, plus `later` (L-2).
- Only `transform` and `opacity` animate, inside `prefers-reduced-motion: no-preference`.
- State colours appear only under state-class selectors.
- Every CSS file is policed by `contrast.test`. New surface classes go into `ON_SURFACE`.
- Every e2e wait is on the DOM or a store attribute, never a sleep.
- Commit trailers, exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push. Commit before finishing each task.

## Review Focus

The five failure modes most likely to bite a player:

1. **Typed advice delaying or blocking a buy.**
   - **The risks:**
     - Enter while typing does nothing, or runs the previous advice;
     - the run button is rendered off until `done`;
     - a re-type on every 4 Hz countdown re-arms timers forever;
     - a screen reader hears the command letter by letter.
   - **What guards it:** L-19 and U-8a. Task 2 tests 4–7 and 10–12 and `keyboard.spec`'s existing Enter-buys step.
2. **The log spamming on the EPSILON flip, or logging the wrong thing.**
   - **The risks:**
     - a FULL tag flickering at each boundary;
     - the bottleneck flipping A↔B;
     - a reserve change logged as a purchase;
     - the first snapshot after a reload or a sign-in dumping lines;
     - one world's lines showing in another.
   - **What guards it:** L-4, L-6, L-7 and L-8. Task 3 tests 5–11.
3. **The banner or the log stealing focus or speaking twice.**
   - **The risks:**
     - the banner taking focus, or being a second live region;
     - the log as `role=log` (implicitly live);
     - the tier-up said twice (once from a visible toast, once from the hidden span);
     - arrows on the focused log moving rows.
   - **What guards it:** L-9, L-17 and U-8a. Task 4 tests 1–2 and 6, Task 6 tests 7–10, and the one-region test.
4. **Motion or glow ignoring reduced motion or high contrast.**
   - **The risks:**
     - a `text-shadow` under `reduce` or `prefers-contrast: more`;
     - the banner fading under `reduce`;
     - typing under `reduce`;
     - the log cursor blinking outside no-preference;
     - a solid-fill button smeared by the glow.
   - **What guards it:** L-16, L-18 and L-19. 7a/7b/12a, Task 6 tests 1–4, `reduced-motion.spec` and `themes.spec`.
5. **Sparklines leaking memory or re-rendering the tree.**
   - **The risks:**
     - buckets that grow without bound over a long session;
     - a minute timer that outlives its subscribers;
     - trend computation inside `useTick`;
     - every Row re-rendering every second;
     - rows moving when the TREND column appears.
   - **What guards it:** L-12 and L-13, U-3a. Task 5 tests 2, 9 and 11–12, and 10a.

---

### Task 1: the store's `onAdopt` and `later`, `FakeStore`, and `feel.ts`

**Files:**
- **Modify:**
  - `apps/web/src/sync/store.ts`: `AdoptEvent`, `onAdopt`, `later`, and `settling` as a `Batch`;
  - `apps/web/src/sync/store.test.ts`: new cases 28–31;
  - `apps/web/src/ui/test-fixtures.ts`: `FakeStore` gains `onAdopt`, `later` and `adopt()`; `tick` fires due `later` timers;
  - `apps/web/src/main.tsx`: `feelOf(store)` after construction.
- **Create:**
  - `apps/web/src/ui/feel.ts`: `Feel`, `feelOf`, `FeelContext`, `useFeel`. The books are stubs here (an `AdoptEvent[]` recorder interface) and are filled in by Tasks 3 and 5;
  - `apps/web/src/ui/feel.test.ts`.

**Interfaces:**

```ts
// store.ts (U-9f, L-2)
export interface AdoptEvent { prev: Snapshot | null; next: Snapshot; settled: Batch | null }
onAdopt(fn: (e: AdoptEvent) => void): () => void;
/** A one-shot timer on the ClientClock; the returned function cancels it. */
later(fn: () => void, ms: number): () => void;

// feel.ts (L-3)
export type FeelStore = Pick<GameStore, "onAdopt" | "later" | "now">;
export interface Book { record(e: AdoptEvent): void }
export interface Feel { log: FactoryLogBook; trend: TrendBook }   // Task 1: both minimal Books
export function feelOf(store: FeelStore): Feel;                   // WeakMap; subscribes once
export const FeelContext: React.Context<Feel | null>;
export function useFeel(): Feel;                                  // throws outside the provider
```

Steps:
- [ ] **Step 1: Write the failing tests.**
  - `store.test.ts`, under the existing rig, with a 60 s timeout:
    - **28. A buy reports its batch.** Send a `BUY_MACHINE` under `drawer:iron_ore:buy`. Exactly one event arrives: `settled.label === "drawer:iron_ore:buy"`, `settled.id` is the batch's, `prev` is the snapshot before, and `next.stateVersion` is one higher. *Catches:* passing the id, or reading `outbox.inFlight` after it moved on.
    - **29. A poll reports `null`.** Advance to the boundary, and the GET's event has `settled: null`.
    - **30. A stale response reports nothing.** Use the existing stale-GET setup (`isAdoptable` false), and no event fires. *Catches:* calling listeners before the adoptable check.
    - **31. The order, a throwing listener, and unsubscribing.** When a listener runs, `store.getView().snapshot` is still the previous view object (it's before `#emit`). A listener that throws doesn't stop a second one, and adoption completes (`status` `ready`). Unsubscribe → no more calls. `later(fn, 500)` fires after `advance(500)`, and its cancel prevents it.
    - **32. A new factory gives `prev: null`.** After `newFactory()` the next event's `prev` is `null`.
  - `feel.test.ts`:
    1. `feelOf(s) === feelOf(s)`, and `onAdopt` was called once per book.
    2. A second store gets its own pair.
- [ ] **Step 2:** watch them fail.
- [ ] **Step 3: Implement.**
  - **Thread the `Batch`.** `onOutcome` already gets `b`: pass `b` (not `b.id`) through `#handle(…, settling?: Batch)` to `#adopt`, and set `#settlingId = settling.id`.
  - **The listeners.** Keep `#adoptListeners = new Set`. Call them after `this.#arm()` and before `this.#emit()`, each in `try/catch`.
  - **`later`** wraps `#clock.setTimeout`/`clearTimeout`.
  - **`FakeStore`:**
    - `later` queues `{ at, fn }` on its own clock, and `tick(ms)` fires the due ones in time order, inside `act`;
    - `onAdopt` keeps listeners;
    - `adopt({ prev?, next, settled? })` sets `view.snapshot = next`, calls the adopt listeners, then the view listeners, all in one `act`.
- [ ] **Step 4:** green.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Emit before the listeners: 31 fails.
  - Pass `settled: null` always: 28 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and the e2e. Commit: `Web: the store reports adoptions (onAdopt) and keeps one-shot timers on its clock (UI-3, U-9f)`.

---

### Task 2: the command bar: `$` below desktop, and the advice types itself out

**Files:**
- **Create:** `apps/web/src/ui/use-typed.ts`, `apps/web/src/ui/use-typed.test.ts`.
- **Modify:**
  - `apps/web/src/ui/CommandBar.tsx`: a `mode` and an `instant` prop; the prompt per L-1; `CommandWords` uses `useTyped`; the section gets `onClickCapture`;
  - `apps/web/src/ui/CommandBar.module.css`: `.typed` gets a crossfade under no-preference (an opacity `@keyframes`), and `data-typing` for the cursor;
  - `apps/web/src/ui/App.tsx`: it passes `mode`, and `instant = whyOpen || helpOpen || sheet !== null`;
  - `apps/web/src/ui/CommandBar.test.tsx`;
  - `apps/web/e2e/themes.spec.ts`: the geometry test;
  - `apps/web/e2e/reduced-motion.spec.ts`: the command is complete at once.

**Interfaces:**

```ts
// use-typed.ts (U-9e, L-19)
export interface TypedClock { later(fn: () => void, ms: number): () => void }
export function typeInterval(length: number): number;   // min(30, 600 / length), length ≥ 1
export function useTyped(text: string, enabled: boolean, clock: TypedClock):
  { shown: string; done: boolean; finish(): void };
```

`enabled` is `voice === "shell" && !instant && !prefersReducedMotion() && document.visibilityState !== "hidden"`, read when `text` changes. The hook types one character per `typeInterval(text.length)` through `clock.later`. A new `text` cancels the pending timer, then restarts from `""`. Unmount cancels it.

`CommandProps.store` widens to `Pick<GameStore, "now" | "send" | "later">`. `CommandSplit` (the phone) doesn't type: its short form is a button label, and U-9e names "the visible span" of the bar.

Steps:
- [ ] **Step 1: Write the failing tests.**
  - `use-typed.test.ts` (`renderHook`, a fake `later` queue):
    1. **It types on the clock.** `"buy 4 x"` (7 characters) → `shown` grows by one per 30 ms, and `done` is `true` after 210 ms.
    2. **The 600 ms cap.** A 60-character text completes at 600 ms (an interval of 10 ms). A 200-character text completes within 600 ms + one interval. *Catches:* a fixed 30 ms.
    3. **Instant when disabled.** With `enabled: false`, the first render has `shown === text`, `done: true`, and no timer is queued.
    4. **`finish()`** → `shown === text`, and the pending timer is cancelled (the queue is empty).
    5. **A change mid-type** restarts from `""` for the new text, and the old timer is cancelled (at most one pending).
    6. **The same text again** (a re-render) doesn't restart. *Catches:* keying on object identity, or on the 4 Hz run label.
    7. **The first advice types too** (U-9e). On mount with `enabled`, `shown` starts at `""` and a timer is queued.
  - `CommandBar.test.tsx` (App-level cases get the 60 s timeout):
    8. **The prompt (L-1).** Terminal, `mode="desktop"` → `operator@manufactory:~$`; `mode="tablet"` → `$`; Clean, either mode → `Next`.
    9. **Accessible text throughout.** While typing, `[data-command-text]` already holds the complete plain words, and `[data-typed]` stays `aria-hidden`. `spokenIds` finds nothing.
    10. **Runnable from the first frame.** Right after a model change (`shown` is `""`), `[data-run]` isn't `aria-disabled` (affordable fixture). Clicking it sends exactly the model's batch under `BOTTLENECK_BUY_LABEL`, and `[data-typed]` then reads the full text. *Catches:* gating the run on `done`, and a missing `finish`.
    11. **`instant`.** With the card open (`instant`), a new model's text shows whole. Under `stubWidth(1280, { reducedMotion: true })` too.
    12. **The run label's countdown doesn't re-type.** `tick(250)` four times on an unaffordable model, and `[data-typed]` stays complete with no new timer.
- [ ] **Step 2:** watch them fail.
- [ ] **Step 3: Implement.**
  - `CommandWords` renders `<span aria-hidden data-typed data-typing={!done || undefined} className={css.typed} key={voice === "plain" ? text : undefined}>{shown}</span>`. The `key` remounts the plain voice's span so its opacity animation (150 ms, no-preference only) replays: that's the crossfade.
  - The blinking cursor is unchanged.
- [ ] **Step 4: The e2e.**
  - **`themes.spec`, "the command reads at every width (L-1)."** For each of `terminal`, `clean-dark`, `clean-oled` and `clean-light` (set through Settings as the spec already does), at widths 600, 640, 820, 1000 and 1280, with `emulateMedia({ reducedMotion: "reduce" })` so the text is whole:
    - read `[data-command] [data-typed]`'s parent's `clientWidth`;
    - measure `"0".repeat(20)` with a canvas in that element's computed `font`;
    - assert width ≥ that measure, or `scrollWidth <= clientWidth` (the whole command fits);
    - in terminal, assert the prompt's text is `$` below 1001 and `operator@manufactory:~$` at 1280.
  - **`reduced-motion.spec`.** `[data-typed]`'s text equals `[data-command-text]`'s shell form at once: compare with `expect(...).toHaveText` on the first poll, with no wait for typing.
- [ ] **Step 5: Mutations.**
  - Drop `onClickCapture`: test 10's full-text assertion fails.
  - Key the hook on the run label: test 12 fails.
  - Restore the long prompt on the tablet: test 8 and the 640 px geometry case fail. Record the measured width in the commit body.
- [ ] **Step 6:** run the full sequence. Commit: `Web: the advice types itself out (cosmetic only), and the tablet prompt is $ so the command reads (UI-3, U-9e, L-1)`.

---

### Task 3: `factory-log.ts`, the pure model and the book; `unlockedAt`

**Files:**
- **Create:**
  - `apps/web/src/ui/factory-log.ts`;
  - `apps/web/src/ui/factory-log.test.ts` (it uses tier-8 fixtures, so it gets the 60 s timeout);
  - `apps/web/src/ui/unlocks.ts`;
  - `apps/web/src/ui/unlocks.test.ts`.
- **Modify:**
  - `apps/web/src/ui/derive.ts`: export `bottleneckKey`, moved from `App.tsx`;
  - `apps/web/src/ui/App.tsx`: import it;
  - `apps/web/src/ui/feel.ts`: `log` is the real book.

**Interfaces:**

```ts
// unlocks.ts (U-9d)
export interface Unlocks { items: ItemId[]; lanes: LaneId[]; marks: { machineClass: MachineClassId; mark: number }[] }
export function unlockedAt(content: IndexedContent, tier: number): Unlocks;
/** "ROTOR, STATOR +3" / "Rotor, Stator +3": the first two named (items, then lanes, then marks), then +N; "" if none. */
export function unlockSummary(s: Snapshot, u: Unlocks, voice: Voice): string;
/** U-8a: "Tier 3 reached. Rotor unlocked." / "Tier 3 reached. Rotor, Stator and 3 more unlocked." / "Tier 3 reached." */
export function tierUpSaid(s: Snapshot, tier: number): string;

// factory-log.ts (U-9a, L-4..L-8)
export type LogTone = "normal" | "advice" | "milestone";
export interface LogEntry { seq: number; atLocalMs: number; tone: LogTone; key: string; text: string; said: string }
export type LogDraft = Omit<LogEntry, "seq" | "atLocalMs">;
/** Pure: the drafts for one adoption, in L-8's order; no dedupe; [] when prev is null. */
export function logEntries(prev: Snapshot | null, next: Snapshot, settled: Batch | null): LogDraft[];
export function itemOfLabel(label: string, prev: Snapshot): ItemId | null;
export function logTime(atLocalMs: number): string;           // "14:02:11", local, zero-padded
export const LOG_CAP = 200, DEDUPE_MS = 60_000, FULL_EVERY_MS = 600_000;
export interface FactoryLogBook {
  record(e: AdoptEvent): void;
  entries(): readonly LogEntry[];   // oldest first; stable identity between versions
  version(): number;
  subscribe(fn: () => void): () => void;
}
export function createFactoryLog(d: { now(): number; wallNow?: () => number }): FactoryLogBook;
```

**Storage-full** compares `itemStateTag(next.content, next.display.state, id) === "FULL"` with `prev`'s, over the items shown as rows in `next`: `laneItemIds` across the unlocked lanes (L-8's content order).

Steps:
- [ ] **Step 1: Write the failing tests.**
  - `unlocks.test.ts`:
    1. Tier-by-tier on the slice: `unlockedAt` lists the items whose `tier === t` in lanes unlocked at `t`, then the lanes whose `unlockTier === t`, then the marks whose `unlockTier === t`. The test reads the expected sets from content, not from literals.
    2. `unlockSummary` names two, then `+N`, in both voices. `tierUpSaid` uses content names and "and N more". A tier with nothing new gives `"Tier N reached."`.
  - `factory-log.test.ts`:
    3. **Nothing on the first snapshot.** `logEntries(null, s, null)` is `[]`.
    4. **A purchase, for each L-6 row:**
       - `drawer:<item>:buy` with `BUY_MACHINE` → the line with lane and rates;
       - `BOTTLENECK_BUY_LABEL` → the item of `prev`'s bottleneck;
       - `power:biomass_burner:buy` → the grid line (`burnerMk2Slice` not needed);
       - `BUY_STORAGE` → the cap line;
       - `DISMANTLE`, `UPGRADE_MARK` and `BUY_QS` → their lines;
       - an unknown label → no rate clause.

       Each also checks `said` against `ID_LIKE` (no ids).
    5. **Settings never log.** `SET_RESERVE` under `BOTTLENECK_BUY_LABEL`, `REORDER_PRIORITY`, `ASSIGN` and a recipe change → `[]`. *Catches:* deciding by label, not by action.
    6. **Storage full.** An item that gains `FULL` → one `normal` line, with key `full:<id>`. An item already `FULL` in `prev` → nothing. An item not shown as a row → nothing.
    7. **The bottleneck.** Moved (both sides non-null), appeared, cleared and frameless (the `power` name), each `advice`. The same key → nothing.
    8. **A tier-up.** One `milestone` line, `TIER 3 reached · ROTOR, STATOR unlocked`, ordered after the purchase and before full and bottleneck (L-8).
    9. **The book's 60 s dedupe.** Record A→B, B→A, A→B at 10 s apart on `now`: the entries are 2. At 61 s after the first A→B, a third A→B is kept. *Catches:* deduping on `text`, or on the wall clock.
    10. **Full every 10 minutes.** A flip FULL→not→FULL on one item at 1 min intervals logs once until 10 min have passed, then again.
    11. **The reset.** An event with `prev: null` empties `entries()`, clears both dedupe maps (the same full line right after is kept), and bumps `version()`.
    12. **The ring.** 250 purchases → 200 entries, and the oldest dropped. `entries()` is the same array object between records with no new lines. `subscribe` fires only when lines were added or reset.
    13. **`logTime`.** A pinned `TZ`-agnostic case: build the ms from `new Date(2026, 10, 7, 4, 5, 6)` → `"04:05:06"`.
- [ ] **Step 2:** watch them fail.
- [ ] **Step 3: Implement.**
  - `text` uses `itemLabel`/`machineLabel`/`laneLabel` with `themeDef("terminal")`. `said` uses `themeDef("clean-dark")` (the content names), capitalised.
  - The book appends with `seq++` and slices to `LOG_CAP`.
- [ ] **Step 4:** green.
- [ ] **Step 5: Mutations.**
  - Remove the `prev === null` reset: 11 fails.
  - Make purchases dedupe by item: test 4's double buy (add one: two buys of the same item 5 s apart, both kept) fails.
- [ ] **Step 6:** full sequence. Commit: `Web: the factory log's model: purchases, storage full, the bottleneck and tier-ups, deduped, in a ring per world (UI-3, U-9a)`.

---

### Task 4: the log in the shell: the desktop box, the phone ticker and sheet

**Files:**
- **Create:**
  - `apps/web/src/ui/FactoryLog.tsx`: `FactoryLog` (the box), `LogTicker` and `LogSheet`;
  - `apps/web/src/ui/FactoryLog.module.css`;
  - `apps/web/src/ui/FactoryLog.test.tsx`.
- **Modify:**
  - `apps/web/src/ui/Shell.tsx`: a `log` slot between the content row and the command (desktop); on the phone, the ticker before `slots.command` on the factory tab;
  - `apps/web/src/ui/App.tsx`: `logOpen` state, the sheet, closing it on a layout change, `scopeOf({ …, log })`, focus return to `[data-log-ticker]`;
  - `apps/web/src/ui/keys.ts`: `focusKind` → `"arrows"` for `[data-factory-log]` and its descendants; `scopeOf` gains `log`;
  - `apps/web/src/ui/keys.test.ts`;
  - `apps/web/src/ui/dialog.ts`: `[data-log-host]` in `MODAL_HOSTS`;
  - `apps/web/src/styles/contrast.test.ts`: `ON_SURFACE.logSheet = "s2"`;
  - `apps/web/e2e/layout-320.spec.ts`: the log sheet step.

**The box (desktop and tablet, `(min-height: 700px)`):**
- `section[aria-label="Factory log"][aria-live="off"][data-factory-log]`: 96 px (`flex: none; height: 96px`), `padding: 6px 12px`, a `1px solid var(--line)` border, 12 px.
- The first line is `$ tail -f factory.log` in `--t3` (plain: `Factory log`).
- Then `ol` entries: `time  text`. `normal` lines are `--t2`, `advice` `--advice`, `milestone` `--advice-hi`.
- The newest `li` ends with an 8×13 `--t-body` block (`.cursor`). Its `steps(1)` opacity blink is under no-preference only.
- **Sticking to the bottom:** a layout effect after the entries change sets `scrollTop = scrollHeight` if, before the update, `scrollHeight − scrollTop − clientHeight ≤ 2`.
- **Reachable when it overflows:** `tabIndex={overflowing ? 0 : undefined}`, measured in the same effect and on resize.
- **Re-renders only on new lines:** it subscribes with `useSyncExternalStore(book.subscribe, book.entries)`. Each `li` is a `memo` keyed by `seq`.

The ticker and the sheet: L-10 and L-11. The ticker is `button[data-log-ticker]` with the label "Factory log, N entries" and the newest line ellipsized (`aria-hidden` text inside a labelled button). The sheet is `[data-log-host] > [role=dialog][aria-modal=true][data-log-sheet]`, titled `factory.log` (plain: `Factory log`), with the full list (newest at the bottom, scrolled there on open).

Steps:
- [ ] **Step 1: Write the failing tests** (`FactoryLog.test.tsx`, App-level, 60 s timeout, `fakeStore` + `adopt`).
  1. **No second live region.** At 1280, after a purchase adoption, the log section has `aria-live="off"`, no `role`, and is labelled "Factory log". The document still has exactly one `[aria-live="polite"], [role=status], [role=log], [role=alert]`. *Catches:* `role=log`.
  2. **No announcement.** The announce span's text doesn't change for log lines (spy on `createAnnouncer`'s `announce`).
  3. **Rows don't move (U-3a).** The first row's `getBoundingClientRect().top` is equal before and after five log lines arrive. `[data-main-box]`'s own height isn't changed by lines (the box is fixed at 96 px).
  4. **Render isolation (L-12).** With a render counter on `Row` (a `vi.spyOn` of the module export via a test-only wrapper, or React Profiler `onRender` around `RowList`), a log-only update (`log.record` with a full-storage event) re-renders `FactoryLog` and no `Row`.
  5. **Sticks to the bottom, unless scrolled up.** Stub `scrollHeight`/`clientHeight`. At the bottom, a new line scrolls down. With `scrollTop` set up 50 px, it stays put.
  6. **Keys (L-9).** `focusKind` on `[data-factory-log]` gives `"arrows"`. With focus there, ↓ doesn't change the row selection, and Enter sends nothing.
  7. **The phone ticker.** At 390 with no entries, there's no `[data-log-ticker]`. After one, the ticker shows its text and is named "Factory log, 1 entries" (pluralised: "1 entry"). Clicking it opens the modal sheet. The rest of the app is inert (the floating TAP is under `[inert]`), Tab is trapped, and Esc closes it, focus back on the ticker.
  8. **A resize while open.** 390 → 1280 with the sheet open closes it, focus lands on the row list, and there's never more than one `[aria-modal=true]`.
  9. **Short viewport (L-10).** `stubWidth` extended with a height (add `height` to its options and `min-height`/`max-height` query support). At 1280×650 → the ticker, not the box.
  10. **The plain voice.** Clean (Dark) shows `said`. Terminal's `spokenIds` within the log is `[]`.
  - `keys.test.ts`: `scopeOf({ phone: true, log: true, … })` is `"sheet"`, and a `[data-factory-log]` element gives `focusKind === "arrows"`.
- [ ] **Step 2:** watch them fail.
- [ ] **Step 3: Implement.** The box CSS: `.cursor` blinks with a keyframes on `opacity`, inside no-preference, in `FactoryLog.module.css`. `--t3` is used only on the header line on `--bg`, and the sheet uses `--t2`.
- [ ] **Step 4: E2E.**
  - **`layout-320`:** after the existing buy, `[data-log-ticker]` appears. Tap it: `[data-log-sheet][aria-modal="true"]` and `expectNoOverflow`. Close with `x`, and focus is on the ticker.
  - **`guest-buy`:** after the buy, `[data-factory-log] li` contains `bought` (desktop 1280×820). At 1280×820 the main box fits at least eight 44 px rows: `mainBox.clientHeight − 30 ≥ 8 × 44` (U-9a's cost line).
- [ ] **Step 5: Mutations.**
  - Give the section `role="log"`: test 1 fails.
  - Drop the `"arrows"` case: test 6 fails.
  - Make the box `min-height: 96px` inside the content row: test 3 fails.
- [ ] **Step 6:** full sequence. Commit: `Web: the factory log: a tail -f box on desktop, a ticker and a modal sheet on the phone, never a live region (UI-3, U-9a)`.

---

### Task 5: `trend.ts`, the TREND column, the drawer's trend, and the trend word

**Files:**
- **Create:**
  - `apps/web/src/ui/trend.ts`;
  - `apps/web/src/ui/trend.test.ts`;
  - `apps/web/src/ui/use-trend.ts`.
- **Modify:**
  - `apps/web/src/ui/feel.ts`: `trend` is the real book;
  - `apps/web/src/ui/RowList.tsx`: `LAST 10 MIN` in the header; the lane's trends via `useTrend`;
  - `apps/web/src/ui/Row.tsx`: a `trend` prop; the `Trend` memo cell, `aria-hidden`; `optionName(…, trend.word)`;
  - `apps/web/src/ui/Row.module.css`: `.trend` (120 px), its colours (L-14), `display: none` by default and shown under `@container rows (min-width: 1100px)`; `.phone .trend { display: none }`;
  - `apps/web/src/ui/derive.ts`: `optionName(s, row, bottleneck, word?: TrendWord | null)`;
  - `apps/web/src/ui/Drawer.tsx`: the item meta line appends `· trend ▁▂▂▃▃▅` when `trendInMeta` (`mode !== "desktop"`): the cells are `aria-hidden`, then a visually hidden "trend rising";
  - `apps/web/src/ui/App.tsx`: passes `trendInMeta`;
  - `apps/web/src/styles/contrast.test.ts`: case 6 (L-14);
  - `RowList.test.tsx`, `derive.test.ts`, `Drawer.test.tsx`.

**Interfaces:**

```ts
// trend.ts (U-9b, L-12, L-13)
export const TREND_BUCKETS = 10, BUCKET_MS = 60_000, STEADY_BAND = 0.02;
export type TrendWord = "rising" | "falling" | "steady";
export interface TrendBook {
  record(e: AdoptEvent): void;                       // reset on prev === null; else credit prev's segment
  /** Oldest first; the open segment of `latest` credited up to serverMs, not stored. */
  window(itemId: ItemId, latest: Snapshot, serverMs: number): (number | null)[];
  version(): number;
  subscribe(fn: () => void): () => void;              // arms the minute timer while subscribed
}
export function createTrendBook(d: { later(fn: () => void, ms: number): () => void; now(): number }): TrendBook;
export function sparkline(values: readonly (number | null)[]): string;   // "▁▂…█", "·" for null, all "▄" when steady
export function trendWord(values: readonly (number | null)[]): TrendWord | null;
export interface RowTrend { cells: string; word: TrendWord | null; down: boolean }
export function rowTrend(book: TrendBook, s: Snapshot, itemId: ItemId, serverMs: number): RowTrend;

// use-trend.ts
export function useTrend(book: TrendBook): number;    // useSyncExternalStore(book.subscribe, book.version)
```

**The storage.**
- **A fixed ring.** Ten slots, each `{ key: number; coveredMs: number; sums: Map<ItemId, number> }`, indexed by `key % 10`. A slot whose `key` isn't the bucket asked for is empty.
- **`committedTo`** is L-13's fence.
- **The cost is bounded.** At most 10 × (catalog items) numbers. Nothing is persisted.

Steps:
- [ ] **Step 1: Write the failing tests.**
  - `trend.test.ts` (pure, with a hand-made `Snapshot`-like `schedule`):
    1. **The weighting.** A segment of 30 s at +2 and 30 s at +4, inside one minute → that bucket is 3. A segment across two minutes splits by time.
    2. **The cut at the boundary.** `end = min(next.atMs, prev.nextBoundaryAtMs)`. With a boundary at +20 s and the next snapshot at +5 min, only 20 s are credited, and the minutes after are `null`. *Catches:* crediting the hidden-tab gap at stale rates.
    3. **The open segment** is credited in `window` and not stored: two `window` calls at the same `serverMs` agree, and a later `record` doesn't double it.
    4. **The fence (L-13).** A POST whose `atMs` trails the last credited end by 2 s adds 0 for the overlap.
    5. **Unknown cells.** A fresh book → ten `null`s → `"··········"`.
    6. **The scale.** `[0, 1, …, 7]` → `"▁▂▃▄▅▆▇█"`, and a negative range scales the same way.
    7. **The steady band.** Values within 2 % of `max|v|` → every known cell `▄`; all zero → `▄`. *Catches:* dividing by zero, or a flat line drawn as `▁`.
    8. **`trendWord`.** Rising, falling and steady (inside the band), and `null` with fewer than two known values.
    9. **Bounded (Review Focus 5).** Record 1,000 one-minute adoptions. The internal slot count stays 10 (expose a test-only `size()`), and `window` covers only the last ten minutes.
    10. **The reset** on `prev === null` empties the ring and `committedTo`.
    11. **The minute timer.** With a fake `later`, subscribing arms one timer for the next server minute. It fires → `version` bumps → re-arms. Unsubscribing the last listener cancels it (the queue is empty). *Catches:* a timer leak.
  - `RowList.test.tsx` (60 s timeout):
    12. **The cadence (L-12).** On tier-8 with a Profiler around the list, ten `tick(250)` re-render no `Trend` cell. One `adopt` re-renders each once. Advancing past the server minute (`tick` to the boundary) re-renders each once.
    13. **The DOM is fixed (U-3a, RowList test 1 extended).** The bottleneck row and a normal row still have the same element structure with the trend cell.
    14. **The option name.** It ends `…, rising, bottleneck` on a rising bottleneck row (L-15), and has no word with fewer than two known buckets.
    15. **The colour classes.** Down when `netPerSecond < 0`, `state-bottleneck` on the bottleneck row, otherwise neither.
  - `derive.test.ts`: `optionName` with `word` keeps `, bottleneck` last.
  - `Drawer.test.tsx`: at a tablet `presentation="panel"` with `trendInMeta`, `[data-meta]` contains `trend ` and ten cells, and a reader gets "trend steady" (or no trend text with no word). On desktop, no trend in the meta.
  - `contrast.test.ts` case 6: **"every --t3 row cell has a selected-row override (L-14)".** Read `Row.module.css`. For every rule that sets `color: var(--t3)` on a selector containing a cell class (`gutter`, `name`, `rate`, `sat`, `trend`, `unknown`, `machines`, `storage`, `stock`), some rule with `.row[aria-selected="true"]` and that class sets `color: var(--t2)`. Self-check: a synthetic CSS without the override fails.
- [ ] **Step 2:** watch them fail.
- [ ] **Step 3: Implement.**
  - **The header.** `LAST 10 MIN` sits in `.trend` between SAT and MACHINES (U-3b's order).
  - **The cell.** `<span className={cx(css.trend, down && css.down, bottleneck && "state-bottleneck")} aria-hidden="true">`. Runs of `·` are wrapped in `<span className={css.unknown}>`.
- [ ] **Step 4: E2E.** `guest-buy` at 1280: the `LAST 10 MIN` header is visible, and the first row's `[class*="_trend_"]` text has length 10 and starts with `·`. `layout-320`: no trend cell visible.
- [ ] **Step 5: Mutations.**
  - Read `useTick()` in `Trend`: test 12 fails.
  - Drop `committedTo`: test 4 fails.
  - Remove the selected-row override: contrast case 6 fails.
  - Put the word after `, bottleneck`: test 14 and `reduced-motion.spec` fail.
- [ ] **Step 6:** full sequence. Commit: `Web: ten-minute sparklines in the TREND column and the drawer, with the trend in the row's name (UI-3, U-9b)`.

---

### Task 6: the glow, the scanlines, the CRT setting, and the tier-up banner

**Files:**
- **Modify:**
  - `apps/web/src/styles/tokens.css`: the three off blocks (L-16);
  - `apps/web/src/styles/base.css`: `.app`'s `text-shadow` and `background-image`;
  - `apps/web/src/ui/Shell.module.css`: `.title` `--glow-title`; `[data-tier-slot]`;
  - every module with an `--accent` or `--advice-fill` background: `text-shadow: none` (12a finds them);
  - `apps/web/src/ui/theme.ts`: `crtOn`, `setCrt`, `useCrt`, `CRT_KEY = "mi.crt"`, `applyCrt(root)`;
  - `apps/web/index.html`: the inline script sets `data-crt`;
  - `apps/web/src/ui/Settings.tsx` and `Settings.module.css`: the checkbox;
  - `apps/web/src/ui/Notices.tsx`: the tier-up as a hidden span with `tierUpSaid` (L-17); `tier-up` leaves `TOASTS`;
  - `apps/web/src/ui/Shell.tsx`: the `[data-tier-slot]` wrappers; `TierBanner` in them;
  - `apps/web/src/ui/TierReadout.tsx`: the comment ("the tier-up notice is the announcement");
  - `apps/web/src/styles/tokens.test.ts`: 12a, 12b, 12c;
  - `theme.test.ts`, `Settings.test.tsx`, `Shell.test.tsx` (test 7's count) and `RowList.test.tsx` ("one live region": the tier-up is still inside it);
  - `apps/web/e2e/themes.spec.ts` and `apps/web/e2e/reduced-motion.spec.ts`.
- **Create:**
  - `apps/web/src/ui/TierBanner.tsx`;
  - `apps/web/src/ui/TierBanner.module.css`;
  - `apps/web/src/ui/TierBanner.test.tsx`.

**The banner:**

```tsx
// TierBanner.tsx (U-9d, L-17, L-18)
export function TierBanner(p: { view: StoreView; snapshot: Snapshot;
  store: Pick<GameStore, "dismiss" | "later"> }): JSX.Element | null;
```

- **What it shows:** `*** TIER 3 REACHED · ROTOR unlocked ***` (plain: `Tier 3 reached · Rotor unlocked`), using `unlockSummary`. With no unlocks: `*** TIER 3 REACHED ***`.
- **Its box:** 13 px `--advice-hi`, `1px solid var(--advice-hi)`, `padding: 4px 10px`, `text-shadow: var(--glow-banner)`, `background: var(--bg)`, `aria-hidden="true"` and `data-tier-banner`.

Steps:
- [ ] **Step 1: Write the failing tests.**
  - `tokens.test.ts`:
    1. **12a. Solid fills drop the glow.** Every rule whose `background` or `background-color` is `var(--accent)` or `var(--advice-fill)` sets `text-shadow: none`. Self-check on a synthetic rule.
    2. **12b. The off switches.** `tokens.css` has `@media (prefers-reduced-motion: reduce)` setting every `--glow-*` to `none` (and not `--scanlines`). It has `@media (prefers-contrast: more)` and `:root[data-crt="off"]` setting all five `--glow-*` and `--scanlines` to `none`. All three come after the phone block (source order).
    3. **12c. Static glow.** No `transition` or `@keyframes` names `text-shadow` or `background-image` (7a covers it; this case names the glow so the reason is on record). `base.css`'s `.app` uses `var(--glow-text)` and `var(--scanlines)` as `background-image`, never on a `::after` overlay (U-1f).
  - `theme.test.ts`:
    4. `mi.crt` absent → on. `setCrt(false)` stores `"off"` and sets `data-crt="off"` on `<html>`. `setCrt(true)` removes both. Storage throwing → in memory only. The `index.html` inline script, run against `"off"`, junk and absent, sets the same attribute as `applyCrt` (as the theme's script test does).
  - `Settings.test.tsx`:
    5. "Glow and scanlines" is checked by default and toggles `data-crt`. In Clean (Dark) it's `disabled`, with "Retro terminal only" as its description.
  - `TierBanner.test.tsx` (App-level, 60 s timeout):
    6. **The text.** A tier 1→2 adoption plus the `tier-up` notice → `[data-tier-banner]` reads the unlock summary for the slice's tier 2, and it's `aria-hidden`.
    7. **8 s.** `tick(7_999)` → still shown. `tick(1)` → `store.dismiss` is called with `"tier-up"`, and after the out-fade (`tick(400)`) it's gone. Under `stubWidth(…, { reducedMotion: true })` it's gone at 8 s with no 400 ms tail.
    8. **A click dismisses it.** The banner is never `document.activeElement` at any point, and focus stays where it was (the row list). *Catches:* a focusable banner.
    9. **Said once (U-8a).** The region holds exactly one `[data-notice="tier-up"]`, visually hidden, reading `Tier 2 reached. <Name> unlocked.`. No visible tier-up toast and no Dismiss button. The banner isn't inside the region, and there's still one live region.
    10. **The header doesn't move (L-18).** At 1280, 820 and 390, `header.getBoundingClientRect().height` is equal with and without the banner. On the phone the readouts' box is unchanged.
- [ ] **Step 2:** watch them fail.
- [ ] **Step 3: Implement**, following L-16 to L-18. `Notices` keeps every other notice as it is.
- [ ] **Step 4: E2E.**
  - **`themes.spec`:**
    - in terminal, `.app`'s computed `text-shadow` isn't `none`, and its `background-image` contains `repeating-linear-gradient`;
    - in Clean (Dark), both are `none`;
    - back in terminal, untick "Glow and scanlines" → both `none`, and after a reload still `none`, checked before first paint by reading `document.documentElement.dataset.crt` in an `addInitScript` hook, as the theme's no-flash case does;
    - with `emulateMedia({ contrast: "more" })`, both are `none`.
  - **`reduced-motion.spec`:** `.app`'s computed `text-shadow` is `none` (the spec's row). The `background-image` still has the scanlines (U-8c: they stay).
- [ ] **Step 5: Mutations.**
  - Remove the reduce block: `reduced-motion.spec` fails.
  - Put the tier-up back in `TOASTS`: test 9 fails.
  - Lay the banner out in flow: test 10 fails.
- [ ] **Step 6:** full sequence. Commit: `Web: phosphor glow and scanlines under a CRT setting, and an 8 s tier-up banner over the readout (UI-3, U-9c, U-9d)`.

---

### Task 7: `feel-alive.spec`, frame timing, the U-8c audit, and the README

**Files:**
- **Create:** `apps/web/e2e/feel-alive.spec.ts`.
- **Modify:**
  - `apps/web/e2e/keyboard.spec.ts`: one assertion (Enter during typing);
  - `README.md` ("In the client");
  - `.github/workflows/ci.yml`: the e2e timing comment only.

Steps:
- [ ] **Step 1: `feel-alive.spec`** (desktop 1280×820, motion on).
  1. **The log on a buy.** Wait for `[data-command] [data-run]` to be enabled, then press Enter. `data-state-version` advances, and `[data-factory-log] li` gains a line matching `/bought \d+ /`. The section's `aria-live` is `off`, and `page.locator('[role="log"]')` has count 0.
  2. **Enter during typing.** After step 1's buy the command text changes and types again (at most 600 ms). Wait for `[data-typed][data-typing]` to be attached (a DOM wait), and for `[data-run]` to be enabled. Then press Enter at once.
     - one POST is sent (the `actionPosts` count);
     - `[data-typed]` equals the full shell text right after;
     - `[data-command-text]` never contained a partial string (record its text on each mutation with a `MutationObserver` installed via `evaluate`; every recorded value is a complete sentence ending as `commandText` does).
  3. **The trend.** `LAST 10 MIN` is visible, and each visible trend cell has 10 characters.
  4. **Glow and frames (L-20).**
     - install a `PerformanceObserver({ type: "longtask", buffered: true })` collector;
     - wait 5 s for the store's next tick: `expect.poll` on a `data-state-version` or 20 ticks via the DOM stock text changing. This is a DOM wait, not a sleep;
     - assert no long task over 50 ms;
     - record the median `requestAnimationFrame` interval over 120 frames as `test.info().annotations`;
     - repeat with CRT off, and record both.
  5. **Rows don't move.** The first row's `top` is equal before and after the log gains a line.
- [ ] **Step 2: `keyboard.spec`.** In the existing Enter step, also assert `[data-typed]`'s text equals the shell command after the press (`finish`).
- [ ] **Step 3: The U-8c audit.** Walk the table row by row, and record each in the commit body with the test that pins it:
  - bar fill: `Bar` tests;
  - `!` pulse: 7c and `reduced-motion`;
  - command cursor: 7b;
  - typing: Task 2;
  - number tweens: `use-tween`;
  - card, sheets and drawer: 7b;
  - tier banner: Task 6 test 7;
  - glow and scanlines: Task 6;
  - TAP time-left bar: `Power` tests;
  - the conveyor and sweep: retired (grep confirms there's no `Conveyor` and no `sweep`).

  Any row without a test gets one here.
- [ ] **Step 4: README.** The "In the client" paragraph gains one sentence each:
  - the factory log (the desktop box, the phone ticker);
  - sparklines (ten minutes, kept in memory);
  - the glow and scanlines with the CRT setting (terminal only, off under reduced motion and high contrast);
  - the tier banner;
  - the typing advice (cosmetic).

  Also: "Welcome back, sound, haptics, the command palette and the flow tree are deferred."
- [ ] **Step 5: Mutations, with the one spec re-run.**
  - Gate `[data-run]` on typing `done`: step 2's POST count is 0 in time, so it fails.
  - Give the log `role="log"`: step 1 fails.
- [ ] **Step 6:** run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, then the e2e, all green. Commit: `Web: the feel-alive e2e, frame timing with the glow, the U-8c audit and the README (UI-3)`.

---

## Spec-vs-code notes (for the reviewer)

1. **`LogEntry` has `said` beside `text`** (L-5). U-9a's shape had only `text`, which would put ids in front of screen readers (U-1h).
2. **Purchases are keyed by batch, never deduped** (L-6). U-9a's 60 s same-key rule is for automatic events. A second identical buy is a second player action.
3. **The generator purchase line** has no item. Its label is `power:<class>:buy` (K-12), so it reports the grid's MW, not a rate.
4. **The tier-up's unlock summary** is added in `Notices`, not in the store's notice text (L-17). `sync/` doesn't import UI naming.
5. **The banner's timer dismisses the store notice.** The hidden announcement and the picture leave together, and the notice no longer lingers as an undismissable toast.
6. **The phone ticker is 44 px on touch** (L-10). U-8d's 44 px rule outranks U-9a's 24 px.
7. **The log box needs a 700 px tall viewport** (L-10). Shorter ones use the ticker, protecting U-9a's eight-row claim.
8. **The scrollable log is a tab stop when it overflows**, and its arrows are native (L-9), amending K-18 for this region.
9. **The frame-timing check runs on the guest world,** and tier-8 render isolation is pinned in jsdom (L-20).
10. **"Every theme" in the geometry check** means the four themes a production build can select. Cosy and Industrial are locked, and `?theme=` is dev-only (U-1i). Their tokens are covered by the contrast and token tests.
11. **The CRT checkbox** is natively `disabled` outside terminal (L-16). The locked theme radios use `aria-disabled` because they must stay announced as choices. The checkbox's description says why it's off.
12. **The deferred ideas are absent.** There's no `summary` read, no `AudioContext`, no `navigator.vibrate`, no `:` key and no flow tree. The Task 7 reviewer greps for each.
