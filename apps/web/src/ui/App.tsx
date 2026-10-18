// The shell: the header, the notices, then the W-19 panes (Q-7). The lanes pane (tabs and the
// visible lane), the detail pane (the drawer, or a hint), the priority slot (Task 4) and the
// dock slot (Task 5). The store is created and started outside React (main.tsx).
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ItemId, LaneId } from "@manufactory/engine";
import type { GameStore } from "../sync/store.js";
import { useGame } from "../sync/use-game.js";
import { bottleneckRow, unlockedLanes } from "./derive.js";
import { Drawer } from "./Drawer.js";
import layout from "./Layout.module.css";
import { LaneView } from "./LaneView.js";
import styles from "./LaneView.module.css";
import { Notices } from "./Notices.js";
import { usePanes } from "./use-panes.js";
import { createTickSource, TickContext } from "./use-tick.js";

type View = "factory" | "priority";
const VIEWS: readonly { id: View; name: string }[] = [
  { id: "factory", name: "Factory" },
  { id: "priority", name: "Priority" },
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

export function App({ store }: { store: GameStore }) {
  const view = useGame(store);
  const ticks = useMemo(() => createTickSource(store), [store]);
  const s = view.snapshot;
  const lanes = useMemo(() => (s ? unlockedLanes(s) : []), [s]);
  const bottleneck = useMemo(() => (s ? bottleneckRow(s) : null), [s]);
  const [picked, setPicked] = useState<LaneId | null>(null);
  const laneId = lanes.some((l) => l.id === picked) ? picked : (lanes[0]?.id ?? null);
  const tabRefs = useRef(new Map<LaneId, HTMLButtonElement>());
  const panes = usePanes();
  const [shown, setShown] = useState<View>("factory");
  const [openItem, setOpenItem] = useState<ItemId | null>(null);

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
  const toggle = (itemId: ItemId) => {
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

  const onViewKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = tabTarget(
      e,
      VIEWS.findIndex((v) => v.id === shown),
      VIEWS.length,
    );
    if (to === null) return;
    e.preventDefault();
    const next = VIEWS[to]!.id;
    setShown(next);
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
    <TickContext.Provider value={ticks}>
      <div
        className="app"
        data-sync={view.status}
        data-state-version={s === null ? "" : String(s.stateVersion)}
      >
        <header className="app-header">
          <h1>Manufactory Idle</h1>
        </header>
        <Notices store={store} view={view} bottleneck={bottleneck} />
        {s === null || laneId === null ? (
          <p className="app-loading">Loading your factory…</p>
        ) : (
          <div
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
                {VIEWS.map((v) => (
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
                    onClick={() => setShown(v.id)}
                  >
                    {v.name}
                  </button>
                ))}
              </div>
            )}
            {(panes === 3 || shown === "factory") && (
              <div id="pane-factory" className={layout.lanes}>
                <div role="tablist" aria-label="Lanes" className={styles.tabs} onKeyDown={onTabKey}>
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
                />
              </div>
            )}
            {/* One stable spot for the drawer at every width, so a pane-count change
                re-renders it in place (as a sheet below 600 px) instead of remounting it. */}
            <div className={panes === 1 ? layout.sheetHost : layout.detail}>
              {openItem !== null && (panes >= 2 || shown === "factory") ? (
                <Drawer
                  key={openItem}
                  store={store}
                  snapshot={s}
                  itemId={openItem}
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
              <div id="pane-priority" className={layout.priority} data-priority-slot />
            )}
            <div className={layout.dock} data-dock-slot />
          </div>
        )}
      </div>
    </TickContext.Provider>
  );
}
