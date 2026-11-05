// The app: the store wiring, the announcer, the tick, the settings sheet (S-11: state, not a
// route) and the route (S-10). The markup is the shell's (U-2): DesktopShell for desktop and
// tablet, PhoneShell below 600 px, both filling this .app root. App holds the view state (V-25):
// the selected lane, the factory / priority / phone power view, and the open drawer; the
// handbook view is its route. The store is created and started outside React (main.tsx).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ItemId, LaneId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { useGame } from "../sync/use-game.js";
import { bottleneckRow, laneTabs, type BottleneckModel } from "./derive.js";
import { inertOutside } from "./dialog.js";
import { Drawer } from "./Drawer.js";
import { Handbook } from "./Handbook.js";
import { LaneView } from "./LaneView.js";
import { AnnounceContext, createAnnouncer, type Announcer } from "./announce.js";
import { capabilities } from "./capabilities.js";
import { PowerDock } from "./PowerDock.js";
import { useNotation } from "./notation.js";
import { PriorityList } from "./PriorityList.js";
import { ResetPassword } from "./ResetPassword.js";
import { replaceRoute, useRoute } from "./route.js";
import { Settings, type SettingsProps } from "./Settings.js";
import { DesktopShell, OverlayPanel, PhoneShell, type ShellProps, type View } from "./Shell.js";
import { syncCapabilities } from "./theme.js";
import { useLayoutMode } from "./use-layout-mode.js";
import { createTickSource, TickContext } from "./use-tick.js";

const openerOf = (itemId: ItemId) =>
  document.querySelector<HTMLElement>(`[data-item="${itemId}"] [data-open-row]`);

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
 * at 4 Hz. A frameless bottleneck is already a notice line inside the region: not said twice.
 */
function useBottleneckAnnouncement(
  announcer: Announcer,
  s: Snapshot | null,
  bottleneck: BottleneckModel | null,
) {
  const key = s === null ? undefined : bottleneckKey(bottleneck);
  const text = bottleneck?.text ?? null;
  const framed = bottleneck !== null && bottleneck.itemId !== null;
  /** The key last seen; undefined before the first snapshot. */
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const before = seen.current;
    seen.current = key;
    if (key === undefined || before === undefined || before === key) return;
    if (key === null) announcer.announce("No bottleneck");
    else if (framed) announcer.announce(`Bottleneck: ${text}`);
  }, [announcer, key, text, framed]);
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
  // S-11 / V-12: while the sheet is open everything outside it is inert, but the live region
  // never is (W-20: the one region keeps speaking, and the sheet's announcements land there);
  // only its controls go inert. Every commit, undone first, since lanes and notice buttons can
  // mount while it is open.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (app === null || sheet === null) return;
    const host = app.querySelector("[data-settings-host]");
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

  /** Set when the player opens a drawer; the drawer's mount takes it, so a remount (a view
   * switch, a layout change) never steals focus. */
  const opened = useRef(false);
  const claimFocus = () => {
    const mine = opened.current;
    opened.current = false;
    return mine;
  };

  /** V-25: the open drawer stays across a view switch, but renders on the factory view only. */
  const drawerItem = shown === "factory" ? openItem : null;
  const toggle = (itemId: ItemId) => {
    opened.current = openItem !== itemId;
    setOpenItem(openItem === itemId ? null : itemId);
  };
  /** Closing returns focus to the row button that opened the drawer; when that row is gone
   * (another lane), to the selected lane tab, else the shown view's tab. */
  const close = () => {
    const back =
      (openItem === null ? null : openerOf(openItem)) ??
      (laneId === null ? null : document.getElementById(`lane-tab-${laneId}`)) ??
      document.querySelector<HTMLElement>(`[data-view="${shown}"]`);
    back?.focus();
    setOpenItem(null);
  };

  /** §13.1: a split bar goes to its item's entry in the priority list. */
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
  } else if (shown === "power") {
    main = <PowerDock store={store} snapshot={s} taps={view.taps} pending={view.pending} />;
  } else {
    main = (
      <LaneView
        store={store}
        snapshot={s}
        laneId={laneId}
        bottleneck={bottleneck}
        pending={view.pending}
        openItem={openItem}
        onOpen={toggle}
        onSplit={showEntry}
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
      />
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
      overlays:
        drawer !== null && mode !== "phone" ? <OverlayPanel>{drawer}</OverlayPanel> : drawer,
      command: null,
      footer:
        game && mode !== "phone" ? (
          <PowerDock store={store} snapshot={s} taps={view.taps} pending={view.pending} />
        ) : null,
      floating: null,
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
          {sheet !== null && <Settings store={store} view={view} {...sheet} onClose={closeSheet} />}
        </div>
      </TickContext.Provider>
    </AnnounceContext.Provider>
  );
}
