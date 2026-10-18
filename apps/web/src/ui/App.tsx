// The 4a shell (W-1 item 1): the header, the notices, the lane tabs and the visible lane.
// The store is created and started outside React (main.tsx) and passed in.
import { useMemo, useState } from "react";
import type { LaneId } from "@manufactory/engine";
import type { GameStore } from "../sync/store.js";
import { useGame } from "../sync/use-game.js";
import { bottleneckRow, unlockedLanes } from "./derive.js";
import { LaneView } from "./LaneView.js";
import styles from "./LaneView.module.css";
import { Notices } from "./Notices.js";
import { createTickSource, TickContext } from "./use-tick.js";

export function App({ store }: { store: GameStore }) {
  const view = useGame(store);
  const ticks = useMemo(() => createTickSource(store), [store]);
  const s = view.snapshot;
  const lanes = useMemo(() => (s ? unlockedLanes(s) : []), [s]);
  const bottleneck = useMemo(() => (s ? bottleneckRow(s) : null), [s]);
  const [picked, setPicked] = useState<LaneId | null>(null);
  const laneId = lanes.some((l) => l.id === picked) ? picked : (lanes[0]?.id ?? null);

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
          <>
            <div role="tablist" aria-label="Lanes" className={styles.tabs}>
              {lanes.map((lane) => {
                const selected = lane.id === laneId;
                return (
                  <button
                    key={lane.id}
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
            />
          </>
        )}
      </div>
    </TickContext.Provider>
  );
}
