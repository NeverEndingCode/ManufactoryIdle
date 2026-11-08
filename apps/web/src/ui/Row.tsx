// U-3: one row, one DOM in every layout and every state. Eight cells, each a single ellipsized
// line: the gutter's mark, the name, the rate, SAT, the trend (U-9b), MACHINES, the storage bar
// and the stock. The
// bottleneck, the selection, an open drawer and a pending buy change classes and text only, never
// the element tree (RowList.test 1) or the box (tokens.test 10a). A listbox option holds nothing
// focusable (U-7d): the list owns the keys, and a click is the list's too.
import { useMemo, useRef } from "react";
import type { ItemId } from "@manufactory/engine";
import { shownStock, storageFraction, storageTransition } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import { Bar } from "./Bar.js";
import { machinesText, optionName, rateText, satText, type RowModel } from "./derive.js";
import type { Names } from "./names.js";
import { fmt } from "./notation.js";
import css from "./Row.module.css";
import type { RowTrend } from "./trend.js";
import { Trend } from "./TrendCell.js";
import { useTick } from "./use-tick.js";
import { useTween } from "./use-tween.js";

export interface RowProps {
  row: RowModel;
  snapshot: Snapshot;
  /** The client clock (store.now), stable across renders. */
  now: () => number;
  names: Names;
  /** The one framed row in the factory (P-2): the gutter's "!", and colour classes. */
  bottleneck: boolean;
  selected: boolean;
  /** 16 cells on the phone (U-3b). */
  cells?: number;
  /** U-9b: the row's sparkline and word, from RowList's one memo per book version (L-12). */
  trend: RowTrend;
  onClick(itemId: ItemId): void;
}

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function rowId(itemId: ItemId): string {
  return `row-${itemId}`;
}

export function Row({
  row,
  snapshot,
  now,
  names,
  bottleneck,
  selected,
  cells,
  trend,
  onClick,
}: RowProps) {
  const { itemId } = row;
  const sat = satText(row);
  const net = row.netPerSecond;
  const atSnapshot = useMemo(
    () => storageFraction(snapshot, itemId, snapshot.schedule.atMs),
    [snapshot, itemId],
  );
  // One transition per snapshot (W-7); the bar's layout effect starts it.
  const transition = useMemo(
    () => storageTransition(snapshot, itemId, serverNow(snapshot, now())),
    [snapshot, itemId, now],
  );
  const mark = bottleneck && "state-bottleneck";
  return (
    <li
      role="option"
      id={rowId(itemId)}
      aria-selected={selected}
      aria-label={optionName(snapshot, row, bottleneck, trend.word)}
      data-item={itemId}
      data-tag={row.tag}
      className={css.row}
      onClick={() => onClick(itemId)}
    >
      <span className={cx(css.gutter, "glyph", mark)} aria-hidden="true">
        {bottleneck ? "!" : ""}
      </span>
      <span className={cx(css.name, mark)}>{names.item(itemId)}</span>
      <span className={cx(css.rate, "num", net > 0 && css["rate-up"], net < 0 && css["rate-down"])}>
        {rateText(net)}
      </span>
      <span className={cx(css.sat, "num", `state-${sat.cls}`)}>{sat.text}</span>
      <Trend cells={trend.cells} down={trend.down} bottleneck={bottleneck} />
      <span className={css.machines}>{machinesText(snapshot, itemId, names.theme)}</span>
      <span className={css.storage}>
        <Bar
          label={`${row.name} storage`}
          valueNow={atSnapshot}
          valueText={`${Math.round(atSnapshot * 100)}% full`}
          tone={bottleneck ? "bottleneck" : "normal"}
          transition={transition}
          stepAt={() => storageFraction(snapshot, itemId, serverNow(snapshot, now()))}
          cells={cells}
        />
      </span>
      <span className={cx(css.stock, "num")}>
        <LiveStock snapshot={snapshot} itemId={itemId} now={now} />
        {` / ${row.capText}`}
      </span>
    </li>
  );
}

/** Interpolated stock at the 4 Hz tick (W-7), tweened over a snapshot correction (S-14). Not
 * a live region. */
export function LiveStock({
  snapshot,
  itemId,
  now,
}: {
  snapshot: Snapshot;
  itemId: string;
  now: () => number;
}) {
  useTick();
  const span = useRef<HTMLSpanElement>(null);
  useTween(span, snapshot, itemId, now);
  return (
    <span ref={span} data-stock>
      {fmt(shownStock(snapshot, itemId, serverNow(snapshot, now())))}
    </span>
  );
}
