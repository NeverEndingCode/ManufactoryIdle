# The UI redesign: retro terminal, Layout C

**Implements:** the direction the user settled through the mockups in
`.superpowers/mock/project/` (2026-10-26): the retro-terminal theme as the default, Layout C (the
command line), drawers, the keyboard map, the phone power tab with a floating TAP, and the first
"feel alive" features.
**Builds on:** `main` at dd4ab61 (Phase 4a–4c, plus post-launch PL-1 and PL-2), branch `ui-terminal`.
**Status:** design, 2026-10-27. This is a decision record in the Phase 4 style. Each design call is
a **Ruling** (U-n) with its reason and its cost if it's wrong. The Phase 4 rulings (W-1 to W-26,
with their errata) and the post-launch rulings stand unless a ruling here supersedes them. Each
supersession is named in the ruling and collected in the table at the end.

**Sources, in order of authority:**
1. The user's decisions, as recorded in the brief.
2. The chosen mockups: `CWhy`, `DrawerDesktop`, `PhoneMain`, `PhoneSheet`, `PhoneDrawer` and
   `PhonePower`. They give the exact colours, sizes and copy. `Delight` and `PhoneBoot` show the
   feel-alive ideas.
3. The theme mockups: `Terminal`, `Minimal`, `Cosy` and `Main`, for their palettes and type only.
4. The code.

`PhoneV2`, `LayoutA` and `LayoutB` are rejected. B's NEXT_BUY card look is kept, and it's the look
`CWhy` already draws. Note that `PhoneDrawer` was drawn over the rejected v2 phone. Only its sheet
is specced here, not what sits behind it.

---

## What exists, and what the redesign touches

Citations are to `dd4ab61`, under `apps/web/src/`.

- **The shell** (`ui/App.tsx`): the header (title, `TierReadout`, the save chip, Handbook,
  Settings), then `Notices` (the one polite live region), then the W-19 panes. `usePanes`
  (`ui/use-panes.ts`) returns 1, 2 or 3 from `(min-width: 600px)` and `(min-width: 1001px)`.
  At three panes the layout is lanes | detail | priority. At two it's a switch plus lanes,
  with detail beside them. At one there's a bottom tab bar (Factory · Priority · Handbook), and the
  power dock is fixed above it. `Footer` (W-25) sits inside the layout.
- **Lanes** come from content (`unlockedLanes`, `ui/derive.ts`). **Power is a real lane.** In the
  slice it's `{ id: power, order: 1, unlockTier: 0 }`, with the `biomass` item and the collector,
  burner and generator recipes (`packages/content/bundles/vertical-slice/lanes.yaml`). So today
  the tabs at tier 0 are `Iron · Power`, and `layout-320.spec.ts` pins exactly that.
- **Rows** (`ui/ItemRow.tsx`) are F.1's three-line row: name and rate; a storage bar (a CSS
  `scaleX` transition per snapshot, W-7); the QS and BOUND chips when they're non-zero; and a
  satisfaction meter that sweeps (S-14), or a split bar. Row height depends on its content.
- **The bottleneck** (`bottleneckRow`, `ui/derive.ts`, and `ui/BottleneckFrame.tsx`) wraps the
  one framed row in a frame. The frame holds the label "bottleneck", the advice text, and one
  button: a `SpendButton` (pessimistic, through `Guarded`, busy on `BOTTLENECK_BUY_LABEL`) or
  a `ReserveButton`. Framing a row makes it taller, and the rows below it move.
  A frameless bottleneck (`laneId === null`) is a notice line.
- **The drawer** (`ui/Drawer.tsx`) shows segmented tabs, Buy · Upgrade · Dismantle · Recipe ·
  Storage · Assign, over `drawerModel` (`ui/machines.ts`), `quote.ts`, `preview.ts` and
  `Projection.tsx`. It sits in the detail pane, or below 600 px in a non-modal bottom sheet.
- **Power** (`ui/PowerDock.tsx`, `ui/dock-model.ts`) shows the grid demand against supply, a note
  when power is short or limiting, the kick (stacks, multiplier, seconds left), and the holdable
  tap (pointer, plus a held Space or Enter on the button). **Generators can only be bought from
  the bottleneck frame.** The biomass drawer covers the collector, and no drawer covers
  `biomass_burner` or `coal_generator`.
- **Themes** (`ui/theme.ts`, `styles/tokens.css`) are System, Dark or Light, set as `data-theme`
  on `<html>` and stored in `mi.theme`. `main.tsx` applies the stored theme before the first
  render. The fonts are system stacks.
- **Tests:**
  - `styles/tokens.test.ts` enforces W-17 and W-18 over the CSS: only `transform` and `opacity`
    animate; motion only inside `prefers-reduced-motion: no-preference`; state colours only in
    state classes; the 8b token values; and the 44 px `segBtn`.
  - **No test checks contrast**, although W-20 says the token test does.
  - The e2e specs select on `[data-frame]`, `li[data-item]`, `[data-open-row]`,
    `[role=tab][data-lane]`, the "View" tablist, `[data-conveyor]`, `[data-dock]`,
    `button[data-tap]`, `[data-drawer]`, `[data-ladder]` and the footer's `[data-source-link]`.
- **Events the store already knows:** a tier-up (a `tier-up` toast notice, `sync/store.ts`), a
  bottleneck change (announced in `App.tsx`), and rejections. Nothing records purchases, storage
  filling, or rate history.

---

## Rulings

### U-1. Themes are token sets: retro terminal by default, three free Clean variants, two locked

**U-1a. The registry.** There are six themes, in one table in `ui/theme.ts`. CSS holds everything
visual. TypeScript holds only what CSS can't express: the copy voice, how names are shown, and the
lock.

| id | Name in settings | `color-scheme` | Voice | Item names | Effects | Lock |
|---|---|---|---|---|---|---|
| `terminal` | Retro terminal | dark | shell | `IRON_ORE` | glow, scanlines, typing | free, **default** |
| `clean-dark` | Clean (Dark) | dark | plain | `Iron Ore` | none | free |
| `clean-oled` | Clean (OLED Dark) | dark | plain | `Iron Ore` | none | free |
| `clean-light` | Clean (Light) | light | plain | `Iron Ore` | none | free |
| `cosy` | Cosy | light | plain | `Iron Ore` | none | `theme:cosy` |
| `industrial` | Industrial | dark | plain | `IRON ORE` | none | `theme:industrial` |

- **Every theme uses Layout C.** The Minimal, Cosy and Main mockups also drew an inline bottleneck
  frame and a priority sidebar. Only their palettes and type carry over.
- **The default is `terminal`,** whatever `prefers-color-scheme` says. W-17's "dark default,
  light by preference" is superseded.

*Why:* the user chose a terminal-first identity. Clean is the accessible, plain alternative, and
the two prestige themes are cosmetic rewards. One layout across six themes is one set of tests.

*Cost if wrong:* a theme that wants its own layout would need a component fork. Token sets can't
give it one.

**U-1b. One semantic token set; one block per theme.** `styles/tokens.css` defines `:root`
(terminal) and `:root[data-theme="<id>"]` for each of the others. Components read only the tokens
below, never raw colours.

| Token | Use |
|---|---|
| `--bg` | the page |
| `--s1` | the drawer panel |
| `--s2` | the NEXT_BUY card and sheet |
| `--s-hi` | the selected row, and the active lane or bottom tab |
| `--line` | box borders |
| `--line-soft` | row dividers |
| `--rule` | the divider style: `dashed` or `solid` |
| `--t1` | item names and titles |
| `--t-body` | body text |
| `--t2` | secondary text |
| `--t3` | column headers and section labels |
| `--accent` / `--on-accent` | the TAP, the active nav button, drawer buy buttons |
| `--advice` | command-bar and card borders and text |
| `--advice-dim` | hints, and the card's detail lines |
| `--advice-hi` | the card's action line |
| `--advice-fill` / `--on-advice-fill` | `[ENTER] run`, `[ buy N ]` |
| `--rate-up` / `--rate-down` | the sign of a net rate |
| `--state-fed`, `--state-throttled`, `--state-bottleneck`, `--state-paused` | W-17's four state colours, still used only by state classes (test 8a) |
| `--scrim` | the backdrop behind a sheet |
| `--font-ui`, `--font-mono`, `--font-display` | the three faces |
| `--fs-body`, `--fs-small`, `--fs-label`, `--fs-title`, `--fs-bar` | sizes per breakpoint (U-2) |
| `--radius`, `--radius-pill` | 0 in terminal |
| `--bar-h`, `--bar-seg`, `--bar-open`, `--bar-close` | the bar style (U-3d) |
| `--glow-text`, `--glow-title`, `--glow-advice`, `--glow-banner`, `--glow-tap` | text and box shadows; `none` outside terminal (U-9c) |
| `--scanlines` | a background image, or `none` |

W-17's single `--fs-1/2/3` scale and its "no shadows or gradients" rule are superseded. The glow
and the scanlines are shadows and gradients, and they're confined to these tokens.

**U-1c. Terminal tokens, exact from `CWhy`, `DrawerDesktop` and `Phone*`.**

