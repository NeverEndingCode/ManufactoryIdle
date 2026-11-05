// The app: the store wiring, the announcer, the tick, the settings sheet (S-11: state, not a
// route) and the route (S-10). The markup is the shell's (U-2): DesktopShell for desktop and
// tablet, PhoneShell below 600 px, both filling this .app root. App holds the view state (V-25):
// the selected lane, the factory / priority / phone power view, the open drawer, and each lane's
// selected row (U-7d); the handbook view is its route. The store is created and started outside React (main.tsx).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ItemId, LaneId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { useGame } from "../sync/use-game.js";
import {
  bottleneckRow,
  laneItemIds,
  laneTabs,
  powerLaneId,
  type BottleneckModel,
} from "./derive.js";
import { inertOutside } from "./dialog.js";
import { Drawer } from "./Drawer.js";
import { Handbook } from "./Handbook.js";
import { AnnounceContext, createAnnouncer, type Announcer } from "./announce.js";
import { capabilities } from "./capabilities.js";
import { CommandBar, CommandSplit } from "./CommandBar.js";
import { FloatingTap } from "./FloatingTap.js";
import { NextBuyCard, NextBuySheet } from "./NextBuy.js";
import { useNotation } from "./notation.js";
import { PowerFooter } from "./PowerFooter.js";
import { PowerPanel } from "./PowerPanel.js";
import { PriorityList } from "./PriorityList.js";
import { ResetPassword } from "./ResetPassword.js";
import { replaceRoute, useRoute } from "./route.js";
import { RowList } from "./RowList.js";
import { Settings, type SettingsProps } from "./Settings.js";
import { DesktopShell, OverlayPanel, PhoneShell, type ShellProps, type View } from "./Shell.js";
import { syncCapabilities } from "./theme.js";
import { useLayoutMode } from "./use-layout-mode.js";
import { createTickSource, TickContext } from "./use-tick.js";

type SheetAt = Pick<SettingsProps, "section" | "mode">;

/** What the bottleneck announcement keys on: the framed item, a frameless one, or none. */
function bottleneckKey(b: BottleneckModel | null): string | null {
  if (b === null) return null;
  return b.itemId === null ? "\u0000frameless" : `item:${b.itemId}`;
}

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
  /** The why button toggles: a second press closes the card, focus staying on it. */
  const openWhy = (opener: HTMLElement) => {
    if (whyOpen) {
      whyReturn.current = true;
      setWhyOpen(false);
      return;
    }
    whyOpener.current = opener;
    setWhyOpen(true);
  };
  const closeWhy = (returnFocus: boolean) => {
    whyReturn.current = returnFocus;
    setWhyOpen(false);
  };
  // S-11 / V-12: while a modal (the settings sheet, the phone's NEXT_BUY sheet) is open
  // everything outside it is inert, but the live region never is (W-20: the one region keeps
  // speaking, and the sheet's announcements land there); only its controls go inert. Every
  // commit, undone first, since lanes and notice buttons can mount while it is open.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (app === null) return;
    const host =
      sheet !== null
        ? app.querySelector("[data-settings-host]")
        : app.querySelector("[data-next-buy-host]");
    if (sheet === null && host === null) return;
    return inertOutside(app, host === null ? [] : [host], app.querySelector(".notices"));
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
    (back !== null && back.isConnected
      ? back
      : appRef.current?.querySelector<HTMLElement>("[data-why]")
    )?.focus();
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
  const [openItem, setOpenItem] = useState<ItemId | null>(null);
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
  const claimFocus = () => {
    const mine = opened.current;
    opened.current = false;
    return mine;
  };

  const powerId = s === null ? null : powerLaneId(s);
  /** V-25: the open drawer stays across a view switch, but renders on the factory view only,
   * and on the phone's power view for a FUEL row (U-6b). */
  const drawerItem =
    shown === "factory" ||
    (shown === "power" && openItem !== null && s?.content.items.get(openItem)?.lane === powerId)
      ? openItem
      : null;
  /** A row's click, → or Space: its drawer, the title taking focus (U-7c). */
  const openRow = (itemId: ItemId) => {
    opened.current = openItem !== itemId;
    setOpenItem(itemId);
  };
  /** U-7c: closing returns focus to the row list, the drawer's row still active. The drawer
   * renders on the factory view only, where the list always is. */
  const close = () => {
    appRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
    setOpenItem(null);
  };

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

  /** The sheet's "open ROTOR": the sheet closes and that item's drawer opens, on its lane. */
  const openFromSheet = (itemId: ItemId) => {
    closeWhy(false);
    const lane = s?.content.items.get(itemId)?.lane;
    if (lane !== undefined) {
      setPicked(lane);
      select(lane, itemId);
    }
    opened.current = true;
    setOpenItem(itemId);
  };

  const game = route.kind !== "reset-password" && s !== null && laneId !== null;
  let main: ReactNode;
  if (route.kind === "reset-password") {
    main = (
      <ResetPassword
        store={store}
        view={view}
        onDone={() => {
          // The used link isn't a page to go back to.
          replaceRoute({ kind: "game" });
          openSheet({ section: "account", mode: "sign-in" }, null);
        }}
      />
    );
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
    game && drawerItem !== null ? (
      <Drawer
        key={drawerItem}
        store={store}
        snapshot={s}
        itemId={drawerItem}
        pending={view.pending}
        onClose={close}
        sheet={mode === "phone"}
        claimFocus={claimFocus}
        onSplit={showEntry}
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
    snapshot: route.kind === "reset-password" ? null : s,
    mode,
    shown,
    onView: selectView,
    lanes,
    laneId,
    onLane: setPicked,
    bottleneck,
    onSettings: (opener) => openSheet({}, opener),
    onSaveChip: (opener) => openSheet({ section: "account", mode: "sign-up" }, opener),
    slots: {
      main,
      overlays: (
        <>
          {drawer !== null && mode !== "phone" ? <OverlayPanel>{drawer}</OverlayPanel> : drawer}
          {card}
        </>
      ),
      command:
        command === null ? null : mode === "phone" ? (
          <CommandSplit {...command} onWhy={openWhy} />
        ) : (
          <CommandBar {...command} onWhy={openWhy} whyOpen={whyOpen} />
        ),
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
          {command !== null && whyOpen && mode === "phone" && (
            <NextBuySheet {...command} onClose={() => closeWhy(true)} onOpenItem={openFromSheet} />
          )}
          {sheet !== null && <Settings store={store} view={view} {...sheet} onClose={closeSheet} />}
        </div>
      </TickContext.Provider>
    </AnnounceContext.Provider>
  );
}
