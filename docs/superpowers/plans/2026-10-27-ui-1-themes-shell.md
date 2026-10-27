# UI-1: themes, the shell and the command bar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the spec's UI-1 row. When it lands:
- players get the retro terminal by default and can switch to the three Clean themes;
- Cosy and Industrial are registered but locked;
- the bottleneck lives in the command line, and rows never move;
- the phone has its power tab and a floating TAP;
- every D.1 action is still reachable, and generators get a `+1` of their own.

**Architecture:**
- **Task 1:** the token sets and the theme registry. This covers migration, the lock, the capability seam, the Settings theme list and the new contrast test. A legacy-alias block keeps today's CSS modules rendering until they're re-skinned.
- **Task 2:** self-hosted fonts and the name helpers.
- **Task 3:** the viewport shell at three layouts. It brings the header, the Panels nav, the lane tabs (with lights and locked lanes), the phone's bottom tabs, the notices overlay, the generalised inert pass, and About in Settings.
- **Task 4:** the command line. This is the desktop bar, the phone split bar, and the NEXT_BUY card and sheet. The frame's buttons move into it; the old frame keeps rendering for one more commit.
- **Task 5:** fixed rows. The row list is a listbox, with the SAT cell and the `Bar` (a two-transform reveal). The frame, `LaneView`, `ItemRow`, the conveyor and the sweep are deleted. The split bar, QS and BOUND move into the drawer.
- **Task 6:** the PowerPanel, `PowerFooter` and `FloatingTap`. `PowerDock` is deleted.
- **Task 7:** the existing drawer is restyled and placed: the U-5a panel on desktop and tablet, a U-5b-shaped non-modal sheet on the phone. The remaining modules are re-skinned to the new tokens.
- **Task 8:** the legacy aliases go, the e2e specs are updated, `themes.spec` is added, and the README is updated. Then the full verification, e2e included.

**Tech Stack:** TypeScript ESM, React 18.3.1, Vite 8.2.2, vitest 4 + jsdom + Testing Library, `@playwright/test` 1.64.1 (Chromium). There are no new npm dependencies. The font files are vendored assets.

**Spec:** `docs/superpowers/specs/2026-10-27-ui-terminal-redesign-design.md`. UI-1's scope is its "Build order" row:
- U-1 entire;
- U-2 entire;
- U-3 without TREND;
- U-4 entire;
- U-6 entire;
- the current drawer restyled and placed;
- the frame, conveyor, sweep and dock deleted;
- the e2e selectors updated.

The Phase 4 rulings and the post-launch rulings stand unless a U-ruling supersedes them. Probes are in `/home/nec/.claude/jobs/56686703/tmp/ui/` (`contrast.mjs` measured every value below).

## Rulings made in this plan

- **V-1. A legacy-alias block bridges the token rename, and it's deleted in Task 8.**
  - Task 1 rewrites `tokens.css` to U-1b's semantic set. It appends one `:root` block of aliases for the names today's 13 CSS files use: `--sans`, `--mono`, `--fs-1/2/3`, `--fw-regular`, `--fw-strong`, `--line2`, `--s3` and `--hairline`. Each maps onto a new token: `--line2: var(--line)`, `--s3: var(--s-hi)`, `--hairline: 1px`, `--fs-1: var(--fs-body)` and so on.
  - Tasks 3–7 move each module onto the new names as they rewrite it. Task 8 deletes the block, and a test fails on any legacy name left in any CSS file.
  - *Why:* rewriting 13 files in one task isn't reviewable, and leaving the old names undefined would blank the app between tasks.
  - *Cost if wrong:* an alias outlives Task 8. The Task 8 test prevents that.
