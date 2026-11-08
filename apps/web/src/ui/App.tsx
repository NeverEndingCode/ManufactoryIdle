// The app: the store wiring, the announcer, the tick, the settings sheet (S-11: state, not a
// route) and the route (S-10). The markup is the shell's (U-2): DesktopShell for desktop and
// tablet, PhoneShell below 600 px, both filling this .app root. App holds the view state (V-25):
// the selected lane, the factory / priority / phone power view, the open drawer, and each lane's
// selected row (U-7d); the handbook view is its route. The store is created and started outside React (main.tsx).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ItemId, LaneId, RecipeId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { useGame } from "../sync/use-game.js";
import {
  bottleneckKey,
  bottleneckRow,
  laneItemIds,
  laneTabs,
  powerLaneId,
  type BottleneckModel,
} from "./derive.js";
import { inertOutside, openModal } from "./dialog.js";
import { focusKind, isRowList, scopeOf, type KeyContext, type SectionKey } from "./keys.js";
import { Drawer, drawerKey, type DrawerTarget } from "./Drawer.js";
import { Handbook } from "./Handbook.js";
import { Help } from "./Help.js";
import { AnnounceContext, createAnnouncer, type Announcer } from "./announce.js";
import { capabilities } from "./capabilities.js";
import { CommandBar, CommandSplit } from "./CommandBar.js";
import { FactoryLog, LogSheet, LogTicker } from "./FactoryLog.js";
import { FeelContext, feelOf } from "./feel.js";
import { FloatingTap } from "./FloatingTap.js";
import { NextBuyCard, NextBuySheet } from "./NextBuy.js";
import { useNotation } from "./notation.js";
import { PowerFooter } from "./PowerFooter.js";
import { PowerPanel } from "./PowerPanel.js";
import { PriorityList } from "./PriorityList.js";
import { useRoute } from "./route.js";
import { rowId } from "./Row.js";
import { RowList } from "./RowList.js";
import { currentRow, stepRow } from "./selection.js";
import { Settings, type SettingsProps } from "./Settings.js";
import { DesktopShell, PhoneShell, type ShellProps, type View } from "./Shell.js";
import { syncCapabilities } from "./theme.js";
import { useKeyboard, type KeyActions } from "./use-keyboard.js";
import { useLayoutMode, useTallViewport } from "./use-layout-mode.js";
import { createTickSource, TickContext } from "./use-tick.js";

type SheetAt = Pick<SettingsProps, "section">;

/**
 * S-15 / W-20: "Bottleneck: <advice>" when the framed item changes between adopted snapshots,
 * "No bottleneck" when it clears. Never on the first snapshot seen (again after the snapshot
 * goes away: a new factory), and never for a new snapshot with the same framed item, so never
 * at 4 Hz. A frameless bottleneck is said too (V-14): it's the command line's comment now, no
 * longer a notice line inside the region.
 */
function useBottleneckAnnouncement(
  announcer: Announcer,
  s: Snapshot | null,
  bottleneck: BottleneckModel | null,
) {
  const key = s === null ? undefined : bottleneckKey(bottleneck);
  const text = bottleneck?.text ?? null;
  /** The key last seen; undefined before the first snapshot. */
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const before = seen.current;
    seen.current = key;
    if (key === undefined || before === undefined || before === key) return;
    if (key === null) announcer.announce("No bottleneck");
    else announcer.announce(`Bottleneck: ${text}`);
  }, [announcer, key, text]);
}

