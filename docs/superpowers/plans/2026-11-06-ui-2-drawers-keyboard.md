# UI-2: drawers and the keyboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the spec's UI-2 row. When it lands:
- the game is fully playable from the keyboard on desktop: Enter runs the advice, Tab opens why, `1`–`5` pick lanes, F1–F3 (or F, P, H) switch panels, ↑/↓ move rows, → or Space open a row's drawer, a held `T` taps, `?` shows the help;
- the drawer is U-5's: MACHINES by default, the other sections behind letter-key `MORE` buttons (B, U, R, A, S, D, H), `SPLIT` in place of the split bar, and the drawer follows ↑/↓;
- generators get their own drawer, opened from the power panel;
- the phone's drawer sheet is modal, with a scrim and a drag grip;
- key hints appear on a fine pointer, and every one of them works.

**Architecture:**
- **Task 1:** `ui/keys.ts`, the pure resolver. `resolveKey(event, context)` gives a `Command` or `null`, and `focusKind`, `scopeOf` and `KEYMAP` sit beside it. It gets the full table test, and nothing is wired yet.
- **Task 2:** the dispatcher, wired. `useKeyboard` puts one `keydown`/`keyup` listener on `document`, and App gives it the context and the actions. Enter, Tab, the digits, the F-keys, ↑/↓ (the drawer follows), → and Space, Esc, Home and End, the held `T`, and `1` in the card all land here. `RowList`'s own keys go. The hints become visible on a fine pointer, and a test checks every hint.
- **Task 3:** the `?` help overlay. It's modal, built from `KEYMAP`, and ends with the GPL line. The header gets its `?` button, and the inert pass learns which modal is open.
- **Task 4:** the drawer's sections. MACHINES (a row per mark, ×1/×10/max, the ladder, `IF YOU BUY`, `SPLIT`) replaces the segmented tabs, and the `MORE` buttons carry the letter keys. Test 9a is rewritten for coarse pointers (U-8d).
- **Task 5:** generator drawers. `drawerModel(s, { recipeId })` is added, the open drawer becomes a target (item or generator), and power-panel generator rows open it.
- **Task 6:** the phone drawer sheet goes modal: scrim, inert background, Tab trap, focus return, and the drag grip.
- **Task 7:** `keyboard.spec`, `phone.spec`, a held `T` in `tap-hold`, the README and the CI comment, then the full verification.

**Tech Stack:** TypeScript ESM, React 18.3.1, Vite, vitest 4 + jsdom + Testing Library, `@playwright/test` (Chromium). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-ui-terminal-redesign-design.md`. UI-2's scope is its "Build order" row:
- U-5 entire: letter-key sections, `[U]`, `SPLIT`, ↑/↓ follow, the modal phone sheet with its grip, generator drawers;
- U-7 entire: the dispatcher, scopes, Tab/Enter/F-keys, listbox focus, the `?` overlay, hints;
- U-8d's 9a rewrite, which comes with the segmented tabs' removal (deferred here by the UI-1 plan, Task 8);
- `keyboard.spec` and `phone.spec`.

It also takes up everything UI-1 deferred to UI-2:
- V-9: hints hidden;
- V-10: the listbox's own keys, and Enter doing nothing;
- V-12 / V-19: the non-modal phone sheet;
- V-15: no `?` button;
- V-18: `SplitBar` not yet `SPLIT`;
- V-21: generator rows not clickable;
- `tap-hold`'s held-`T` case;
- the SDD ledger's parked "listbox hint omits *enter runs the next buy*".

The Phase 4 rulings, the post-launch rulings, the U-rulings and UI-1's V-rulings all stand unless a K-ruling below supersedes one, and each supersession is named in its ruling.

## Rulings made in this plan

- **K-1. Screen readers hear content names (U-1h), in the help overlay and the hints too.**
  - **Hints.** Every `.key-hint` stays `aria-hidden`, as UI-1 built them.
  - **The help overlay:**
    - each key cap renders through `Spoken`: `[ENTER]` is seen and "Enter" is heard; `[↑↓]` is heard as "Up or down arrow";
    - every description is plain words with no ids;
    - the title is `man manufactory` in the shell voice, and "Keyboard shortcuts" is what a reader hears in every theme.
  - **The test.** `spokenIds` (test-fixtures) finds nothing in the open overlay under terminal.
  - *Why:* the hints are visual shortcuts. The overlay is the only place a reader learns the keys, so it must speak names.
- **K-2. The dispatcher never steals a key.** A `keydown` is ignored when any of these hold:
  - **Typing** (`focusKind` is `"typing"`). The event target is:
    - an `input` whose type isn't `radio`, `checkbox`, `button`, `submit` or `reset` (a `range` counts as typing, as U-7a's "slider" says);
    - a `textarea`, a `select`, or `[contenteditable]`;
    - an element with role `textbox`, `searchbox`, `combobox`, `spinbutton` or `slider`.
  - **A modifier.** Ctrl, Alt or Meta is held. Shift is accepted only for `?`, and Shift+Tab is never taken.
  - **Composition.** `e.isComposing`, or `keyCode === 229`.
  - **Already handled.** `e.defaultPrevented`. The lane and Panels tablists, the priority list, the recipe radios and the TAP button's Space and Enter keep their own keys this way.
  - **A modal scope.** Settings or the phone sheet is open. In the help scope, only `?` (it closes the help) gets through.
  - **A repeat.** `e.repeat` is ignored for every command except ↑ and ↓. A held ↓ walks the rows; a held Enter or `B` never buys twice.
  - **The `T` exception.** A `keyup` of `t`/`T` releases a key-held tap **whatever** the modifiers, the target or the scope. So the hold can never stick. `window` `blur` and `visibilitychange` (hidden) release it too.
  - *Why:* browser and screen-reader shortcuts keep working, and a filtered release would leave the kick tapping forever.
- **K-3. The phone drawer sheet is modal (U-5b).** This supersedes Q-7 and V-12 / V-19's "non-modal in UI-1".
  - **The box.** `role=dialog`, `aria-modal="true"`, inside a `[data-drawer-host]` backdrop with the `--scrim` fill.
  - **The background** is inert through `inertOutside`, so the floating TAP and the bottom tabs go inert. `trapTab` wraps Tab inside the sheet.
  - **Closing:** the `x`, the backdrop, Esc, or the grip (K-20). Focus returns to the drawer's opener (K-12), falling back to the row list.
  - **Notices.** The overlay stays above the sheet (phone notices at z 35, sheet 30, NEXT_BUY sheet 40, Settings 50; UI-1 pinned these). Under any modal its controls are inert and the region stays live (V-12, unchanged).
- **K-4. Keyboard actions use the click paths. There's no parallel implementation.**
  - **Clicking the button.** A key that acts calls `.click()` on the **same element** a mouse would press:
    - Enter: `[data-command] [data-run]`;
    - `1` in the card: `[data-next-buy] [data-run-one]`;
    - a drawer letter: `[data-drawer] [data-key="<K>"]`.
  - **What that keeps.** `Guarded`'s `off` guard, the busy label (`BOTTLENECK_BUY_LABEL`, `drawer:<item>:<verb>`) and the exact batch are the click's.
    - Spends stay pessimistic and settings optimistic (W-13).
    - One key press is one intent and one batch.
    - A missing or off target makes the key a no-op.
  - **The tap.** `T` goes through `tapKeyHold`, which is `useTapHold`'s keyboard semantics (one press, repeats ignored, release on up or blur) over the same `store.pressTap()` / `releaseTap()`.
- **K-5. One modal at a time. The inert pass finds it.**
  - **`openModal(app)`** (in `dialog.ts`) returns the first open host of `MODAL_HOSTS`: `[data-settings-host]`, `[data-help-host]`, `[data-next-buy-host]`, then `[data-drawer-host]` (from Task 6). App's existing layout effect inerts around it.
  - **Why they can't overlap.** Every opener sits behind the others' inert, so a test pins at most one `[aria-modal="true"]` at a time.
  - **Scopes.** `scopeOf` follows U-7a's order: help > settings > the phone sheet > the card > the drawer > global.
- **K-6. Returning focus from a keyboard-opened card or help.**
  - The opener is `document.activeElement` at the moment of opening. If that's `<body>`, the opener is the shown row list, or `null` off the factory and phone power views.
  - Esc returns focus to the opener, or leaves it on `<body>` when that's `null`.
  - **Never to `[data-why]`,** as the click path's fallback does. Focus on `why` isn't at rest, so the next Enter would toggle the card instead of running the advice.
  - *Supersedes:* App's `whyReturn` fallback, for keyboard openings only. The `[data-why]` button keeps its toggle (the ledger's Task 4 ruling).
- **K-7. Hints are honest by construction.**
  - **One source per target.** Every element a letter key clicks carries `data-key="<K>"`. Its `.key-hint` is rendered from that same attribute, so a hint can't name a key that clicks something else.
  - **One source for the help.** `KEYMAP` (keys.ts) drives the help overlay. A test resolves every `KEYMAP` probe through `resolveKey` in its scope.
  - **The hint test.** A second test resolves every rendered `.key-hint` through `hintProbe` + `resolveKey`, in the scope it's rendered in.
  - **Visibility.** `.key-hint` becomes visible only under `@media (hover: hover) and (pointer: fine)` (U-7e). This supersedes V-9.
- **K-8. Home and End move to the dispatcher, but only on the row list.**
  - They act only while focus is the row list itself (the listbox convention). ↑/↓ act from anywhere that isn't typing or an arrow control (U-7a).
  - `RowList`'s `onKeyDown` is deleted (V-10 said UI-2 would), and its test moves to `keyboard.test.tsx`.
- **K-9. A missing target is a no-op, never a hidden action.**
  - `B` clicks the best unlocked mark's `buy 1`, which exists only while the MACHINES body shows (U-5c's "the MACHINES row's primary button"). With another section open, `B` does nothing. Its hint isn't on screen then either.
  - A key whose target is absent doesn't call `preventDefault`.
- **K-10. F-keys and `F`/`P`/`H` agree in every scope.**
  - **What a press does.** Each is the Panels tab's `selectView`. Then it closes the drawer (U-7a's drawer column) and the card (U-7a's card column, F1–F3).
  - **The spec says the alternatives are "as global" in the card.** Here they close it too, so the pairs agree, which is what `keys.test` checks.
  - **`H`/F3 with an item drawer open** opens that item's handbook entry (V-25's `selectView` already does). So the drawer's `[H] handbook` and the global `H` are one command. A generator drawer gives the index.
- **K-11. The drawer never drops focus to `<body>`.**
  - **What the drawer remembers.** The last element focused inside it, from `focusin`.
  - **The check.** A layout effect after every commit refocuses the title when all three hold:
    - that element is no longer connected;
    - `document.activeElement` is `<body>`;
    - the drawer is still mounted.
  - **When it fires:** a section swap, a dismantle-all that removes its row, or a mark row going away.
  - **A section opened by its key** focuses its own toggle (`[data-section]`), which stays rendered.
  - *Why:* a non-modal panel can't use Settings' "focus outside means take it back" rule, because the rows stay interactive. A click on blank space keeps that element connected, so it never triggers the refocus.
- **K-12. Generator drawers.**
  - **The target.** The open drawer is a `DrawerTarget`: `{ kind: "item", itemId }` or `{ kind: "generator", recipeId }`. `data-drawer` is the item id, or `power:<class>` for a generator.
  - **Labels.** A generator drawer's spends go under `power:<class>:<verb>`. Its buy uses `generatorLabel` (V-21), so the panel's `+1` and the drawer's `buy 1` are busy together. UI-3's log keeps parsing `drawer:<item>:<verb>` for items only.
  - **Sections:** MACHINES, plus `[U]` and `[D]` when they apply. No R, A, S or H.
  - **Keys.** ↑/↓ don't follow from a generator drawer: they move the FUEL list's selection, and the drawer stays.
  - **Focus.** Opening focuses the title. Closing returns focus to the row's `[data-open-generator]` button.
  - **Locked generators** aren't openable.
- **K-13. MACHINES buttons and their names.**
  - **Each unlocked mark row** has `buy 1`, `x10` and `max`: `button[data-mark-buy="<mark>"][data-count="1|10|max"]`. `max` is `maxAffordableCount`, at least 1.
  - **Accessible names** are plain: "Buy 10 Miner Mk.1", plus ", affordable in N seconds" when off and not busy (V-17's form).
  - **The follow line.** `IF YOU BUY N` follows the hovered or focused count (default: the best mark ×1). It's `[data-follow]` and carries that count's `CostList` and `[data-countdown]`. So Drawer test 9's invariant holds: a cost is red exactly when its button is off for lack of that item.
  - **The ladder** shows `ladder: 8 more MINER → x1.50` through `Spoken`, and a reader hears the existing `ladder.text`. So `drawer-buy`'s `toContainText("8 more Miners → ×1.50")` still matches.
  - **The row's owned count** is `[data-owned]` reading `x3`.
- **K-14. Projection lines are themed, and a draining input is drawn in `--advice`.**
  - **The formatter.** `projectionLines` (in `Projection.tsx`) formats `preview()`'s deltas: `IRON_PLATE -0.8/s (still +11.2/s)` when `after < before`, with the class `drain`; otherwise `ROTOR +0.4 → +0.6/s`. Each line goes through `Spoken`.
  - **Unchanged.** `preview.ts` and `previewLines` (used by NEXT_BUY), as the spec says.
- **K-15. `SPLIT` rows are buttons to the item's priority entry** (U-3c's words: "as `onSplit` does today"). `onSplit(itemId)` is unchanged. Each row is `button[data-split]`, so `PriorityList` test 9 still finds the first.
- **K-16. Coarse targets come from one rule (U-8d's 9a).**
  - **The rule.** `base.css` gets `@media (pointer: coarse) { button, .btn, [role="tab"] { min-height: 44px; min-width: 44px } }`.
  - **How modules size things.** They set their small fine-pointer sizes with `height`. `min-height` always wins over `height`, whatever the specificity.
  - **The new 9a:**
    - the coarse rule exists;
    - no `min-height` or `min-width` below 44 px sits anywhere outside a `(pointer: fine)` block.
  - **The e2e.** `phone.spec` also runs `expectNoOverflow` on a coarse tablet (820×1180, `hasTouch`).
- **K-17. One keyboard on every layout.**
  - **The phone.** The dispatcher runs there too. Its sheets are modal scopes and take no keys (their own Esc closes them), so there's no ↑/↓ follow on the phone (U-5b). The digits pick the four production lanes.
  - **The `?` header button** is on desktop and tablet only, beside `cfg`. The phone has no hints (U-7e).
- **K-18. No new tab stop.** The main box stays unfocusable. "At rest" includes `[data-main-box]` and the `[data-command]` section only because U-7b lists them.
- **K-19. `keyboard.spec`'s typing check uses the handbook search.** U-7's "the settings email field" no longer exists: accounts are OAuth only (PR #30), so Settings has no text field. `[data-handbook-search]` is the game's text input.
- **K-20. The grip.**
  - **The control.** The 44×4 bar (`--t3`) sits in a `[data-grip]` hit area 44 px tall and the sheet's width. It's `aria-hidden`; the `x` is the accessible close.
  - **Pointer events** use `setPointerCapture`, and a drag down past `DRAG_CLOSE_PX = 96` closes the sheet.
  - **With motion:** while dragging, the sheet follows via an inline `transform: translateY(<dy>px)`. Released short of 96, it snaps back with a CSS transition declared inside `prefers-reduced-motion: no-preference`.
  - **Under reduced motion** the sheet doesn't follow and just closes on a long enough drag (U-5b).
- **K-21. Enter at rest is always the bar's run.** In the card scope with focus at rest (the primary unmounted), Enter clicks `[data-command] [data-run]`. That's the same batch under the same label as the card's `buy N`, so there's one code path.
- **K-22. Tab is taken only at rest and only when `[data-why]` exists** (there's advice to explain, U-7b). Otherwise Tab is native.
- **K-23. E2E in every task.** Each task ends with `pnpm test`, `pnpm lint`, `pnpm typecheck`, then `pnpm --filter @manufactory/web e2e`. A spec a task breaks is fixed in that task:
  - Task 4 changes `drawer-buy`;
  - Task 6 changes `layout-320`'s drawer-sheet step;
  - Task 7 adds `keyboard.spec` and `phone.spec`, and the held `T` in `tap-hold`.
- **K-24. Not added:** `aria-keyshortcuts`. The spec doesn't ask for it, the hints are `aria-hidden` by design, and the help overlay is the screen-reader path.

## Global Constraints

- Work only in `.claude/worktrees/ui2` on branch `ui-2`.
- Never run `pnpm format`.
- Verify with `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, then `pnpm --filter @manufactory/web e2e`, sequentially in the foreground, never in the background. Never run lint or typecheck while tests run.
  - A single suite: `pnpm --filter @manufactory/web exec vitest run <path>`.
