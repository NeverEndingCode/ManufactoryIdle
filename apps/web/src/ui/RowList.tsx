// U-3 / U-7d / V-10: one lane's rows as a listbox (W-19: only the visible lane renders). The
// list is the one tab stop; aria-activedescendant names the selected row, and the selection is
// the App's, per lane. Its own keys until UI-2's dispatcher: ↑ ↓ Home End move, → and Space open
// the drawer. Enter is left alone (UI-2 runs the next buy with it), and so is every modified key.
import { useCallback, useId, useMemo, type KeyboardEvent } from "react";
import type { ItemId, LaneId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { laneRows, type BottleneckModel, type RowModel } from "./derive.js";
import { useNames } from "./names.js";
import { useNotation } from "./notation.js";
import { Row, rowId } from "./Row.js";
import css from "./Row.module.css";
import type { LayoutMode } from "./use-layout-mode.js";

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
  const framed = bottleneck?.itemId ?? null;
  if (framed !== null && rows.some((r) => r.itemId === framed)) return framed;
  return rows[0]?.itemId ?? null;
}

const MOVES = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
const OPENS = new Set(["ArrowRight", " "]);

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
  const current =
    selected !== null && rows.some((r) => r.itemId === selected)
      ? selected
      : defaultSelection(rows, bottleneck);
  const framed = bottleneck?.itemId ?? null;

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (rows.length === 0) return;
    if (OPENS.has(e.key)) {
      e.preventDefault();
      if (current !== null) open(current);
      return;
    }
    if (!MOVES.has(e.key)) return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.itemId === current);
    const last = rows.length - 1;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : Math.min(last, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    const id = rows[next]!.itemId;
    onSelect(id);
    document.getElementById(rowId(id))?.scrollIntoView?.({ block: "nearest" });
  };

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
        onKeyDown={onKeyDown}
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
            onClick={open}
          />
        ))}
      </ul>
      <span id={hint} className={css.hint}>
        Arrow keys to move, right arrow or space for details.
      </span>
    </div>
  );
}
