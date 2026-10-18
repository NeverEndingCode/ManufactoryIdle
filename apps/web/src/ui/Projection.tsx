// The projected effect of the drawer's selected action (W-13, Q-2): client-against-client,
// memoised per snapshot, never recomputed at 4 Hz. Not a live region: it changes as the
// player points at actions, and a screen reader reads it on demand.
import type { Action, LaneId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import styles from "./Drawer.module.css";
import { preview, previewLines } from "./preview.js";

export function Projection({
  snapshot,
  actions,
  laneId,
}: {
  snapshot: Snapshot;
  actions: readonly Action[] | null;
  laneId: LaneId;
}) {
  // The store's snapshot object as is: preview() memoises per (snapshot, actions' JSON), so a
  // re-render with the same action is a lookup.
  const lines = actions === null ? [] : previewLines(snapshot, preview(snapshot, actions), laneId);
  return (
    <div className={styles.preview} data-preview aria-live="off">
      <div className={styles.caption}>Projected effect</div>
      {actions === null ? (
        <p className={styles.muted}>Nothing to project</p>
      ) : (
        <ul className={styles.lines}>
          {lines.map((line, i) => (
            <li key={`${i}:${line}`} className="num">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