- Never `pkill -f`. No containers.
- Heavy suites (anything rendering `App`, tier-8 fixtures) get explicit vitest timeouts: `describe(name, { timeout: 60_000 }, …)`. CI is 10–20× slower. That covers `keyboard.test.tsx`, `Help.test.tsx`, `Drawer.test.tsx`, `RowList.test.tsx`, `PowerPanel.test.tsx`, `d1-coverage.test.tsx`, `NextBuy.test.tsx`, `Shell.test.tsx` and `PriorityList.test.tsx`.
- No new npm dependencies. No API, engine, content or sync change.
- Only `transform` and `opacity` animate, inside `prefers-reduced-motion: no-preference`. State colours appear only under state-class selectors. Every CSS file is policed by `contrast.test` (new surface classes go into `ON_SURFACE`).
- Every e2e wait is on the DOM or a store attribute, never a sleep.
- Commit trailers, exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

The five failure modes most likely to bite a player:

1. **A shortcut firing while typing, or stealing a browser or screen-reader key.**
   - **Where it would bite:** typing `t`, `1` or `?` into the handbook search; a digit on the reserve slider; Ctrl+1; an IME composition; Alt+↓ in the priority list; anything while Settings is open.
   - **What guards it:** K-2. Task 1 tests 2–4 and Task 2 test 9 cover it, and `keyboard.spec` step 7.
2. **Enter (or `B`, or `1` in the card) buying twice, or buying through a path a click wouldn't.**
   - **The risks:** a held key's repeats; Enter on a focused `[data-run]` sending once natively and once through the dispatcher; a busy or unaffordable run sending anyway.
   - **What guards it:** K-4 and K-21. Task 2 tests 1–3 and Task 4 test 6 cover it, and `keyboard.spec` step 2 counts the POSTs.
3. **Focus lost to `<body>` after a drawer action, or returned to the wrong place.**
   - **The cases:** a section swap, a dismantle-all, ↑/↓ follow (focus must land on the new title), Esc (back to the row list with the row active), a keyboard-opened card closing (K-6: never onto `why`), and a generator drawer closing.
   - **What guards it:** K-6, K-11 and K-12. Task 2 tests 5–7, Task 4 test 7 and Task 5 test 4 cover it.