export function App({ store }: { store: GameStore }) {
  const view = useGame(store);
  // V-7: a grant (Spec 2) re-applies the stored theme; a same-content set does nothing.
  useEffect(() => syncCapabilities(capabilities(view)), [view]);
  const [route, navigate] = useRoute();
  // Every number goes through fmt(): a notation change re-renders the tree (S-11).
  useNotation();
  const mode = useLayoutMode();
  // L-3: the store's feel pair (main.tsx created it before the first adoption).
  const feel = useMemo(() => feelOf(store), [store]);
  /** L-10: the log's box on desktop and tablet 700 px tall or more; the ticker elsewhere. */
  const tall = useTallViewport();
  const logBox = mode !== "phone" && tall;
  const [sheet, setSheet] = useState<SheetAt | null>(null);
  const appRef = useRef<HTMLDivElement>(null);
  /** The control that opened the sheet; focus goes back to it, else to Settings. */
  const sheetOpener = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);
  const openSheet = (at: SheetAt, opener: HTMLElement | null) => {
    sheetOpener.current = opener;
    setSheet(at);
  };
  const closeSheet = () => {
    returnFocus.current = true;
    setSheet(null);
  };
  /** U-4c: the NEXT_BUY card (desktop) or sheet (phone), and the control that opened it. */
  const [whyOpen, setWhyOpen] = useState(false);
  const whyOpener = useRef<HTMLElement | null>(null);
  const whyReturn = useRef(false);
  /** K-6: opened by Tab, so Esc goes back to the opener (or nowhere), never to why. */
  const whyByKey = useRef(false);
  /** The why button toggles: a second press closes the card, focus staying on it. */
  const openWhy = (opener: HTMLElement | null, byKey = false) => {
    if (whyOpen) {
      // A toggle from why returns to why: a card opened by Tab (K-6) gives up its opener.
      whyOpener.current = opener;
      whyByKey.current = byKey;
      whyReturn.current = true;
      setWhyOpen(false);
      return;
    }
    whyOpener.current = opener;
    whyByKey.current = byKey;
    setWhyOpen(true);
  };
  const closeWhy = (returnFocus: boolean) => {
    whyReturn.current = returnFocus;
    setWhyOpen(false);
  };
  /** U-7e: the help overlay, the control that opened it (K-6), and whether to return there. */
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpener = useRef<HTMLElement | null>(null);
  const helpReturn = useRef(false);
  const openHelp = (opener: HTMLElement | null) => {
    helpOpener.current = opener;
    setHelpOpen(true);
  };
  const closeHelp = () => {
    helpReturn.current = true;
    setHelpOpen(false);
  };
  /** L-11: the log sheet (the ticker's), and whether focus goes back to the ticker. */
  const [logOpen, setLogOpen] = useState(false);
  const logReturn = useRef(false);
  const closeLog = () => {
    logReturn.current = true;
    setLogOpen(false);
  };
  // S-11 / V-12 / K-5: while a modal (Settings, the help, the phone's NEXT_BUY or drawer sheet)
  // is open everything outside it is inert, but the live region never is (W-20: the one region
  // keeps speaking, and the sheet's announcements land there); only its controls go inert.
  // Every commit, undone first, since lanes and notice buttons can mount while it is open.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (app === null) return;
    const host = openModal(app);
    if (host === null) return;
    return inertOutside(app, [host], app.querySelector(".notices"));
  });
  // Focus returns once inert is gone (every layout cleanup runs before any layout effect).
  useLayoutEffect(() => {
    if (sheet !== null || !returnFocus.current) return;
    returnFocus.current = false;
    const back = sheetOpener.current;
    sheetOpener.current = null;
    (back !== null && back.isConnected && back !== document.body
      ? back
      : appRef.current?.querySelector<HTMLElement>("[data-open-settings]")
    )?.focus();
  });
  // The NEXT_BUY card or sheet closed by Esc, its close button or the backdrop: focus goes back
  // to the why button (after the inert pass is undone).
  useLayoutEffect(() => {
    if (whyOpen || !whyReturn.current) return;
    whyReturn.current = false;
    const back = whyOpener.current;
    whyOpener.current = null;
    if (whyByKey.current) {
      // K-6: a keyboard opening returns to its opener; with none, focus stays where it fell.
      whyByKey.current = false;
      if (back !== null && back.isConnected) back.focus();
      return;
    }
    (back !== null && back.isConnected
      ? back
      : appRef.current?.querySelector<HTMLElement>("[data-why]")
    )?.focus();
  });
  // The log sheet closed by x, the backdrop or Esc: focus goes back to the ticker, once inert
  // is gone; the row list if the ticker went with the lines (a new world).
  useLayoutEffect(() => {
    if (logOpen || !logReturn.current) return;
    logReturn.current = false;
    (
      appRef.current?.querySelector<HTMLElement>("[data-log-ticker]") ??
      appRef.current?.querySelector<HTMLElement>('ul[role="listbox"][data-rows]')
    )?.focus();
  });
  // The help closed: focus goes back to its opener (K-6), once inert is gone; with none (a key
  // from <body> off the row views), it stays on <body>.
  useLayoutEffect(() => {
    if (helpOpen || !helpReturn.current) return;
    helpReturn.current = false;
    const back = helpOpener.current;
    helpOpener.current = null;
    if (back !== null && back.isConnected) back.focus();
  });
  const ticks = useMemo(() => createTickSource(store), [store]);
  const announcer = useMemo(() => createAnnouncer(), []);
  const s = view.snapshot;
  const bottleneck = useMemo(() => (s ? bottleneckRow(s) : null), [s]);
  useBottleneckAnnouncement(announcer, s, bottleneck);
  const lanes = useMemo(() => (s ? laneTabs(s, bottleneck, mode) : []), [s, bottleneck, mode]);
  // The picked lane survives a layout change; a locked one, or power on the phone, falls back
  // to the first open lane.
  const [picked, setPicked] = useState<LaneId | null>(null);
  const laneId =
    lanes.find((t) => t.id === picked && !t.locked)?.id ?? lanes.find((t) => !t.locked)?.id ?? null;
  const [pane, setPane] = useState<Exclude<View, "handbook">>("factory");
  const onHandbook = route.kind === "handbook";
  // V-25: the handbook is its route; power is a view on the phone only (a lane tab elsewhere).
  const shown: View = onHandbook
    ? "handbook"
    : mode !== "phone" && pane === "power"
      ? "factory"
      : pane;
  /** K-12: the open drawer, an item row's or a generator's. */
  const [open, setOpen] = useState<DrawerTarget | null>(null);
  const openItem = open?.kind === "item" ? open.itemId : null;
  const openGenerator = open?.kind === "generator" ? open.recipeId : null;
  const [focusEntry, setFocusEntry] = useState<string | null>(null);
  /** U-7d: each lane's selected row. It survives lane switches and snapshots; an item that's no
   * longer a row drops out, so its lane falls back to the default (RowList) and stays there. */
  const [selection, setSelection] = useState<ReadonlyMap<LaneId, ItemId>>(() => new Map());
  const select = (lane: LaneId, itemId: ItemId) =>
    setSelection((m) => (m.get(lane) === itemId ? m : new Map(m).set(lane, itemId)));
  useEffect(() => {
    if (s === null) return;
    setSelection((m) => {
      const kept = [...m].filter(([lane, item]) => laneItemIds(s, lane).includes(item));
      return kept.length === m.size ? m : new Map(kept);
    });
  }, [s]);

  /** Set when the player opens a drawer; the drawer's mount takes it, so a remount (a view
   * switch, a layout change) never steals focus. */
  const opened = useRef(false);
  /** Set when the drawer unmounted holding focus: crossing 600 px swaps the shells (U-2c, U-2d)
   * and remounts it, so the remount takes the focus back. A flag no mount took in its own commit
   * is dropped by the effect below, so a later remount (a view switch back) never steals focus. */
  const leftFocused = useRef(false);
  const claimFocus = () => {
    const mine = opened.current || leftFocused.current;
    opened.current = false;
    leftFocused.current = false;
    return mine;
  };
  // After every commit, and after the drawer's own mount effect (children's run first).
  useEffect(() => {
    leftFocused.current = false;
  });

  const powerId = s === null ? null : powerLaneId(s);
  const openLane =
    open === null
      ? undefined
      : open.kind === "item"
        ? s?.content.items.get(open.itemId)?.lane
        : s?.content.recipes.get(open.recipeId)?.lane;
  /** V-25: the open drawer stays across a view switch, but renders only over its own lane: on
   * the factory view when its lane is the one shown (the desktop's power tab for a FUEL row or a
   * generator), and on the phone's power view for a FUEL row or a generator (U-6b, K-12). */
  const drawerTarget =
    (shown === "factory" && openLane === laneId) || (shown === "power" && openLane === powerId)
      ? open
      : null;
  /** The final review's item 2: on the phone only one sheet can be modal. A layout that becomes
   * the phone with the card and a drawer both open keeps the drawer (the more specific
   * context) and closes the card, focus staying with the drawer sheet. The render below never
   * shows the NEXT_BUY sheet over a drawer either, so not even one frame has two. */
  const sheetClash = mode === "phone" && whyOpen && drawerTarget !== null;
  useEffect(() => {
    if (sheetClash) closeWhy(false);
  });
  /** A lane tab: the drawer of another lane closes, so it never covers the new lane's rows.
   * Focus stays on the tab that was pressed. */
  const onLane = (lane: LaneId) => {
    setPicked(lane);
    if (openLane !== undefined && openLane !== lane) setOpen(null);
  };
  /** A row's click, → or Space: its drawer, the title taking focus (U-7c). */
  const openRow = (itemId: ItemId) => {
    opened.current = openItem !== itemId;
    setOpen({ kind: "item", itemId });
  };
  /** K-12: a generator row's button opens its drawer, the title taking focus. */
  const openGeneratorDrawer = (recipeId: RecipeId) => {
    opened.current = openGenerator !== recipeId;
    setOpen({ kind: "generator", recipeId });
  };
  /** U-7c: closing returns focus to the row list, the drawer's row still active. The drawer
   * renders on the factory view only, where the list always is. K-12: a generator drawer's
   * opener is its row's [data-open-generator] button; the row list if that's gone. */
  const rowList = () =>
    appRef.current?.querySelector<HTMLElement>('ul[role="listbox"][data-rows]') ?? null;
  const opener = (): HTMLElement | null => {
    if (open?.kind !== "generator" || s === null) return null;
    const cls = s.content.recipes.get(open.recipeId)?.machineClass;
    return cls === undefined
      ? null
      : (appRef.current?.querySelector<HTMLElement>(`[data-open-generator="${cls}"]`) ?? null);
  };
  /** K-3: where focus goes once the drawer has closed. Focus moves after the commit, since
   * on the phone the opener is inert until the sheet's host is gone. */
  const closeTo = useRef<HTMLElement | null | undefined>(undefined);
  const close = () => {
    closeTo.current = opener() ?? rowList();
    setOpen(null);
  };
  // Every layout cleanup (the inert pass's undo) runs before this.
  useLayoutEffect(() => {
    const back = closeTo.current;
    if (back === undefined) return;
    closeTo.current = undefined;
    (back !== null && back.isConnected ? back : rowList())?.focus();
  });
  /** K-11 / Review Focus 3: a key that closed the drawer or the card under focus, or unmounted
   * the focused view, puts focus on the shown view's own target once it's rendered, never
   * leaving it on <body>: the row list (the new lane's), the priority list's first row, or the
   * handbook's heading (never its search, where the next letter would type). */
  const refocusRows = useRef(false);
  useLayoutEffect(() => {
    if (!refocusRows.current) return;
    refocusRows.current = false;
    const at = document.activeElement;
    if (at !== null && at !== document.body) return;
    const app = appRef.current;
    const target =
      shown === "priority"
        ? app?.querySelector<HTMLElement>("#view-priority li[data-entry]")
        : shown === "handbook"
          ? app?.querySelector<HTMLElement>("[data-handbook] h2")
          : rowList();
    target?.focus();
  });

  /** §13.1 / V-18: the drawer's split bar goes to its item's entry in the priority list. */
  const showEntry = (itemId: ItemId) => {
    const entry = s?.state.priority.find((e) => e.kind === "item" && e.itemId === itemId);
    if (entry === undefined) return;
    setPane("priority");
    setFocusEntry(entry.id);
  };

  /** The handbook view is its route: the open drawer's entry, else the index (§13.4, V-25).
   * Another view leaves it. */
  const selectView = (next: View) => {
    if (next === "handbook") {
      if (!onHandbook) navigate({ kind: "handbook", itemId: openItem });
      return;
    }
    setPane(next);
    if (onHandbook) navigate({ kind: "game" });
  };

  /** The sheet's "open ROTOR": the sheet closes and that item's drawer opens, on its lane: the
   * power view for a power-lane item, since the phone's lane tabs have no power (U-6a). */
  const openFromSheet = (itemId: ItemId) => {
    closeWhy(false);
    const lane = s?.content.items.get(itemId)?.lane;
    if (lane !== undefined) {
      if (lane === powerId) setPane("power");
      else {
        setPicked(lane);
        setPane("factory");
      }
      select(lane, itemId);
    }
    opened.current = true;
    setOpen({ kind: "item", itemId });
  };

  const game = route.kind !== "callback" && s !== null && laneId !== null;
  /** L-11: the sheet only where the ticker is (the phone, a short viewport). */
  const logSheetShown = game && logOpen && !logBox;
  // A layout that gets the box (or a world being loaded) closes the sheet; focus that was in it
  // goes to the shown view's target (refocusRows). In a layout effect, so no frame has both.
  // K-5 holds across a resize into the phone (fix round 1, I-1): the ticker closes the card and
  // any drawer (openLog), and every other opener is inert while the sheet is open, so the log
  // sheet is never beside a second modal.
  useLayoutEffect(() => {
    if (!logOpen || logSheetShown) return;
    refocusRows.current = true;
    setLogOpen(false);
  }, [logOpen, logSheetShown]);
  /** The ticker: opening the log is a switch of context (I-1), so the NEXT_BUY card and any
   * open drawer close first, and the log sheet is the one modal. */
  const openLog = useCallback(() => {
    whyReturn.current = false;
    setWhyOpen(false);
    setOpen(null);
    setLogOpen(true);
  }, []);

  // U-7: the dispatcher. Every action is the click path (K-4): it clicks the real button, or
  // calls the handler the button calls. Each returns whether it found its target (K-9).
  const listLane = shown === "power" ? powerId : laneId;
  const listIds = () => (s === null || listLane === null ? [] : laneItemIds(s, listLane));
  const listCurrent = () =>
    listLane === null ? null : currentRow(listIds(), selection.get(listLane) ?? null, bottleneck);
  /** K-6: the opener of a keyboard-opened card or help: what had focus; from <body>, the shown
   * row list (or none off the row views). */
  const keyOpener = (): HTMLElement | null => {
    const at = document.activeElement;
    if (at instanceof HTMLElement && at !== document.body) return at;
    return shown === "factory" || shown === "power" ? rowList() : null;
  };
  /** Focus inside the main box goes with the view a key unmounts: back to the row list. */
  const inMain = () =>
    appRef.current?.querySelector("[data-main-box]")?.contains(document.activeElement) ?? false;
  /** K-4 / K-9: a key clicks its target; an off one (aria-disabled, as Guarded's are, or a
   * placeholder such as the phone's "Nothing to run") is a missing one, so the key is left
   * alone and nothing is prevented. */
  const click = (sel: string): HTMLElement | null => {
    const el = appRef.current?.querySelector<HTMLElement>(sel) ?? null;
    if (el === null || el.getAttribute("aria-disabled") === "true" || el.matches(":disabled"))
      return null;
    el.click();
    return el;
  };
  const keyActions: KeyActions = {
    context(): KeyContext {
      const at = document.activeElement;
      const why = appRef.current?.querySelector("[data-why]") ?? null;
      return {
        scope: scopeOf({
          help: helpOpen,
          settings: sheet !== null,
          phone: mode === "phone",
          why: whyOpen,
          drawer: drawerTarget !== null,
          log: logSheetShown,
        }),
        focus: focusKind(at),
        onRows: isRowList(at),
        view: shown,
        rows: shown === "factory" || (shown === "power" && powerId !== null),
        advice: why !== null && why.getAttribute("aria-disabled") !== "true",
        // K-12: ↑/↓ re-key an item drawer only; a generator drawer stays.
        follows: drawerTarget?.kind === "item",
      };
    },
    run: () => click("[data-command] [data-run]") !== null,
    runOne: () => click("[data-next-buy] [data-run-one]") !== null,
    why() {
      if (appRef.current?.querySelector("[data-why]") == null) return false;
      openWhy(keyOpener(), true);
      return true;
    },
    lane(n, closeDrawer) {
      const tab = lanes.find((t) => t.key === n);
      if (tab === undefined || tab.locked) return false;
      if (inMain()) refocusRows.current = true;
      selectView("factory");
      onLane(tab.id);
      if (closeDrawer && drawerTarget !== null) {
        refocusRows.current = true;
        setOpen(null);
      }
      return true;
    },
    view(v, closeDrawer, closeCard) {
      if (closeCard && whyOpen) {
        refocusRows.current = true;
        closeWhy(false);
      }
      if (inMain()) refocusRows.current = true;
      // selectView reads openItem before it's cleared: H opens the drawer's item's entry (K-10).
      selectView(v);
      if (closeDrawer && drawerTarget !== null) {
        refocusRows.current = true;
        setOpen(null);
      }
      return true;
    },
    move(to, follow) {
      if (listLane === null) return false;
      const next = stepRow(listIds(), listCurrent(), to);
      if (next === null) return false;
      select(listLane, next);
      document.getElementById(rowId(next))?.scrollIntoView?.({ block: "nearest" });
      if (follow && drawerTarget !== null) {
        // U-5a / U-7c: the drawer re-keys on the new row and its title takes focus.
        if (drawerTarget.kind !== "item" || next !== drawerTarget.itemId) {
          opened.current = true;
          setOpen({ kind: "item", itemId: next });
        }
      } else rowList()?.focus();
      return true;
    },
    open() {
      const id = listCurrent();
      if (id === null || listLane === null) return false;
      select(listLane, id);
      openRow(id);
      return true;
    },
    close() {
      close();
      return true;
    },
    help() {
      if (helpOpen) closeHelp();
      else openHelp(keyOpener());
      return true;
    },
    section(k: SectionKey) {
      const el = click(`[data-drawer] [data-key="${k}"]`);
      if (el === null) return false;
      if (el.matches("[data-section]")) el.focus(); // K-11
      return true;
    },
  };
  useKeyboard(game, keyActions, store);
  let main: ReactNode;
  if (route.kind === "callback") {
    // O-8: only this line while the sign-in finishes, so nothing can change the URL mid-request.
    main = <p className="app-loading">Signing in…</p>;
  } else if (s === null || laneId === null) {
    main = <p className="app-loading">Loading your factory…</p>;
  } else if (shown === "handbook") {
    main = (
      <Handbook
        snapshot={s}
        itemId={route.kind === "handbook" ? route.itemId : null}
        onOpen={(itemId) => navigate({ kind: "handbook", itemId })}
      />
    );
  } else if (shown === "priority") {
    main = (
      <PriorityList
        store={store}
        snapshot={s}
        focusEntry={focusEntry}
        onFocused={() => setFocusEntry(null)}
      />
    );
  } else if (shown === "power" || laneId === powerId) {
    // U-6a: the phone's ~ power tab, or the desktop's 5 POWER lane tab: one panel.
    const lane = powerId ?? laneId;
    main = (
      <PowerPanel
        store={store}
        snapshot={s}
        view={view}
        bottleneck={bottleneck}
        selected={selection.get(lane) ?? null}
        onSelect={(itemId) => select(lane, itemId)}
        onOpen={openRow}
        openItem={openItem}
        onOpenGenerator={openGeneratorDrawer}
        openGenerator={drawerTarget?.kind === "generator" ? openGenerator : null}
        mode={mode}
      />
    );
  } else {
    main = (
      <RowList
        store={store}
        snapshot={s}
        laneId={laneId}
        bottleneck={bottleneck}
        selected={selection.get(laneId) ?? null}
        onSelect={(itemId) => select(laneId, itemId)}
        onOpen={openRow}
        openItem={openItem}
        mode={mode}
      />
    );
  }

  const drawer =
    game && drawerTarget !== null ? (
      <Drawer
        key={drawerKey(drawerTarget)}
        store={store}
        snapshot={s}
        target={drawerTarget}
        pending={view.pending}
        onClose={close}
        onSplit={showEntry}
        presentation={mode === "phone" ? "sheet" : "panel"}
        claimFocus={claimFocus}
        onLeaveFocused={() => (leftFocused.current = true)}
        cardOpen={whyOpen && mode !== "phone"}
        trendInMeta={mode !== "desktop"}
      />
    ) : null;

  const command =
    game && s !== null ? { model: bottleneck, snapshot: s, store, pending: view.pending } : null;
  const card =
    command !== null && whyOpen && mode !== "phone" ? (
      <NextBuyCard {...command} onClose={closeWhy} />
    ) : null;

  const props: ShellProps = {
    store,
    view,
    snapshot: route.kind === "callback" ? null : s,
    mode,
    shown,
    onView: selectView,
    lanes,
    laneId,
    onLane,
    bottleneck,
    cardOpen: card !== null,
    onSettings: (opener) => openSheet({}, opener),
    onSaveChip: (opener) => openSheet({ section: "account" }, opener),
    onHelp: openHelp,
    slots: {
      main,
      overlays: (
        <>
          {/* U-5a: the panel, an absolute sibling of the main box over its right columns. */}
          {mode !== "phone" && drawer}
          {card}
        </>
      ),
      command:
        command === null ? null : mode === "phone" ? (
          <CommandSplit {...command} onWhy={openWhy} />
        ) : (
          <CommandBar
            {...command}
            onWhy={openWhy}
            whyOpen={whyOpen}
            mode={mode}
            instant={whyOpen || helpOpen || sheet !== null || logSheetShown}
          />
        ),
      // U-9a / L-10: the box, else the ticker (rendered only once there's a line).
      log: !game ? null : logBox ? <FactoryLog /> : <LogTicker onOpen={openLog} />,
      footer:
        game && mode !== "phone" ? (
          <PowerFooter store={store} snapshot={s} taps={view.taps} pending={view.pending} />
        ) : null,
      floating:
        game && mode === "phone" ? (
          <FloatingTap
            store={store}
            snapshot={s}
            taps={view.taps}
            pending={view.pending}
            withCommand={shown === "factory" && command !== null}
          />
        ) : null,
    },
  };

  return (
    <FeelContext.Provider value={feel}>
      <AnnounceContext.Provider value={announcer}>
        <TickContext.Provider value={ticks}>
          <div
            ref={appRef}
            className="app"
            data-layout={mode}
            data-route={route.kind}
            data-sync={view.status}
            data-state-version={s === null ? "" : String(s.stateVersion)}
            data-polling={view.polling ? "armed" : "off"}
          >
            {mode === "phone" ? <PhoneShell {...props} /> : <DesktopShell {...props} />}
            {/* K-3: the phone's modal sheet, its backdrop on the app root over the TAP and the
              bottom tabs (inert while it's open). */}
            {mode === "phone" && drawer}
            {command !== null && whyOpen && mode === "phone" && drawerTarget === null && (
              <NextBuySheet
                {...command}
                onClose={() => closeWhy(true)}
                onOpenItem={openFromSheet}
              />
            )}
            {logSheetShown && <LogSheet onClose={closeLog} />}
            {helpOpen && <Help onClose={closeHelp} />}
            {sheet !== null && (
              <Settings store={store} view={view} {...sheet} onClose={closeSheet} />
            )}
          </div>
        </TickContext.Provider>
      </AnnounceContext.Provider>
    </FeelContext.Provider>
  );
}
