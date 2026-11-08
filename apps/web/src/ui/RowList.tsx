// U-3 / U-7d / V-10: one lane's rows as a listbox (W-19: only the visible lane renders). The
// list is the one tab stop; aria-activedescendant names the selected row, and the selection is
// the App's, per lane. The keys are the dispatcher's (U-7a, K-8): ↑ ↓ Home End move, → and Space
// open the drawer, Enter runs the next buy; currentRow is the one rule both read (selection.ts).
import { useCallback, useId, useMemo } from "react";
import type { ItemId, LaneId } from "@manufactory/engine";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { laneRows, type BottleneckModel, type RowModel } from "./derive.js";
import { useFeel } from "./feel.js";
import { useNames } from "./names.js";
import { useNotation } from "./notation.js";
import { Row, rowId } from "./Row.js";
import css from "./Row.module.css";
import { currentRow } from "./selection.js";
import { rowTrend, type RowTrend } from "./trend.js";
import type { LayoutMode } from "./use-layout-mode.js";
import { useTrend } from "./use-trend.js";

export interface RowListProps {
  store: Pick<GameStore, "now">;
  snapshot: Snapshot;
  laneId: LaneId;
  bottleneck: BottleneckModel | null;
  /** The App's selection for this lane; null (or an item no longer shown) takes the default. */
  selected: ItemId | null;
  onSelect(id: ItemId): void;
  onOpen(id: ItemId): void;
  openItem: ItemId | null;
  mode: LayoutMode;
}

/** U-7d: the bottleneck's row when it's in this lane, else the first row. */
export function defaultSelection(
  rows: readonly RowModel[],
  bottleneck: BottleneckModel | null,
): ItemId | null {
  return currentRow(
    rows.map((r) => r.itemId),
    null,
    bottleneck,
  );
}

export function RowList({
  store,
  snapshot,
  laneId,
  bottleneck,
  selected,
  onSelect,
  onOpen,
  mode,
}: RowListProps) {
  // The rows carry formatted text: the notation is a memo key (S-11).
  const [notation] = useNotation();
  const rows = useMemo(() => laneRows(snapshot, laneId, notation), [snapshot, laneId, notation]);
  const now = useCallback(() => store.now(), [store]);
  const names = useNames(snapshot);
  const hint = useId();
  // L-12: the lane's trends, once per book version (an adoption, or the server minute) and per
  // snapshot, never at the 4 Hz tick.
  const book = useFeel().trend;
  const version = useTrend(book);
  const ids = rows.map((r) => r.itemId).join(" ");
  const trends = useMemo(() => {
    const at = serverNow(snapshot, store.now());
    return new Map<ItemId, RowTrend>(
      ids.split(" ").map((id) => [id, rowTrend(book, snapshot, id, at)]),
    );
    // `version` is the book's change (the window reads the book), so it is a key the body
    // doesn't name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, version, snapshot, ids, store]);
  const current = currentRow(
    rows.map((r) => r.itemId),
    selected,
    bottleneck,
  );
  const framed = bottleneck?.itemId ?? null;

  const open = (id: ItemId) => {
    onSelect(id);
    onOpen(id);
  };

  return (
    <div className={mode === "phone" ? `${css.rows} ${css.phone}` : css.rows}>
      <div className={css.head} aria-hidden="true">
        <span className={css.gutter} />
        <span className={css.name}>ITEM</span>
        <span className={css.rate}>RATE</span>
        <span className={css.sat}>SAT</span>
        <span className={css.trend}>LAST 10 MIN</span>
        <span className={css.machines}>MACHINES</span>
        <span className={css.storage}>STORAGE</span>
        <span className={css.stock}>STOCK</span>
      </div>
      <ul
        role="listbox"
        aria-label={`${snapshot.content.lanes.get(laneId)?.name ?? laneId} lane`}
        aria-activedescendant={current === null ? undefined : rowId(current)}
        aria-describedby={hint}
        tabIndex={0}
        className={css.list}
        data-rows
      >
        {rows.map((row) => (
          <Row
            key={row.itemId}
            row={row}
            snapshot={snapshot}
            now={now}
            names={names}
            bottleneck={framed === row.itemId}
            selected={current === row.itemId}
            cells={mode === "phone" ? 16 : undefined}
            trend={trends.get(row.itemId)!}
            onClick={open}
          />
        ))}
      </ul>
      <span id={hint} className={css.hint}>
        Arrow keys to move, right arrow or space for details, enter runs the next buy.
      </span>
    </div>
  );
}