| Token | Value | Token | Value |
|---|---|---|---|
| `--bg` | `#050a06` | `--advice` | `#ffb000` |
| `--s1` | `#071009` | `--advice-dim` | `#c98c00` |
| `--s2` | `#0b1208` | `--advice-hi` | `#ffd166` |
| `--s-hi` | `#0b1a0e` | `--advice-line` (the sheet close border) | `#5a4206` |
| `--line` | `#1f6b30` | `--advice-fill` / `--on-advice-fill` | `#ffb000` / `#050a06` |
| `--line-soft` | `#123d1c` | `--rate-up` | `#4ee06c` |
| `--rule` | `dashed` | `--rate-down` | `#ff6b5a` |
| `--t1` | `#7dff9a` | `--state-fed` | `#4ee06c` |
| `--t-body` | `#4ee06c` | `--state-throttled` | `#d9c34a` (Terminal's 72% entry) |
| `--t2` | `#3fb85a` | `--state-bottleneck` | `#ffb000` |
| `--t3` | `#2a8c42` | `--state-paused` | `#2a8c42` |
| `--accent` / `--on-accent` | `#4ee06c` / `#050a06` | `--scrim` | `rgba(0,0,0,.55)` |
| link / hover | `#7dff9a` / `#c8ffd4` | `--radius` | `0` |

Faces: `--font-display: VT323`; `--font-ui` and `--font-mono: "IBM Plex Mono"`, weights 400 and 500.

Effects:
- `--glow-text: 0 0 5px rgba(78,224,108,.35)`
- `--glow-title: 0 0 8px rgba(125,255,154,.6)`, or `0 0 6px rgba(78,224,108,.45)` below 600 px
- `--glow-advice: 0 0 6px rgba(255,176,0,.45)`
- `--glow-banner: 0 0 8px rgba(255,209,102,.6)`
- `--glow-tap: 0 0 0 1px #4ee06c, 0 0 12px rgba(78,224,108,.45)`
- `--scanlines: repeating-linear-gradient(0deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px)`

**U-1d. Clean, derived from `Minimal`.** All three use Inter for the UI and JetBrains Mono for
names and numbers, with `--rule: solid`, `--radius: 8px`, and solid 3 px bars on a rounded track
(Minimal's look). Values in **bold** are changed from the mockup to pass AA (U-1f).

| Token | Clean (Light) | Clean (Dark) | Clean (OLED Dark) |
|---|---|---|---|
| `--bg` | `#ffffff` | `#18181b` | `#000000` |
| `--s1` | `#ffffff` | `#1f1f23` | `#0a0a0a` |
| `--s2` | `#f4f4f5` | `#27272a` | `#141416` |
| `--s-hi` | `#f4f4f5` | `#27272a` | `#141416` |
| `--line` | `#e4e4e7` | `#3f3f46` | `#27272a` |
| `--line-soft` | `#f4f4f5` | `#27272a` | `#141416` |
| `--t1` / `--t-body` | `#18181b` | `#fafafa` / `#e4e4e7` | same as Dark |
| `--t2` | `#52525b` | `#d4d4d8` | same as Dark |
| `--t3` | **`#68686f`** (Minimal's `#71717a` is 4.40 on `#f4f4f5`) | `#a1a1aa` | same as Dark |
| `--accent` / `--on-accent` | `#18181b` / `#ffffff` (Minimal's Tap and Save) | `#fafafa` / `#18181b` | same as Dark |
| `--advice` | `#c2410c` | `#fb923c` | same as Dark |
| `--advice-fill` / on | `#1d4ed8` / `#ffffff` (Minimal's buy button) | `#60a5fa` / `#18181b` | same as Dark |
| `--rate-up` / `--state-fed` | `#15803d` | `#4ade80` | same as Dark |
| `--rate-down` | **`#b91c1c`** (Minimal reused the bottleneck orange) | `#f87171` | same as Dark |
| `--state-throttled` | **`#975f05`** (Minimal's `#a16207` is 4.48 on `#f4f4f5`) | `#facc15` | same as Dark |
| `--state-bottleneck` | `#c2410c` | `#fb923c` | same as Dark |
| `--state-paused` | **`#68686f`** | `#a1a1aa` | same as Dark |
| `--scrim` | `rgba(24,24,27,.4)` | `rgba(0,0,0,.6)` | `rgba(0,0,0,.7)` |

**U-1e. Cosy and Industrial, from their mockups. Registered and locked.**
- **Cosy:**
  - Faces: Nunito for the UI, Fraunces 600/700 for display, JetBrains Mono for names and numbers.
  - Values:
    - `--bg #f5ede1`, `--s1 #fffaf2`, `--s2 #f1e3cf`, `--s-hi #fff3ea`
    - `--line #ead9c2`, `--line-soft #ead9c2`
    - `--t1 #3b2f26`, `--t2 #6b5848`, `--t3` **`#72604d`** (the mockup's `#a08a74` is 2.83)
    - `--accent #5b7a4f` on `#fffaf2`
    - `--advice` **`#9c4226`**, with the hot row's `#e8a585` as its border tint
    - `--advice-fill` **`#a8482a`** on `#fffaf2` (the mockup's `#c8643b` button is 3.78)
    - `--rate-up` and `--state-fed`: `#4e6b43`
    - `--rate-down` and `--state-bottleneck`: **`#9c4226`**
    - `--state-throttled` **`#7e560e`**, `--state-paused #72604d`
  - Shape: `--radius 18px`, `--radius-pill 999px`, 10 px bars on rounded tracks, solid rules.
- **Industrial (from `Main`):**
  - Faces: Oswald 500–700 for display (uppercase, 2 px tracking), IBM Plex Mono 400/500/600 for
    the UI and names.
  - Values:
    - `--bg #17191b`, `--s1 #1f2225`, `--s2 #23272a`, `--s-hi #241b18`
    - `--line #2b2e31` (`#33373b` on bar tracks)
    - `--t1 #f2f0ea`, `--t-body #d6d3cc`, `--t2 #d6d3cc`, `--t3 #9a968d`
    - `--accent #f2a900` on `#17191b`
    - `--advice` **`#ef6a4c`** (the mockup's `#e04f2f` is 4.47 on `#17191b`)
    - `--advice-fill #f2a900` on `#17191b`
    - `--rate-up` and `--state-fed`: `#8fc27a`
    - `--rate-down` and `--state-bottleneck`: **`#ef6a4c`**
    - `--state-throttled #f2a900`, `--state-paused` **`#969288`** (the mockup's `#6f6b64` is 3.33)
  - Shape: `--radius 0`, 10 px bars with a `#0f1112` track. A 3 px `--accent` rule under the
    header, and the hazard stripe beside the title.

**U-1f. Contrast: WCAG AA in every theme, checked by a test.**
- **The thresholds.** Every text and background pair the CSS uses must reach 4.5:1, or 3:1 for
  text at least 24 px (or 18.66 px bold) and for the non-text fills of meters and bars
  (WCAG 1.4.11).
- **The test.** `styles/contrast.test.ts` (new) parses each theme block in `tokens.css` and
  checks a declared pair table. For each theme it checks `--t1`, `--t-body`, `--t2`, `--t3`,
  `--advice*`, `--rate-*` and `--state-*` on `--bg`, `--s1`, `--s2` and `--s-hi`, plus each
  `on-*` on its fill. The table also records the pairs that are not allowed. It finally does what
  W-20 claimed and never did.
- **The mockup values that fail** are adjusted (shown in bold above), or barred from a surface:
  - Terminal `--t3 #2a8c42` measures 4.68 on `--bg` and 4.53 on `--s1`, but **4.22 on `--s-hi`
    and 4.46 on `--s2`.** So no `--t3` text sits on the selected row, an active tab, or the
    card. Those surfaces use `--t2`, which is at least 7.0, and the test enforces it.
  - Minimal's `#a1a1aa` (2.56) isn't used anywhere.
- **Measured (`--bg`):**
  - terminal: `t1` 15.8, `t-body` 11.6, `t2` 7.8, `t3` 4.7, `advice` 10.9, `advice-dim` 6.9,
    `rate-down` 7.1, `throttled` 11.3
  - the black on green and on amber fills: 11.6 and 10.9
- **Borders.** `--line` against `--bg` is 3.0:1 in terminal. Box borders are decoration, because
  each control carries a text label, so 1.4.11 doesn't apply to them.
- **The scanlines** are painted under the content (U-9c), never over it, so they can't lower text
  contrast. In the mockups the overlay sits on top.

*Cost if wrong:* a pair that's missed from the table can pass with poor contrast. The table is
derived from the CSS modules' `var()` uses, so a new pairing fails the test until it's declared.

**U-1g. Fonts are self-hosted, OFL-licensed, and loaded only by the theme that uses them.**
- **The files.** VT323, IBM Plex Mono, Inter, JetBrains Mono, Nunito, Fraunces and Oswald. Each
  ships as a latin-subset `woff2` under `src/styles/fonts/`, with its `OFL.txt`, through
  `@font-face` with `font-display: swap`. Vite hashes them. A browser fetches a face only when
  rendered text uses it, so a terminal player downloads only VT323 and Plex Mono.
- **`index.html` preloads** VT323 and Plex Mono 400 (the default), so the first paint isn't a
  fallback flash.
- **No Google Fonts link.** W-2's one origin keeps third-party requests out.
- **Licences.** OFL fonts may be bundled with GPL software (W-25), and each keeps its own licence
  file.
- **A glyph test.** The bars draw `[` and `]` in VT323, and the sparklines draw `▁▂▃▄▅▆▇█` in
  Plex Mono, so a unit test reads the font files' cmap and checks those glyphs are present
  (U-9b).

*Cost if wrong:* about 30–60 KB per theme. A missing glyph falls back to the system monospace,
and the test catches that.

**U-1h. Names are always mono. Each theme decides the casing.**
- **Item names**, in `--font-mono`:
  - terminal: `item.id.toUpperCase()` → `IRON_ORE`
  - Clean and Cosy: the content `name` → `Iron Ore`
  - Industrial: `name.toUpperCase()` → `IRON ORE`, at weight 600
- **Machines follow the same rule:** `CONSTRUCTOR_MK1` (class id and mark) in terminal,
  `Constructor Mk.1` (the mark's content name) in the plain themes, and `CONSTRUCTOR MK.1` in
  Industrial.
- **One helper** does this: `itemLabel(s, itemId, theme)` / `machineLabel(…)` in a new
  `ui/names.ts`.
- **Screen readers** always get the content name, through `aria-label` where the visible text is
  an id, so they don't read `IRON_ORE` aloud.
- **The departures:**
  - The Minimal, Cosy and Main mockups set names in Inter, Nunito and Oswald. The user's "always
    mono" rule overrides them.
  - The plain themes use the content's Title Case (`Iron Plate`) rather than Minimal's sentence
    case (`Iron plate`), so as not to invent names.

**U-1i. The switcher, persistence and the lock.**
- **The switcher.** The settings sheet's Theme fieldset becomes a radio list of the six themes.
  Each entry has a three-chip swatch (`--bg`, `--t-body`, `--advice`), drawn from the registry,
  not by applying the theme.
- **A CRT effects checkbox** sits below the list ("Glow and scanlines", on by default, only
  enabled in terminal). It's stored as `mi.crt`.
- **The About section** (U-2e) moves into the same sheet.
- **Persistence.** `mi.theme` is per device, in `localStorage`, behind the existing
  `try`/`catch`. It's applied in `main.tsx` before the first render, as today, and it also sets
  `<meta name="theme-color">` to `--bg`. Old values migrate when read:

  | Old value | New value |
  |---|---|
  | `dark` | `clean-dark` |
  | `light` | `clean-light` |
  | `system`, or missing | `terminal` |

  An unknown value becomes `terminal`.
- **The capability flag.** `ui/capabilities.ts` (new) exports
  `type Capability = "theme:cosy" | "theme:industrial"` and
  `capabilities(view: StoreView): ReadonlySet<Capability>`, which returns the empty set today.
  Spec 2's prestige store will fill it from the world or account state, and nothing else needs
  to change.
  - `applyTheme` takes the set. A stored locked theme without its capability renders as
    `terminal`, and the stored value is kept, so a grant restores it.
  - A development build also honours `?theme=<id>` regardless of the lock
    (`import.meta.env.DEV` only), so the locked themes can be reviewed.
- **The locked state's UI.** A locked theme stays in the list as a radio with
  `aria-disabled="true"`. It's still focusable and announced, and selecting it does nothing. It
  shows a `locked` tag and the line "Unlocks in the prestige store", linked to nothing until
  Spec 2. The swatch is shown at 60% opacity. The radio's accessible description is the same
  line.

*Why:* the store doesn't exist yet. Shipping the tokens now means Spec 2 only adds the grant, and
the contrast test already covers the locked sets.

*Cost if wrong:* a player who explicitly chose "System" on a light OS lands on the dark terminal
once, and has to pick Clean (Light). That's one setting, and nothing is lost.

### U-2. The shell: Layout C at each W-19 breakpoint

**U-2a. The breakpoints are W-19's widths. The panes are superseded.**
- `usePanes` becomes `useLayoutMode()`, which returns `"phone" | "tablet" | "desktop"` from the
  same two media queries. `data-layout` replaces `data-panes`.
- W-19's three-pane layout (lanes | detail | priority) is gone. The priority list is a view
  (`F2`), and the drawer is an overlay (U-5), not a column. W-19's reason for the third pane, "a
  reorder updates the split bars in view", is answered by the priority list's own live
  satisfaction (W-1 item 3). Split bars move to the drawer (U-3c).
- **No horizontal scrolling at any width** (W-19 stands).
- **The app is a viewport shell:** `height: 100dvh` (`100vh` as the fallback), a flex column,
  `overflow: hidden`. Only the main box scrolls, so the header, tabs, command bar and footer
  never move.

**U-2b. Desktop (> 1000 px), from `CWhy`, `DrawerDesktop` and `Delight`.** The shell has
`padding: 16px 22px` and `gap: 10px`. Every box has a `1px solid var(--line)` border.

| Block | Structure and dimensions |
|---|---|
| **Header** | `padding: 8px 14px`, `gap: 20px`. The title `MANUFACTORY_` in `--font-display` 34 px `--t1` (`line-height: 1`, the glow). The tier readout in 13 px `--t2`: `[TIER 3] next: ROTOR 214/500 · MODULAR_FRAME 38/120`. A spacer. The save chip `> save_factory` (36 px, `--t1` on an `--accent` border; S-12's conditions are unchanged). The `Panels` nav: `F1 factory`, `F2 priority`, `F3 handbook`, each 36 px tall, `padding: 0 12px`, 13 px. The active one is `--accent` filled with `--on-accent` text; the rest are `--bg` with `--t2` text and a `--line` border. Then `?` (help, 36×44) and `cfg` (settings, 36 px). |
| **Lane tabs** | `nav[aria-label=Lanes]` (still `role=tablist`), `gap: 4px`. Each tab is 34 px, `padding: 0 14px`, 13 px: `● 1 IRON` plus ` !` on the bottleneck's lane (U-3e). The production lanes come first in content order, then `5 POWER` last (U-6a). The active tab has `--s-hi` fill, `--t1` text and an `--accent` border (`Delight`'s style, so the light stays visible). Inactive tabs are `--bg`, `--t2`, `--line`. |
| **Main box** | `flex: 1`, `min-height: 0`, `padding: 6px 12px`, `position: relative`, scrolling on its own. A 30 px column header in 12 px `--t3`, with a `1px var(--rule) var(--line)` bottom. Then the rows (U-3). The NEXT_BUY card (U-4c) and the drawer (U-5a) are positioned inside this box. |
| **Factory log** (PR 3) | 96 px, `padding: 6px 12px`, 12 px `--t2`, between the main box and the command bar (U-9a). |
| **Command bar** | 54 px, with an `--advice` border (U-4a). |
| **Footer** | `padding: 8px 14px`, `gap: 20px`. `PWR` in `--t1`. The power bar in `--font-display` 22 px, `flex: 1`: `[█…░] 412/450 MW`. `KICK x1.35 · 7 STK · 21s` in 12 px `--t2`. Then the `[T] TAP` button: 48 px, `padding: 0 18px`, `--accent` fill, `--font-display` 28 px (U-6c). |

**U-2c. Tablet (600–1000 px).** The tablet uses the desktop chrome (`desktop` and `tablet` share
one component tree), with these changes:
- the shell has `padding: 12px 16px`, and the title is 28 px;
- the tier readout ellipsizes, and its full text is the element's `title`;
- the row columns follow U-3b's container queries, so MACHINES and TREND drop out;
- the drawer's width is `clamp(360px, 100% − 300px, 560px)` (U-5a);
- the NEXT_BUY card is `min(420px, 100% − 24px)` wide.

A touch tablet gets the coarse-pointer sizes (U-8d).

**U-2d. Phone (< 600 px), from `PhoneMain`.** The shell has `padding: 12px 12px 0` and
`gap: 8px`, with a 13 px body.

| Block | Structure and dimensions |
|---|---|
| **Header** | `padding: 6px 10px`, `justify-content: space-between`. The title is the current tab's name in `--font-display` 28 px with the glow: `MANUFACTORY_` (factory), `POWER_GRID` (power), `PRIORITY.CFG` (priority) or `HANDBOOK` (handbook); plain-voice themes use `Factory`, `Power`, `Priority` and `Handbook`. On the right, in 12 px `--t2` over two lines: `[TIER 3] ROTOR 214/500` (the requirement furthest from done) and `PWR 412/450 MW`, or `412 / 450 MW` and `91% load` on the power tab. Then a 44×44 `≡` button (settings; not in the mockup, see U-2e). |
| **Lane tabs** | Factory tab only. `display: grid`, `grid-template-columns: repeat(4, minmax(0, 1fr))`, `gap: 4px`; a fifth production lane wraps to a second row. Each tab is 44 px, `padding: 0 4px`, 12 px: `● IRON`. The light shows the lane's status; on the bottleneck's lane the light is replaced by an `--advice` `!` (U-3e). The active tab has `--s-hi` fill, `--t1` text and an `--accent` border. |
| **Main box** | `flex: 1`, `padding: 2px 10px`, `--line` border, scrolling, `scroll-padding-bottom: 96px` so the last row can scroll clear of the floating TAP. Rows are 54 px (U-3b). |
| **Log ticker** (PR 3) | 24 px, the newest log line, opening the log sheet (U-9a). |
| **Command bar** | Factory tab only. 44 px, split (U-4b). |
| **Floating TAP** | 68×76, `position: absolute`, `right: 14px` (U-6c). |
| **Bottom tabs** | `nav[aria-label=Panels]`, `role=tablist`, `grid-template-columns: repeat(4, minmax(0, 1fr))`, `border-top: 1px solid var(--line)`, `margin: 0 -12px` (full bleed), `padding-bottom: env(safe-area-inset-bottom)`. The tabs are `factory · ~ power · priority · handbook`, each 52 px, 12 px, with `border-left: 1px solid var(--line)`. The active tab has `--s-hi` fill and `--t1` text; the rest are `--bg` and `--t2`. Power gets ` !` when the bottleneck is in the power lane. |

The existing one-pane layout (`.tabbar`, the fixed `.dock`, `--dock-h` and its `ResizeObserver`,
and `--sheet-max`) is superseded and removed.

**U-2e. Chrome the mockups leave out.**
- **Settings.** `cfg` on desktop (`Settings` in the plain voice), `≡` on the phone. Both open the
  existing sheet (S-11).
- **The save chip.** On the phone it's the first notice line (`> save_factory: keep this factory
  on any device`, with a `save` button), not a header chip. S-12's conditions are unchanged.
- **Notices** stop pushing the layout down. The region element is permanent (W-20). Its visible
  list is an overlay, anchored to the bottom of the main box, full width, at most two items, and
  stacked above any card. Rows stay where they are.
- **The GPL notice (W-25)** moves from the footer to an About section in the settings sheet, and
  to a line at the end of the `?` overlay. GPLv3 §0's "Appropriate Legal Notices" accepts a
  prominent menu item, and the footer row is now the power bar. The links and their
  `data-source-link` / `data-license-link` attributes are unchanged.

### U-3. Rows never move

**U-3a. Fixed geometry.**
- **Heights.** A row is exactly `--row-h` tall: 44 px on desktop and tablet, 54 px on the phone.
  A pinned `height` and `overflow: hidden`, never `min-height`.
- **Nothing in a row** changes its box: not the bottleneck, not selection, not an open drawer, a
  pending buy, a chip, a split, or a long name.
- **Text.** Every cell is single-line, ellipsized, and fixed-width or `flex`.
- **State is paint only:**
  - the bottleneck changes colour classes and one glyph;
  - the selected row adds `background: var(--s-hi)` and `box-shadow: inset 3px 0 0 var(--accent)`
    (`DrawerDesktop`);
  - the focus ring is `outline: 2px solid var(--accent)` with `outline-offset: -2px`.
- **A test pins the DOM.** In `RowList.test.tsx`, the framed row and an unframed row have the same
  element structure; only classes and text differ. The CSS test checks that the row rule has a
  fixed `height` and no `min-height` or `height: auto` anywhere it can be reached.

*Why:* the user's rule. A framed row that grows makes the rows below jump whenever the bottleneck
moves, and that's the moment the player is reading them.

*Cost if wrong:* information that needs a taller row has to live in the drawer, which is what
U-3c does.

**U-3b. Columns.** On desktop and tablet a row is a single line, `gap: 14px`, 14 px (the
gutter and stock columns are at 12 px). The row list is a size container (`container: rows / inline-size`), and
columns drop out by container width, not viewport width. W-19's viewport-only rule still holds
for the shell.

| Column | Width | Content | Shown |
|---|---|---|---|
| gutter | 16 | `!` in `--state-bottleneck`, else empty | always |
| ITEM | 170 (150 under 700 px) | the name (U-1h), `--t1`; bottleneck: `--state-bottleneck` | always |
| RATE | 100 (90) | `+48.0/s` via `rateText`, `--rate-up` or `--rate-down` | always |
| SAT | 48 | empty when fed (≥ 98%); `72%` in `--state-throttled`; `paused`; `—` when idle (`stateClass`) | always |
| TREND (PR 3) | 120 | the sparkline (U-9b) | container ≥ 1100 px |
| MACHINES | 210 (190) | 12 px `--t2`: `CONSTRUCTOR_MK1 x20` for one mark, `CONSTRUCTOR x20 (2 marks)` for several, `—` for none, plus ` · split` on a contested item | container ≥ 900 px |
| STORAGE | `flex: 1`, min 64 | the storage bar (U-3d) | always |
| STOCK | 130 (110), right-aligned | live stock `/` cap, 4 Hz, `--t2` (W-7) | always |

On the phone a row is two lines in 54 px, `gap: 2px`:
- **Line 1:** gutter (10 px), name (`flex: 1`), rate.
- **Line 2:** `padding-left: 18px`, then the bar (`flex: 1`, `--fs-bar` 17 px, 16 cells),
  SAT (11 px), and stock (11 px `--t2`).

The column header row uses the same widths: `ITEM RATE SAT [LAST 10 MIN] MACHINES STORAGE STOCK`
in 12 px `--t3`. The phone has no column header (`PhoneMain`).

**U-3c. What leaves the row, and where it goes.** This supersedes W-1 item 1's three-line row, and
F.1's chips "in the row".

| Was in the row | Now |
|---|---|
| The satisfaction meter and its sweep (S-14) | The SAT cell's text. The sweep is retired (U-8c). |
| The split bar (§13.1) | A `SPLIT` section in the drawer, with the same percentages and labels. Its rows are buttons to the item's priority entry, as `onSplit` does today. The row's MACHINES cell carries ` · split`. |
| The QS and BOUND chips | The drawer's header meta: `IRON lane · +0.4/s · 214/2.0k · QS 40.0k · BOUND 12`, shown only when non-zero. Affordability already counts `bound` (W-13). |
| The open-row button (`[data-open-row]`) | The row itself, as a listbox option (U-7d). |
| The bottleneck frame (P-2, P-3) | The command bar (U-4). |

*Cost if wrong:* QS and BOUND are one tap away instead of glanceable. A 48 px FLAGS column fits
the desktop container if players miss them.

**U-3d. Bars: one DOM, styled per theme, drawn by the compositor.**
- **One `Bar` component** draws every storage bar and the power bar. It's a `role=meter` element
  (W-20's `aria-valuenow` per snapshot) with a track and a fill.
- **Terminal** draws a segmented bar. The track and the fill are each a
  `repeating-linear-gradient(90deg, currentColor 0 calc(var(--bar-seg) − 2px), transparent 0 var(--bar-seg))`,
  with `--bar-seg: 1ch` of `--font-display` at `--fs-bar` (20 px on desktop, 17 px on the
  phone). The track is at 25% opacity, standing in for `░`, and the fill stands in for `█`.
  `::before` and `::after` draw `var(--bar-open)` and `var(--bar-close)`, which are `"["` and
  `"]"`.
- **The other themes** set `--bar-seg: 0`, which makes the fill solid, and set the brackets to `""`,
  `--bar-h` to 3 px (Clean) or 10 px (Cosy and Industrial), and use `--radius-pill` on the track.
- **The fill is revealed, not scaled.** `scaleX` would squash the segments. The fill sits inside a
  clip wrapper. The wrapper gets `transform: translateX((f − 1) × 100%)`, and the fill inside it
  gets `translateX((1 − f) × 100%)`. The two transitions have the same duration and timing, so the
  segments stay still while the edge moves. This keeps W-7's one compositor transition per
  snapshot (now two transforms on two elements), and the 7a test still holds. Under reduced
  motion, the 4 Hz tick steps both transforms, as `StorageBar` does today.
- **Colour.**
  - a normal row: `--t2`;
  - the bottleneck: `--state-bottleneck`, through a state class (test 8a);
  - a power bar that's short or limiting: `--state-bottleneck`, otherwise `--t-body`.

*Cost if wrong:* a literal `█░` string would be easier to copy-paste, but it would re-render at
4 Hz and step instead of gliding. The meter's value is what assistive technology reads anyway.

**U-3e. The bottleneck mark, the lane lights, and locked lanes.**
- **The bottleneck row** (`bottleneckRow`, unchanged, at most one in the factory, errata P-2)
  shows:
  - `!` in the gutter, pulsing (W-18's `--pulse-cycle`, now on the glyph);
  - the name in `--state-bottleneck`;
  - the bar in `--state-bottleneck`;
  - and a text alternative: the option's label ends with ", bottleneck" (U-8b).
- **Its lane tab** shows ` !` after the name on desktop, and an `!` in place of the light on the
  phone. That `!` is `aria-hidden`; the tab's `aria-label` is "Iron, bottleneck".
- **Lane lights** come from a new `laneStatus(s, laneId)` in `ui/derive.ts`, the first match of:

  | Status | When | Colour |
  |---|---|---|
  | `bottleneck` | the bottleneck is in this lane | `--state-bottleneck` |
  | `throttled` | any row is below 98% satisfaction | `--state-throttled` |
  | `idle` | nothing is produced | `--state-paused` |
  | `fed` | otherwise | `--state-fed` |

  The status is also in the tab's `aria-label`, so colour is never the only signal (W-20).
- **Locked production lanes** are drawn as tabs too: `aria-disabled`, skipped by the tablist's
  arrow keys, with a `T6` tag in place of the light and the label "Oil, unlocks at tier 6". So
  the tab row and the `1–4` keys never shift as tiers unlock.
  - This is the call on `CWhy` showing OIL at tier 3, although oil unlocks at tier 6. Showing the
    name earlier is a small spoiler.
  - Today, locked lanes aren't shown (`unlockedLanes`).
- **A frameless bottleneck** (`laneId === null`) is no longer a notice line (P-2's fallback). It's
  the command bar's comment line (U-4a).

### U-4. The command line: the recommended buy has one home

**U-4a. The desktop command bar** (`ui/CommandBar.tsx`, new; `CWhy`). It is
`section[aria-label="Command line"]`: 54 px, with a `1px solid var(--advice)` border,
`padding: 0 8px 0 14px`, `gap: 14px`, and `--advice` text with `--glow-advice`. From left to right:
1. The prompt `operator@manufactory:~$` in `--t1`. The plain voice shows `Next`.
2. The command, in 14 px `--advice`. It's typed out (U-9e).
3. A 10×20 block cursor in `--advice`. It blinks in `steps(1)` opacity, under no-preference only.
4. A spacer.
5. `[TAB] why`: a real `<button>` styled as 12 px `--advice-dim` text, at least 36 px tall. It
   opens the card, so a mouse can reach it too.
6. `[ENTER] run`: 40 px, `padding: 0 14px`, `--advice-fill` and `--on-advice-fill`, 13 px, weight 500.

**The command grammar** (shell voice; `commandText(model, s, voice)` in `ui/command.ts`, new). The
plain voice is in brackets.

| `FrameAction` | Shell | Phone short form | Run label |
|---|---|---|---|
| `BUY_MACHINE` | `buy 4 constructor_mk1 --lane iron --for rotor` (`--for` is the bottleneck's item) [`Buy 4 Constructor Mk.1 for Rotor`] | `4 constructor → ROTOR` | `[ENTER] run` / `[ buy 4 ]` [`Buy 4`] |
| `BUY_STORAGE` | `storage +1 iron_plate` | `storage → IRON_PLATE` | `[ store ]` |
| `BUY_QS` | `qs +1 --lane iron` | `qs → IRON` | `[ qs ]` |
| `SET_RESERVE` | `reserve screw 30%` | `reserve 30% → SCREW` | `[ reserve ]` |
| `null`, with advice | `# power is short, limiting rotor. build a generator.` (`model.text`, lower-cased, as a comment) | the same, truncated | hidden on desktop; on the phone, an `aria-disabled` button reading `—` |
| no bottleneck | `# all lines fed` [`Everything is running`] | the same | hidden on desktop; on the phone, an `aria-disabled` button reading `—` |

**The run button's states.** These come from the frame's existing logic, moved, not rewritten:
`SpendButton`, `ReserveButton`, `affordability` and `BOTTLENECK_BUY_LABEL`.
- **Busy:** `aria-busy`, and the label `[ENTER] running…`.
- **Unaffordable:** `affordable in 12s` or `not affordable yet`, on the 4 Hz tick.
- **Off** in either case: `Guarded`, so it stays focusable.
- **The reserve** is a setting (W-13), never busy, and guarded against a double send.
- **Pressing it, or Enter (U-7a),** sends exactly the batch the frame sent.
- **Shown on every view** (factory, priority, handbook, power), so Enter runs the advice anywhere.

**The data.** `bottleneckRow(s)` (exists) gives the model. The command text, the short form and
the run label are a pure function of the model plus the snapshot. Nothing new reaches the store.

*Supersedes:* W-1 item 1's "exactly one bottleneck frame per lane", errata P-2's frame, P-3's
inline buy in the row, and W-18's "bottleneck legible from its frame colour and its label".
`BottleneckFrame.tsx` and its CSS module are deleted.

**U-4b. The phone's split bar** (`PhoneMain`).
- **Layout.** 44 px, `display: flex`, `gap: 6px`, two buttons:
  - **Left, "why":** `flex: 1`, `--advice` border, `--bg` fill, `padding: 0 10px`, 13 px. It shows
    `$` in `--t1`, the short form (single line, ellipsized), and `why ▴` in `--advice-dim`. Its
    `aria-label` is "Why: next buy is 4 Constructor for Rotor. Open details" (content names, not
    ids). It opens the NEXT_BUY sheet.
  - **Right:** 96 px, `--advice-fill`, 14 px, weight 500: `[ buy 4 ]`. One tap runs the advice,
    with the same states as U-4a. Unaffordable reads `[ 12s ]`, and the accessible name is
    "Buy 4 Constructors, affordable in 12 seconds".
- **Shown on the factory tab only.** `PhonePower` has no command bar, and the priority and
  handbook tabs need their room.

**U-4c. The NEXT_BUY card (desktop) and sheet (phone).** One model, two presentations.
- **The model** is `nextBuyModel(s, model, now)` in `ui/command.ts`, computed only while the
  card or sheet is open:
  - **action:** `+4 CONSTRUCTOR_MK1 → ROTOR` (`--advice-hi`);
  - **why** (a template per bottleneck kind):
    - recipe: `ROTOR limits MODULAR_FRAME`, the framed item and `limitingTarget`;
    - power: `power limits ROTOR`;
    - storage: `IRON_PLATE is full, limiting ROTOR`;
    - reserve: `SCREW never banks, limiting ROTOR`;
  - **lane** (sheet only): `IRON`;
  - **cost:** `160 IRON_PLATE (have 3.2k)`, from `quote()`, with `have` as the live stock plus
    `bound` on the 4 Hz tick;
  - **effect:**
    - machines: `ROTOR +0.4 → +1.2/s`, from `preview.ts`'s projection (`apply` + `scheduleDetail`,
      W-13) at count N, with the projection for 1 computed lazily on focus or hover of `buy 1`;
    - storage: `IRON_PLATE cap 10.0k → 15.0k`;
    - QS: `IRON quantum +1 level`;
    - reserve: `SCREW keeps 30% in stock`.

  A preview costs about 2 ms (W-8), and only an open card pays it.
- **The desktop card** (`CWhy`): `section[role=dialog][aria-modal=false][aria-labelledby]`.
  - **Position:** `position: absolute`, `left: 12px`, `bottom: 8px` inside the main box,
    `width: 420px`.
  - **Box:** `--s2` fill, `1px solid var(--advice)` border, `box-shadow: 0 0 0 4px var(--bg)`,
    `padding: 12px 14px`, `gap: 8px`.
  - **Head:** `NEXT_BUY` in `--font-display` 26 px `--advice`, and `[ESC] close` in 12 px
    `--advice-dim`.
  - **Action:** 15 px.
  - **Detail lines:** 12 px `--advice-dim`, `line-height: 1.7`.
  - **Buttons** (40 px): `[ENTER] buy 4` (`flex: 1`, `--advice-fill`) and `[1] buy 1` (outlined,
    border `--advice-dim`). `buy 1` exists only for a `BUY_MACHINE` with a count above 1.
  - **Lifetime:** it stays open after a buy and re-renders the next advice, so Enter, Enter
    chains. Esc, or focus leaving it, closes it (U-7c).
- **The phone sheet** (`PhoneSheet`): `role=dialog`, `aria-modal=true`, over a `--scrim`
  backdrop, with the background inert (as S-11 does).
  - **Box:** pinned to the bottom, `--s2` fill, `border-top: 2px solid var(--advice)`,
    `padding: 14px 16px calc(22px + env(safe-area-inset-bottom))`, `gap: 12px`.
  - **Grip:** 44×4 in `--advice-dim`.
  - **Head:** `NEXT_BUY` in `--font-display` 32 px, and a 44×44 close `x` with an
    `--advice-line` border.
  - **Action:** 16 px.
  - **Detail lines:** 13 px, `line-height: 1.8`, with why, lane, cost and effect.
  - **Buttons:** `[ buy 4 ]` (56 px, 16 px), then `buy 1` and `open ROTOR`, side by side
    (48 px, outlined). `open ROTOR` closes the sheet and opens that item's drawer sheet.
  - **Closing:** tapping the backdrop, the close button, or Esc.

*Why:* the user's decisions: Tab, Esc, Enter, and one-tap on the phone. One model keeps the two
in step.

*Cost if wrong:* the card covers the bottom-left rows while it's open, and it's dismissible.

### U-5. Drawers

**U-5a. The desktop and tablet panel** (`DrawerDesktop`).
- **Position:** `position: absolute`, `top: 0`, `right: 0`, `bottom: 0`, inside the content row
  (below the lane tabs, above the log and command bar).
- **Size and box:** `width: min(560px, 100% − 340px)` on desktop, and
  `clamp(360px, 100% − 300px, 560px)` on tablet. `--s1` fill, `1px solid var(--accent)` border,
  `box-shadow: -8px 0 0 var(--bg)`, `padding: 12px 16px`, `gap: 10px`, scrolling on its own.
- **Over the rows.** It lies over the STORAGE, MACHINES and STOCK columns. **The rows underneath
  keep their full layout.**
  - The mockup narrows the row columns to ITEM, RATE and STORAGE while the drawer is open. That
    would reflow every row, so the overlay is ruled instead.
  - The gutter, ITEM, RATE and SAT stay visible, at the 340 px reserve.
- **It's non-modal:** `role=dialog`, `aria-modal=false`, `aria-labelledby` its title. The rows
  stay interactive.
- **Head:**
  - the title in `--font-display` 30 px, `--state-bottleneck` when the item is the bottleneck,
    else `--t1`;
  - the meta in 12 px `--t2`: `IRON lane · +0.4/s · 214/2.0k`, plus QS and BOUND (U-3c);
  - the hint in 12 px `--t3`: `[↑↓] row  [ESC] close` (fine pointer only, U-7e);
  - a `Close` button (the mockup has none, and a mouse needs one).
- **The selection is followed:** `↑`/`↓` move the selected row and the drawer re-renders for
  the new item. It's keyed on the item, as `key={drawerItem}` is today.
- The selected row carries the `--s-hi` fill and the inset bar (U-3a).

**U-5b. The phone sheet** (`PhoneDrawer`).
- **Box:** `role=dialog`, `aria-modal=true`, `--scrim` backdrop, background inert.
  `position: fixed`, `left: 0`, `right: 0`, `bottom: 0`, `top: clamp(56px, 18dvh, 150px)`.
  `--s1` fill, `border-top: 2px solid var(--accent)`,
  `padding: 12px 16px calc(18px + env(safe-area-inset-bottom))`, `gap: 10px`, scrolling.
- **Grip:** 44×4 in `--t3`.
- **Head:** the title in `--font-display` 32 px (the same colour rule as U-5a), the meta in
  12 px `--t2` (`+0.4/s · 214/2.0k`), and a 44×44 close `x`.
- **The sections' buttons** sit in a 2-column grid of 48 px buttons at the bottom. The mockup
  doesn't show upgrade or handbook; they're added here.
- **The floating TAP** is under the scrim, and inert while the sheet is open.
- **Closing:** the close button, tapping the backdrop, Esc, or dragging the grip down more than
  96 px (pointer events; under reduced motion the sheet just closes). The phone has no ↑/↓
  follow.
- **Supersedes** the non-modal sheet (Q-7), which had no backdrop.

**U-5c. Sections and letter keys.** This replaces the segmented `Action` group: the `segBtn` tabs,
including the "9a" 44 px rule's subject.
- **The default body is MACHINES:**
  - a box with a `--line` border, one row per mark, 44 px on desktop and 48 px buttons on the
    phone;
  - each row: the machine label (150 px, `--t1`), the owned count `x2` (50 px), the per-machine
    cost in 12 px `--t2` (`40 IRON_PLATE each`), then `[B] buy 1` (36 px, `--accent` fill), `x10`
    and `max` (outlined). `max` is added on desktop to match the phone and W-10's ×1 / ×10 / ×max;
  - a locked mark reads `locked · tier 4` in `--t3`;
  - then the ladder line, `ladder: 8 more ASSEMBLER → x1.50` (12 px `--t2`, `[data-ladder]` is
    kept);
  - then `IF YOU BUY 1`, which follows the hovered or focused count, and the projection box
    (`--rule` border in `--line`, `padding: 8px 10px`, 13 px, `line-height: 1.8`). An input
    draining is drawn in `--advice`: `IRON_PLATE -0.8/s (still +11.2/s)`;
  - then `SPLIT` (U-3c), when contested.
- **The other sections are `MORE` buttons.** Each opens its section in place of MACHINES, and
  pressing it again returns:

  | Key | Button | Section (the existing component, re-skinned) |
  |---|---|---|
  | `B` | `[B] buy 1` | buys 1 of the best unlocked mark (the MACHINES row's primary button) |
  | `U` | `[U] upgrade` | `UpgradeSection`, only when a consolidation exists. **Added:** the approved keys had no home for `UPGRADE_MARK`. |
  | `R` | `[R] recipe` | `RecipeSection` |
  | `A` | `[A] assign` | `AssignSection` |
  | `S` | `[S] storage · next 900 plate` | `StorageSection` (storage and QS). The mockup's `storage +1 · 900 plate` reads like a direct buy, so the label shows the next cost and the key opens the section, where the buy is. |
  | `D` | `[D] dismantle` | `DismantleSection` |
  | `H` | `[H] handbook` | navigates to `/handbook/<item>` (the existing `data-handbook-link`) |

- **The data, and the pending rules,** are unchanged: `drawerModel`, `quote`, `preview`,
  `usePendingMap` and `usePendingSetting`.
- **Generator drawers (new).** `drawerModel` gains a recipe-keyed entry,
  `drawerModel(s, { recipeId })`, for a generator recipe, which has no item row. It offers the
  same MACHINES, upgrade and dismantle sections over that recipe's lane-class. It's opened from
  the power panel (U-6b), and closes the gap that generators could only be bought from the frame.

*Cost if wrong:* letter keys are only shortcuts. Every section is still a button.

### U-6. Power and TAP

**U-6a. Power is a lane tab on desktop, and a bottom tab on the phone. Both show one panel.**
- **Desktop and tablet:**
  - Power is the last lane tab, `5 POWER`, whatever its content `order` (1 in the slice).
  - The keys are positional: the production lanes take `1…n` in content order, and power takes
    `n+1`. In the slice that's iron 1, copper 2, coal 3, oil 4, power 5. The approved map's
    `1–5` holds, and locked lanes keep their numbers (U-3e).
- **Phone:**
  - Power leaves the lane grid, which has exactly the four production lanes (`PhoneMain`).
  - It's the `~ power` bottom tab (`PhonePower`).
- **Both** render one `PowerPanel` (new, `ui/PowerPanel.tsx`), so there's one model and one set of
  tests.
- **The phone footer.** The phone has no PWR footer. Its header shows `PWR 412/450 MW`, and the
  floating TAP shows the kick.

*Why:* the content needs power to be a lane, because lanes carry QS levels and multipliers, and
generators need both. The panel shows what a player wants from power. Making the desktop tab and
the phone tab the same panel is the reconciliation.

*Cost if wrong:* the e2e lane order changes (it pins `["iron", "power"]` today).

**U-6b. The PowerPanel** (`PhonePower`). On the phone it has a 10 px gap between sections. On
desktop it's a single column, `max-width: 720px`, in the main box. The sections, in order:
1. **Load.** The `Bar` (U-3d) with 20 cells in `--font-display` 22 px, and the line
   `headroom 38 MW · next machine needs up to 15 MW` (12 px `--t2`):
   - **headroom** is `supplyMw − demandMw`, from `Solution.power`, which exists;
   - **"up to"** is the largest `drawPerMachine` among the best unlocked marks of the shown lanes.
     It's a new pure helper over `solution.capacity`.

   When power is short or limiting, the line reads `power is short · needs 450 MW`, in
   `--state-bottleneck`. This text carries over from `PowerDock`.
2. **GENERATORS.** One 52 px row per power-producing machine class in the power lane
   (`content.producersOf(POWER_ITEM)`):
   - the label (`BIOMASS_BURNER x14`, `--t1`);
   - the detail in 11 px `--t2`: `eats 14 BIOMASS/s · 30 MW each`, from the recipe's inputs ×
     units and `outputPerSecond(POWER_ITEM)`;
   - the MW produced;
   - a 44 px `+1` (`BUY_MACHINE`, power lane, best unlocked mark, count 1, pessimistic through
     `Guarded`, with the label `power:<class>:buy`).

   The row itself opens the generator drawer (U-5c). A locked generator reads
   `COAL_GENERATOR x0 · unlocks at tier 4`, in `--t3`, with no button.
3. **FUEL (new; not in the mockup).** The power lane's item rows (`biomass`, …), as ordinary
   fixed rows (U-3). The bottleneck's `!` can land here, since a power bottleneck frames the
   scarcest input (Q-5), and these rows open item drawers.
4. **BIGGEST USERS.** The top three lanes by drawn MW, in 36 px rows: `IRON lane` · `184 MW`.
   This is new and client-only: `powerByLane(s)` groups `Σ machinesByRecipe × drawPerMachine ×
   clock` by `recipe.lane`, skipping generators. That's the same sum `powerDemandMw` makes
   (`engine/src/economy/capacity.ts:142`), and a test pins that the groups add up to
   `solution.power.demandMw`.
5. **The kick line.** `KICK x1.35 · 7 / 10 stacks · 21s left · hold TAP to keep it up`
   (12 px `--t2`), from `dockModel`, which is unchanged.

*Data:* `dockModel` (exists), plus `powerByLane` and `generatorRows` (new pure functions in
`ui/dock-model.ts`). No engine export changes are needed, beyond the already-exported
`laneClassKey`, which `machines.ts` imports.

**U-6c. TAP.** The store's tap is unchanged: `pressTap`, `releaseTap`, the 10 Hz repeat, and the
flush (W-12).
- **Desktop and tablet:**
  - the footer's `[T] TAP` button (U-2b), keeping `data-tap`;
  - W-20's "the tap target is 58 px" becomes 48 px on a fine pointer, and 76 px on the phone.
- **Phone** (`PhoneMain` and `PhonePower`):
  - **Position:** a floating button on every tab, `position: absolute`, `right: 14px`.
    `bottom` is `52px + env(safe-area-inset-bottom) + 14px`, plus `44px + 8px` when the factory
    tab's command bar is showing. That's the mockups' 116 px and 66 px.
  - **Box:** 68×76, `padding: 6px 4px 4px`, `--accent` fill, `2px solid var(--bg)`,
    `box-shadow: var(--glow-tap)`, falling back to `0 0 0 1px var(--accent)` when there's no glow.
  - **Contents, top to bottom:**
    - `TAP` in `--font-display` 24 px;
    - `x1.35` in 11 px, weight 500;
    - ten stack ticks, `▮` for a live stack and `▯` for an empty one, 8 px, `letter-spacing: -1px`,
      `aria-hidden`;
    - a 54×4 time-left bar (a `--line` track and an `--on-accent` fill, `scaleX` of
      `remainingMs / 30 s`, stepped at 4 Hz under reduced motion), also `aria-hidden`.
  - **Accessible name:** "Tap, hold to keep tapping. Kick times 1.35, 7 of 10 stacks, 21 seconds
    left". It's updated per snapshot and per tap, never at 4 Hz, so the countdown isn't in it.
    With no stacks it reads "Tap, hold to keep the kick".
- **Holding:**
  - by pointer, with `setPointerCapture`, as today;
  - by a held Space or Enter on the focused button, as today, with the button's own handler
    stopping propagation, so the global Space (U-7a) doesn't also fire;
  - by a held `T` anywhere (U-7a).
- **Supersedes:** `PowerDock.tsx`, which splits into `PowerFooter` (desktop), `FloatingTap`
  (phone) and `PowerPanel`. `data-dock` becomes `data-power` on both.

### U-7. The keyboard

**U-7a. The map (approved), with its scopes.** There's one dispatcher, `ui/keys.ts` (new): a pure
`resolveKey(key, context) → Command | null`, plus one `keydown`/`keyup` listener on `document` in
the bubble phase. When scopes overlap, the topmost wins: help overlay > settings sheet > a phone
sheet > NEXT_BUY card > drawer > global.

| Key | Global (factory view unless noted) | Drawer open | NEXT_BUY card open |
|---|---|---|---|
| `Enter` | run the advice: any view, when focus is at rest (U-7b) | run the advice, at rest | buy N (the focused primary) |
| `Tab` | toggle why, at rest only; open the card and focus its primary button | as global | native, inside the card; leaving the card closes it |
| `1`–`5` | select that lane; from F2 or F3, switch to factory first | select the lane and close the drawer | `1` = buy 1; others as global |
| `F1` / `F2` / `F3` | factory, priority, handbook views | as global, and close the drawer | close the card, then as global |
| `F` / `P` / `H` (alternatives) | as F1, F2, F3 | `H` = this item's handbook entry; `F` and `P` as global | as global |
| `↑` / `↓` | move the row selection, and focus the row list | move the selection; the drawer follows | native |
| `→` or `Space` | open the drawer for the selected row | `→` does nothing; `Space` is native on a focused control | native |
| `Esc` | close the topmost thing: overlay, sheet, card, then drawer | close the drawer; focus goes back to its row | close the card; focus goes back to where it came from |
| `T` (held) | tap, with hold to repeat; `keyup` releases; ignores `e.repeat` | as global | as global |
| `B` `U` `R` `A` `S` `D` `H` | n/a (`H` is the alternative above) | the drawer sections (U-5c) | n/a |
| `?` | the help overlay (U-7e) | as global | as global |

**Ignored in every scope:**
- while typing: the event target is an `input` (other than radio, checkbox or button), a
  `textarea`, a `select`, `[contenteditable]`, or a `textbox`, `combobox`, `spinbutton` or
  `slider` role;
- while `e.isComposing`;
- with Ctrl, Meta or Alt held (Shift only for `?`), so browser and OS shortcuts and W-21's
  Alt+↑/↓ keep working;
- when `e.defaultPrevented`, so the priority list, the recipe radiogroup, the tablists' arrow
  keys and the TAP button's Space keep their own keys;
- while the settings sheet is open (S-11 makes the background inert).

`↑` and `↓` are also left alone when focus is inside a control that uses arrows: a radio, a
listbox other than the row list, or a slider.

**U-7b. "At rest", and the browser keys.**
- **Focus is at rest** when `document.activeElement` is `body`, the row list, the main box, or
  the command bar's section (not its buttons). On a button, link, tab or field, `Enter` and
  `Space` do what that control does.
- **Tab** is taken only at rest, and only when there's advice to explain. Otherwise it moves focus
  as normal. Shift+Tab is never taken. So a keyboard user is never trapped (WCAG 2.1.2). The
  first Tab from a fresh page opens the card, and the next Tab moves on through the card. This is
  documented in the `?` overlay.
- **Space** is `preventDefault`ed only when it opens a drawer, so the page's own scroll is never
  wanted: the main box scrolls with the arrows when it's focused.
- **F1, F2 and F3** are `preventDefault`ed on `keydown` when they're handled:
  - Chromium on Windows and Linux opens help on F1, and every major browser binds F3 to "find
    next". Pages can cancel both.
  - On macOS, the F-keys are media keys unless Fn is held, so they often never reach the page.
  - **So the alternatives `F`, `P` and `H` always work.** The nav buttons show `F1 factory` and
    friends on a fine pointer, and the `?` overlay lists both.
  - If a browser doesn't let F1 be cancelled, its help opens as well, and the view still
    switches.
- **No Ctrl or Alt shortcuts.** Ctrl+digit and Alt+digit switch tabs in Chromium on
  Windows/Linux and in Firefox on Linux, so they're never used.

*Cost if wrong:* taking Tab surprises a few keyboard users once, and the overlay and the hint
`[TAB] why` explain it. If it tests badly, the fallback is `W` for why, with Tab left native.

**U-7c. Focus.**
- **Opening the drawer** (`→`, `Space` or a click) focuses its title (`claimFocus`, unchanged).
  `↑`/`↓` keep focus inside the drawer, on the title of the item it now shows.
- **Esc** closes the drawer and puts focus back on the row list, with that row active. This
  supersedes "focus back to the `[data-open-row]` button", which no longer exists.
- **The card** takes focus on its primary button. When focus leaves it (`focusout` to outside),
  or on Esc, it closes. Esc returns focus to where it came from.
- **The phone sheets** trap focus (they're modal) and return it to their opener.
- **The help overlay** is modal and returns focus.

**U-7d. The row list is a listbox.**
- **Roles.** `ul[role=listbox][aria-label="Iron lane"]` with `aria-activedescendant`. Each row is
  `li[role=option][aria-selected]`, keeping `data-item` and `data-tag`. A row contains no
  focusable children.
- **The selection** is client state, per lane. It defaults to the bottleneck's row in that lane,
  then the first row. It survives lane switches and snapshots, and is dropped when the item
  disappears.
- **A click or tap** on a row selects it and opens its drawer.
- **The option's accessible name** is one phrase: "Rotor, plus 0.4 per second, 11 percent full,
  41 percent satisfied, bottleneck", with the trend word in PR 3 (U-9b).
- **The listbox's `aria-describedby`** points to a hidden hint: "Arrow keys to move, right arrow
  or space for details, enter runs the next buy."

**U-7e. Discoverability.**
- **Key hints** (`[TAB] why`, `[ENTER] run`, `[T] TAP`, `[B] buy 1`, `[↑↓] row  [ESC] close`,
  `F1 …`) render only under `@media (hover: hover) and (pointer: fine)`. Touch screens never see
  them (the phone mockups have none), and the buttons keep plain labels.
- **`?` opens the help overlay:** a modal dialog. Its title is `man manufactory` (`Keyboard
  shortcuts` in the plain voice). It lists the U-7a table grouped by scope, the "at rest" and
  "not while typing" rules, the F-key alternatives, and the GPL line (U-2e). The header's `?`
  button opens it too.

### U-8. Accessibility and motion

**U-8a. One live region (W-20 stands). What it says changes.** The region is `Notices`' `status`
element, fed by `announce.ts`. It says, once each:
- a bottleneck change ("Bottleneck: Limiting rotor. 4 more Constructors clear it." — the existing
  `useBottleneckAnnouncement`, unchanged);
- "No bottleneck";
- a rejection (the toast);
- a tier-up: "Tier 3 reached. Rotor unlocked." The existing `tier-up` notice text gains the
  unlock summary (U-9d);
- priority moves (4b).

**It never says:**
- **the typing advice,** character by character or at all: the typed span is `aria-hidden`, and
  the command bar's accessible text is the complete command, which changes once;
- **factory log lines:** the log is `aria-live="off"`, a labelled region with no `role=log`,
  because `role=log` is implicitly live and would be a second region;
- **the tier banner:** it's `aria-hidden` (it duplicates the announcement), with no
  `role=status`. The mockup's `role="status"` would be a second region;
- **purchases:** the button's busy state, and then its new label, are the feedback, as W-13
  intends;
- **sparklines,** or **any 4 Hz number.**

**U-8b. Roles and names.**
- the row list is a listbox (U-7d);
- lane tabs and the bottom tabs stay `role=tablist`, with roving tabindex and the arrow keys
  (`tabTarget`, unchanged);
- the NEXT_BUY card, the drawer, the sheets and the help overlay are dialogs, as specced above;
- bars are meters (U-3d);
- every glyph that carries meaning (`!`, `●`, `▮▯`, `▴`) is `aria-hidden`, with its meaning in a
  label.

**U-8c. Reduced motion.** W-18's "a complete static UI" stands, and so do test 7a (only
`transform` and `opacity`) and test 7b (all motion inside `prefers-reduced-motion:
no-preference`). JS-driven effects check `prefersReducedMotion()` (exists).

| Effect | With motion | Reduced motion |
|---|---|---|
| Bar fill | two-transform reveal per snapshot (U-3d) | stepped at the 4 Hz tick |
| Bottleneck `!` | opacity pulse, `--pulse-cycle` 2.6 s | static `!` |
| Command cursor | `steps(1)` opacity blink, 1.06 s | a steady block |
| Typing advice | types out (U-9e) | the full text at once |
| Number tweens | 300 ms log space (W-7) | snap, as today |
| NEXT_BUY card, sheets, drawer | opacity 120 ms; sheets `translateY` 180 ms | appear and disappear |
| Tier banner | opacity in 200 ms, out 400 ms | appears for 8 s, then disappears |
| Glow and scanlines | on in terminal (U-9c) | **glow off** (the user's call); scanlines stay, since they're a still texture |
| TAP time-left bar | `scaleX` transition | stepped at 4 Hz |
| Production sweep, conveyor | **retired** | — |

The conveyor (S-14, W-18) and the sweep are retired. Neither has a place in Layout C's fixed
rows, and the sparklines and the log replace them as the signs of life.
`Conveyor.tsx`, `conveyor()` and `sweepPeriodS()` in `motion.ts`, and their tests, are deleted.

**U-8d. Targets.**
- **At 44 px:** W-20's 44 px holds under `(pointer: coarse)` at every width and on the phone:
  lane tabs, bottom tabs, sheet buttons (48–56 px), the drawer grid (48 px), and the TAP (76 px).
- **On a fine pointer,** desktop uses the mockups' 34–40 px controls, which are above WCAG 2.2's
  24 px minimum (2.5.8). The "9a" test becomes: "every button reachable under `pointer: coarse`
  is at least 44 px both ways".

### U-9. Feel alive, PR 3

**U-9a. The factory log** (`Delight`).
- **The model** (`ui/factory-log.ts`, new) is pure:
  `logEntries(prev, next, settled, ctx) → LogEntry[]`, run on each adoption through the store hook
  (U-9f). `LogEntry` is `{ atLocalMs, text, tone: "normal" | "advice" | "milestone", key }`.
- **The events:**

  | Event | When | Line (shell voice) | Tone |
  |---|---|---|---|
  | Storage full | an item shown as a row gains `FULL` (`itemStateTag`) in `next` that it lacked in `prev` | `IRON_PLATE storage full · raise it or use it` | normal |
  | Bottleneck moved | `bottleneckKey` changed; both sides non-null | `bottleneck moved: SCREW → ROTOR` | advice |
  | Bottleneck appeared or cleared | one side is null | `bottleneck: ROTOR` / `bottleneck cleared` | advice |
  | A purchase | `settled` is a batch with a spend (`BUY_MACHINE`, `UPGRADE_MARK`, `DISMANTLE`, `BUY_STORAGE`, `BUY_QS`), adopted | `bought 4 CONSTRUCTOR_MK1 (IRON) · ROTOR +0.4 → +1.2/s`. The item comes from the batch label: `drawer:<item>:<verb>`, or `prev`'s bottleneck item for `BOTTLENECK_BUY_LABEL`. The rates come from `prev` and `next` `schedule`. Storage: `storage +1 IRON_PLATE · cap 10.0k → 15.0k`. | normal |
  | A tier-up | `next.state.tier > prev.state.tier` | `TIER 3 reached · ROTOR, STATOR unlocked` | milestone |

- **Never logged:**
  - the first snapshot of a session (that's welcome-back, which is deferred);
  - settings (reorder, mode, reserve, recipe, assign): their controls are the feedback;
  - taps.
- **Dedupe.** The same `key` (kind + item) within 60 s is dropped. "Storage full" for one item is
  logged at most once per 10 minutes. Both guard against the EPSILON cycle (the post-launch
  PL-2 screw flip), which can flip a tag at every boundary.
- **Storage.** A 200-entry ring, in memory, per world. It's reset when the identity or the world
  changes (`newFactory`, sign-in, sign-out). It isn't persisted.
- **Timestamps** use the local wall clock (`Date`), for display only. W-6's server time is
  untouched.
- **Desktop:** `section[aria-label="Factory log"][aria-live=off]`, 96 px, between the main box and
  the command bar.
  - The first line is `$ tail -f factory.log` in `--t3` (`Factory log` in the plain voice).
  - Then an `ol` of entries in 12 px: normal in `--t2`, advice in `--advice`, milestone in
    `--advice-hi`. The format is `14:02:11  <text>`.
  - It's scrollable (`tabindex=0` when it overflows) and sticks to the bottom unless the player
    has scrolled up.
  - The newest line ends with an 8×13 `--t-body` block cursor, which blinks under no-preference.
- **Phone:** a 24 px ticker above the command bar shows the newest line, ellipsized, as a button
  ("Factory log, 3 entries"). It opens a log sheet in the U-4c style with the full list. With no
  entries, the ticker isn't rendered. The mockups put no log on the phone, so this is the call
  made here.
- **The cost to the shell.** On desktop the log takes 96 px + 10 px from the main box. At 820 px
  of viewport, eight 44 px rows still fit without scrolling.

**U-9b. Sparklines.**
- **The model** (`ui/trend.ts`, new) is a ring buffer per world, kept beside the store, outside
  React. For each item it holds `N = 10` buckets of 60 s, keyed by `floor(serverMs / 60_000)`.
- **Feeding it.** On each adoption (U-9f), the previous snapshot's segment `[prev.atMs, end)` is
  credited to the buckets it covers, at `prev.schedule.items[i].netPerSecond`, weighted by time.
  `end` is `min(next.atMs, prev.nextBoundaryAtMs)`.
  - **A segment never runs past its snapshot's boundary.** Time past a boundary that no snapshot
    covered (a hidden tab, offline) is unknown, and an unknown bucket is drawn as `·` in `--t3`.
  - The open segment is credited the same way at render time, up to the current server time.
- **The cost** is 10 numbers × 32 items, which stays trivial at the full catalog's ~160 items.
  Nothing is persisted, so a reload starts with ten `·`, and the line fills over ten minutes.
- **Drawing** (`sparkline(values) → string`, pure). The cells are `▁▂▃▄▅▆▇█`, scaled per row from
  the window's min to its max. When `max − min ≤ 2% · max|v|`, every known cell is `▄` (steady).
  The colour is:
  - `--rate-down` when the current rate is below 0;
  - `--state-bottleneck` on the bottleneck row (a state class);
  - otherwise `--t3`. This follows `Delight`'s `sparkColor`.
- **Where it shows:** the desktop TREND column (U-3b), with the header `LAST 10 MIN`. On the phone
  and tablet it shows in the drawer header's meta: `trend ▁▂▂▃▃▅`.
- **For screen readers** the cells are `aria-hidden`. The row option's name gains "rising",
  "falling" or "steady": the sign of the last known bucket minus the first, beyond the steady
  band.
- **Under reduced motion** nothing changes. It's text that changes once a minute.

**U-9c. Phosphor glow and scanlines.**
- **The glow** is `text-shadow: var(--glow-text)` on `.app`, `--glow-title` on the title,
  `--glow-advice` on the command bar, `--glow-banner` on the tier banner, and `--glow-tap` on the
  TAP.
  - Buttons with a solid fill set `text-shadow: none`, as `Delight` does.
  - **The glow is off** (the tokens become `none`):
    - in every theme except terminal;
    - under `prefers-reduced-motion: reduce` (the user's decision, although glow isn't motion);
    - under `prefers-contrast: more`;
    - when the CRT setting is off (U-1i).
- **The scanlines** (`--scanlines`) are a `background-image` on the shell. They are **under** the
  content, not an overlay on top as in the mockups, so they never lower text contrast (U-1f).
  They're off with CRT off, under `prefers-contrast: more`, and outside terminal.
- **Performance.** A `text-shadow` repaints with the 4 Hz text, which costs microseconds per
  row. A check in the e2e suite records that frame timing stays under 16 ms on the tier-8
  fixture, with glow on.

**U-9d. The tier-up banner** (`Delight`).
- **When:** on the store's existing tier-up detection (`sync/store.ts:1227`).
- **What:** the header shows `*** TIER 3 REACHED · ROTOR unlocked ***` for 8 s.
  - 13 px `--advice-hi`, `1px solid var(--advice-hi)` border, `padding: 4px 10px`,
    `--glow-banner`.
  - Desktop: it's laid over the tier readout's space, so the nav doesn't move.
  - Phone: it replaces the header's right-hand readout.
  - A click dismisses it.
- **The unlock summary** is `unlockedAt(content, tier)` (new, pure): the items whose
  `tier === tier` in unlocked lanes, then the lanes whose `unlockTier === tier`, then the machine
  marks. The first two are named, then `+N`.
- **Accessibility:** the banner is `aria-hidden`. The live-region text is the `tier-up` notice's
  (U-8a).
- **The tier-up toast** no longer renders in the notice list. The banner is its visual, the log
  keeps the line, and the store's notice remains the announcement.
- **Supersedes** W-18's "a tier-up gets one toast", which becomes one banner. Nothing routine
  celebrates, so W-18's rule holds.

**U-9e. The advice types itself out.**
- **The hook:** `useTyped(text, enabled)` in `ui/use-typed.ts`, new.
- **What triggers it.** When the command text changes (U-4a's `commandText`, not the run label's
  4 Hz countdown), the visible span types the new text at
  `interval = min(30 ms, 600 ms / length)`. So no command takes longer than 600 ms. The first
  advice of a session types too.
- **Who sees it:** the shell voice only (terminal). The plain themes crossfade (opacity 150 ms).
- **When it's skipped** (the full text at once):
  - under reduced motion;
  - in a hidden tab;
  - while the card or a sheet is open.
- **Accessibility.** The typed span is `aria-hidden`. A visually hidden sibling always holds the
  complete text, so the accessible name never changes mid-type. The live region says the
  bottleneck change once (U-8a).
- **It's cosmetic only.** The action is set before the first character. `Enter` during typing
  runs it, and finishes the typing at once.
- **Timers:** `setTimeout` through the store's `ClientClock`, so tests drive it with the injected
  clock.

**U-9f. The only sync change: an adoption hook.** The store gains
`onAdopt(fn: (e: { prev: Snapshot | null; next: Snapshot; settled: Batch | null }) => void):
() => void`.
- It's called once per adopted snapshot, after adoption.
- `settled` is the batch whose response this is: the `settling` id that the adopt path already
  tracks. It's `null` for a `GET`.
- It's tested in the sync suite (W-22) against the real API: a buy reports its batch, a poll
  reports `null`, and a stale response reports nothing.
- The log and the trend book subscribe to it. Neither touches the outbox, the polling or the wire.

**No API change and no engine change in any of the three PRs.** The pieces that would need one
are deferred: welcome-back (open question 2's `summary` on `GET /api/world`), and an averaged
cycle rate.

---

## What changes in the existing code, and what it supersedes

| File or area | Change | Supersedes |
|---|---|---|
| `ui/App.tsx` | Split into `Shell` (`DesktopShell`, `PhoneShell`) with the U-2 structure. View state is factory, priority, handbook, plus power on the phone. Lane selection and row selection are client state; the keyboard dispatcher is mounted here. | W-19's panes, the `View` tablist, `--dock-h` |
| `ui/use-panes.ts` | Becomes `use-layout-mode.ts` (`phone`, `tablet`, `desktop`) | W-19's pane count |
| `ui/Layout.module.css` | Rewritten for the U-2 shell | three-pane, two-pane and one-pane grids, `.dock`, `.tabbar`, `.sheetHost` |
| `ui/LaneView.tsx`, `ItemRow.tsx` and their CSS | Become `RowList.tsx` and `Row.tsx` (U-3). `LiveStock`, `useTween` and the storage meter carry over into `Bar.tsx`. `SatisfactionMeter` becomes the SAT cell; `SplitBar` moves into the drawer. | F.1's three-line row (W-1 item 1), S-14's sweep |
| `ui/BottleneckFrame.tsx` and its CSS | **Deleted.** Its spend and reserve buttons move to `CommandBar.tsx`. | P-2, P-3 and W-1's frame |
| `ui/Conveyor.tsx`, the sweep in `motion.ts` | **Deleted** (U-8c) | W-18's conveyor and sweep |
| `ui/PowerDock.tsx` and its CSS | Split into `PowerFooter`, `FloatingTap` and `PowerPanel` (U-6); `dock-model.ts` gains `powerByLane` and `generatorRows` | W-1 item 4's dock, Q-12's layout |
| `ui/Drawer.tsx` and its CSS | Desktop panel and phone modal sheet (U-5a, b); letter-key sections replace the segmented tabs (U-5c); `SPLIT`; recipe-keyed generator drawers in `machines.ts` | Q-6's tabs, Q-7's non-modal sheet |
| `ui/derive.ts` | Adds `laneStatus`; `bottleneckRow` is unchanged | — |
| `ui/command.ts`, `CommandBar.tsx`, `NextBuy.tsx` | **New** (U-4) | — |
| `ui/keys.ts`, `HelpOverlay.tsx` | **New** (U-7) | — |
| `ui/names.ts`, `capabilities.ts` | **New** (U-1h, U-1i) | — |
| `ui/factory-log.ts`, `FactoryLog.tsx`, `trend.ts`, `use-typed.ts`, `TierBanner.tsx` | **New** (U-9) | — |
| `ui/Notices.tsx` | The visible list becomes an overlay (U-2e); the tier-up toast is no longer drawn (U-9d); the frameless-bottleneck line goes (U-3e); the region element stays | P-2's notice fallback, W-18's toast |
| `ui/TierReadout.tsx` | Terminal format; the phone's furthest-requirement form | — |
| `ui/Settings.tsx` | The theme list with locks, the CRT toggle, About (the GPL links) | S-11's System/Dark/Light |
| `ui/Footer.tsx` | Its content moves into Settings' About and the help overlay | W-25's footer placement (the links are unchanged) |
| `ui/theme.ts` | The registry, migration and capability-aware apply (U-1a, U-1i) | W-17's dark/light |
| `styles/tokens.css`, `base.css` | Six theme blocks, `@font-face`, the shell base | W-17's token values |
| `ui/Handbook.tsx`, `PriorityList.tsx`, `AccountForms.tsx`, `ResetPassword.tsx` | Re-skinned to tokens only; their behaviour, including W-21's drag, is unchanged | — |
| `sync/store.ts` | `onAdopt` (U-9f) | — |
| Kept unchanged | `fmt` and notation (S-11), `Guarded`, `use-pending`, `announce.ts`, `quote.ts`, `preview.ts`, `machines.ts` (other than the generator entry), `use-tick`, `use-tween`, the whole sync core apart from `onAdopt`, the route | — |

## Testing

**Unit (vitest, jsdom, the existing fixtures):**
- **Themes:**
  - The registry covers all six ids, and old values migrate (`dark`, `light`, `system`, missing,
    and junk).
  - A locked theme without its capability applies `terminal` and keeps the stored value. With the
    capability, it applies.
  - `?theme=` works only in dev.
  - `meta[name=theme-color]` follows the theme.
- **CSS (`tokens.test.ts`):**
  - 8b is updated to the terminal `:root` values, and checks that each theme block defines every
    semantic token.
  - 7a, 7b, 7c (the pulse, now on the `!` class), 7d and 8a stand.
  - 9a is rewritten (U-8d).
  - New: the row rule has a fixed `height` and no `min-height`.
- **Contrast** (`styles/contrast.test.ts`, new): every declared pair in every theme passes AA, and
  no barred pair is used anywhere in the CSS modules (U-1f).
- **Fonts:** the cmap check for `[ ] ▁…█ ▮ ▯ ● ▴ → ·` in the faces that draw them (U-1g).
- **Names** (`names.test.ts`): the four casings, and the `aria-label` content name.
- **Rows** (`RowList.test.tsx`, replacing `LaneView.test.tsx`):
  - fixed DOM whether framed or not;
  - the SAT cell's text for each state;
  - the option names;
  - the listbox selection model (default, follows across lanes, dropped on removal);
  - `laneStatus` for each status;
  - locked lanes `aria-disabled`, and skipped by the arrows.
- **The command line** (`command.test.ts`, `CommandBar.test.tsx`):
  - the command text, the short form and the run label for every `FrameAction` kind, both
    voices, `null` and no-bottleneck;
  - busy, unaffordable and the countdown;
  - the exact batch sent: the same assertion the frame tests made, moved over.
- **NEXT_BUY:**
  - why, cost and effect for each kind;
  - `buy 1` only for multi-count machine buys;
  - the effect matches `preview.ts`;
  - the card stays open across a buy;
  - focus leaving closes it.
- **Keyboard** (`keys.test.ts`): a table test of `resolveKey` over every key × every scope × "at
  rest or on a control" × typing targets × modifiers × `isComposing` × `defaultPrevented`. It also
  checks which keys `preventDefault`, and that F1–F3 and F, P, H agree.
- **Drawer** (`Drawer.test.tsx`, updated):
  - the letter-key sections, the `[U]` and `[S]` rules, `SPLIT`;
  - ↑/↓ follow, keeping focus on the title;
  - Esc returns focus to the row list;
  - the phone sheet's modality, inert background and focus trap;
  - the generator drawer.
- **d1-coverage:** every D.1 action is still reachable, at its new home. That includes
  generators from the power panel, which is newly covered.
- **Power** (`PowerPanel.test.tsx`, replacing `PowerDock.test.tsx`):
  - `powerByLane` adds up to `demandMw` on the tier-8 fixtures;
  - the generator rows and `+1`;
  - headroom and "up to";
  - the FUEL rows;
  - the TAP's accessible name updates per snapshot, not per tick;
  - the hold carries over (pointer, Space/Enter on the button, `T`).
- **Feel alive:**
  - `factory-log.test.ts`: each event kind, nothing on the first snapshot, both dedupe rules, the
    labels to items, the reset on a world change;
  - `trend.test.ts`: the bucket weighting, the cut at the boundary, unknown cells, the scale and
    steady band, the trend words;
  - `use-typed.test.ts`: typing on the injected clock, the 600 ms cap, instant under reduced
    motion or when hidden, the complete accessible text throughout, Enter finishing it;
  - `TierBanner.test.tsx`: the unlock summary, 8 s, `aria-hidden`, the announcement text.
- **Sync:** the `onAdopt` cases in `store.test.ts` (U-9f).

**E2E (Playwright, Chromium, W-23), with selectors updated:**

| Spec | Change |
|---|---|
| `guest-buy` | `[data-frame]` and "bottleneck" become the command bar: `[data-command]` holds the advice and `[data-run]` buys. The row is `[role=option][data-item="iron_plate"]`. The no-overflow check stays. |
| `drawer-buy` | Open by clicking the option. `[data-drawer]` stays; the buy is `[data-mark-buy="1"]`. `[data-ladder]` stays. |
| `tap-hold` | `button[data-tap]` stays (footer and floating). `[data-dock]` becomes `[data-power]`. Adds a held `T`. |
| `reduced-motion` | No running animations, as before; the `!` is visible and labelled; a computed `text-shadow` of `none`; the command text complete at once. The pulse case moves to the `!` glyph. The conveyor assertions go. |
| `layout-320` | Bottom tabs (factory, power, priority, handbook) replace the "View" tablist. Lanes are `["iron", "copper", "coal", "oil"]`, the last three `aria-disabled`, with power in the bottom tab. Covers the NEXT_BUY sheet, the drawer sheet, the log sheet, the floating TAP not covering the command bar, 44 px targets under `hasTouch`, and the source link now in Settings > About. |
| `priority-drag` | `#pane-priority` becomes the priority view, opened by `F2` on desktop or the bottom tab. Drag and Alt+↑/↓ are unchanged. |
| `accounts`, `injected-failures` | Only the opener selectors change (`cfg` / `≡`, `[data-open-settings]` stays). Notices keep `data-notice`. |
| **New** `keyboard.spec` (desktop 1280×820) | Tab opens the card and Enter buys (the state version goes up); Esc closes and focus returns; `1`–`5`; F1, F2, F3 and F, P, H; ↑↓ then → opens the drawer; ↓ moves it to the next item; Esc returns focus; typing in the settings email field triggers nothing; `?` opens the overlay. |
| **New** `themes.spec` | Switch to Clean (Light), reload, still Clean (Light); no flash (checked before first paint); a locked theme can't be selected; a stored `cosy` without the capability renders terminal. |
| **New** `phone.spec` (390×844, `hasTouch`) | The split bar's one-tap buy; the why sheet's `open ROTOR`; the power tab's generator `+1`; the TAP on all four tabs. |

All specs wait on store or DOM attributes, never sleeps (W-23). `data-state-version`,
`data-sync` and `data-polling` stay on the app root.

## Build order: three PRs, each shippable

| PR | Scope | Ends in |
|---|---|---|
| **UI-1: themes, the shell, the command bar** | U-1 entire (six token sets, fonts, names, the switcher with locks and migration, the contrast test); U-2 entire (all three breakpoints, header, nav, lane tabs with lights and locked lanes, bottom tabs, notices overlay, About); U-3 (fixed rows, columns without TREND, SAT, `Bar`); U-4 entire (command bar, split bar, card and sheet, opened by click or tap and by the `[TAB] why` button); U-6 entire (PowerPanel with generator `+1`, footer, floating TAP). The current drawer is restyled and placed as the U-5a panel or a phone sheet, with its segmented tabs still in. The frame, conveyor, sweep and dock are deleted. E2E selectors are updated. | Players get the terminal look by default, and can switch to Clean. The bottleneck lives in the command line and rows never move. The phone has its power tab and floating TAP. Every D.1 action is reachable, and generators get a home. |
| **UI-2: drawers and the keyboard** | U-5 entire (letter-key sections, `[U]`, `SPLIT`, ↑/↓ follow, the modal phone sheet with grip, generator drawers); U-7 entire (dispatcher, scopes, Tab/Enter/F-keys, listbox focus, `?` overlay, hints); `keyboard.spec` and `phone.spec`. | The game is fully playable from the keyboard on desktop, and the drawers match the mockups. |
| **UI-3: feel alive** | U-9 entire (`onAdopt`, the factory log on desktop plus the phone ticker and sheet, sparklines and the TREND column, glow, scanlines and the CRT toggle, the tier banner, the typing advice), plus U-8c's remaining rows. | The factory talks back: a log of what happened, trends per item, the phosphor look, and a celebration at tier-up. |

*Why this split:*
- UI-1 is the biggest. It can't be smaller without shipping half a theme, or a frame and a
  command bar at once.
- UI-2 depends on UI-1's row list and selection model.
- UI-3 depends on neither keyboard nor drawer. It could swap with UI-2 if the feel-alive work is
  wanted sooner.
- Each PR is its own plan and its own subagent-driven run.

## Deferred: "feel alive", later

- **Welcome back** (`PhoneBoot`): the boot screen with `WHILE YOU WERE AWAY`, gains, storage-full
  and bottleneck lines, and the 8 h cap note. It needs `GET /api/world` to return the offline
  `summary`, which `viewWorld` already computes and discards (`worlds.ts:141`, Phase 4 open
  question 2), and it means "since your last action". A later spec, with the API change.
- **Sound and haptics.**
- **The `:` command palette.**
- **The handbook flow tree.**

## Out of scope

- OAuth: Discord and GitHub sign-in, a separate PR (Phase 4 open question 4).
- Spec 2 (progression): the prestige store and what grants `theme:cosy` and `theme:industrial`.
  This spec only registers the themes and the capability seam.
- Any API, engine, content or pacing change.
- List virtualization (W-19 still holds until the full catalog).
- PWA and notifications.
- The averaged cycle rate (PL-2's deferred part).

## Supersessions at a glance

| Phase 4 ruling | Superseded by |
|---|---|
| W-1 item 1 (the three-line row, chips in the row, one frame) | U-3c, U-4a |
| W-1 item 4 (the dock) | U-6 |
| W-17 (values, dark by default with light by preference, three sizes, no shadows or gradients) | U-1b to U-1d, U-9c. The state-colour discipline (8a) stands. |
| W-18 (the sweep, the conveyor, the frame pulse, the tier-up toast) | U-8c, U-9d. Transform/opacity-only and reduced motion stand. |
| W-19 (the panes) | U-2a. The widths and no-horizontal-scroll stand. |
| W-20 (the 58 px tap, 44 px everywhere, the contrast test claim) | U-6c, U-8d, U-1f. The one live region stands. |
| W-25 (the footer placement) | U-2e. The links stand. |
| P-2 (the frame, the frameless notice), P-3 (the inline buy) | U-4a, U-3e |
| Q-6 (the drawer's tabs), Q-7 (the non-modal sheet) | U-5 |
| S-11 (System/Dark/Light), S-14 (the sweep, the conveyor) | U-1i, U-8c |
