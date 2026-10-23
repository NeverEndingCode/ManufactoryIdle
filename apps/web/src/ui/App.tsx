// The shell: the header, the notices, then the route (S-10): the W-19 panes (Q-7) or the
// reset-password page. The lanes pane (tabs and the visible lane), the detail pane (the
// drawer, or a hint), the priority list and the dock slot. The settings sheet (S-11) is state,
// not a route. The store is created and started outside React (main.tsx).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ItemId, LaneId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { useGame } from "../sync/use-game.js";
import { bottleneckRow, unlockedLanes, type BottleneckModel } from "./derive.js";
import { Drawer } from "./Drawer.js";
import { Handbook } from "./Handbook.js";
import layout from "./Layout.module.css";
import { LaneView } from "./LaneView.js";
import styles from "./LaneView.module.css";
import { AnnounceContext, createAnnouncer, type Announcer } from "./announce.js";
import { Notices } from "./Notices.js";
import { PowerDock } from "./PowerDock.js";
import { useNotation } from "./notation.js";
import { PriorityList } from "./PriorityList.js";
import { ResetPassword } from "./ResetPassword.js";
import { replaceRoute, useRoute } from "./route.js";
import { Settings, type SettingsProps } from "./Settings.js";
import { TierReadout } from "./TierReadout.js";
import { usePanes } from "./use-panes.js";
import { createTickSource, TickContext } from "./use-tick.js";

type View = "factory" | "priority" | "handbook";
/** Two and three panes: the handbook takes the detail pane, so the switch has two views. */
const VIEWS: readonly { id: View; name: string }[] = [
  { id: "factory", name: "Factory" },
  { id: "priority", name: "Priority" },
];
/** One pane (W-19): the tab bar's third view is the handbook, which is the route. */
const VIEWS_ONE_PANE: readonly { id: View; name: string }[] = [
  ...VIEWS,
  { id: "handbook", name: "Handbook" },
];

const openerOf = (itemId: ItemId) =>
  document.querySelector<HTMLElement>(`[data-item="${itemId}"] [data-open-row]`);

/** WAI-ARIA tabs, automatic activation: the arrows, Home and End; modifiers are left to the
 * browser and the OS. The index to select, or null. */
function tabTarget(e: KeyboardEvent, i: number, n: number): number | null {
  if (e.altKey || e.ctrlKey || e.metaKey || i === -1 || n === 0) return null;
  switch (e.key) {
    case "ArrowRight":
      return (i + 1) % n;
    case "ArrowLeft":
      return (i - 1 + n) % n;
    case "Home":
      return 0;
    case "End":
      return n - 1;
    default:
      return null;
  }
}

type SheetAt = Pick<SettingsProps, "section" | "mode">;

/** What goes inert inside the notices while the sheet is open; the region itself never does. */
const NOTICE_CONTROLS = "button, a, input, select, textarea, [tabindex]";