4. **A modal with no way out, or a stuck tap.**
   - **The sheet:** it must close by `x`, backdrop, Esc and grip, and Tab wraps without leaving.
   - **The help:** it closes by Esc and by `?`.
   - **The tap:** a `T` keyup with Shift held, or after focus moved into a modal, must still release. So must window blur.
   - **What guards it:** K-2, K-3 and K-20. Task 2 test 8, Task 3 test 3 and Task 6 tests 1–3 cover it.
5. **A hint advertising a key that doesn't work** (or the help overlay drifting from the real map).
   - **The cases:** `[U]` on a drawer with no consolidation, `[B]` with another section open, `F1` while the dispatcher is off, `[ENTER]` with nothing to run.
   - **What guards it:** K-7 and K-9. Task 2 test 10 and Task 3 test 2 cover it, re-run after Task 4.

---

### Task 1: `keys.ts`, the pure resolver, with the full table test

**Files:**
- **Create:** `apps/web/src/ui/keys.ts`, `apps/web/src/ui/keys.test.ts`.

**Interfaces** (later tasks rely on these names):

```ts
// keys.ts (U-7a, U-7b, K-2, K-5, K-7, K-8, K-10, K-21, K-22): pure, no React, no listeners.
export type Scope = "help" | "settings" | "sheet" | "card" | "drawer" | "global";
export type FocusKind = "rest" | "typing" | "arrows" | "control";
export type ViewName = "factory" | "priority" | "handbook" | "power";
export type SectionKey = "B" | "U" | "R" | "A" | "S" | "D";
export type RowMove = "next" | "prev" | "first" | "last";

export interface KeyInput {
  type: "keydown" | "keyup";
  key: string;
  repeat: boolean;
  isComposing: boolean;
  keyCode?: number;
  ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean;
  defaultPrevented: boolean;
}

export interface KeyContext {
  scope: Scope;
  focus: FocusKind;
  /** Focus is the row list itself (Home/End, K-8). */
  onRows: boolean;
  view: ViewName;
  /** A row list is on screen: the factory view (any lane, power's FUEL included) or the phone power view. */
  rows: boolean;
  /** [data-why] exists: there's advice to explain (K-22). */
  advice: boolean;
  /** The open drawer is an item drawer, so ↑/↓ re-key it (U-5a); false for a generator drawer (K-12). */
  follows: boolean;
}

export type Command =
  | { kind: "run" }                                   // click [data-command] [data-run] (K-4, K-21)
  | { kind: "runOne" }                                // click [data-next-buy] [data-run-one]
  | { kind: "why" }                                   // open the card / phone sheet (K-6 opener)
  | { kind: "lane"; n: number; closeDrawer: boolean } // 1-based position in laneTabs; to the factory view
  | { kind: "view"; view: "factory" | "priority" | "handbook"; closeDrawer: boolean; closeCard: boolean }
  | { kind: "move"; to: RowMove; follow: boolean }
  | { kind: "open" }                                  // the selected row's drawer
  | { kind: "close" }                                 // the drawer; focus to its opener (U-7c)
  | { kind: "section"; key: SectionKey }              // click [data-drawer] [data-key=K]
  | { kind: "tap"; down: boolean }
  | { kind: "help" };                                 // toggle the overlay

export interface Resolved { command: Command; preventDefault: boolean }

export function resolveKey(e: KeyInput, ctx: KeyContext): Resolved | null;
/** The focused element's kind (K-2, U-7b). null, <html> and <body> are "rest". */
export function focusKind(el: Element | null): FocusKind;
/** The row list: ul[role=listbox][data-rows]. */
export function isRowList(el: Element | null): boolean;
export function scopeOf(open: { help: boolean; settings: boolean; phone: boolean;
  why: boolean; drawer: boolean }): Scope;   // help > settings > (phone && (why || drawer) → sheet) > why → card > drawer > global

/** One help line (K-7): what it shows, what a reader hears, and the events that must resolve. */
export interface KeyRow {
  scope: "global" | "drawer" | "card" | "help";
  caps: readonly { shown: string; said: string }[];   // [{ shown: "[ENTER]", said: "Enter" }]
  does: string;                                        // plain words, no ids (K-1)
  probes: readonly Partial<KeyInput>[];
  /** Esc: handled by the dialog's own onKeyDown, not by resolveKey. */
  byComponent?: true;
}
export const KEYMAP: readonly KeyRow[];
/** A rendered hint's text → its probes: "[ENTER]" → Enter, "[↑↓] row  [ESC] close" → ArrowUp,
 *  ArrowDown, Escape; "F1" → F1; "3" → "3"; "[B]" → "b". Unknown text throws (a new hint must be mapped). */
export function hintProbe(text: string): { probe: Partial<KeyInput>; byComponent: boolean }[];
```