- **V-2. Values for the tokens the spec leaves undefined, all measured to pass AA (`contrast.mjs`).** Terminal's `--state-paused` also changes.

  | Token | Clean Light | Clean Dark / OLED | Cosy | Industrial |
  |---|---|---|---|---|
  | `--t-body` | `#18181b` (= t1) | spec | `#3b2f26` (= t1) | spec |
  | `--advice-dim` | `#9a3412` (6.65 on s2) | `#f97316` (5.31 / 6.56) | `#8a3b22` (6.09) | `#d9826b` (5.27) |
  | `--advice-hi` | `#9a3412` | `#fed7aa` (11.0) | `#7a3319` (7.18) | `#f59a80` (7.04) |
  | `--advice-line` | = `--advice` | = `--advice` | `#e8a585` (the spec's border tint) | = `--advice` |
  | `--on-advice-fill` / `--on-accent` | spec | spec | `#fffaf2` | `#17191b` |
  | `--link` / `--link-hover` | `--t1` / `--advice` | `--t1` / `--advice-hi` | `--t1` / `--advice` | `--t1` / `--accent` |
  | `--bar-track` | `--line` | `--line` | `--line` | `#0f1112` |

  - **Terminal's `--state-paused` changes from `#2a8c42` to `#2f9a4a`.** The spec's value is `--t3`'s, and the spec bars `--t3` from `--s-hi` (4.22) and `--s2` (4.46). The SAT cell shows `paused` on a row that can be the selected one, which is `--s-hi`. `#2f9a4a` measures 5.00 on `--s-hi` and 5.55 on `--bg`, and it still reads dimmer than fed (`#4ee06c`).
  - **`--link` / `--link-hover`** are terminal `#7dff9a` / `#c8ffd4`, the spec's own "link / hover" row.
  - **Cosy's `--accent` `#5b7a4f` is a fill only.** It measures 4.17 on `--bg` and 3.83 on `--s2`. That's ≥ 3:1 for the focus ring and the inset bar, but it isn't text. The contrast test bars `color: var(--accent)` in every theme (V-4).
  - *Cost if wrong:* one value in one block. The contrast test re-measures it.
- **V-3. Bars paint through `--bar-paint`, not `--bar-seg: 0`.** U-3d makes the non-terminal fill solid with `--bar-seg: 0`. That gives `repeating-linear-gradient(90deg, currentColor 0 calc(0px − 2px), transparent 0 0)`, and CSS Images 3 renders a zero-length repeating gradient as the **average** of its stops. Here that's a half-transparent fill.
  - Instead, terminal sets `--bar-paint: repeating-linear-gradient(90deg, currentColor 0 calc(var(--bar-seg) - 2px), transparent 0 var(--bar-seg))`, and every other theme sets `--bar-paint: currentColor`. The track and the fill both use `background: var(--bar-paint)`.
  - `--bar-seg` stays `1ch` in terminal and is undefined elsewhere.
  - *Cost if wrong:* one token.
- **V-4. How the contrast test is built (`styles/contrast.test.ts`).**
  - **The parse.** It parses `tokens.css` with the same brace walker `tokens.test.ts` uses. `:root` is terminal, `:root[data-theme="<id>"]` is each other theme, and each block is resolved through `var()` references.
  - **The matrix.** Every theme, every TEXT token on every SURFACE, must reach 4.5:1.
    - TEXT is `t1`, `t-body`, `t2`, `t3`, `advice`, `advice-dim`, `advice-hi`, `rate-up`, `rate-down`, the four `state-*` and `link`.
    - SURFACES are `bg`, `s1`, `s2` and `s-hi`.
    - The fills are `on-accent`/`accent` and `on-advice-fill`/`advice-fill`.
    - Non-text pairs need 3:1: `t2`, `t-body` and `state-bottleneck` on `bg` (bar fills), and `accent` on `bg` and `s2` (the focus ring, the inset bar and the active-tab border).
  - **The barred list.** A `BARRED` table lists the pairs that are allowed to fail the matrix: terminal `t3` on `s-hi` and on `s2`. They're skipped by the matrix and policed in the CSS instead:
    - no rule may set `color: var(--t3)` together with `background: var(--s-hi | --s2)`;
    - no rule may set `color: var(--t3)` on a selector naming a class in a declared `ON_SURFACE` map. The map covers the selected row, the active lane and bottom tabs, the NEXT_BUY card and sheet, and the `[aria-selected="true"]` selectors;
    - no rule may set `color: var(--accent)` anywhere (V-2).
  - **The re-skin allowlist.** A `PENDING_RESKIN` set exempts the not-yet-re-skinned files from the CSS checks. Each task removes its files, and Task 8 asserts the set is empty.
  - *Why:* the matrix covers every pair a component *could* make, so only barred pairs need a usage check. That's tractable without a DOM.
  - *Cost if wrong:* a `--t3` text on a barred surface that's reached through a descendant selector the map doesn't name. The map is reviewed with each new surface class.
- **V-5. Fonts: a latin file plus a symbols file per mono face, from pinned upstreams.**
  - **The problem.** U-1g's "latin subset" doesn't contain the glyphs UI-1 draws. Fontsource's latin range includes U+2191 and U+2193 but **not U+2192 `→`**, and none of `● ▮ ▯ ▴ ≡ ▁…█`. So U-1g's glyph test would fail on latin-only files.
  - **The latin files.** Each face ships its `latin` woff2 from the `@fontsource/<family>` npm tarball, at the version current on the day. Fetch it with `npm pack` into a scratch directory; it's not installed. Record the version in a comment in `styles/fonts.css`.
  - **The symbols files.** IBM Plex Mono and JetBrains Mono also ship a `-symbols` woff2 with exactly `→ ● ▮ ▯ ▴ ≡ · ▁▂▃▄▅▆▇█`. It comes from Google Fonts' `css2?family=…&text=<those glyphs>` endpoint, fetched once at authoring time with a Chrome User-Agent so the response is woff2. It's committed, so there's no runtime request (W-2 holds). It's declared with a matching `unicode-range`.
  - **The weights:**
    - VT323 400;
    - IBM Plex Mono 400, 500 and 600 (600 is Industrial's names);
    - Inter 400, 500 and 600;
    - JetBrains Mono 400 and 500;
    - Nunito 400 and 700;
    - Fraunces 600 and 700;
    - Oswald 500 and 700.
  - **The glyph test (`styles/fonts.test.ts`)** decodes the woff2 files itself (header, table directory, one Brotli stream via `node:zlib`; cmap is never transformed) and reads cmap format 4 and 12. It asserts:
    - VT323 has `[` and `]`;
    - each mono face's latin ∪ symbols covers the set above.

    The UI and display faces aren't checked. A glyph they lack falls back per character, and every meaning glyph sits in a `.glyph` span set in `--font-mono`.
  - **If a mono face lacks a glyph upstream**, the test fails. The implementer then swaps the glyph for the face's nearest equivalent (`■□` for `▮▯`, `▲` for `▴`) and records the swap here.
  - *Cost if wrong:* a few KB per face. The test catches a missing glyph.
- **V-6. A blocking inline script in `index.html` applies the theme before first paint.** `main.tsx` is a module script, so it's deferred, and a browser can paint the parsed body first. For a Clean (Light) player that's a dark flash.
  - A 10-line classic `<script>` in `<head>` reads `mi.theme`, migrates it (the U-1i table), and sets `data-theme`. It doesn't check locks, so a stored `cosy` is set as `terminal`, the same as no capability.
  - `main.tsx` then applies the capability-aware result and the `theme-color` meta.
  - A unit test evaluates the inline script's source from `index.html` against every row of `migrateTheme`'s table, so the two can't drift.
  - `applyTheme` always sets `data-theme`, `terminal` included, so tests and e2e can read it.
  - *Supersedes:* U-1i's "applied in `main.tsx` before the first render", which can't guarantee pre-paint.
  - *Cost if wrong:* one inline script. The CSP is `frame-ancestors` only (`infra/Caddyfile:36`).
- **V-7. Capabilities reach the theme store once per view.**
  - `capabilities(view: StoreView)` returns the empty set today (U-1i).
  - `main.tsx` calls `applyTheme(storedTheme(), capabilities(store.getView()))` after creating the store.
  - `App` calls `syncCapabilities(capabilities(view))` in an effect. That re-applies only when the set's contents change.
  - The theme store holds `{ stored, caps }`, and `useTheme()` returns `{ stored, applied, set }`.
- **V-8. The glow, scanlines and the CRT checkbox wait for UI-3.**
  - The two scope rows overlap: UI-1 claims "U-1 entire", which includes U-1i's CRT checkbox, but UI-3 lists "glow, scanlines and the CRT toggle".
  - UI-1 defines `--glow-*` and `--scanlines` in every block (terminal values from U-1c, `none` elsewhere), so the token tests cover them. No rule references them, and there's no `mi.crt`.
  - *Cost if wrong:* UI-1's terminal is flatter than the mockups for one PR.
- **V-9. Key hints are rendered but hidden until UI-2.**
  - The keyboard (U-7) is UI-2, so in UI-1 `[ENTER]`, `[TAB]`, `F1`, `[T]` and `[1]` would advertise keys that do nothing.
  - Every hint is a separate `<span class="key-hint" aria-hidden="true">`. One rule in `base.css`, `.key-hint { display: none }`, hides them all, and UI-2 replaces it with U-7e's `(hover: hover) and (pointer: fine)` rule.
  - So the visible labels in UI-1 are `run`, `why`, `factory`, `priority`, `handbook`, `TAP`, `buy 1` and `close`.
  - *Cost if wrong:* one CSS rule.
- **V-10. The row list is a listbox with its own arrow keys in UI-1.**
  - **The problem.** U-3c removes the `[data-open-row]` button. Without keys, a keyboard player couldn't open a drawer between UI-1 and UI-2, which would be a W-20 regression.
  - **The keys.** `RowList`'s own `onKeyDown` handles:
    - `↑` and `↓` (move the selection);
    - `Home` and `End`;
    - `→` and `Space` (open the drawer).

    These are exactly U-7a's meanings for those keys. It ignores modified keys and `defaultPrevented`. `Enter` is left alone for UI-2's dispatcher.
  - **The selection** is client state per lane (U-7d). It defaults to the bottleneck's row, then the first row, and is dropped when its item disappears.
  - **Esc** in the drawer returns focus to the listbox (U-7c).
  - **UI-2** moves the keys into `keys.ts`, and the tests carry over.
  - *Cost if wrong:* UI-2 deletes one handler.
- **V-11. The content row is a positioned wrapper. The main box is a `div` that scrolls inside it.**
  - U-2b puts the NEXT_BUY card, the drawer and the notices "inside" the scrolling main box. An absolute child of a scroller scrolls away with the content.
  - So `.contentRow` (`position: relative; flex: 1; min-height: 0`) holds:
    - `.mainBox` (`overflow: auto`, the border, the column header);
    - the overlays, which are absolutely positioned siblings.
  - The main box isn't `<main>`, because `ResetPassword` renders its own `main[data-reset]` inside it.
- **V-12. One inert pass for every modal, and the region is never inert.**
  - **The problem.** Today `App`'s layout effect inerts `app.children` while Settings is open, and it skips `.notices`. In the new shell the region sits inside the content row (U-2e), so inerting its ancestor would silence it.
  - **The helper.** `ui/dialog.ts` adds `inertOutside(root, keep: Element[], region: Element | null)`. It walks down from `root`, inerts every element that contains none of `keep` or `region`, and descends into the ones that do. It inerts the controls inside `region` (`NOTICE_CONTROLS`, unchanged). It returns an undo function.
  - **Who uses it.** It runs for Settings and for the phone NEXT_BUY sheet. That sheet is modal in UI-1 (U-4c). `trapTab` moves out of `Settings.tsx` into the same module.
  - **The phone drawer sheet stays non-modal in UI-1** (`aria-modal="false"`, no scrim, no inert). It takes U-5b's box geometry (V-19). U-5b's modality, grip and drag are UI-2.
- **V-13. The notices overlay shows two at a time and scrolls for the rest.** U-2e says "at most two items". Dropping the third would hide a toast's Dismiss button. So the list renders every notice, and its `max-height` is two notice heights with `overflow-y: auto`. The rows never move.
- **V-14. A frameless bottleneck is now announced.**
  - **Why it's needed.** `useBottleneckAnnouncement` skips a frameless bottleneck, because its notice line was inside the region (`App.tsx:87`). U-3e moves that line into the command bar's comment, out of the region. Without a change, a frameless bottleneck would never be said.
  - **The change.** It's announced as `Bottleneck: <model.text>`, like a framed one.
  - **Scope.** The rest of U-8a's announcement is unchanged.
- **V-15. Both Panels navs are tablists. `?` waits for UI-2.**
  - **The tablists.** The desktop `F1/F2/F3` nav is a `role=tablist` like the phone's bottom tabs (U-2d). So one `tabTarget` (moved to `ui/tabs.ts`, gaining a `skip` predicate for locked lanes) serves both, and one test covers both.
  - **The `?` button.** It opens U-7e's help overlay, which is UI-2, so it isn't rendered in UI-1.
  - **The GPL notice** moves to Settings > About now (U-2e).
- **V-16. The power lane is the generators' lane, found from content.**
  - `powerLaneId(s)` is the lane of the first recipe in `content.producersOf.get(POWER_ITEM)`, or `null`. The production lanes are every other lane, in content `order`.
  - **Lane labels:** `IRON` (uppercased `lane.name`) in terminal and Industrial, and `Iron` in the plain themes. That's `laneLabel` in `names.ts`. U-1h covers items and machines only.
  - **Chrome labels are shared across themes:** `PWR`, `KICK`, the column headers and `lane`. The plain voice changes only what the spec lists: the prompt, the command, the run labels, the phone titles and `Settings`.
  - *Cost if wrong:* a string table in `names.ts`.
- **V-17. The run button's accessible name is the plain spend text.**
  - The visible label is `run` / `[ buy 4 ]` / `affordable in 12s`. The `aria-label` is `BottleneckFrame`'s `spendText` or the reserve text, carried over: "Buy 1 Constructor", "Buy storage for Iron Plate", "Reserve 30% of Screw".
  - When unaffordable it gains ", affordable in 12 seconds" (U-4b's form).
  - The plain short forms:
    - `4 Constructor → Rotor`;
    - run labels `Buy 4`, `Store`, `QS`, `Reserve`;
    - the desktop `Run`.
  - `buy 1` sends `{ ...action, count: 1 }` under `BOTTLENECK_BUY_LABEL`, so the two buttons are busy together.
- **V-18. The split bar, QS and BOUND move into the existing drawer in UI-1.**
  - U-3c takes them out of the row, but the drawer's `SPLIT` section is UI-2. Dropping them for one PR would lose the split's link to the priority list (`PriorityList.test.tsx:439`).
  - So Task 5 moves:
    - `SplitBar`, its `[data-split]` button and `onSplit`, into the drawer;
    - QS and BOUND into the drawer's header meta (U-3c).

    `derive.ts` exports `splitOf`. UI-2 re-skins `SplitBar` as `SPLIT`.
- **V-19. The phone drawer sheet takes U-5b's geometry without its modality.** That's `position: fixed; inset: clamp(56px, 18dvh, 150px) 0 0 0`, with the `--s1` fill, the 2 px `--accent` top border, U-5b's padding and `z-index` above the TAP and the bottom tabs. It's `role=dialog` and `aria-modal=false` (Q-7, as today). `--sheet-bottom`, `--sheet-max` and `data-sheet` go.
- **V-20. The MACHINES cell counts the active recipe's assigned machines.**
  - It shows `CONSTRUCTOR_MK1 x20` when the lane-class pool holds one mark. With several marks it shows `CONSTRUCTOR x20 (2 marks)`, and with none, `—`. It adds ` · split` when `splitOf` isn't null.
  - The count is `solution.capacity.machinesByRecipe.get(activeRecipe)`. The pool is shared across recipes (`ASSIGN_MACHINES`), and the row is the recipe's view of it.
  - Labels use `machineLabel` (U-1h).
- **V-21. Power numbers come from the right engine fields.**
  - **"Up to".** `drawPerMachine` is the **mean over the installed pool** per `lane::class`, and 0 for an empty pool (`economy/capacity.ts:91-97`). It isn't per mark. So "next machine needs up to N MW" is the largest content `MarkDef.powerDraw` of `bestUnlockedMark` over the live non-generator lane-classes in unlocked lanes. That's what one more best-mark machine draws at clock 1.
  - **`powerByLane`** sums `machinesByRecipe × drawPerMachine × solution.clocks` per `recipe.lane`, skipping `powerOutput > 0`.
    - It must use `solution.clocks`, which `absoluteClocks` scales by the ratio for consumers (`solve/power.ts:52`).
    - The pass clocks would sum to `fullDemandMw`, not `demandMw` (`solve/solve.ts:138`).
    - The test pins `|Σ − demandMw| ≤ 1e-9·max(1, demandMw)`.
  - **Generator detail:**
    - `eats` is `Σ inputPerSecond × unitsByRecipe × clock`;
    - `MW each` is `powerOutput × unitsByRecipe / machinesByRecipe` (multipliers included);
    - `MW now` is `powerOutput × unitsByRecipe × clock`.
  - **Generator rows aren't clickable in UI-1.** The recipe-keyed generator drawer is U-5c, which is UI-2. Only `+1` acts.
- **V-22. The footer and TAP strings.**
  - The footer reads `KICK x1.35 · 7 STK · 21s`. With no stacks it reads `KICK off · hold TAP`.
  - The panel's kick line follows U-6b. With no stacks it reads `KICK off · hold TAP to start it`.
  - The floating TAP's accessible name follows U-6c, updated per snapshot and per tap. It's memoised on `(snapshot, taps.lastTapAt, stacks)` and never read at 4 Hz.
  - `data-power` carries `data-stacks` and `data-holding`, as `data-dock` did.
- **V-23. The command line lands before the rows.**
  - Task 4 moves `SpendButton` and `ReserveButton` out of `BottleneckFrame.tsx` into `CommandBar.tsx`. `BottleneckFrame` imports them back for one commit, so the bottleneck buy is never missing from the UI and the `7c` pulse still has a home.
  - For that commit the buy shows twice. Both buttons share `BOTTLENECK_BUY_LABEL`, so they're busy together.
  - Task 5 deletes the frame.
  - *Cost if wrong:* nothing ships between tasks.
- **V-24. The tier readout's formats.**
  - Desktop shell voice: `[TIER 3] next: ROTOR 214/500 · MODULAR_FRAME 38/120`.
  - Plain voice: `Tier 3 · next: Rotor 214/500 · Modular Frame 38/120`.
  - At tier 10: `[TIER 10] complete`.
  - The phone shows one requirement, the lowest `shown / amount`.
  - `data-tier` and `data-requirement` are kept. The numbers tick at 4 Hz, and the readout is never a live region.
- **V-25. View state.**
  - The handbook view **is** the route (`/handbook…`), as today.
  - `factory`, `priority` and (on the phone) `power` are client state in `App`. On desktop, power is the selected lane tab.
  - **The open drawer** stays in `App` state across a view switch, but renders only on the factory view. `claimFocus` keeps a remount from stealing focus, as today.
  - **The handbook link.** `F3 handbook` / `handbook` opens the open drawer's entry, else the index (§13.4, as `data-open-handbook` does).

## Global Constraints

- **Where to work.** Use `.claude/worktrees/phase-4c` only, on branch **`ui-terminal`**. It's main at dd4ab61 plus the spec at 19fcad9. Never touch the top-level checkout, which is stale.
- **Commands:**
  - **Never run `pnpm format`.** It rewrites the whole repo.
  - Verify with `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, sequentially and in the foreground. Never run lint or typecheck while a test run is going, because turbo builds race. Don't run anything in the background.
  - For a single suite: `pnpm --filter @manufactory/web exec vitest run <path>`.
- **Heavy tests get explicit vitest timeouts:** `describe(name, { timeout: 60_000 }, …)`. CI's shared runner is 10–20× slower than local. This covers every suite that renders `App`, or solves or previews a tier-8 fixture: `RowList`, `CommandBar`, `NextBuy`, `PowerPanel`, `d1-coverage`, `Drawer` and `Shell`.
- **Never `pkill -f`**, and no `pgrep -f` loops.
- **No containers.** No Docker, no compose. The only servers are Playwright's own `webServer` entries (the API's PGlite dev server and `vite preview`). Don't start a dev server by hand.
- **No new npm dependencies.** No API, engine, content or sync change: UI-1 needs none (the spec's "no API change and no engine change").
- **The W-4 browser lint** stays as it is. Node-only helpers, such as the woff2 reader, live inside `*.test.ts` files.
- **Motion:**
  - only `transform` and `opacity` animate, all inside `prefers-reduced-motion: no-preference` (tests 7a/7b and `styles/motion.test.ts`);
  - state colours appear only under state-class selectors (8a).
- **Spends are pessimistic and settings are optimistic** (W-13). One intent is one batch.
- **The e2e must run locally and pass before Task 8 commits.**
  - Chromium is installed. Run `pnpm --filter @manufactory/web e2e`, in the foreground.
  - Playwright's `webServer` builds and starts what it needs. `reuseExistingServer` reuses an API already on 8787 only if it was started with `DEV_FAKE_SESSIONS=1`.
- **Commit trailers, exactly:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

- **Rows never move (U-3a).** A framed row and an unframed row have the same DOM. `.row` has a fixed `height`, with no `min-height` or `height: auto` anywhere it can be reached. Nothing in a row changes its box. (Task 5, tests 1–2.)
- **The run button is the frame's logic, moved, not rewritten.** It sends the same batch under the same label. Busy, the countdown and `Guarded` all carry over, and the reserve is never busy. (Task 4, tests 3–5.)
- **Themes:**
  - the contrast matrix covers every theme, and the barred pairs are policed in CSS;
  - the registry swatches equal the CSS values;
  - a locked theme renders `terminal` and keeps the stored value;
  - the inline script agrees with `migrateTheme`.

  (Task 1, tests 1–7.)
- **One live region.** The region is never inert. Its controls are inerted under a modal. A frameless bottleneck is announced. (Task 3 test 6, Task 4 test 8.)
- **Power.** `powerByLane` sums to `demandMw` on both tier-8 fixtures. The generator `+1` is the only new spend path, and it's pessimistic. (Task 6, tests 1–3.)

---

### Task 1: token sets, the theme registry, the lock and the contrast test

**Files:**
- **Rewrite:**
  - `apps/web/src/styles/tokens.css`: six blocks, the size tokens, the V-1 alias block;
  - `apps/web/src/ui/theme.ts`.
- **Create:**
  - `apps/web/src/ui/capabilities.ts`;
  - `apps/web/src/ui/theme.test.ts`;
  - `apps/web/src/styles/contrast.test.ts`.
- **Modify:**
  - `apps/web/src/styles/tokens.test.ts`: 8b is rewritten, and a new test checks that every block defines every token;
  - `apps/web/src/main.tsx`;
  - `apps/web/index.html`: the V-6 inline script and `<meta name="theme-color" content="#050a06">`;
  - `apps/web/src/ui/Settings.tsx`, `Settings.module.css` and `Settings.test.tsx`: the theme list;
  - `apps/web/src/ui/App.tsx`: `syncCapabilities`.

**Interfaces:**

```ts
// capabilities.ts (U-1i)
export type Capability = "theme:cosy" | "theme:industrial";
/** Empty until Spec 2's prestige store; nothing else changes when it fills. */
export function capabilities(view: StoreView): ReadonlySet<Capability>;

// theme.ts (U-1a, U-1i)
export type ThemeId = "terminal" | "clean-dark" | "clean-oled" | "clean-light" | "cosy" | "industrial";
export type Voice = "shell" | "plain";
export type NameStyle = "id" | "title" | "upper";          // IRON_ORE | Iron Ore | IRON ORE (U-1h)
export interface ThemeDef {
  id: ThemeId; name: string;                               // "Retro terminal", "Clean (Dark)", …
  scheme: "dark" | "light"; voice: Voice; names: NameStyle; effects: boolean;
  lock: Capability | null;
  /** The settings swatch and theme-color; a test pins them equal to tokens.css (--bg, --t-body, --advice). */
  swatch: { bg: string; body: string; advice: string };
}
export const THEMES: readonly ThemeDef[];                  // the U-1a order
export const DEFAULT_THEME: ThemeId;                       // "terminal"
export const THEME_KEY = "mi.theme";
export function themeDef(id: ThemeId): ThemeDef;
/** dark→clean-dark, light→clean-light, system|null|unknown→terminal; a ThemeId passes through. */
export function migrateTheme(raw: string | null): ThemeId;
export function storedTheme(): ThemeId;                    // localStorage behind try/catch
/** The theme to render: a locked theme without its capability renders terminal.
 *  In dev only, ?theme=<id> wins regardless of the lock. */
export function resolveTheme(stored: ThemeId, caps: ReadonlySet<Capability>,
  opts?: { search?: string; dev?: boolean }): ThemeId;
/** Sets data-theme (always, terminal included) and meta[name=theme-color] to the swatch bg. Returns the applied id. */
export function applyTheme(stored: ThemeId, caps: ReadonlySet<Capability>,
  root?: HTMLElement, opts?: { search?: string; dev?: boolean }): ThemeId;
/** Stores and applies; a locked id without its capability does nothing and returns false. */
export function setTheme(next: ThemeId): boolean;
export function syncCapabilities(caps: ReadonlySet<Capability>): void; // V-7; re-applies on a content change only
export function useTheme(): { stored: ThemeId; applied: ThemeDef; set(id: ThemeId): boolean };
export function isLocked(def: ThemeDef, caps: ReadonlySet<Capability>): boolean;
```

`tokens.css` defines:
- **U-1b's set:**
  - the surfaces `--bg`, `--s1`, `--s2`, `--s-hi`, `--line`, `--line-soft` and `--rule`;
  - the text tokens `--t1`, `--t-body`, `--t2` and `--t3`;
  - `--accent`/`--on-accent`, the five `--advice*` tokens and `--on-advice-fill`;
  - `--rate-up/down`, the four `--state-*` and `--scrim`;
  - the three faces and the five sizes;
  - the radii;
  - the bar tokens `--bar-h`, `--bar-seg`, `--bar-open` and `--bar-close`;
  - the five glows and `--scanlines`.
- **V-2 and V-3's additions:** `--advice-line`, `--link`, `--link-hover`, `--bar-track` and `--bar-paint`.
- **Row and weight:** `--row-h` (44 px, or 54 px under `(max-width: 599px)`) and `--fw-name` (400, or 600 in Industrial).
- **The sizes:**
  - `--fs-body` 14 px, `--fs-small` 12 px, `--fs-label` 13 px, `--fs-title` 34 px and `--fs-bar` 20 px;
  - under `(max-width: 1000px)`: `--fs-title` 28 px;
  - under `(max-width: 599px)`: `--fs-body` 13 px, `--fs-small` 11 px, `--fs-label` 12 px, `--fs-title` 28 px and `--fs-bar` 17 px.

  These are the same widths as `useLayoutMode`. CSS and JS agree by construction, as W-19 has it.
- **`--pulse-cycle: 2.6s`** stays.
- **`color-scheme`** is set per block.
- **Values:** U-1c to U-1e, V-2 and V-3. Cosy and Industrial's faces name families that Task 2 declares.
- **What goes:** the old light block and the `prefers-color-scheme` block (U-1a: the default ignores the OS preference).

Steps:
- [ ] **Step 1: Write the failing tests.**
  1. **`theme.test.ts`: the registry.**
     - It has six ids in U-1a's order, with `DEFAULT_THEME === "terminal"`.
     - `cosy.lock === "theme:cosy"` and `industrial.lock === "theme:industrial"`. The rest are `null`.
     - The voices and name styles match U-1a's table.
  2. **Migration.** `migrateTheme` maps:
     - `"dark"` → `clean-dark`;
     - `"light"` → `clean-light`;
     - `"system"`, `null`, `"junk"` and `""` → `terminal`;
     - each ThemeId to itself.

     `storedTheme()` with a throwing `localStorage` returns `terminal`.
  3. **The lock.**
     - `resolveTheme("cosy", new Set())` is `terminal`, and the stored value stays `cosy` (`localStorage` untouched).
     - With `new Set(["theme:cosy"])` it's `cosy`.
     - `setTheme("industrial")` with no capability returns `false` and changes neither storage nor `data-theme`.
     - `?theme=cosy` applies with `dev: true` and not with `dev: false`.
  4. **`applyTheme` side effects.**
     - `data-theme` is always set (`"terminal"` included).
     - `meta[name=theme-color]`'s `content` equals `themeDef(applied).swatch.bg`.
  5. **The inline script agrees.** Read `index.html`, extract the inline `<script>` body, and run it with `new Function("localStorage", "document", body)` against a fake storage and root, for every row of test 2. The resulting `data-theme` equals `resolveTheme(migrateTheme(raw), new Set())`.
  6. **`tokens.test.ts`:**
     - 8b is rewritten: terminal `:root` equals U-1c (with V-2's `--state-paused #2f9a4a`) and `--pulse-cycle: 2.6s`.
     - New **8d**: each of the six blocks (`:root`, plus `:root[data-theme="<id>"]` for the five others) defines every semantic token in one `SEMANTIC_TOKENS` list. The alias block is excluded by name.
     - New **8e**: every `THEMES[i].swatch` equals its block's `--bg`, `--t-body` and `--advice`.
  7. **`contrast.test.ts`** (V-4):
     - the matrix, the fills and the non-text pairs pass in every theme;
     - `BARRED` lists exactly terminal `t3`/`s-hi` and `t3`/`s2`;
     - a self-check: the measured terminal `t3` on `s-hi` is 4.22 ± 0.01, so the barred entries are real;
     - the CSS usage checks over every CSS file not in `PENDING_RESKIN`.

     `PENDING_RESKIN` starts with every CSS module under `ui/`, plus `styles/base.css`.
  8. **`Settings.test.tsx`** (test 3 is rewritten):
     - the Theme fieldset lists six radios with swatches;
     - picking Clean (Light) sets `data-theme="clean-light"` and stores it;
     - **Cosy:**
       - it has `aria-disabled="true"`, is focusable, and carries the `locked` tag;
       - its `aria-describedby` text is "Unlocks in the prestige store";
       - clicking it changes nothing.
- [ ] **Step 2: Run the tests, and watch each one fail.** Run `pnpm --filter @manufactory/web exec vitest run src/ui/theme.test.ts src/styles src/ui/Settings.test.tsx`.
- [ ] **Step 3: Implement.**
  - **`theme.ts`:** the registry and `useSyncExternalStore` over `{ stored, caps }`.
  - **`capabilities.ts`.**
  - **`tokens.css`:** the six blocks plus the alias block (V-1). The aliases are `--sans: var(--font-ui)`, `--mono: var(--font-mono)`, `--fs-1: var(--fs-body)`, `--fs-2: var(--fs-label)`, `--fs-3: var(--fs-small)`, `--fw-regular: 400`, `--fw-strong: 600`, `--line2: var(--line)`, `--s3: var(--s-hi)` and `--hairline: 1px`. The faces fall back to `ui-monospace, monospace` until Task 2.
  - **`main.tsx`:** create the store, then `applyTheme(storedTheme(), capabilities(store.getView()))`, then render.
  - **`index.html`:** the inline script and the meta.
  - **`App`:** `useEffect(() => syncCapabilities(capabilities(view)), [view])`.
  - **The Settings Theme fieldset:**
    - one radio per theme, with a `<span class="swatch">` of three chips coloured from `swatch` (inline `background`, which is not a CSS file);
    - for a locked theme: `aria-disabled`, `onChange` returning without calling `set`, the `locked` tag, and a describing line;
    - the swatch at `opacity: 0.6`.
- [ ] **Step 4:** run the suites from Step 2 again. They're green.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Make `resolveTheme` ignore `lock`: test 3 fails.
  - Swap Clean Light's `--t3` back to Minimal's `#71717a`: test 7 fails with 4.40 on `--s2`.
  - Delete `--advice-dim` from the Industrial block: 8d fails.
  - Map `"system"` to `clean-dark` in the inline script only: test 5 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: six theme token sets, the registry with migration and the lock, and a contrast test that measures them (UI-1, U-1)`.

---

### Task 2: self-hosted fonts and the name helpers

**Files:**
- **Create:**
  - `apps/web/src/styles/fonts/*.woff2`, with each family's `OFL.txt` as `fonts/<family>/OFL.txt`;
  - `apps/web/src/styles/fonts.css`;
  - `apps/web/src/styles/fonts.test.ts`;
  - `apps/web/src/ui/names.ts`;
  - `apps/web/src/ui/names.test.ts`.
- **Modify:**
  - `apps/web/src/main.tsx`: import `fonts.css` before `tokens.css`;
  - `apps/web/index.html`: the two preloads;
  - `apps/web/src/styles/tokens.css`: the real `--font-*` stacks per block;
  - `apps/web/vite.config.ts`: only if Step 5's check needs it.

**Interfaces:**

```ts
// names.ts (U-1h, V-16)
export function itemLabel(s: Snapshot, itemId: ItemId, theme: ThemeDef): string;        // IRON_ORE | Iron Ore | IRON ORE
export function machineLabel(s: Snapshot, machineClass: MachineClassId, mark: number | null,
  theme: ThemeDef): string;  // CONSTRUCTOR_MK1 | Constructor Mk.1 (mark def name) | CONSTRUCTOR MK.1; mark null → class: CONSTRUCTOR | Constructor
export function laneLabel(s: Snapshot, laneId: LaneId, theme: ThemeDef): string;        // IRON | Iron
/** What a screen reader gets: the content name, always. */
export function itemName(s: Snapshot, itemId: ItemId): string;
/** Bound to the applied theme: useNames().item(id), .machine(c, m), .lane(id), .voice, .theme. */
export function useNames(s: Snapshot): { item(id: ItemId): string; machine(c: MachineClassId, m: number | null): string;
  lane(id: LaneId): string; voice: Voice; theme: ThemeDef };
```

`fonts.css` declares:
- one `@font-face` per face and weight for the latin file, with `font-display: swap` and fontsource's latin `unicode-range`;
- for Plex Mono and JetBrains Mono, one more per weight for the `-symbols` file, with its `unicode-range` (V-5);
- `url("./fonts/<file>.woff2") format("woff2")`, which Vite hashes.

A `.glyph` class sets `font-family: var(--font-mono)`.

Steps:
- [ ] **Step 1: Obtain the files (V-5). This needs the network, once.**
  - In a scratch directory, `npm pack @fontsource/{vt323,ibm-plex-mono,inter,jetbrains-mono,nunito,fraunces,oswald}`. Copy each needed `files/<family>-latin-<weight>-normal.woff2` and its `LICENSE` (OFL) into `src/styles/fonts/`.
  - Fetch the two symbol subsets with `curl -A "<a current Chrome UA>" "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&text=<URL-encoded set>"`. Download each `src: url(...)` it returns as `ibm-plex-mono-symbols-<w>.woff2`. Do the same for JetBrains Mono at 400 and 500.
  - Record the fontsource versions and the fetch date in a comment at the top of `fonts.css`.
  - Measure the total size per theme. Expect VT323 plus Plex 400/500 latin and symbols at under ~60 KB (U-1g). Report it in the commit body.
- [ ] **Step 2: Write the failing tests.**
  1. **`fonts.test.ts`, the glyphs.** An inline woff2 reader decodes:
     - the 48-byte header;
     - the table directory (the flags byte, then the tag: one of the 63 known tags or an explicit 4 bytes; `UIntBase128` lengths; the transform length for transformed `glyf`/`loca`/`hmtx`);
     - `brotliDecompressSync` of the one stream;
     - the slice of `cmap` (formats 4 and 12).

     Then it asserts:
     - VT323 400 has `[` and `]`;
     - for each weight of Plex Mono and JetBrains Mono, latin ∪ symbols covers `→ ● ▮ ▯ ▴ ≡ · ▁▂▃▄▅▆▇█`;
     - every `url()` in `fonts.css` exists on disk;
     - every family directory has an `OFL.txt`.

     The reader self-checks by finding `A` (U+0041) in every latin file.
  2. **`names.test.ts`.**
     - For `iron_ore`: terminal `IRON_ORE`, Clean `Iron Ore`, Industrial `IRON ORE`.
     - For the constructor at mark 1: `CONSTRUCTOR_MK1`, `Constructor Mk.1` and `CONSTRUCTOR MK.1`.
     - At mark `null`: `CONSTRUCTOR` and `Constructor`.
     - `laneLabel` gives `IRON` and `Iron`.
     - `itemName` is always the content name.
  3. **`tokens.test.ts` 8f:**
     - terminal `--font-display` starts with `"VT323"`;
     - `--font-ui` and `--font-mono` start with `"IBM Plex Mono"`;
     - each other block's faces match U-1d and U-1e;
     - every family named in a `--font-*` token has an `@font-face` in `fonts.css`.
- [ ] **Step 3:** run the tests. Tests 1 and 3 fail (no files or faces yet), and test 2 fails (no module).
- [ ] **Step 4: Implement.**
  - `fonts.css` and the `--font-*` stacks, each ending `, ui-monospace, monospace` (or `system-ui, sans-serif` for a UI face).
  - `names.ts`.
  - Two preloads in `index.html`, for `vt323-latin-400` and `ibm-plex-mono-latin-400`, with `as="font" type="font/woff2" crossorigin`.
- [ ] **Step 5: Check the preload survives the build.** Run `pnpm --filter @manufactory/web run build`. Then `grep -o 'rel="preload"[^>]*' apps/web/dist/index.html` must show **hashed** `/assets/…woff2` paths.
  - **If Vite leaves the source path:** add a `transformIndexHtml` plugin to `vite.config.ts`. It emits the preloads from the bundle's asset names (`generateBundle`), and the check repeats.
  - Also check `dist/assets` has no request to any font origin: `grep -L googleapis` over the CSS.
- [ ] **Step 6:** all three tests are green.
- [ ] **Step 7: Mutations, each undone by hand.**
  - Delete the Plex Mono 400 symbols `@font-face`: test 1 fails on `→`.
  - Make `itemLabel` return `name.toUpperCase()` for terminal: test 2 fails (`IRON ORE` ≠ `IRON_ORE`).
  - Rename the Inter `@font-face` family: test 3 fails.
- [ ] **Step 8:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: self-hosted OFL fonts with a symbols subset, a cmap glyph test, and one name helper per theme (UI-1, U-1g, U-1h)`.

---

### Task 3: the viewport shell at three layouts, with lane tabs, bottom tabs and the notices overlay

**Files:**
- **Create:**
  - `apps/web/src/ui/use-layout-mode.ts`, which replaces `use-panes.ts` (deleted);
  - `apps/web/src/ui/Shell.tsx` (`DesktopShell`, `PhoneShell`) and `Shell.module.css`, which replaces `Layout.module.css` (deleted);
  - `apps/web/src/ui/tabs.ts`, holding `tabTarget` moved out of `App.tsx`;
  - `apps/web/src/ui/dialog.ts`, holding `inertOutside` and `trapTab`;
  - `apps/web/src/ui/Shell.test.tsx`, `apps/web/src/ui/dialog.test.ts` and `apps/web/src/ui/TierReadout.test.tsx` (`PowerDock.test.tsx`'s tests 6 and 7 move here).
- **Modify:**
  - `apps/web/src/ui/App.tsx`: state and wiring only; the markup moves into `Shell`;
  - `apps/web/src/ui/derive.ts`: `laneStatus`, `laneTabs`, `powerLaneId`;
  - `apps/web/src/ui/TierReadout.tsx`: V-24;
  - `apps/web/src/ui/Notices.tsx`: overlay markup only; the region element is unchanged;
  - `apps/web/src/ui/Settings.tsx`: About, and `trapTab` imported;
  - `apps/web/src/styles/base.css`: the app shell, `.key-hint`, `.glyph`, the notice overlay, and no `.app-footer`;
  - `apps/web/src/ui/derive.test.ts`;
  - `apps/web/src/ui/Handbook.test.tsx` and `apps/web/src/ui/LaneView.test.tsx`: the pane and dock tests go, and the `matchMedia` stub becomes `stubWidth` in `test-fixtures.ts`.
- **Delete:** `apps/web/src/ui/Footer.tsx`. Its content goes into Settings > About.

**Interfaces:**

```ts
// use-layout-mode.ts (U-2a)
export type LayoutMode = "phone" | "tablet" | "desktop";
export const DESKTOP_QUERY = "(min-width: 1001px)";
export const TABLET_QUERY = "(min-width: 600px)";
export function useLayoutMode(): LayoutMode;              // no matchMedia → "desktop"

// derive.ts
export type LaneStatus = "bottleneck" | "throttled" | "idle" | "fed";   // U-3e, first match
export function laneStatus(s: Snapshot, laneId: LaneId, bottleneck: BottleneckModel | null): LaneStatus;
export function powerLaneId(s: Snapshot): LaneId | null;                // V-16
export interface LaneTab { id: LaneId; key: number; locked: boolean; unlockTier: number;
  status: LaneStatus | null /* null when locked */; bottleneck: boolean; power: boolean }
/** Production lanes in content order (locked ones too, U-3e), then power last on desktop/tablet; no power on the phone (U-6a). */
export function laneTabs(s: Snapshot, bottleneck: BottleneckModel | null, mode: LayoutMode): LaneTab[];

// tabs.ts
export function tabTarget(e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">,
  i: number, n: number, skip?: (j: number) => boolean): number | null;

// dialog.ts (V-12)
export const NOTICE_CONTROLS = "button, a, input, select, textarea, [tabindex]";
export function inertOutside(root: HTMLElement, keep: readonly Element[], region: Element | null): () => void;
export function trapTab(e: KeyboardEvent, root: HTMLElement): void;     // Settings' wrap, moved

// Shell.tsx
export type View = "factory" | "priority" | "handbook" | "power";       // power: phone only (V-25)
export interface ShellProps {
  store: GameStore; view: StoreView; snapshot: Snapshot; mode: LayoutMode;
  shown: View; onView(v: View): void;
  laneId: LaneId; onLane(id: LaneId): void;
  bottleneck: BottleneckModel | null;
  onSettings(opener: HTMLElement): void; onSaveChip(opener: HTMLElement): void;
  /** Filled by later tasks: the main box content, the overlays, the command line, the footer/TAP. */
  slots: { main: ReactNode; overlays: ReactNode; command: ReactNode; footer: ReactNode; floating: ReactNode };
}
export function DesktopShell(p: ShellProps): JSX.Element;               // desktop and tablet (U-2c: one tree)
export function PhoneShell(p: ShellProps): JSX.Element;
```

The structure:
- **The root.** `.app` has `data-layout`, plus `data-route`, `data-sync`, `data-state-version` and `data-polling`, all unchanged. It's `height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden`.
- **The header.** It holds `h1[aria-label="Manufactory Idle"]`, whose visible title is `aria-hidden`: `MANUFACTORY_`, or the phone tab title from U-2d. Then `TierReadout`. On desktop, the save chip `[data-save-chip]` (S-12 unchanged). The Panels tablist `nav[aria-label=Panels]`, with each tab carrying `data-view`. Then `cfg` / `≡`, as `[data-open-settings]`.
- **The lane tabs.** `nav[aria-label=Lanes]` wraps a `role=tablist` of `button[role=tab][data-lane]`:
  - the light is `span.glyph` `●` (`aria-hidden`), coloured by a `state-*` class;
  - the label is `laneLabel`;
  - the bottleneck lane adds ` !` (desktop) or swaps the light for `!` (phone);
  - a locked lane has `aria-disabled="true"`, a `T6` tag, and the label "Oil, unlocks at tier 6";
  - the `aria-label` is "Iron, bottleneck" / "Iron, throttled" / …;
  - `tabTarget` skips locked tabs, and a click on one does nothing.
- **The content row** (V-11). `.contentRow` holds `.mainBox#view-<shown>` (the factory panel: `role=tabpanel`, `aria-labelledby` the lane tab), then the notices region (`Notices`, overlay CSS), then `slots.overlays`.
- **The phone.** `slots.command` goes on the factory tab only. `slots.floating` (the TAP) is absolute in `.app`. The bottom tablist `nav[aria-label=Panels]` holds `factory · ~ power · priority · handbook`.
- **Desktop.** `slots.command`, then `slots.footer`.
- **About.** In Settings, `section[aria-labelledby]` "About" holds Footer's text and its two links, keeping `data-source-link` and `data-license-link`.

Until Tasks 4–6, the slots hold today's components. `main` is `LaneView` / `PriorityList` / `Handbook` / (phone power) `PowerDock`. `footer` is `PowerDock` on desktop. `command` and `floating` are empty.

Steps:
- [ ] **Step 1: Write the failing tests.**
  1. **`derive.test.ts`, `laneStatus`.**
     - A fresh world gives iron `bottleneck`.
     - `power` with a throttled biomass row (tier-8 `starvedPipeState`, or a fixture picked by scanning `satisfaction < 0.98`) gives `throttled`.
     - A lane with zero production (copper on a fresh world, forced unlocked by `state.tier = 2` with no machines) gives `idle`.
     - Otherwise `fed`.
  2. **`laneTabs`.**
     - **A fresh world at desktop:** `["iron","copper","coal","oil","power"]`, keys 1–5. Copper, coal and oil are `locked`, with `unlockTier` 2/3/6. `power.power === true`.
     - **At phone:** `["iron","copper","coal","oil"]`.
     - `powerLaneId` is `"power"`.
  3. **`tabs.ts`.** With `skip` marking indices 1–3, `ArrowRight` from 0 lands on 4 and `ArrowLeft` from 4 lands on 0. Alt, Ctrl and Meta give `null`.
  4. **`Shell.test.tsx`, the three layouts** (`stubWidth` 1280 / 800 / 390, with App on a fake store):
     - `data-layout` is `desktop`, `tablet` or `phone`.
     - Desktop shows the Panels tablist with three tabs and the five lane tabs. There's no `[data-open-handbook]` button: F3 is the handbook.
     - The phone shows four bottom tabs, and the title text is `MANUFACTORY_`. Selecting `~ power` makes it `POWER_GRID`, and the lane tabs aren't rendered.
     - A resize from 1280 to 390 keeps the selected lane.
  5. **Locked lanes.** Clicking `[data-lane="oil"]` leaves iron selected. The oil tab's accessible name is "Oil, unlocks at tier 6", and iron's is "Iron, bottleneck". The `!` and `●` are `aria-hidden`.
  6. **`dialog.test.ts`, `inertOutside`.** On a fixture tree, `app > [header, content > [main, region > [button], card]]`, with `keep = [card]` and the region given:
     - `header` and `main` are inert;
     - `content` and the region are not;
     - the region's button is inert.

     Undo restores every one. In `Shell.test`, with Settings open, the region is never inert and its notice controls are.
  7. **Notices overlay.** Three notices all render inside `.notices[role=status]`, and the list element has the overlay class. The main box's `getBoundingClientRect().top` is unchanged by adding a notice (jsdom: assert the region isn't in the `.app` flex flow, by checking that its parent is `.contentRow`).
  8. **`TierReadout.test.tsx`:** V-24's formats for shell and plain voices, tier 10, and the phone's one requirement.
  9. **About.** Settings shows `a[data-source-link]` and `a[data-license-link]` in a section named "About". No `footer` element exists.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement.**
  - `useLayoutMode`, keeping `usePanes`'s subscribe pattern.
  - **`Shell`.** The DOM above, with the CSS from U-2b to U-2d (exact dimensions, only the new tokens). `--dock-h`, the `ResizeObserver`, `.tabbar`, `.dock`, `.sheetHost` and `.switch` go.
  - **`App`.** It keeps the store wiring, the announcer, the tick, the Settings state and the route. It uses `inertOutside(appRef, [settingsHost], regionEl)` in the layout effect for Settings. It renders `mode === "phone" ? PhoneShell : DesktopShell`.
  - **The views.** The priority view gets `id="view-priority"`, replacing `#pane-priority`. The handbook view is the route.
  - Take `Shell.module.css` and `base.css` out of `PENDING_RESKIN`.
- [ ] **Step 4:** run the tests, green. `LaneView.test.tsx`'s tests 7.4a and 7.4b (dock height) are deleted, because their subject is gone. `Handbook.test`'s test 1 uses the bottom tabs, and test 3 uses F3 with the drawer open.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Drop `skip` from the lane tablist: test 5 fails, because arrows reach oil.
  - Have `inertOutside` inert the region: test 6 fails.
  - Put power first in `laneTabs`: test 2 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: the viewport shell at three layouts, lane tabs with lights and locked lanes, bottom tabs, and a notices overlay (UI-1, U-2)`.

---

### Task 4: the command line — the desktop bar, the phone split bar, and the NEXT_BUY card and sheet

**Files:**
- **Create:**
  - `apps/web/src/ui/command.ts` and `command.test.ts`;
  - `apps/web/src/ui/CommandBar.tsx`, `CommandBar.module.css` and `CommandBar.test.tsx`;
  - `apps/web/src/ui/NextBuy.tsx`, `NextBuy.module.css` and `NextBuy.test.tsx`.
- **Modify:**
  - `apps/web/src/ui/BottleneckFrame.tsx`: it imports `RunButton` and `ReserveRun` back (V-23);
  - `apps/web/src/ui/App.tsx`: `whyOpen` state, the frameless announcement (V-14), and the slots;
  - `apps/web/src/ui/Notices.tsx`: the frameless line goes (U-3e);
  - `apps/web/src/ui/LaneView.test.tsx`: test 5 gains the frameless case.

**Interfaces:**

```ts
// command.ts (U-4a, U-4b, U-4c), pure
export function commandText(m: BottleneckModel | null, s: Snapshot, voice: Voice): string;
//   BUY_MACHINE  "buy 4 constructor_mk1 --lane iron --for rotor"   [Buy 4 Constructor Mk.1 for Rotor]
//   BUY_STORAGE  "storage +1 iron_plate"   BUY_QS "qs +1 --lane iron"   SET_RESERVE "reserve screw 30%"
//   null action  "# " + m.text.toLowerCase()        no bottleneck "# all lines fed" [Everything is running]
export function shortText(m: BottleneckModel | null, s: Snapshot, voice: Voice): string;  // "4 constructor → ROTOR" [4 Constructor → Rotor]
export type RunKind = "bar" | "split" | "card" | "sheet";
export function runLabel(m: BottleneckModel, s: Snapshot, voice: Voice, kind: RunKind,
  a: Affordability, busy: boolean): string;    // "run" | "[ buy 4 ]" | "[ store ]" | "[ qs ]" | "[ reserve ]" | "running…" | "affordable in 12s" | "[ 12s ]" | "not affordable yet"
/** V-17: the plain spend text, plus ", affordable in N seconds" when off. */
export function runName(m: BottleneckModel, s: Snapshot, a: Affordability): string;
export interface NextBuyModel {
  action: string;          // "+4 CONSTRUCTOR_MK1 → ROTOR"
  why: string;             // per bottleneck kind (U-4c)
  lane: string | null;     // "IRON"
  cost: string[];          // ["160 IRON_PLATE (have 3.2k)"]
  effect: string[];        // ["ROTOR +0.4 → +1.2/s"] | ["IRON_PLATE cap 10.0k → 15.0k"] | ["IRON quantum +1 level"] | ["SCREW keeps 30% in stock"]
  buyOne: BuyMachine | null;   // only BUY_MACHINE with count > 1
  open: ItemId | null;         // the "open ROTOR" target
}
/** Only while the card/sheet is open (a preview costs ~2–13 ms). serverMs is the 4 Hz "have". */
export function nextBuyModel(s: Snapshot, m: BottleneckModel, serverMs: number, theme: ThemeDef): NextBuyModel | null;
```

```tsx
// CommandBar.tsx
export function RunButton(p: { model: BottleneckModel; spend: FrameSpend; snapshot: Snapshot;
  store: Pick<GameStore, "now" | "send">; pending: readonly Batch[]; kind: RunKind; voice: Voice;
  className?: string; count?: 1 }): JSX.Element;          // SpendButton, moved: Guarded, aria-busy, BOTTLENECK_BUY_LABEL
export function ReserveRun(p: { model: BottleneckModel; reserve: Extract<FrameAction, { type: "SET_RESERVE" }>;
  snapshot: Snapshot; store: Pick<GameStore, "send">; kind: RunKind; voice: Voice }): JSX.Element; // never busy; double-send guard
export function CommandBar(p: CommandProps & { onWhy(opener: HTMLElement): void; whyOpen: boolean }): JSX.Element;  // section[aria-label="Command line"][data-command]
export function CommandSplit(p: CommandProps & { onWhy(opener: HTMLElement): void }): JSX.Element;               // the phone's two buttons
interface CommandProps { model: BottleneckModel | null; snapshot: Snapshot; store: Pick<GameStore, "now" | "send">; pending: readonly Batch[] }
// NextBuy.tsx
export function NextBuyCard(p: CommandProps & { onClose(returnFocus: boolean): void }): JSX.Element;  // section[role=dialog][aria-modal=false][data-next-buy]
export function NextBuySheet(p: CommandProps & { onClose(): void; onOpenItem(id: ItemId): void }): JSX.Element; // role=dialog aria-modal=true, scrim
```

- **Data attributes.** `[data-command]` is on the bar; the full command is its `aria-label` and its visible span's text. `[data-run]` is on every run button. `[data-why]` is on `why` / the split's left button.
- **The typed span.** It has no typing yet (U-9e is UI-3). It's `aria-hidden`, and a visually hidden sibling holds the same text, so UI-3 only adds the animation.

Steps:
- [ ] **Step 1: Write the failing tests** (`describe(…, { timeout: 60_000 })` for the tier-8 ones).
  1. **`command.test.ts`:**
     - `commandText`, `shortText` and `runLabel` for each `FrameAction` kind, in both voices;
     - `null` with advice, and no bottleneck;
     - the run label's busy, unaffordable (`affordable in 12s` / `[ 12s ]`) and `not affordable yet` cases.

     The fixtures:
     - fresh: `BUY_MACHINE` on `make_iron_plate`;
     - a tier-8 storage bottleneck built by capping an item (`BUY_STORAGE`);
     - QS: the derive test's `upgrade: "quantum"` world;
     - reserve: derive's reserve fixture;
     - frameless: derive's "power with no generator".
  2. **`nextBuyModel`:**
     - why, cost and effect for each kind;
     - `buyOne` only for a machine buy with count > 1;
     - the machine effect's numbers equal `preview(s, [action]).deltas` for the framed item, formatted with `rateText`;
     - `have` is `shownStock + bound` at `serverMs`.
  3. **`CommandBar.test.tsx`: the exact batch.** Carry over `LaneView.test`'s test 4. On a fresh world, pressing `[data-run]` sends `[P3_BUY]` with `BOTTLENECK_BUY_LABEL` exactly once. With that batch pending, the button is `aria-busy`, still focused, and a second press sends nothing.
  4. **Unaffordable** (carried from test 4b). The label counts down on the 4 Hz tick. It's `aria-disabled` but focusable, and its accessible name ends ", affordable in N seconds".
  5. **The reserve.**
     - It's never `aria-busy`.
     - A double click while the first send is unsettled sends once.
     - A `SET_RESERVE` already in effect gives no button (`model.action === null`).
  6. **The card.**
     - `[data-why]` opens `[data-next-buy]` with focus on its primary.
     - Esc closes it and returns focus to `[data-why]`.
     - `focusout` to an outside element closes it.
     - **Across a buy** (`store.set` with a new snapshot), the card stays open and re-renders the next advice.
  7. **The phone.**
     - `CommandSplit`'s right button sends the same batch.
     - The left button's name is "Why: next buy is 1 Constructor for Iron Plate. Open details".
     - It opens `NextBuySheet`, which is modal: `aria-modal="true"`, the background inert via `inertOutside`, the region live, and Tab wrapping.
     - `open IRON_PLATE` closes the sheet and opens that item's drawer.
     - The backdrop and Esc close the sheet.
  8. **Frameless (V-14).**
     - A frameless bottleneck renders `# power is short, …` as the command.
     - There's no desktop run button, and on the phone an `aria-disabled` `—`.
     - **No** `[data-notice="bottleneck"]` exists.
     - The announcer says `Bottleneck: Power is short, …` once when it appears.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement.**
  - **The move.** Move `spendText`, `SpendButton` and `ReserveButton` into `CommandBar.tsx` as `RunButton` and `ReserveRun`, with their bodies unchanged apart from the label and the name. `BottleneckFrame` imports them (V-23).
  - **The dimensions** are U-4a, U-4b and U-4c's.
  - **`App`:**
    - `whyOpen: boolean`, with a ref to the opener;
    - desktop: `slots.command = <CommandBar/>` and `slots.overlays += whyOpen && <NextBuyCard/>`;
    - phone: `<CommandSplit/>`, with the sheet as a child of `.app` next to the Settings host, so `inertOutside` keeps it.
  - **`useBottleneckAnnouncement`** announces frameless too.
  - **`Notices`** loses the `bottleneck` line and the `bottleneck` prop.
  - Take the three new CSS modules out of `PENDING_RESKIN`. They're born re-skinned.
- [ ] **Step 4:** run the tests, green, and run `LaneView.test.tsx`: the frame tests still pass (V-23).
- [ ] **Step 5: Mutations, each undone by hand.**
  - Drop the `busy` check from `RunButton`'s `off`: test 3 fails on the second send.
  - Have `nextBuyModel` read `liquid` without `bound`: test 2 fails.
  - Skip frameless in the announcement: test 8 fails.
  - Make the sheet's `inertOutside` omit the region: test 7 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: the command line, the phone split bar, and the NEXT_BUY card and sheet; the frame's buttons move into it (UI-1, U-4)`.

---

### Task 5: fixed rows, the columns, SAT and the `Bar`; the frame, conveyor and sweep go

**Files:**
- **Create:**
  - `apps/web/src/ui/RowList.tsx`, `Row.tsx` and `Row.module.css`;
  - `apps/web/src/ui/Bar.tsx` and `Bar.module.css`;
  - `apps/web/src/ui/RowList.test.tsx`, replacing `LaneView.test.tsx`. Its App-level tests (region, plateau, root mirror, announcements, the tween) move over with selectors updated.
- **Modify:**
  - `apps/web/src/ui/derive.ts`: `satText`, `machinesText`, `optionName`, and `splitOf` exported;
  - `apps/web/src/ui/Drawer.tsx`: `SplitBar` and `[data-split]`, plus the QS and BOUND meta (V-18), and a new `onSplit` prop;
  - `apps/web/src/ui/App.tsx`: the selection map, the `RowList` slot, and the drawer's close focusing the listbox;
  - `apps/web/src/styles/tokens.test.ts`: the file list, and a new 10a;
  - `apps/web/src/styles/motion.test.ts`: 1a's file list and keyframes, now `pulse` and `rise`;
  - `apps/web/src/ui/motion.ts` and `motion.test.ts`: `sweepPeriodS`, `conveyor` and their constants go;
  - `apps/web/src/ui/PriorityList.test.tsx`: test 9 opens the screw drawer, then `[data-split]`;
  - `apps/web/src/ui/Drawer.test.tsx`, `d1-coverage.test.tsx`, `preview-invariant.test.tsx` and `Handbook.test.tsx`: `[data-open-row]` becomes a click on `li[role=option][data-item=…]`.
- **Delete:**
  - `apps/web/src/ui/LaneView.tsx`, `LaneView.module.css` and `LaneView.test.tsx`;
  - `ItemRow.tsx` and `ItemRow.module.css`;
  - `Conveyor.tsx`;
  - `BottleneckFrame.tsx` and `BottleneckFrame.module.css`.

**Interfaces:**

```ts
// derive.ts
/** U-3b's SAT cell: "" fed (≥ 98%), "72%" throttled, "paused", "—" idle; cls drives the state class. */
export function satText(row: Pick<RowModel, "satisfaction" | "paused" | "idle">): { text: string; cls: ReturnType<typeof stateClass> };
/** V-20: "CONSTRUCTOR_MK1 x20" | "CONSTRUCTOR x20 (2 marks)" | "—", + " · split". */
export function machinesText(s: Snapshot, itemId: ItemId, theme: ThemeDef): string;
/** U-7d: "Rotor, plus 0.4 per second, 11 percent full, 41 percent satisfied, bottleneck". */
export function optionName(s: Snapshot, row: RowModel, bottleneck: boolean): string;
export function splitOf(s: Snapshot, itemId: ItemId): RowModel["split"];   // now exported (V-18)
```

```tsx
// Bar.tsx (U-3d, V-3): one DOM for storage and power
export interface BarProps {
  label: string; valueNow: number /* per snapshot */; valueMax?: number; valueText: string;
  tone: "normal" | "bottleneck" | "body";                         // state-bottleneck only through a state class (8a)
  /** The W-7 transition: from/to fractions over durationMs; none → static at `to`. */
  transition: { from: number; to: number; durationMs: number };
  /** Reduced motion: the 4 Hz step's fraction. */
  stepAt?: () => number;
  cells?: number;                                                  // 16 phone rows, 20 the power panel; terminal only
}
export function Bar(p: BarProps): JSX.Element;   // div[role=meter] > .track + .clip > .fill
// RowList.tsx (U-3, U-7d, V-10)
export interface RowListProps {
  store: Pick<GameStore, "now">; snapshot: Snapshot; laneId: LaneId; bottleneck: BottleneckModel | null;
  selected: ItemId | null; onSelect(id: ItemId): void; onOpen(id: ItemId): void;
  openItem: ItemId | null; mode: LayoutMode;
}
export function RowList(p: RowListProps): JSX.Element;  // ul[role=listbox][aria-label="Iron lane"][tabindex=0][aria-activedescendant]
export function defaultSelection(rows: readonly RowModel[], bottleneck: BottleneckModel | null): ItemId | null;
```

**The row DOM**, one for every layout:

```
li[role=option][id=row-<item>][aria-selected][aria-label=optionName][data-item][data-tag]
  > span.gutter.glyph(aria-hidden)   "!" on the bottleneck, with .state-bottleneck and the pulse
  > span.name                        itemLabel; .state-bottleneck on the bottleneck
  > span.rate.num                    rateText, .rate-up or .rate-down
  > span.sat.num                     satText; .state-<cls>
  > span.machines                    machinesText
  > span.storage                     <Bar/>
  > span.stock.num                   <LiveStock/> / cap
```

- **Desktop and tablet.** One flex line in the U-3b widths. The column header shares the widths. MACHINES hides under `@container rows (max-width: 899px)`, and the narrower widths apply under 700 px.
- **The phone.** CSS grid areas give U-3b's two lines in 54 px. MACHINES and the header are `display: none`.
- **The row rule.** `.row { height: var(--row-h); overflow: hidden }`. The selected row adds `background: var(--s-hi); box-shadow: inset 3px 0 0 var(--accent)`, and the focus ring is U-3a's.
- **The drawer header meta** gains `QS 40.0k · BOUND 12`, shown only when non-zero. `SplitBar`, moved as is, sits under the drawer's tabs.

Steps:
- [ ] **Step 1: Write the failing tests** (`RowList.test.tsx`, `describe(…, { timeout: 60_000 })`).
  1. **Fixed DOM.** On a fresh world, the framed `iron_plate` row and the unframed `iron_ore` row have the same element tree. Compare `tagName` plus child structure recursively, ignoring classes, text and `aria-*`. Selecting a row, opening its drawer, and a pending buy don't change either tree.
  2. **`tokens.test.ts` 10a.** In `Row.module.css`, `.row` declares `height: var(--row-h)` and `overflow: hidden`. No declaration of `min-height`, `max-height` or `height: auto` sits under any selector containing `.row` or a row-cell class.
  3. **SAT.** `satText` gives `""` (fed), `"72%"` (a throttled tier-8 row; pick one by scanning), `"paused"` (pause an entry in the state) and `"—"` (idle).
  4. **Option names and selection:**
     - the U-7d phrase for the bottleneck row;
     - `defaultSelection` is the bottleneck row, else the first;
     - the selection survives a lane switch and back, and a new snapshot;
     - it's dropped when the item disappears (a snapshot without it);
     - a click selects and opens.
  5. **The listbox keys (V-10).**
     - `↓` and `↑` move `aria-activedescendant`. `Home` and `End` go to the ends.
     - `→` and `Space` open the drawer.
     - `Enter` does nothing here.
     - Alt+`↓` is ignored.
     - Esc in the drawer returns focus to the listbox, with the row still active.
  6. **The `Bar` reveal.**
     - On a snapshot, the clip's `style.transform` is `translateX(${(from − 1) × 100}%)`, then `translateX(${(to − 1) × 100}%)`. The fill's is the negation.
     - Both get `transition: transform <durationMs>ms linear` in the same commit.
     - The meter's `aria-valuenow` moves only per snapshot.
     - Under reduced motion there's no transition, and the 4 Hz tick steps both transforms.
  7. **What moved.**
     - The tier-8 `screw` drawer shows `[data-split]`, and clicking it focuses the screw priority entry. That's `PriorityList.test`'s test 9, moved.
     - The `iron` rows on tier 8 show no QS chip, but the drawer's meta has `QS`.
  8. **The pulse moves.** 7c's pulse is now on `.gutter` under a state class (U-3e). `motion.test.ts` 1a names `ui/Row.module.css` and `@keyframes pulse`, and no longer `sweep` or `conveyor`.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement.**
  - **Carried over into `Bar.tsx` and `Row.tsx`:** `StorageBar`'s layout effect becomes `Bar`, while `LiveStock` and `useTween` carry over unchanged.
  - **`App`:** `selection: Map<LaneId, ItemId>`; `close()` focuses the listbox (U-7c).
  - **The deletions** listed above. `d1-coverage`'s openers change selector only.
  - Take `Row.module.css` and `Bar.module.css` out of `PENDING_RESKIN`.
- [ ] **Step 4:** all green.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Give the bottleneck row an extra `<span>` label: test 1 fails.
  - Use `min-height: var(--row-h)`: test 2 fails.
  - Animate the fill's transform at a different duration than the clip's: test 6 fails.
  - Default the selection to the first row always: test 4 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: fixed one-line rows in a listbox, the SAT cell and a segmented Bar; the frame, conveyor and sweep go (UI-1, U-3)`.

---

### Task 6: the PowerPanel, the footer and the floating TAP; the dock goes

**Files:**
- **Create:**
  - `apps/web/src/ui/PowerPanel.tsx`, `PowerFooter.tsx` and `FloatingTap.tsx`;
  - `apps/web/src/ui/Power.module.css`;
  - `apps/web/src/ui/use-tap-hold.ts`;
  - `apps/web/src/ui/PowerPanel.test.tsx`, replacing `PowerDock.test.tsx`.
- **Modify:**
  - `apps/web/src/ui/dock-model.ts`: `generatorRows`, `powerByLane`, `nextMachineDrawMw`, `tapName`;
  - `apps/web/src/ui/dock-model.test.ts`;
  - `apps/web/src/ui/App.tsx`: the footer, floating and power slots;
  - `apps/web/src/ui/d1-coverage.test.tsx`: TAP through `[data-power] button[data-tap]`, plus a generator `+1` case.
- **Delete:** `apps/web/src/ui/PowerDock.tsx`, `PowerDock.module.css` and `PowerDock.test.tsx`.

**Interfaces:**

```ts
// dock-model.ts (U-6b, V-21, V-22)
export interface GeneratorRow {
  machineClass: MachineClassId; recipeId: RecipeId; lane: LaneId;
  owned: number; mark: number | null /* best unlocked; null = locked */; unlockTier: number;
  eats: { itemId: ItemId; perSecond: number }[]; mwEach: number; mwNow: number;
  buy: BuyMachine | null;   // { lane, machineClass, mark, count: 1, recipeId? } — null when locked
}
export function generatorRows(s: Snapshot): GeneratorRow[];                 // one per class among producersOf(POWER_ITEM), content order
export function powerByLane(s: Snapshot): { laneId: LaneId; mw: number }[]; // desc by mw, mw > 0, generators skipped
export function nextMachineDrawMw(s: Snapshot): number;                     // V-21 "up to"
export const generatorLabel = (machineClass: MachineClassId) => `power:${machineClass}:buy`;
/** U-6c's accessible name; "Tap, hold to keep the kick" with no stacks. */
export function tapName(m: DockModel): string;
// use-tap-hold.ts: PowerDock's handlers, moved (pointer capture; held Space/Enter with stopPropagation; blur)
export function useTapHold(store: Pick<GameStore, "pressTap" | "releaseTap">): {
  onPointerDown; onPointerUp; onPointerCancel; onLostPointerCapture; onKeyDown; onKeyUp; onBlur; onContextMenu };
```

```tsx
export function PowerPanel(p: { store; snapshot; view: StoreView; bottleneck; selected; onSelect; onOpen; openItem; mode }): JSX.Element; // [data-power-panel]
export function PowerFooter(p: { store; snapshot; taps; pending }): JSX.Element;   // footer[data-power] … button[data-tap]
export function FloatingTap(p: { store; snapshot; taps; pending; withCommand: boolean }): JSX.Element; // div[data-power] > button[data-tap]
```

What the panel holds:
- Load: the `Bar`, 20 cells.
- GENERATORS: each row has its `+1`, a `Guarded` that's busy on `generatorLabel` and uses `affordability` like the drawer.
- FUEL: a `RowList` for the power lane.
- BIGGEST USERS.
- The kick line.

The footer is U-2b. The floating TAP is U-6c's box. Its `bottom` is set by a class: `withCommand` is the factory tab with the command bar showing.

Steps:
- [ ] **Step 1: Write the failing tests** (`describe(…, { timeout: 60_000 })`).
  1. **`powerByLane` sums to `demandMw`** on `slice-tier-8.world.json` and `slice-tier-8-reinforced-full.world.json`, within `1e-9 · max(1, demandMw)`. A fresh world gives `[{ iron, … }]` or `[]`, consistent with its `demandMw`.
  2. **`generatorRows`.**
     - A fresh world gives three rows: `biomass_burner` unlocked with mark 1 and a `buy` of count 1 with `recipeId: "burn_biomass"`; `coal_generator` locked with `unlockTier: 4`; `fuel_generator` locked with `unlockTier: 7`.
     - On tier 8: `mwNow` sums (with `baseGridCapacityMw` and the tap injection) to `power.supplyMw` within 1e-9, and `eats` equals `inputPerSecond × units × clock`.
  3. **The `+1`.** In `PowerPanel`, `+1` on biomass burners sends `[{ type: "BUY_MACHINE", lane: "power", machineClass: "biomass_burner", mark: 1, count: 1, recipeId: "burn_biomass" }]` with `power:biomass_burner:buy`. While that's pending, it's `aria-busy`. Before it's affordable, it counts down. A locked class has no button, and its text is `COAL_GENERATOR x0 · unlocks at tier 4`.
  4. **Headroom and "up to".**
     - Headroom equals `supplyMw − demandMw`.
     - `nextMachineDrawMw` on a fresh world equals the largest `powerDraw` of the best unlocked marks among the live lane-classes. That's the constructor or miner mark 1 from `machines.yaml`, so assert it against `content.machineClasses` directly.
     - The short line reads `power is short · needs N MW` in a `state-bottleneck` span when `ratio < 1`.
  5. **The TAP's name.**
     - With 7 stacks: "Tap, hold to keep tapping. Kick times 1.35, 7 of 10 stacks, 21 seconds left".
     - Four `store.tick(250)` leave `aria-label` unchanged, while the visible countdown moves.
     - A new snapshot updates it.
     - With 0 stacks: "Tap, hold to keep the kick".
  6. **The hold carries over** (PowerDock's tests 1 and 2, on both the footer and the floating TAP):
     - pointer down, up, cancel and lost capture;
     - Space and Enter held, with `e.repeat` ignored, keyup and blur releasing;
     - the Space keydown's propagation stopped (a `document` listener sees nothing).
  7. **Placement.**
     - At 390 px, the `~ power` tab shows `[data-power-panel]`, and the floating TAP is present on all four tabs.
     - At 1280 px, the `5 POWER` lane tab shows the panel, and `footer[data-power] button[data-tap]` is present.
     - There's no `[data-dock]` anywhere.
  8. **`d1-coverage`.** TAP through the new button. BUY_MACHINE for a generator through `+1` (newly covered, U-6). "Covers all eleven action types" still passes.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement.**
  - Move PowerDock's handlers into `useTapHold`, adding `e.stopPropagation()` on the Space and Enter keydown and keyup (U-6c).
  - Build the panel per U-6b. `dockModel` is unchanged.
  - Delete PowerDock.
  - Take `Power.module.css` out of `PENDING_RESKIN`.
- [ ] **Step 4:** all green.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Use the pass clocks (`fullDemandMw`'s) in `powerByLane`, by summing without the ratio: test 1 fails.
  - Use `drawPerMachine` for "up to": test 4 fails on a fresh world, because the pool mean of an empty pool is 0.
  - Compute `tapName` inside the 4 Hz render: test 5 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: a power panel with generator +1, the PWR footer and a floating TAP; the dock goes (UI-1, U-6)`.

---

### Task 7: the existing drawer, restyled and placed; the remaining modules re-skinned

**Files:**
- **Modify:**
  - `apps/web/src/ui/Drawer.tsx`: `presentation: "panel" | "sheet"` replaces `sheet?: boolean`, the head is U-5a's, and the segmented tabs stay;
  - `apps/web/src/ui/Drawer.module.css`;
  - `apps/web/src/ui/App.tsx`: the drawer goes in `slots.overlays` on desktop and tablet, or as a fixed sheet on the phone;
  - `apps/web/src/ui/Drawer.test.tsx`: tests 8 and 14 and the pane cases;
  - `apps/web/src/ui/Handbook.module.css`, `PriorityList.module.css` and `Settings.module.css`, plus `AccountForms`' and `ResetPassword`'s styles in `base.css` and `Settings.module.css`: new tokens only, re-skinned (behaviour unchanged, W-21's drag included).

**Interfaces:**

```ts
export interface DrawerProps {
  store: Pick<GameStore, "now" | "send">; snapshot: Snapshot; itemId: ItemId; pending: readonly Batch[];
  onClose(): void; onSplit(itemId: ItemId): void;
  presentation: "panel" | "sheet";      // panel: U-5a, non-modal; sheet: V-19, role=dialog aria-modal=false
  claimFocus?: () => boolean;
}
```

- **The head.** The title (`h2#drawer-title`, `--font-display`, 30 px or 32 px on the sheet) is `itemLabel`, with an `aria-label` of the content name. It's `state-bottleneck` when the item is the bottleneck. Then the meta (`IRON lane · +0.4/s · 214/2.0k`, plus QS and BOUND), the hint (a `.key-hint`, hidden per V-9), and `Close`.
- **The panel's position** is U-5a's: `top/right/bottom: 0` in `.contentRow`, with `width: min(560px, 100% − 340px)`, or `clamp(360px, 100% − 300px, 560px)` under `[data-layout=tablet]`. The rows beneath keep their layout.
- **The `rise` animation** stays, under no-preference.

Steps:
- [ ] **Step 1: Write the failing tests** (`Drawer.test.tsx`, `describe(…, { timeout: 60_000 })`).
  1. **The panel at desktop** (`stubWidth(1280)`). Clicking `iron_ore` mounts `[data-drawer="iron_ore"]` inside `.contentRow`, as a sibling of `.mainBox`, with `role=dialog`, `aria-modal="false"` and `aria-labelledby` its title. The rows stay interactive: clicking another row re-keys the drawer to it.
  2. **Tablet** (`stubWidth(800)`): the same element, with `data-layout="tablet"`.
  3. **The phone** (`stubWidth(390)`). The drawer is a direct child of `.app` with the sheet class. Its title takes focus. Esc closes it and returns focus to the listbox. Priority and back remounts it without stealing focus (today's test 14, moved).
  4. **The head meta.** On tier 8, `iron_plate` reads `IRON lane · <rate> · <stock>/<cap>` and has `QS` when non-zero. The title gets `state-bottleneck` only on the bottleneck item.
  5. **The contrast usage checks** now include `Drawer.module.css`, `Handbook.module.css`, `PriorityList.module.css` and `Settings.module.css`, and `PENDING_RESKIN` is empty (every other file was deleted or re-skinned in Tasks 3–6). Task 8 then deletes the set itself.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement the restyle.** Every value comes from U-5a and V-19's geometry. The re-skin of the four modules maps old tokens to new ones, by meaning:
  - `--t3` on a barred surface becomes `--t2`;
  - `color: var(--accent)` becomes `--t1` with an `--accent` border, or `--advice`;
  - `accent-color: var(--accent)` stays, because it's not text.
- [ ] **Step 4:** all green. Every Drawer test 1–13 not listed above passes unchanged, which shows the segmented tabs and their behaviour are untouched.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Render the desktop drawer inside `.mainBox`: test 1 fails.
  - Revert one `PriorityList.module.css` rule to `color: var(--accent)`: test 5 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Commit: `Web: the drawer as the desktop panel and the phone sheet, and the remaining modules on the new tokens (UI-1, U-5a placement)`.

---

### Task 8: legacy aliases gone, e2e updated, `themes.spec`, README, and the full verification

**Files:**
- **Modify:**
  - `apps/web/src/styles/tokens.css`: the alias block is deleted;
  - `apps/web/src/styles/tokens.test.ts`: new 8g, and 9a scoped (below);
  - `apps/web/src/styles/contrast.test.ts`: the empty `PENDING_RESKIN` set and its exemption are deleted;
  - `apps/web/e2e/guest-buy.spec.ts`, `drawer-buy.spec.ts`, `tap-hold.spec.ts`, `reduced-motion.spec.ts`, `layout-320.spec.ts`, `priority-drag.spec.ts`, `accounts.spec.ts` and `injected-failures.spec.ts`;
  - `README.md`: the "In the client" paragraph;
  - `.github/workflows/ci.yml`: the `web-e2e` comment's spec list and measured times only.
- **Create:** `apps/web/e2e/themes.spec.ts`.

Steps:
- [ ] **Step 1: The unit side, failing first.**
  - **8g.** No CSS file names `--sans`, `--mono`, `--fs-1/2/3`, `--fw-regular`, `--fw-strong`, `--line2`, `--s3`, `--hairline`, `--dock-h`, `--tabbar-h`, `--sheet-max`, `--sheet-bottom`, `--sweep-period` or `--conveyor-period`, and `tokens.css` defines none of them.
  - **9a stays** as written (`.segBtn` is 44 × 44). U-8d's rewrite is UI-2's, together with the segmented tabs' removal.
  - Delete the alias block. Grep for leftovers and fix them. All green.
- [ ] **Step 2: The e2e specs.** Every wait is on the DOM or a store attribute (W-23).
  - **`guest-buy`:**
    - `[role=option][data-item="iron_plate"]` is visible, and its `.name` reads `IRON_PLATE`, with the option's accessible name starting "Iron Plate";
    - `[data-command]` contains `buy 1 constructor_mk1 --lane iron --for iron_plate`;
    - `[data-run]` becomes enabled (`aria-disabled="false"`, 120 s) and is clicked, giving state version 1;
    - no `[data-frame]` exists;
    - the reload step and the no-overflow check are unchanged.
  - **`drawer-buy`.** Open by clicking `[role=option][data-item="iron_ore"]`. The rest is unchanged: `[data-ladder]`, `[data-preview]`, "Buy 1 Miner" and "3 owned".
  - **`tap-hold`:**
    - `[data-dock]` becomes `footer[data-power]`;
    - the kick reads `^KICK x1\.50 · 10 STK · \d+s$`;
    - the spec's held-`T` case is not added: the `T` key is U-7a's dispatcher, which is UI-2.
  - **`reduced-motion`:**
    - under `reduce`, nothing is running;
    - the `!` gutter (`li[aria-selected] .gutter` or the bottleneck option's gutter) is visible, and the option's name ends ", bottleneck";
    - the conveyor assertions go;
    - without the preference, the pulse runs (the hashed `pulse` name, on the gutter).
  - **`layout-320`:**
    - **The bottom tabs.** `getByRole("tablist", { name: "Panels" })` has `factory`, `~ power`, `priority` and `handbook`.
    - **The lanes** are `["iron","copper","coal","oil"]`, with the last three `aria-disabled="true"`.
    - **The steps:**
      - Factory: `expectNoOverflow`.
      - The drawer sheet (open by clicking the option): `expectNoOverflow`, then Close.
      - The NEXT_BUY sheet (`[data-why]`): `expectNoOverflow`, then Esc.
      - The power tab: `[data-power-panel]` visible, then `expectNoOverflow`.
      - Priority Simple and Advanced, then the handbook index and `encased_industrial_beam`: as today.
      - The floating TAP's box doesn't intersect the command bar's box on the factory tab.
      - The settings sheet, the sign-up form, the reset page and the rejection toast: as today, with the toast reached through the bottom tab.
    - The `seekMotion` steps go, because the conveyor and sweep are gone.
    - **The source test** opens Settings and reads `section` "About" `a[data-source-link]` / `a[data-license-link]` (the hrefs are unchanged), plus the source maps as today.
  - **`priority-drag`, `accounts` and `injected-failures`.** First click `getByRole("tab", { name: /priority/ })` in the Panels nav. `#pane-priority` becomes `#view-priority`. Everything else is unchanged.
  - **New `themes.spec`** (desktop):
    1. Open Settings, choose Clean (Light), and `html[data-theme="clean-light"]` follows. After a reload it's still `clean-light`.
    2. **No flash.** `addInitScript` stores `mi.theme=clean-light` and registers a first-`requestAnimationFrame` probe that records `documentElement.dataset.theme` onto `window`. After `goto`, the recorded value is `clean-light` (V-6).
    3. Cosy's radio is `aria-disabled="true"`. Clicking it leaves `data-theme` unchanged.
    4. `addInitScript` stores `mi.theme=cosy`. The page renders `data-theme="terminal"`, and `localStorage["mi.theme"]` is still `cosy`.
- [ ] **Step 3: Run the e2e locally, in the foreground.** Run `pnpm --filter @manufactory/web e2e`. All specs must pass. Record each spec's time, and put the times in the `ci.yml` comment (it currently lists 4b's).
  - **If a spec fails,** debug it with `trace: retain-on-failure`. Never with sleeps.
- [ ] **Step 4: Mutations, each undone by hand.**
  - Restore `--line2` in one CSS module: 8g fails.
  - Remove the inline script from `index.html` and rebuild: `themes.spec` test 2 fails (or is flaky-red). Record which.
- [ ] **Step 5: README.** Update the "In the client" paragraph:
  - the terminal default and the theme list, with the two locked ones;
  - Layout C (the command line, `why`, NEXT_BUY);
  - the phone's power tab and floating TAP;
  - About in Settings, which now holds the GPL links that were in the footer.
- [ ] **Step 6:** run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, then the e2e once more, all green. Commit: `Web: drop the legacy token aliases, move the e2e to Layout C, add themes.spec, and update the README (UI-1)`.

---

## Spec-vs-code notes (for the reviewer)

1. **The bar's solid fill.** U-3d's `--bar-seg: 0` produces a zero-length repeating gradient, which CSS renders as its average colour (half-transparent). V-3 uses `--bar-paint` instead.
2. **Terminal `--state-paused`.** The spec's `#2a8c42` is `--t3`'s value, which the spec bars from `--s-hi` and `--s2`. But a paused SAT cell can sit on the selected row. V-2 changes it to `#2f9a4a`.
3. **Font subsets.** A latin-only subset lacks `→ ● ▮ ▯ ▴ ≡ ▁…█`, so U-1g's own glyph test would fail. V-5 adds a symbols file per mono face.
4. **`drawPerMachine`** is a pool mean per `lane::class`, and 0 for an empty pool. So it can't give "next machine needs up to". V-21 uses the content `powerDraw` of the best unlocked mark.
5. **`powerByLane`** sums to `demandMw` only with `solution.clocks`. The pass clocks give `fullDemandMw` (V-21).
6. **The frameless announcement.** Moving the frameless bottleneck out of the region would leave it never announced, because `useBottleneckAnnouncement` skips frameless. V-14 announces it.
7. **The spec leaves some tokens unset:**
   - Cosy has no `--t-body`;
   - Clean, Cosy and Industrial have no `--advice-dim`, `--advice-hi` or `--advice-line`;
   - link/hover isn't in the U-1b table;
   - Cosy's `--accent` fails as text (4.17).

   V-2 sets them all.
8. **The CRT toggle overlaps two PRs.** UI-1's "U-1 entire" includes it, and UI-3 lists it too. V-8 puts it in UI-3.
9. **The PR boundaries leave gaps.** V-9, V-10, V-12, V-18, V-19 and V-21 fill them, so UI-1 doesn't regress:
   - key hints advertise keys that only arrive in UI-2;
   - the listbox would have no keys;
   - the phone drawer sheet's modality is UI-2;
   - `SPLIT` is UI-2;
   - the generator drawer is UI-2.
10. **Two more small conflicts:**
    - `ResetPassword` renders its own `<main>`, so the main box is a `div` (V-11);
    - a module script can't guarantee a theme before first paint, so V-6 adds an inline script.