/** S-12: the "Save your factory" chip, from the first milestone on, for a guest only. */
function showsChip(view: ReturnType<typeof useGame>): boolean {
  return (
    view.accounts === "on" &&
    view.identity === "guest" &&
    view.snapshot !== null &&
    view.snapshot.state.tier >= 1
  );
}

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
  const [route, navigate] = useRoute();
  // Every number goes through fmt(): a notation change re-renders the tree (S-11).
  useNotation();
  const [sheet, setSheet] = useState<SheetAt | null>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
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
  // S-11: while the sheet is open the background is inert (React 18 has no prop for it). The
  // notices' live region is the exception (W-20: the one region keeps speaking, and the
  // sheet's announcements land there), so only the controls inside it go inert. Every commit,
  // since panes and notice buttons can mount while it is open. Focus returns once inert is
  // gone.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (app === null) return;
    const open = sheet !== null;
    for (const el of Array.from(app.children)) {
      if (el.hasAttribute("data-settings-host")) continue;
      if (el.classList.contains("notices")) {
        for (const c of Array.from(el.querySelectorAll(NOTICE_CONTROLS)))
          c.toggleAttribute("inert", open);
        continue;
      }
      el.toggleAttribute("inert", open);
    }
    if (sheet === null && returnFocus.current) {
      returnFocus.current = false;
      const back = sheetOpener.current;
      sheetOpener.current = null;
      (back !== null && back.isConnected && back !== document.body
        ? back
        : settingsButton.current
      )?.focus();
    }
  });
  const ticks = useMemo(() => createTickSource(store), [store]);
  const announcer = useMemo(() => createAnnouncer(), []);
  const s = view.snapshot;
  const lanes = useMemo(() => (s ? unlockedLanes(s) : []), [s]);
  const bottleneck = useMemo(() => (s ? bottleneckRow(s) : null), [s]);
  useBottleneckAnnouncement(announcer, s, bottleneck);
  const [picked, setPicked] = useState<LaneId | null>(null);
  const laneId = lanes.some((l) => l.id === picked) ? picked : (lanes[0]?.id ?? null);
  const tabRefs = useRef(new Map<LaneId, HTMLButtonElement>());
  const panes = usePanes();
  const [pane, setPane] = useState<Exclude<View, "handbook">>("factory");
  const onHandbook = route.kind === "handbook";
  const views = panes === 1 ? VIEWS_ONE_PANE : VIEWS;
  // The handbook is a route, not state: below 600 px it is the shown view while it is open.
  const shown: View = panes === 1 && onHandbook ? "handbook" : pane;
  const [openItem, setOpenItem] = useState<ItemId | null>(null);

  // The fixed dock's real height, as --dock-h on the layout, so the column reserves exactly
  // what the dock covers (it wraps taller at 320 px). Without ResizeObserver, the CSS's 6rem.
  const layoutRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const hasLayout = route.kind !== "reset-password" && s !== null && laneId !== null;
  useEffect(() => {
    const host = layoutRef.current;
    const dock = dockRef.current;
    if (!hasLayout || host === null || dock === null || typeof ResizeObserver !== "function")
      return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e === undefined) return;
      const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
      host.style.setProperty("--dock-h", `${Math.ceil(h)}px`);
    });
    ro.observe(dock);
    return () => ro.disconnect();
  }, [hasLayout]);
  const [focusEntry, setFocusEntry] = useState<string | null>(null);

  const viewRefs = useRef(new Map<View, HTMLButtonElement>());
  /** Set when the player opens a drawer; the drawer's mount takes it, so a remount (a view
   * switch) never steals focus. */
  const opened = useRef(false);
  const claimFocus = () => {
    const mine = opened.current;
    opened.current = false;
    return mine;
  };

  const sheetOpen = panes === 1 && shown === "factory" && openItem !== null;
  /** A drawer on screen: the one the header's Handbook button opens the entry of (§13.4). */
  const drawerItem = !onHandbook && (panes >= 2 || shown === "factory") ? openItem : null;
  const toggle = (itemId: ItemId) => {
    // W-19: the handbook holds the detail pane; opening a row's drawer goes back to the game.
    if (onHandbook) {
      opened.current = true;
      setOpenItem(itemId);
      navigate({ kind: "game" });
      return;
    }
    opened.current = openItem !== itemId;
    setOpenItem(openItem === itemId ? null : itemId);
  };
  /** Closing returns focus to the row button that opened the drawer; when that row is gone
   * (another lane, or the Priority view), to the selected lane tab, else the selected view tab. */
  const close = () => {
    const back =
      (openItem === null ? null : openerOf(openItem)) ??
      (laneId === null ? undefined : tabRefs.current.get(laneId)) ??
      viewRefs.current.get(shown) ??
      null;
    back?.focus();
    setOpenItem(null);
  };

  /** §13.1: a split bar goes to its item's entry in the priority list. */
  const showEntry = (itemId: ItemId) => {
    const entry = s?.state.priority.find((e) => e.kind === "item" && e.itemId === itemId);
    if (entry === undefined) return;
    if (panes < 3) setPane("priority");
    setFocusEntry(entry.id);
  };

  /** Below 600 px the handbook view is its route; Factory or Priority leaves it. */
  const selectView = (next: View) => {
    if (next === "handbook") {
      if (!onHandbook) navigate({ kind: "handbook", itemId: null });
      return;
    }
    setPane(next);
    if (panes === 1 && onHandbook) navigate({ kind: "game" });
  };

  const onViewKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = tabTarget(
      e,
      views.findIndex((v) => v.id === shown),
      views.length,
    );
    if (to === null) return;
    e.preventDefault();
    const next = views[to]!.id;
    selectView(next);
    viewRefs.current.get(next)?.focus();
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = tabTarget(
      e,
      lanes.findIndex((l) => l.id === laneId),
      lanes.length,
    );
    if (to === null) return;
    e.preventDefault();
    const next = lanes[to]!.id;
    setPicked(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <AnnounceContext.Provider value={announcer}>
      <TickContext.Provider value={ticks}>
        <div
          ref={appRef}
          className="app"
          data-route={route.kind}
          data-sync={view.status}
          data-state-version={s === null ? "" : String(s.stateVersion)}
          data-polling={view.polling ? "armed" : "off"}
        >
          <header className="app-header">
            {/* Below 600 px the initials, so the header fits at 320 px. */}
            <h1 aria-label="Manufactory Idle">
              <span className="title-full" aria-hidden="true">
                Manufactory Idle
              </span>
              <span className="title-short" aria-hidden="true">
                MI
              </span>
            </h1>
            {s !== null && route.kind !== "reset-password" && (
              <TierReadout snapshot={s} now={() => store.now()} />
            )}
            <div className="app-actions">
              {showsChip(view) && route.kind !== "reset-password" && (
                <button
                  type="button"
                  className="btn chip"
                  data-save-chip
                  onClick={(e) =>
                    openSheet({ section: "account", mode: "sign-up" }, e.currentTarget)
                  }
                >
                  Save your factory
                </button>
              )}
              <button
                type="button"
                className="btn secondary"
                data-open-handbook
                // §13.4's context-aware icon: the open drawer's entry, else the index.
                onClick={() => navigate({ kind: "handbook", itemId: drawerItem })}
              >
                Handbook
              </button>
              <button
                ref={settingsButton}
                type="button"
                className="btn secondary"
                data-open-settings
                aria-haspopup="dialog"
                onClick={(e) => openSheet({}, e.currentTarget)}
              >
                Settings
              </button>
            </div>
          </header>
          <Notices store={store} view={view} bottleneck={bottleneck} />
          {route.kind === "reset-password" ? (
            <ResetPassword
              store={store}
              view={view}
              onDone={() => {
                // The used link isn't a page to go back to.
                replaceRoute({ kind: "game" });
                openSheet({ section: "account", mode: "sign-in" }, null);
              }}
            />
          ) : s === null || laneId === null ? (
            <p className="app-loading">Loading your factory…</p>
          ) : (
            <div
              ref={layoutRef}
              className={`layout ${layout.layout}`}
              data-panes={panes}
              data-view={shown}
              data-sheet={sheetOpen ? "open" : undefined}
            >
              {panes < 3 && (
                <div
                  role="tablist"
                  aria-label="View"
                  className={panes === 1 ? layout.tabbar : layout.switch}
                  onKeyDown={onViewKey}
                >
                  {views.map((v) => (
                    <button
                      key={v.id}
                      ref={(el) => {
                        if (el) viewRefs.current.set(v.id, el);
                        else viewRefs.current.delete(v.id);
                      }}
                      type="button"
                      role="tab"
                      aria-selected={shown === v.id}
                      tabIndex={shown === v.id ? 0 : -1}
                      // Only the shown view's pane is rendered below three panes.
                      aria-controls={shown === v.id ? `pane-${v.id}` : undefined}
                      className={shown === v.id ? `${layout.view} ${layout.on}` : layout.view}
                      onClick={() => selectView(v.id)}
                    >
                      {v.name}
                    </button>
                  ))}
                </div>
              )}
              {(panes === 3 || shown === "factory") && (
                <div id="pane-factory" className={layout.lanes}>
                  <div
                    role="tablist"
                    aria-label="Lanes"
                    className={styles.tabs}
                    onKeyDown={onTabKey}
                  >
                    {lanes.map((lane) => {
                      const selected = lane.id === laneId;
                      return (
                        <button
                          key={lane.id}
                          ref={(el) => {
                            if (el) tabRefs.current.set(lane.id, el);
                            else tabRefs.current.delete(lane.id);
                          }}
                          type="button"
                          role="tab"
                          id={`lane-tab-${lane.id}`}
                          aria-selected={selected}
                          aria-controls="lane-panel"
                          tabIndex={selected ? 0 : -1}
                          className={selected ? `${styles.tab} ${styles.on}` : styles.tab}
                          data-lane={lane.id}
                          onClick={() => setPicked(lane.id)}
                        >
                          {lane.name}
                          {bottleneck?.laneId === lane.id && (
                            <span role="img" aria-label="bottleneck" className={styles.mark}>
                              !
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
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
                </div>
              )}
              {shown === "handbook" && (
                <div id="pane-handbook" className={layout.lanes}>
                  <Handbook
                    snapshot={s}
                    itemId={route.kind === "handbook" ? route.itemId : null}
                    onOpen={(itemId) => navigate({ kind: "handbook", itemId })}
                  />
                </div>
              )}
              {/* One stable spot for the drawer at every width, so a pane-count change
                re-renders it in place (as a sheet below 600 px) instead of remounting it. At two
                and three panes the handbook takes it while its route is open (W-19). */}
              <div className={panes === 1 ? layout.sheetHost : layout.detail}>
                {panes >= 2 && route.kind === "handbook" ? (
                  <Handbook
                    snapshot={s}
                    itemId={route.itemId}
                    onOpen={(itemId) => navigate({ kind: "handbook", itemId })}
                  />
                ) : drawerItem !== null ? (
                  <Drawer
                    key={drawerItem}
                    store={store}
                    snapshot={s}
                    itemId={drawerItem}
                    pending={view.pending}
                    onClose={close}
                    sheet={panes === 1}
                    claimFocus={claimFocus}
                  />
                ) : (
                  panes >= 2 && <p className={layout.hint}>Tap a row to buy, upgrade or store</p>
                )}
              </div>
              {(panes === 3 || shown === "priority") && (
                <div id="pane-priority" className={layout.priority} data-priority-slot>
                  <PriorityList
                    store={store}
                    snapshot={s}
                    focusEntry={focusEntry}
                    onFocused={() => setFocusEntry(null)}
                  />
                </div>
              )}
              <div ref={dockRef} className={layout.dock} data-dock-slot>
                <PowerDock store={store} snapshot={s} taps={view.taps} pending={view.pending} />
              </div>
            </div>
          )}
          {sheet !== null && <Settings store={store} view={view} {...sheet} onClose={closeSheet} />}
        </div>
      </TickContext.Provider>
    </AnnounceContext.Provider>
  );
}
