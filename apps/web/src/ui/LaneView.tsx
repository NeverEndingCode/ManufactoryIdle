// One lane's rows (W-19: only the visible lane renders). At most one row is framed (P-2).
import { useCallback, useMemo } from "react";
import type { LaneId } from "@manufactory/engine";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { BottleneckFrame } from "./BottleneckFrame.js";
import { laneRows, type BottleneckModel } from "./derive.js";
import { ItemRow } from "./ItemRow.js";
import styles from "./LaneView.module.css";

export interface LaneViewProps {
  store: Pick<GameStore, "now" | "send">;
  snapshot: Snapshot;
  laneId: LaneId;
  bottleneck: BottleneckModel | null;
  pending: readonly Batch[];
}

export function LaneView({ store, snapshot, laneId, bottleneck, pending }: LaneViewProps) {
  const rows = useMemo(() => laneRows(snapshot, laneId), [snapshot, laneId]);
  const now = useCallback(() => store.now(), [store]);
  return (
    <section
      role="tabpanel"
      id="lane-panel"
      aria-labelledby={`lane-tab-${laneId}`}
      className={styles.panel}
    >
      <ul className={styles.rows}>
        {rows.map((row) => {
          const framed = bottleneck !== null && bottleneck.itemId === row.itemId;
          const item = <ItemRow row={row} snapshot={snapshot} now={now} />;
          return (
            <li key={row.itemId} className={styles.row} data-item={row.itemId} data-tag={row.tag}>
              {framed ? (
                <BottleneckFrame
                  model={bottleneck}
                  snapshot={snapshot}
                  store={store}
                  pending={pending}
                >
                  {item}
                </BottleneckFrame>
              ) : (
                item
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
