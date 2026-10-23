// One lane's rows (W-19: only the visible lane renders). At most one row is framed (P-2).
import { useCallback, useMemo } from "react";
import type { ItemId, LaneId } from "@manufactory/engine";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { BottleneckFrame } from "./BottleneckFrame.js";
import { Conveyor } from "./Conveyor.js";
import { laneRows, type BottleneckModel } from "./derive.js";
import { ItemRow } from "./ItemRow.js";
import styles from "./LaneView.module.css";
import { useNotation } from "./notation.js";

export interface LaneViewProps {
  store: Pick<GameStore, "now" | "send">;
  snapshot: Snapshot;
  laneId: LaneId;
  bottleneck: BottleneckModel | null;
  pending: readonly Batch[];
  /** The item whose drawer is open, if any. */
  openItem?: ItemId | null;
  onOpen?: (itemId: ItemId) => void;
  /** A split bar's tap: go to the item's priority entry. */
  onSplit?: (itemId: ItemId) => void;
}

export function LaneView({
  store,
  snapshot,
  laneId,
  bottleneck,
  pending,
  openItem = null,
  onOpen,
  onSplit,
}: LaneViewProps) {
  // The rows carry formatted text: the notation is a memo key (S-11).
  const [notation] = useNotation();
  const rows = useMemo(() => laneRows(snapshot, laneId, notation), [snapshot, laneId, notation]);
  const now = useCallback(() => store.now(), [store]);
  const production = useMemo(() => rows.reduce((sum, r) => sum + r.production, 0), [rows]);
  return (
    <section
      role="tabpanel"
      id="lane-panel"
      aria-labelledby={`lane-tab-${laneId}`}
      className={styles.panel}
    >
      <Conveyor production={production} />
      <ul className={styles.rows}>
        {rows.map((row) => {
          const framed = bottleneck !== null && bottleneck.itemId === row.itemId;
          const item = (
            <ItemRow
              row={row}
              snapshot={snapshot}
              now={now}
              onOpen={onOpen}
              expanded={openItem === row.itemId}
              onSplit={onSplit}
            />
          );
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