**The resolution** (one table, U-7a with K-2/K-8/K-10/K-21/K-22). It's evaluated in this order:
1. **`keyup`:** `t`/`T` → `tap up` (no `preventDefault`), whatever the scope, modifiers or target. Anything else → `null`.
2. **Ignored `keydown`s:** composing, `defaultPrevented`, Ctrl/Alt/Meta, `focus === "typing"` → `null`.
3. **Scope `settings` or `sheet`** → `null`.
4. **Scope `help`:** `?` → `help` (`preventDefault`). Anything else → `null`.
5. **`e.repeat`** on anything but `ArrowUp`/`ArrowDown` → `null`.
6. **Letters are lowercased** (`F` ≡ `f`, so Caps Lock doesn't matter). Shift is allowed only with `?`, so Shift + anything else → `null`.
7. **The keys:**

| Key | global | drawer | card | preventDefault |
|---|---|---|---|---|
| Enter | `run` if focus is `rest` | same | `run` if `rest` (K-21), else `null` (native) | yes when resolved |
| Tab | `why` if `rest` and `advice` | same | `null` | yes |
| `1` | `lane 1` | `lane 1, closeDrawer` | `runOne` | yes |
| `2`–`5` | `lane n` | `lane n, closeDrawer` | `lane n` | yes |
| F1 / `f` | `view factory` | `…, closeDrawer` | `…, closeCard` | yes |
| F2 / `p` | `view priority` | `…, closeDrawer` | `…, closeCard` | yes |
| F3 / `h` | `view handbook` | `…, closeDrawer` (K-10) | `…, closeCard` | yes |
| ↑ / ↓ | `move prev/next` if `rows` and focus ∉ {arrows} | same, with `follow: ctx.follows` | `null` | yes |
| Home / End | `move first/last` if `onRows` | same, with `follow` | `null` | yes |
| → | `open` if `rows` and focus ∉ {arrows} | `null` | `null` | yes |
| Space | `open` if `rows` and `rest` | `null` (native) | `null` | yes, only when it opens |
| Esc | `null` | `close` | `null` (the card's own) | no |
| `t` | `tap down` | same | same | yes |
| `b u r a s d` | `null` | `section B/U/R/A/S/D` | `null` | yes |
| `?` | `help` | same | same | yes |

Steps:
- [ ] **Step 1: Write the failing tests** (`keys.test.ts`, pure, no timeout needed).
  1. **The table.** Loop over every key in the table × the scopes `global`, `drawer` and `card` × focus `rest` and `control`, and assert each cell, `preventDefault` included. *Catches:* a wrong cell, e.g. Space resolving on a `control`, or Esc resolving globally.
  2. **The typing targets.** `focusKind` gives `"typing"` for:
     - `input` of type `text`, `search`, `email`, `number` and `range`;
     - `textarea`, `select`, `div[contenteditable]` and `div[contenteditable="true"]`;
     - `[role=textbox|searchbox|combobox|spinbutton|slider]`.

     It gives `"arrows"` for `input[type=radio]`, `[role=radio]`, an element inside `[role=radiogroup]`, and `[role=listbox]` without `data-rows` (plus its options).

     It gives `"rest"` for `null`, `<body>`, `<html>`, `ul[role=listbox][data-rows]`, `[data-main-box]` and `section[data-command]`.

     It gives `"control"` for a `button`, an `a[href]`, a `[role=tab]` and `h2[tabindex=-1]`.

     With focus `typing`, every key in the table resolves to `null` in every scope. *Catches:* dropping `range` from typing, or treating `select` as a control (digits would switch lanes mid-select).
  3. **Modifiers, composition and handled keys.** For every key:
     - Ctrl, Alt or Meta → `null`;
     - `isComposing` → `null`;
     - `keyCode: 229` → `null`;
     - `defaultPrevented` → `null`.

     Shift + `?` → `help`, while Shift + `t`, Shift + Enter, Shift + `1` and Shift+Tab → `null`. *Catches:* accepting Shift generally (which would take Shift+Tab, a WCAG 2.1.2 trap).
  4. **Modal scopes.** In `settings` and `sheet`, every `keydown` → `null`. In `help`, only `?` resolves. *Catches:* a digit switching lanes behind Settings.
  5. **Repeats.** With `repeat: true`:
     - Enter, `t`, `b`, `1` and Tab → `null`;
     - ↑/↓ still `move`.

     *Catches:* the double buy from a held Enter (Review Focus 2).
  6. **The release.** A `keyup` of `T` with Shift, with Ctrl, with focus `typing`, in `settings` and in `sheet` → `tap up` every time. A `keyup` of Enter → `null`. *Catches:* a stuck tap (Review Focus 4).
  7. **F-keys and letters agree (K-10).** For each scope and focus, `F1 ≡ f ≡ F`, `F2 ≡ p`, and `F3 ≡ h`: the same command, the same `preventDefault`. *Catches:* the card column's "F/P/H as global" mismatch.
  8. **`scopeOf`.**
     - help + settings → `help`;
     - settings + why → `settings`;
     - phone + drawer → `sheet`;
     - phone + why → `sheet`;
     - desktop + why + drawer → `card`;
     - desktop + drawer → `drawer`;
     - nothing open → `global`.
  9. **`KEYMAP` is the truth (K-7).** Every non-`byComponent` row's probes resolve non-`null` in that row's scope, with focus `rest` and `rows`, `advice`, `follows` and `onRows` all true. Every `caps[].said` is non-empty and doesn't match `ID_LIKE`.
  10. **`hintProbe`.**
      - `"[ENTER]"`, `"[TAB]"`, `"[T]"`, `"[1]"`, `"F1"`, `"F2"`, `"F3"` and `"1"`…`"5"` each give one probe;
      - `"[↑↓] row  [ESC] close"` gives ArrowUp, ArrowDown and Escape (`byComponent`);
      - `"[ESC]"` is `byComponent`;
      - `"[B]"`, `"[U]"`, `"[R]"`, `"[A]"`, `"[S]"`, `"[D]"` and `"[H]"` give their letters;
      - `"[Q]"` throws.
- [ ] **Step 2:** run `pnpm --filter @manufactory/web exec vitest run src/ui/keys.test.ts`, and watch it fail (no module).
- [ ] **Step 3: Implement `keys.ts`.**
  - The resolver is one ordered function, then a `switch` on the lowercased key.
  - `KEYMAP` covers every U-7a row, grouped by scope, plus the "at rest" and "not while typing" rules as rows with no probes. Those rows are prose and are skipped by test 9.
- [ ] **Step 4:** green.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Remove the `repeat` check: test 5 fails.
  - Let `focusKind` treat `type=range` as `control`: test 2 fails.
  - Filter `keyup` by modifiers: test 6 fails.
  - Make `p` resolve to `view handbook`: tests 7 and 9 fail.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint`, `pnpm typecheck`, then the e2e (no spec changes expected). Commit: `Web: a pure key resolver for the keyboard map, with scopes and the typing, modifier and repeat rules (UI-2, U-7a)`.

---

### Task 2: the dispatcher, wired; listbox focus; held `T`; honest hints

**Files:**
- **Create:**
  - `apps/web/src/ui/use-keyboard.ts`;
  - `apps/web/src/ui/selection.ts`;
  - `apps/web/src/ui/keyboard.test.tsx`.
- **Modify:**
  - `apps/web/src/ui/App.tsx`: the context, the actions, `useKeyboard`, K-6's opener, and the follow;
  - `apps/web/src/ui/RowList.tsx`: `onKeyDown` goes; `data-rows`; the hint sentence restored (the ledger's parked item); `currentRow` from `selection.ts`;
  - `apps/web/src/ui/use-tap-hold.ts`: `tapKeyHold`;
  - `apps/web/src/ui/CommandBar.tsx`: `data-run-one` on `RunButton` when `count === 1`;
  - `apps/web/src/styles/base.css`: the U-7e hint rule;
  - `apps/web/src/styles/tokens.test.ts`: new 11a;
  - `apps/web/src/ui/RowList.test.tsx`: test 5 moves to `keyboard.test.tsx`; the V-10 describe goes.

**Interfaces:**

```ts
// selection.ts (U-7d): one rule for RowList and the dispatcher, so they can't disagree.
export function currentRow(ids: readonly ItemId[], selected: ItemId | null,
  bottleneck: BottleneckModel | null): ItemId | null;        // selected if shown, else the bottleneck's row, else the first
export function stepRow(ids: readonly ItemId[], current: ItemId | null, to: RowMove): ItemId | null; // clamps, no wrap
// RowList keeps exporting defaultSelection(rows, bottleneck) = currentRow(ids, null, bottleneck).

// use-tap-hold.ts (K-4): useTapHold's key semantics, for the global T.
export interface TapKey { down(): void; up(): void; held(): boolean }
export function tapKeyHold(store: Pick<GameStore, "pressTap" | "releaseTap">): TapKey;

// use-keyboard.ts: the one listener pair on document, bubble phase (U-7a).
export interface KeyActions {
  context(): KeyContext;              // read at event time from App's refs and document.activeElement
  run(): void; runOne(): void; why(): void;
  lane(n: number, closeDrawer: boolean): void;
  view(v: "factory" | "priority" | "handbook", closeDrawer: boolean, closeCard: boolean): void;
  move(to: RowMove, follow: boolean): void;
  open(): void; close(): void;
  section(k: SectionKey): void;
  help?(): void;                      // Task 3; absent → the command is a no-op and nothing is prevented
}
export function useKeyboard(enabled: boolean, actions: KeyActions,
  store: Pick<GameStore, "pressTap" | "releaseTap">): void;
```

**The wiring in App:**
- **`enabled`** is true when there's a game: a snapshot, a lane, and not the callback route.
- **`context()`:**
  - the scope is `scopeOf({ help, settings: sheet !== null, phone: mode === "phone", why: whyOpen, drawer: drawerItem !== null })`;
  - the focus is `focusKind(document.activeElement)`;
  - `onRows` is `isRowList(document.activeElement)`;
  - the view is `shown`;
  - `rows` is true when `shown === "factory"`, or when `shown === "power"` with a power lane;
  - `advice` is true when `[data-why]` exists and isn't `aria-disabled="true"`;
  - `follows` is true when the open drawer is an item.
- **The list's lane** is `shown === "power" ? powerId : laneId`, and the ids come from `laneItemIds(s, lane)`.
- **`run()`** clicks `app.querySelector('[data-command] [data-run]')`.
- **`runOne()`** clicks `[data-next-buy] [data-run-one]`.
- **`why()`** calls `openWhy(opener)`, with K-6's opener.
  - `openWhy` gains a flag so a keyboard close returns to that opener. When the opener is `null`, nothing is focused.
  - Opening on the phone opens the modal NEXT_BUY sheet. That's UI-1's own sheet path.
- **`lane(n)`:**
  - `lanes[n-1]`, if it exists and isn't locked: `setPane("factory")`, `onLane(id)`, and `setOpenItem(null)` when `closeDrawer`;
  - locked or missing → nothing.
- **`view(v)`:** `closeWhy(false)` when `closeCard` (and the card is open), then `selectView(v)`, then `setOpenItem(null)` when `closeDrawer`. `selectView("handbook")` reads `openItem` before the clear, so `H`/F3 opens the item's entry (K-10).
- **`move(to, follow)`:**
  - it calls `select(lane, next)` and scrolls `#row-<next>` into view (`block: "nearest"`);
  - **with `follow` and an item drawer open:** `opened.current = true; setOpenItem(next)`. The drawer remounts on its key and focuses its title (U-7c);
  - **otherwise** it focuses the row list.
- **`open()`:** `openRow(currentRow(...))`.
- **`close()`:** App's existing `close()`, which focuses the row list.
- **`section(k)`:** clicks `[data-drawer] [data-key="<k>"]`. When the clicked element is a section toggle, it's then focused (K-11).
- **The tap:**
  - `keydown` `tap down` → `tapKey.down()`, which ignores the call while already held;
  - `keyup` → `tapKey.up()`;
  - `window` `blur` → `tapKey.up()`, and so does `document` `visibilitychange` to `hidden`.
- **`preventDefault`** is called only when the command resolved **and** its action found its target. `run` with no `[data-run]` prevents nothing.

**The hints (U-7e, K-7):**
- `base.css` replaces `.key-hint { display: none }` with `display: none` plus `@media (hover: hover) and (pointer: fine) { .key-hint { display: inline } }`.
- The hint text needs a trailing space or gap, per its module. Keep the existing spans.

Steps:
- [ ] **Step 1: Write the failing tests** (`keyboard.test.tsx`, `describe(…, { timeout: 60_000 })`, App on a fake store, `stubWidth(1280)` unless noted). Events go through `fireEvent.keyDown(document.activeElement ?? document.body, …)`, so they bubble to `document` as in the browser.
  1. **Enter at rest runs the advice, once.**
     - On a topped fresh world (the run is affordable), focus on `<body>`: Enter → `store.send` is called once, with exactly the `[P3_BUY]` batch under `BOTTLENECK_BUY_LABEL`. That's the same assertion as `CommandBar.test` 3.
     - Enter again while that batch is pending → no second send.
     - Enter with `repeat: true` → none.
     - *Catches:* a dispatcher that calls `store.send` itself (it would skip `Guarded`'s busy check).
  2. **Enter on a control is the control's.**
     - Focus `[data-run]` and fire Enter: zero sends from the dispatcher (jsdom has no native activation, so 0 proves the dispatcher stayed out).
     - Focus a lane tab and fire Enter: zero sends.
     - Focus the row list and fire Enter: one send (the list is at rest; the hint sentence says so).
     - *Catches:* treating a button as at rest, which would be a double buy in the browser.
  3. **Enter off the factory view.** On `F2` (priority), Enter at rest sends once (U-4a: "Enter runs the advice anywhere"). With a frameless bottleneck (no `[data-run]`), Enter sends nothing and its event is not `defaultPrevented`. *Catches:* `preventDefault` on a no-op (K-9).
  4. **Tab opens the card (U-7b, K-6, K-22).**
     - From `<body>`, Tab opens `[data-next-buy]` with focus on its primary, and the event is prevented.
     - Esc closes it, and focus lands on the row list, **not** `[data-why]`.
     - Then Enter at rest sends once.
     - Shift+Tab from `<body>` opens nothing.
     - With no bottleneck (no `[data-why]`), Tab isn't prevented.
     - *Catches:* returning focus to `why` (then Enter would re-toggle the card instead of buying).
  5. **↑/↓ and the listbox (U-7c, U-7d, K-8).**
     - From `<body>`, ↓ moves `aria-activedescendant` to the next row and focuses the row list.
     - Home and End act only with the list focused. With focus on a lane tab, Home is the tablist's.
     - → and Space open the active row's drawer, focusing `#drawer-title`. Esc returns focus to the list with that row active.
     - Alt+↓ does nothing.
     - These are the old `RowList.test` 5 cases, moved.
  6. **The drawer follows (U-5a, U-7c).**
     - Open `iron_ore`'s drawer, then ↓: `[data-drawer]` is now the next row's item, the old one is gone, and `document.activeElement` is the new `#drawer-title`, reading the new item's label.
     - ↓ at the last row stays put.
     - **With a recipe radio focused** (tier-8 `plastic`'s drawer, Recipe tab): ↓ does not move the selection. *Catches:* a missing `arrows` check.
  7. **Digits and views.**
     - `5` shows `[data-power-panel]`, and `1` comes back to iron.
     - `2` (copper locked on a fresh world) leaves iron selected.
     - From F2, `1` returns to the factory view.
     - With the drawer open, `1` closes it.
     - F2 / `p` show `#view-priority`, F3 / `h` the handbook, and F1 / `f` the factory. With an item drawer open, `h` navigates to that item's entry (`Handbook.test` 3's assertion), and the drawer is closed afterwards.
     - With the card open, F2 closes it.
     - *Catches:* the drawer outliving a key lane switch (UI-1's final-fix item 2, now by key).
  8. **Held `T` (U-6c, K-2, K-4).**
     - `keydown` t → `pressTap` once. A repeated t → not again.
     - `keyup` T **with Shift held** → `releaseTap` once.
     - t, then `window` blur → `releaseTap`.
     - t, then Settings opens (scope `settings`), then the `keyup` → `releaseTap`.
     - t in `[data-handbook-search]` → nothing.
     - The footer TAP's own Space hold still works, and the document listener doesn't also tap (its `stopPropagation`). That's `PowerPanel.test` 6, re-run.
  9. **Never while typing, or behind Settings.**
     - On F3, focus `[data-handbook-search]` and type `1`, `p`, `t`, `?` and Enter: the view stays the handbook, no send, no tap, and the field's value is `1pt?`.
     - With Settings open, `1` and Enter do nothing, and Esc closes Settings, as before.
     - Ctrl+`1` does nothing.
  10. **Every hint is honest (K-7).**
      - Render desktop with the card open, then with an item drawer open.
      - For every `.key-hint`, take its scope (inside `[data-next-buy]` → `card`; inside `[data-drawer]` → `drawer`; else App's scope) and `hintProbe(text)`.
      - Assert `resolveKey(probe, context)` is non-`null` for every probe not `byComponent`. For `byComponent` (Esc), fire Escape inside that dialog and assert it closes.
      - **Missing hints:** `hintProbe` throws on an unknown hint, so a new one must be mapped.
      - *Catches:* Review Focus 5. Re-run in Task 4 with the letter keys.
  11. **`tokens.test` 11a.**
      - Every `display` declaration on `.key-hint` is either `none` at the top level or `inline` inside exactly `@media (hover: hover) and (pointer: fine)`.
      - The listbox's `aria-describedby` text is "Arrow keys to move, right arrow or space for details, enter runs the next buy."
  12. **`selection.ts`.**
      - `currentRow` falls from the selection to the bottleneck's row to the first row.
      - `stepRow` clamps at both ends.
      - On tier 8, for every lane, `laneRows(s, lane).map(r => r.itemId)` equals `laneItemIds(s, lane)`. The dispatcher's order is the screen's.
- [ ] **Step 2:** run the new suite and the touched ones, and watch them fail.
- [ ] **Step 3: Implement.**
  - `selection.ts`, then `RowList` on it, without `onKeyDown`.
  - `tapKeyHold`.
  - `useKeyboard`: the listeners are added once per `enabled`, and the actions are read through a ref.
  - App's actions and context.
  - `data-run-one`.
  - The hint CSS.
- [ ] **Step 4:** all green. `NextBuy.test` 6 (the why toggle and click focus return) still passes unchanged: K-6 applies to keyboard openings only.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Have `run()` call `store.send([model.action], …)` directly: test 1's pending case fails.
  - Return keyboard focus to `[data-why]`: test 4 fails.
  - Drop `opened.current = true` in `move` with follow: test 6 fails, because focus stays on the old title or falls to body.
  - Skip the blur release: test 8 fails.
  - Show `.key-hint` unconditionally: test 11 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint`, `pnpm typecheck` and the e2e (no spec changes expected). Commit: `Web: the keyboard: Enter runs the advice, Tab opens why, digits and F-keys switch, arrows walk the rows and the drawer follows, a held T taps; hints show on a fine pointer (UI-2, U-7)`.

---

### Task 3: the `?` help overlay, the header button, and one inert pass for every modal

**Files:**
- **Create:**
  - `apps/web/src/ui/Help.tsx`;
  - `apps/web/src/ui/Help.module.css`;
  - `apps/web/src/ui/Help.test.tsx`.
- **Modify:**
  - `apps/web/src/ui/dialog.ts`: `MODAL_HOSTS` and `openModal`;
  - `apps/web/src/ui/App.tsx`: `helpOpen`, its opener, the inert effect on `openModal`, and `actions.help`;
  - `apps/web/src/ui/Shell.tsx`: the `?` button (desktop and tablet), and `ShellProps.onHelp`;
  - `apps/web/src/ui/Shell.module.css`;
  - `apps/web/src/styles/contrast.test.ts`: `ON_SURFACE.help = "s2"`;
  - `apps/web/src/ui/dialog.test.ts`.

**Interfaces:**

```ts
// dialog.ts (K-5)
export const MODAL_HOSTS: readonly string[];  // ["[data-settings-host]", "[data-help-host]", "[data-next-buy-host]"]; Task 6 appends "[data-drawer-host]"
export function openModal(app: HTMLElement): Element | null;   // the first host present
// Help.tsx (U-7e, K-1)
export function Help(p: { onClose(): void; snapshot: Snapshot | null }): JSX.Element;
//   div.backdrop[data-help-host] > div[role=dialog][aria-modal=true][aria-labelledby][data-help]
// Shell.tsx
// ShellProps gains onHelp(opener: HTMLElement): void; the button is button[data-open-help][aria-haspopup=dialog][aria-label="Keyboard shortcuts"], text "?", 36×44.
```

- **The overlay:**
  - **Title.** `h2` `man manufactory` (shell) / `Keyboard shortcuts` (plain), through `Spoken` with "Keyboard shortcuts" said.
  - **The table.** One `section` per scope (Anywhere, With a drawer open, With NEXT_BUY open, In this help), each a `dl` of `KEYMAP` rows: `dt` is the caps via `Spoken`, `dd` is `does`.
  - **The rules.** The "at rest" line, the "not while typing" line, and the F-key note ("F1–F3 may be taken by your browser or OS: F, P and H always work").
  - **The GPL line** (U-2e), with `sourceLinks(currentBuildInfo())`. It's the same text and hrefs as About.
  - **Closing:** Esc (on the dialog, plus a `document` listener like Settings'), `?` through the dispatcher's help scope, the Close button, and the backdrop. Tab wraps (`trapTab`).
  - **Focus.** It opens on its title, and closes back to its opener (K-6 rules; the `?` button when opened by click).
- **Layout.** A centred panel on desktop: `--s2` fill, `1px solid var(--advice)`, `max-width: 640px`, scrolling, `z-index: 55`. Text tokens `--t1`, `--t2` and `--advice` only, with no `--t3` on `--s2` (V-4).
- **Motion.** Opacity 120 ms, under no-preference (U-8c).

Steps:
- [ ] **Step 1: Write the failing tests** (`Help.test.tsx`, `describe(…, { timeout: 60_000 })`).
  1. **Opening.**
     - `?` at rest opens `[data-help]`, which is `role=dialog` and `aria-modal="true"`, with focus on its title.
     - The header's `[data-open-help]` click opens it too.
     - `?` while typing in the handbook search doesn't.
     - The phone has no `[data-open-help]`.
  2. **The content is `KEYMAP`.**
     - Every `KEYMAP` row's `does` text is present.
     - Under terminal, `spokenIds(dialog)` is `[]` and the dialog's accessible name is "Keyboard shortcuts" (K-1).
     - The GPL line holds `a[href]` equal to `sourceLinks(...)`.
  3. **It's modal and closable.**
     - Everything outside the host is inert, but the region isn't. Its controls are (V-12).
     - Tab and Shift+Tab wrap.
     - `1` and Enter do nothing while it's open.
     - **Each close path:** Esc, `?`, Close and the backdrop each close it.
     - **Focus return:** a click-open returns focus to `[data-open-help]`; a key-open from `<body>` on the factory view returns it to the row list.
  4. **One modal at a time (K-5).** `openModal` picks Settings over help over the NEXT_BUY sheet on a fixture tree (`dialog.test`). In App, opening help from each scope leaves exactly one `[aria-modal="true"]`.
  5. **Contrast.** `Help.module.css` passes the usage checks with `help` in `ON_SURFACE`.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement.**
  - App's inert layout effect becomes `const host = openModal(app); if (host === null) return; return inertOutside(app, [host], app.querySelector(".notices"))`.
- [ ] **Step 4:** green, and `Settings.test` 10 / `NextBuy.test` 7 (the inert passes) still pass.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Render the caps as raw text without `Spoken`: test 2 fails (`[ENTER]` read aloud). Re-check that the ids check also fails if a `does` line names `IRON_PLATE`.
  - Drop `[data-help-host]` from `MODAL_HOSTS`: test 3 fails, because the background isn't inert.
  - Have the help scope pass digits through: test 3 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint`, `pnpm typecheck` and the e2e (no spec changes expected). Commit: `Web: the ? help overlay, built from the key map, with the GPL line; one inert pass for every modal (UI-2, U-7e)`.

---

### Task 4: the drawer's sections: MACHINES, the letter keys, `SPLIT`; the segmented tabs go; 9a for coarse pointers

**Files:**
- **Modify:**
  - `apps/web/src/ui/Drawer.tsx`:
    - `Tab`, `TAB_NAMES`, `tabsOf` and `BuySection` go;
    - `MachinesBody`, `MoreBar`, `sectionsOf` and `SplitSection` arrive;
    - the other sections are re-skinned in place;
    - K-11's focus rule;
  - `apps/web/src/ui/Projection.tsx`: `projectionLines` and the `IF YOU BUY` caption prop (K-14);
  - `apps/web/src/ui/Drawer.module.css`: U-5a/U-5c dimensions; `.seg` and `.segBtn` go;
  - `apps/web/src/styles/base.css`: K-16's coarse rule;
  - `apps/web/src/styles/tokens.test.ts`: 9a rewritten;
  - `apps/web/src/ui/Drawer.test.tsx`, `d1-coverage.test.tsx`, `RowList.test.tsx` (test 7) and `PriorityList.test.tsx` (test 9): selectors only, unless named below;
  - `apps/web/src/ui/keyboard.test.tsx`: test 10 re-run with the drawer's letter hints, plus the new test 13 below;
  - `apps/web/e2e/drawer-buy.spec.ts`: the buy selector and the owned text (K-23).

**Interfaces:**

```ts
// Drawer.tsx
export type Section = "upgrade" | "recipe" | "assign" | "storage" | "dismantle";
export const SECTION_KEY: Readonly<Record<Section, SectionKey>>;   // U R A S D
/** Only what the model offers (U-5c): upgrade with a consolidation, recipe with ≥ 2 recipes,
 *  assign with assign rows, storage always (items), dismantle with any owned; in that order. */
export function sectionsOf(m: DrawerModel): Section[];
// Projection.tsx (K-14)
export interface ProjectionLine { shown: string; said: string; drain: boolean }
export function projectionLines(s: Snapshot, p: Preview, laneId: LaneId, theme: ThemeDef): ProjectionLine[];
export function Projection(p: { snapshot; actions; laneId; caption?: string }): JSX.Element;  // caption default "Projected effect"
```

**The drawer DOM** (desktop panel and phone sheet alike; the CSS tells them apart):

```
section[data-drawer][role=dialog][aria-labelledby=drawer-title]
  .head        h2#drawer-title · p[data-meta] · span.key-hint "[↑↓] row  [ESC] close" (panel only) · Close (panel) / x 44×44 (sheet, aria-label "Close")
  .body[data-body="machines|upgrade|recipe|assign|storage|dismantle"]
    machines:  h3 MACHINES
               ul.marks > li[data-mark=n][data-locked?]
                 span.markName (names.machine(class, n); Spoken)  span[data-owned] "x2"
                 span[data-each] "40 IRON_PLATE each" (Spoken; .state-bottleneck when buy 1 is short)
                 Guarded[data-mark-buy=n][data-count=1][data-key=B on the best mark] "[B] buy 1"
                 Guarded[data-mark-buy=n][data-count=10] "x10" · Guarded[data-mark-buy=n][data-count=max] "max"
                 (locked: span "locked · tier 4", --t3, no buttons)
               p[data-ladder] (K-13)
               div[data-follow] "IF YOU BUY N" + CostList + [data-countdown]
               Projection (caption hidden; the follow line is the caption)
               SplitSection when splitOf ≠ null: h3 SPLIT, the bar (aria-hidden), one button[data-split] per part
    others:    h3 UPGRADE | RECIPE | ASSIGN | STORAGE | DISMANTLE, then the existing section, re-skinned
  .more        h3 MORE (desktop) · button[data-section=<s>][data-key=<K>][aria-pressed] per sectionsOf · a[data-handbook-link][data-key=H] (items only)
```

- **The `MORE` buttons.**
  - **Labels:** `[U] upgrade`, `[R] recipe`, `[A] assign`, `[S] storage · next 900 IRON_PLATE` (or `storage · max`), `[D] dismantle` and `[H] handbook`. The hint is from `data-key`.
  - **Accessible names:** "Upgrade", "Recipe", "Assign", "Storage, next 900 Iron Plate", "Dismantle" and "Handbook entry". The last is unchanged, because `Handbook.test` 3b uses it.
  - **Pressing one** shows its section. Pressing it again (or its key) returns to MACHINES.
- **Dimensions (U-5a, U-5c, `DrawerDesktop`, `PhoneDrawer`):**
  - head title 30 px (32 px on the sheet), meta 12 px `--t2`, hint 12 px `--t3`;
  - MACHINES box `1px solid var(--line)`, rows 44 px with a `--line-soft` `var(--rule)` divider;
  - name 150 px `--t1`, owned 50 px, each 12 px `--t2`;
  - `buy 1` 36 px `--accent` fill / `--on-accent`; `x10` and `max` 36 px outlined with `--line`;
  - ladder 12 px `--t2`;
  - projection `1px var(--rule) var(--line)`, `padding: 8px 10px`, 13 px, `line-height: 1.8`, with `.drain` in `--advice`;
  - `MORE` buttons 36 px outlined, in a wrapping row;
  - **the phone sheet:** the mark buttons are 48 px, and `.more` is a 2-column grid of 48 px buttons at the sheet's bottom (U-5b).
- **K-11.** `focusin` on the section records the last focused element. A `useLayoutEffect` with no deps refocuses `#drawer-title` when that element is disconnected, focus is on `<body>`, and the drawer is mounted.

Steps:
- [ ] **Step 1: Write the failing tests** (`Drawer.test.tsx`, `describe(…, { timeout: 60_000 })`; existing tests 1–18 are re-pointed: `pick(d, "Upgrade")` clicks `[data-section="upgrade"]`, and a buy is `[data-mark-buy][data-count]`).
  1. **MACHINES by default.**
     - A fresh `iron_ore` drawer shows `[data-body="machines"]`, `li[data-mark="1"]` with `x2`, the `each` cost, and three buttons. Marks 2 and 3 read `locked · tier 3` / `tier 6`, with no buttons.
     - There's no `[role=group][aria-label=Action]` and no `.segBtn` anywhere.
  2. **The sections (U-5c, "the `[U]` and `[S]` rules"):**
     - a fresh `iron_plate` has no `[data-section="upgrade"]`, and tier 8's has one;
     - `[data-section="storage"]` reads `storage · next <fmt(cost)> IRON_PLATE` and opens `[data-body="storage"]` without sending;
     - pressing it again returns to machines;
     - a fresh drawer has no dismantle when nothing is owned;
     - recipe appears only for an item with two recipes (tier-8 `plastic`).
  3. **`IF YOU BUY` follows (K-13).**
     - Focusing `x10` changes the follow line to `IF YOU BUY 10`, and the projection to `preview(s, [buy 10])`.
     - Hovering `buy 1` on mark 2 (tier 8) follows that mark.
     - A draining input line has `.drain` and reads `… (still …)` (K-14).
  4. **Buy is pessimistic and exact** (test 3, moved).
     - `[data-mark-buy="1"][data-count="1"]` sends `[{ BUY_MACHINE, lane, machineClass, mark: 1, count: 1, recipeId }]` under `drawer:<item>:buy` once. It's `aria-busy` while pending, and a second click sends nothing.
     - `max` sends `maxAffordableCount`.
     - Its accessible name is "Buy 1 Miner Mk.1".
  5. **Cost red ⇔ off** (test 9, moved onto `[data-follow]`).
  6. **The letter keys (K-4, K-9).** With focus on the row list and the drawer open:
     - `b` clicks the best mark's `buy 1`: one send, the same batch as a click;
     - `b` again while pending → none;
     - `r` / `s` open their sections, and their toggle takes focus (K-11);
     - `u` with no consolidation → nothing, not prevented;
     - with the storage section open, `b` → nothing (K-9);
     - `h` → the handbook route for the item.
  7. **Focus never falls to body (K-11).**
     - On tier 8, open the dismantle section, focus "all N" on the last owned mark, and let the click's batch settle with a new snapshot where that mark has 0. Focus is `#drawer-title`.
     - A click on the main box's blank space with focus in the drawer doesn't pull focus back.
  8. **`SPLIT` (K-15).** The tier-8 `screw` drawer has `h3` `SPLIT`, one `button[data-split]` per part with `NN% <label>`, and clicking one focuses screw's priority entry (`PriorityList.test` 9, which now passes unchanged).
  9. **The phone sheet layout.** At 390 px, the `.more` buttons are in a 2-column grid. Assert the CSS via css-walk: `.sheet .more { display: grid; grid-template-columns: 1fr 1fr }`, and the 48 px heights.
  10. **9a, rewritten (U-8d, K-16).**
      - `base.css` has, under `@media (pointer: coarse)`, a rule whose selector list includes `button` with `min-height: 44px` and `min-width: 44px`.
      - No CSS file declares `min-height` or `min-width` with a px value below 44 outside a block whose stack includes `pointer: fine`.
      - No selector names `.segBtn`.
  11. **`keyboard.test` 10 re-run** with the tier-8 `iron_plate` drawer open: the `[B]`, `[U]`, `[R]`, `[A]`, `[S]`, `[D]` and `[H]` hints all resolve.
  12. **`d1-coverage`.** Every case passes with the new selectors, and "covers all eleven" holds.
  13. **`keyboard.test` 13, honesty under a section.** With a non-MACHINES section open there's no `[B]` hint in the DOM.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement.**
  - The DOM above.
  - The re-skins keep each section's behaviour exactly: the Recipe radio's optimistic hold, Assign's one batch, Dismantle's refund text.
  - `drawer-buy.spec`: `drawer.locator('[data-mark-buy="1"][data-count="1"]')`, waiting `aria-disabled="false"` (60 s), then click. Then `drawer.locator('[data-mark="1"] [data-owned]')` reads `x3`, and the ladder `toContainText` is unchanged (K-13).
- [ ] **Step 4:** all green, including the e2e: `drawer-buy`, and `layout-320`'s drawer step (44 px targets on the phone).
- [ ] **Step 5: Mutations, each undone by hand.**
  - Always render `[data-section="upgrade"]`: test 2 fails.
  - Have the `b` section action call `ctx.send` directly: test 6's pending case fails.
  - Remove the K-11 effect: test 7 fails.
  - Add `min-height: 36px` to the mark buttons: test 10 fails.
  - Render `[B]` from a literal string instead of `data-key`, and put it on mark 2: test 11 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint`, `pnpm typecheck` and the e2e. Commit: `Web: drawer sections behind letter keys, MACHINES per mark with IF YOU BUY, SPLIT; the segmented tabs go and 9a polices coarse pointers (UI-2, U-5c, U-8d)`.

---

### Task 5: generator drawers

**Files:**
- **Modify:**
  - `apps/web/src/ui/machines.ts`:
    - `kind: "item"` on `DrawerModel`;
    - `GeneratorModel`;
    - the `drawerModel(s, { recipeId })` overload;
    - `machineSection` refactored to `machineSectionOf(s, recipeId, notation)`;
  - `apps/web/src/ui/Drawer.tsx`:
    - `DrawerTarget`, which replaces `itemId`;
    - the generator head and meta;
    - labels per K-12;
  - `apps/web/src/ui/App.tsx`: `openItem` becomes `open: DrawerTarget | null`; the drawer opener ref (K-12); `follows`;
  - `apps/web/src/ui/PowerPanel.tsx`: the generator row's text becomes `button[data-open-generator=<class>]`, with `onOpenGenerator`;
  - `apps/web/src/ui/Power.module.css`;
  - `apps/web/src/ui/machines.test.ts` (or `Drawer.test.tsx`), `PowerPanel.test.tsx` and `d1-coverage.test.tsx`.

**Interfaces:**

```ts
// machines.ts (U-5c "Generator drawers")
export interface GeneratorModel {
  kind: "generator"; recipeId: RecipeId; machineClass: MachineClassId;
  name: string;            // the class's content name
  laneId: LaneId;          // the power lane
  machines: MachineSection;
}
export function drawerModel(s: Snapshot, itemId: ItemId, notation?: NotationMode): DrawerModel;
export function drawerModel(s: Snapshot, target: { recipeId: RecipeId }, notation?: NotationMode): GeneratorModel;
//   throws for a recipe with powerOutput ≤ 0; memo key `recipe:<notation>:<id>`
// Drawer.tsx
export type DrawerTarget = { kind: "item"; itemId: ItemId } | { kind: "generator"; recipeId: RecipeId };
export function drawerKey(t: DrawerTarget): string;          // "item:iron_ore" | "gen:burn_biomass" (React key)
export const generatorVerbLabel = (machineClass: MachineClassId, verb: "buy" | "upgrade" | "dismantle") =>
  verb === "buy" ? generatorLabel(machineClass) : `power:${machineClass}:${verb}`;
// DrawerProps: `target: DrawerTarget` replaces `itemId`; onSplit stays (items only).
// PowerPanel: onOpenGenerator(recipeId: RecipeId): void; openGenerator: RecipeId | null.
```

- **The generator head:**
  - title `names.machine(class, null)` (`BIOMASS_BURNER`), with an `aria-label` of the content class name;
  - meta `POWER lane · x14 · 420 MW now` (`laneLabel`, owned, and `mwNow` from `generatorRows`);
  - hint `[ESC] close` only (K-12);
  - Close.
- **The body.** MACHINES (a row per mark, the ladder when present, `IF YOU BUY` with the power line from `preview`). `MORE` holds `[U]` and `[D]` only. There's no `SPLIT`, Meta QS or handbook.
- **Placement** follows the power lane's rule in App (`drawerItem` logic): the desktop power tab, or the phone power view.

Steps:
- [ ] **Step 1: Write the failing tests** (`describe(…, { timeout: 60_000 })`).
  1. **`drawerModel(s, { recipeId: "burn_biomass" })`.**
     - On a fresh world: `kind: "generator"`, `machineClass: "biomass_burner"`, lane `power`, `bestMark: 1`, `pool` equal to `installedMachines`.
     - It's the same object on a second call (the memo).
     - A non-generator recipe throws.
     - On tier 8, its `marks` equal the item drawer's for a collector-style lane-class built the same way. Assert against `markRows` through the item path: the `biomass` item's own section has class `collector`, so build the expectation directly from content.
  2. **Opening.**
     - At 1280 px on the `5 POWER` tab, clicking `[data-open-generator="biomass_burner"]` mounts `[data-drawer="power:biomass_burner"]` with focus on its title.
     - `[data-generator="coal_generator"]` (locked) has no `[data-open-generator]`.
     - At 390 px on the `~ power` tab, it's the sheet.
  3. **Its spends (K-12).**
     - `[data-mark-buy="1"][data-count="1"]` sends the same batch as the panel's `+1`, under `generatorLabel("biomass_burner")`.
     - While that's pending, **both** the drawer's `buy 1` and the panel's `+1` are `aria-busy`.
     - On tier 8, `[D]` dismantle ×1 sends `DISMANTLE` under `power:biomass_burner:dismantle`, and `[U]` appears exactly when a consolidation exists.
  4. **Focus and keys.**
     - Esc returns focus to `[data-open-generator="biomass_burner"]`.
     - ↓ with the generator drawer open moves the FUEL list's selection, and the generator drawer stays (`follows: false`).
     - `h` opens the handbook index (`/handbook`).
     - The hint test (`keyboard.test` 10) passes with the generator drawer open.
  5. **`d1-coverage`.** New cases: UPGRADE_MARK and DISMANTLE for a generator through its drawer (tier 8). "Covers all eleven" holds.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement.**
  - Refactor `machineSection` without changing item results. `Drawer.test` and `d1-coverage` pass unchanged before the generator code lands.
  - The generator's recipe id comes from `generatorRows`' row (`recipeId`), so the panel and the drawer agree.
  - Update the PowerPanel header comment: V-21's "rows aren't clickable" is superseded.
- [ ] **Step 4:** all green.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Label the drawer's generator buy `drawer:power:buy`: test 3 fails, because the `+1` isn't busy.
  - Let a generator drawer follow ↓: test 4 fails.
  - Return focus to the row list on close: test 4 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint`, `pnpm typecheck` and the e2e (no spec changes expected; the panel's `+1` selectors are unchanged). Commit: `Web: generator drawers from the power panel, sharing the +1's label (UI-2, U-5c)`.

---

### Task 6: the modal phone drawer sheet, with its grip

**Files:**
- **Create:**
  - `apps/web/src/ui/use-sheet-drag.ts`;
  - `apps/web/src/ui/use-sheet-drag.test.ts`.
- **Modify:**
  - `apps/web/src/ui/Drawer.tsx`: the sheet presentation wraps the section in `div.backdrop[data-drawer-host]`; `aria-modal="true"`; the grip; `trapTab`;
  - `apps/web/src/ui/Drawer.module.css`: the backdrop (`--scrim`, `position: fixed; inset: 0; z-index: 30`), the grip, and the snap-back transition under no-preference;
  - `apps/web/src/ui/dialog.ts`: `MODAL_HOSTS` gains `[data-drawer-host]`;
  - `apps/web/src/ui/App.tsx`: the backdrop's mousedown and the grip close through `close()`;
  - `apps/web/src/ui/Drawer.test.tsx`: the place tests 3, 5, 5b and 6;
  - `apps/web/e2e/layout-320.spec.ts`: the drawer-sheet step (K-23).

**Interfaces:**

```ts
// use-sheet-drag.ts (U-5b, K-20)
export const DRAG_CLOSE_PX = 96;
export function dragOffset(startY: number, y: number): number;              // max(0, y − startY)
export function useSheetDrag(onClose: () => void, opts?: { reduced?: () => boolean }): {
  grip: { onPointerDown; onPointerMove; onPointerUp; onPointerCancel; onLostPointerCapture };
  /** px to translate the sheet by while dragging with motion; null when not dragging or reduced. */
  offset: number | null;
};
```

Steps:
- [ ] **Step 1: Write the failing tests.**
  1. **Modal (K-3).** At 390 px, opening `iron_plate` gives `[data-drawer-host]`, a direct child of `.app`, holding `section[role=dialog][aria-modal="true"]`. Then:
     - `[data-power] button[data-tap]`, the bottom tabs and the lane tabs are inside `[inert]`;
     - the `.notices` region isn't inert, and its Dismiss button is;
     - there's exactly one `[aria-modal="true"]`.
  2. **The trap and focus return.**
     - Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last.
     - **Each close path:** Esc, the `x`, a mousedown on the backdrop (not on the sheet) each close it. Focus goes to the row list with the row active.
     - Opened from the NEXT_BUY sheet's `open IRON_PLATE`, closing focuses the row list, since its opener is gone.
     - A generator drawer sheet returns focus to its `[data-open-generator]`.
  3. **The grip (K-20).**
     - **Down past the threshold:** `pointerdown` at y 100, `pointermove` to 220, `pointerup` → closed. During the move, the sheet's `style.transform` is `translateY(120px)`.
     - **Short of it:** a drag to 180 (80 px) → still open, with no inline transform after `pointerup`.
     - **`pointercancel`** → open.
     - **Under reduced motion** (`stubWidth(390, { reducedMotion: true })`): no inline transform during the move, and 220 still closes.
     - `dragOffset` never goes negative.
  4. **The keyboard on the phone (K-17).** With the sheet open: `1`, ↓ and `b` do nothing (the scope is `sheet`), Esc closes, and `t` doesn't tap (the TAP is inert and the scope ignores it).
  5. **CSS.**
     - The host's z-index (30) is below the phone `.notices` (35), the NEXT_BUY sheet (40) and Settings (50), and above `.floating` (20) (re-pin of test 5/5b).
     - The snap-back `transition` is inside no-preference (7b covers it).
     - `contrast.test` stays green.
- [ ] **Step 2:** run them, and watch them fail.
- [ ] **Step 3: Implement.**
  - The panel presentation is untouched (`aria-modal="false"`, rows live).
  - `layout-320`'s "iron plate drawer sheet" step adds: the sheet has `aria-modal="true"`, `expectNoOverflow`, then the backdrop closes it (`page.mouse.click` at a point above the sheet's top), then reopen and Close as before.
- [ ] **Step 4:** all green, e2e included. `drawer-buy`'s "rows never move (phone)" still holds under the scrim.
- [ ] **Step 5: Mutations, each undone by hand.**
  - Leave `[data-drawer-host]` out of `MODAL_HOSTS`: test 1 fails.
  - Set the threshold at `>= 0`: test 3's short drag fails.
  - Apply the inline transform under reduced motion: test 3 fails.
- [ ] **Step 6:** run `pnpm test`, `pnpm lint`, `pnpm typecheck` and the e2e. Commit: `Web: the phone drawer sheet is modal, with a scrim, a focus trap and a drag-down grip (UI-2, U-5b)`.

---

### Task 7: `keyboard.spec`, `phone.spec`, held `T`, the README, and the full verification

**Files:**
- **Create:**
  - `apps/web/e2e/keyboard.spec.ts` (desktop, 1280×820);
  - `apps/web/e2e/phone.spec.ts` (390×844, `hasTouch: true`, `isMobile: true`).
- **Modify:**
  - `apps/web/e2e/tap-hold.spec.ts`: the held-`T` case;
  - `README.md`: the "In the client" paragraph;
  - `.github/workflows/ci.yml`: the `web-e2e` comment's spec list and measured times only.

Steps:
- [ ] **Step 1: `keyboard.spec`.** Every wait is on the DOM, `data-state-version`, or a request log (`actionPosts`).
  1. **The hints show.** On the fine-pointer desktop, `[data-command] .key-hint` is visible and reads `[ENTER]`.
  2. **Tab, then Enter.**
     - Wait for `[data-command] [data-run]` to have `aria-disabled="false"` (120 s, as `guest-buy`), then `page.evaluate(() => (document.activeElement as HTMLElement)?.blur())`.
     - Press Tab: `[data-next-buy]` is visible and the primary is focused.
     - Press Enter: `data-state-version` becomes `1`, and `actionPosts` has exactly **one** non-TAP POST for it.
     - Press Esc: the card is gone, and the focused element is `[role=listbox][data-rows]`.
  3. **The digits.** `5` shows `[data-power-panel]`, and `1` returns to `[role=option][data-item="iron_ore"]`. `2` leaves the iron tab `aria-selected="true"`.
  4. **The F-keys and letters.**
     - F2 shows `#view-priority`, F3 the handbook (`[data-route="handbook"]`), and F1 the factory.
     - Then `p`, `h` and `f` do the same.
     - After each F-key, `page.url()` didn't change for F1 and F2 (no browser help or find bar side effect we can observe).
  5. **↑/↓, the drawer, Esc.**
     - ↓ then → opens `[data-drawer]` for the row after the bottleneck. The focused element is `#drawer-title`.
     - ↓ re-keys it to the next item, with focus on the new title.
     - Esc closes it. The listbox is focused, and its `aria-activedescendant` is that item's row.
  6. **A letter key in the drawer.** Open `iron_ore`'s drawer, wait for its `buy 1` to be enabled (60 s), and press `b`. `data-state-version` advances once, and `[data-mark="1"] [data-owned]` reads `x3`.
  7. **Typing triggers nothing (K-19).**
     - Press F3, focus `[data-handbook-search]`, and type `1pt?`.
     - The input's value is `1pt?`, `[data-route]` is still `handbook`, there's no `[data-help]`, `data-state-version` is unchanged, and the footer `[data-power]` has no `data-holding`.
  8. **The help.** Back on the factory view (F1), press `?`: `[data-help]` is visible. Esc closes it.
- [ ] **Step 2: `phone.spec`** (390×844, `hasTouch`, `isMobile`).
  1. **The pointer is coarse.** `matchMedia("(pointer: coarse)").matches` is `true` (if it isn't, the spec fails here with that message, so K-16 isn't silently untested), and no `.key-hint` is visible.
  2. **The split bar's one-tap buy.** Wait for `[data-command] [data-run]` to be enabled, tap it, and `data-state-version` reaches `1`.
  3. **The why sheet's `open`.**
     - Tap `[data-why]`. `[data-next-buy]` has `aria-modal="true"`. Tap `[data-open-item]`.
     - The drawer sheet shows (`[data-drawer-host] [aria-modal="true"]`) for that item, and `[data-power] button[data-tap]` is inside `[inert]`.
     - Drag `[data-grip]` down 150 px with `page.mouse` (down, move in steps, up): the sheet closes.
  4. **The power tab's generator `+1`.** Tap the `~ power` tab, wait for `[data-generator-buy="biomass_burner"]` to be enabled (it becomes affordable over real time; use the measured wait, at most 120 s), tap it, and `data-state-version` advances.
  5. **The generator drawer sheet.** Tap `[data-open-generator="biomass_burner"]`. The sheet is modal and `expectNoOverflow` passes. Close with `x`.
  6. **The TAP on all four tabs.** For each bottom tab, `button[data-tap]` is visible. On `priority`, press and hold it (`page.mouse.down` on its box): `[data-power][data-holding]` appears, and `up` clears it.
  7. **A coarse tablet** (a second test at 820×1180, `hasTouch`). On the factory view with the drawer open, `expectNoOverflow` passes: every visible button is at least 44×44 (U-8d's 9a in a browser).
- [ ] **Step 3: `tap-hold`.** Add "a held `T` taps like the button":
  - `keyboard.down("t")` → the footer `[data-power]` gets `data-holding`, and a TAP POST is seen;
  - `keyboard.up("t")` → `data-holding` goes, and one more flush follows, as the button case asserts.
- [ ] **Step 4: Run the e2e locally in the foreground.** Run `pnpm --filter @manufactory/web e2e`. Every spec passes. Record each spec's time in the `ci.yml` comment. Debug a failure with `trace: retain-on-failure`, never with sleeps.
- [ ] **Step 5: Mutations, each undone by hand, with the e2e re-run for the one spec.**
  - Make `run()` also fire on a focused `[data-run]`: `keyboard.spec` step 2's one-POST count fails (it sees two).
  - Remove the coarse rule from `base.css`: `phone.spec` step 7 fails. Record the button it names.
- [ ] **Step 6: README.** The "In the client" paragraph gains:
  - the keyboard map in one sentence (Enter, Tab, `1`–`5`, F1–F3 or F/P/H, ↑/↓, → or Space, a held T, `?`);
  - the drawer's letter keys;
  - the generator drawers;
  - the modal phone sheet with its grip.
- [ ] **Step 7:** run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, then the e2e once more, all green. Commit: `Web: keyboard and phone e2e specs, a held T in tap-hold, and the README (UI-2)`.

---

## Spec-vs-code notes (for the reviewer)

1. **`keyboard.spec`'s "settings email field"** no longer exists. OAuth-only accounts (PR #30) removed every text field from Settings, so the typing check uses the handbook search (K-19).
2. **F-keys and the drawer.** U-7a closes the drawer on F1–F3. V-25 keeps the drawer in state when the Panels **tab** is clicked. Both stand: the keys close it and the click doesn't. `F3`/`H` still open the item's entry first (K-10).
3. **The card column says "F/P/H as global"** but "F1–F3 close the card". The spec's own test wants the pairs to agree, so all of them close the card (K-10).
4. **"Slider" is a typing role** in U-7a's ignore list, so `input[type=range]` (the priority reserve) counts as typing (K-2).
5. **Enter in the card.** U-7a says Enter is "buy N (the focused primary)", which is native. When focus has fallen to rest inside the card scope, Enter runs the bar's identical batch (K-21).
6. **The generator drawer's labels** reuse the panel's `power:<class>:buy`, so the two buttons are busy together. A `drawer:<item>:<verb>` label would mislead UI-3's log parser (K-12).
7. **`B` in another section.** U-5c's table makes `B` the MACHINES row's primary button. With another section showing there's no such button, so `B` does nothing, and its hint isn't on screen either (K-9).
8. **The 9a rewrite** can't measure boxes in jsdom. It pins the one coarse rule and bans small `min-*` outside fine-pointer blocks. `phone.spec`'s coarse-tablet case measures in Chromium (K-16).
9. **UI-1 deferrals closed here:**
   - V-9 (hints): Task 2;
   - V-10 (listbox keys, Enter): Task 2;
   - V-12 / V-19 (non-modal sheet): Task 6;
   - V-15 (`?` button): Task 3;
   - V-18 (`SPLIT`): Task 4;
   - V-21 (generator rows): Task 5;
   - the 9a rewrite and the segmented tabs (UI-1 Task 8): Task 4;
   - `tap-hold`'s held `T`: Task 7;
   - the ledger's listbox hint sentence: Task 2.
