// F.1's three-line row: name and net rate; the storage bar with shown / cap; the QS and BOUND
// chips. Then the satisfaction meter, or the split bar on a contested item.
import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { ItemId } from "@manufactory/engine";
import { shownStock, storageFraction, storageTransition } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import { rateText, stateClass, type RowModel } from "./derive.js";
import styles from "./ItemRow.module.css";
import { sweepPeriodS } from "./motion.js";
import { fmt } from "./notation.js";
import { useTick, useTickSource } from "./use-tick.js";
import { prefersReducedMotion, useTween } from "./use-tween.js";

export interface ItemRowProps {
  row: RowModel;
  snapshot: Snapshot;
  /** The client clock (store.now), stable across renders. */
  now: () => number;
  /** §13.1: the first line opens the drawer for this item. */
  onOpen?: (itemId: ItemId) => void;
  /** This item's drawer is open. */
  expanded?: boolean;
  /** §13.1: tapping the split bar goes to this item's entry in the priority list. */
  onSplit?: (itemId: ItemId) => void;
}

export function ItemRow({ row, snapshot, now, onOpen, expanded = false, onSplit }: ItemRowProps) {
  const top = (
    <>
      <span className={styles.name}>{row.name}</span>
      <span className={`${styles.rate} num`}>{rateText(row.netPerSecond)}</span>
    </>
  );
  return (
    <div className={styles.row}>
      {onOpen === undefined ? (
        <div className={styles.top}>{top}</div>
      ) : (
        <button
          type="button"
          className={`${styles.top} ${styles.open}`}
          aria-expanded={expanded}
          // Only a rendered id: #detail exists while this item's drawer is open.
          aria-controls={expanded ? "detail" : undefined}
          data-open-row
          onClick={() => onOpen(row.itemId)}
        >
          {top}
        </button>
      )}
      <div className={styles.storage}>
        <StorageBar snapshot={snapshot} itemId={row.itemId} name={row.name} now={now} />
        <span className={`${styles.amount} num`}>
          <LiveStock snapshot={snapshot} itemId={row.itemId} now={now} />
          {` / ${row.capText}`}
        </span>
      </div>
      {(row.quantum !== null || row.bound !== null) && (
        <div className={styles.chips}>
          {row.quantum !== null && (
            <span className={`${styles.chip} num`}>{`QS ${fmt(row.quantum)}`}</span>
          )}
          {row.bound !== null && (
            <span className={`${styles.chip} num`}>{`BOUND ${fmt(row.bound)}`}</span>
          )}
        </div>
      )}
      {row.split === null ? (
        <SatisfactionMeter row={row} />
      ) : onSplit === undefined ? (
        <SplitBar split={row.split} />
      ) : (
        <button
          type="button"
          className={styles.splitButton}
          aria-label={`${row.name} split: show in the priority list`}
          data-split
          onClick={() => onSplit(row.itemId)}
        >
          <SplitBar split={row.split} />
        </button>
      )}
    </div>
  );
}

/** Interpolated stock at the 4 Hz tick (W-7), tweened over a snapshot correction (S-14). Not
 * a live region. */
function LiveStock({
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

/**
 * W-7: one compositor transition per snapshot. --from with no transition, a forced reflow,
 * then scaleX(to) over the time to full/empty or the boundary, linear. Nothing runs per
 * frame. Under reduced motion there is no transition; the 4 Hz tick steps the bar instead.
 */
function StorageBar({
  snapshot,
  itemId,
  name,
  now,
}: {
  snapshot: Snapshot;
  itemId: string;
  name: string;
  now: () => number;
}) {
  const fill = useRef<HTMLDivElement>(null);
  const ticks = useTickSource();
  // aria-valuenow changes per snapshot only (W-20).
  const atSnapshot = useMemo(
    () => storageFraction(snapshot, itemId, snapshot.schedule.atMs),
    [snapshot, itemId],
  );

  useLayoutEffect(() => {
    const el = fill.current;
    if (!el) return;
    const t = storageTransition(snapshot, itemId, serverNow(snapshot, now()));
    el.style.setProperty("--from", String(t.from));
    el.style.transition = "none";
    el.style.transform = `scaleX(${t.from})`;
    if (t.durationMs <= 0 || prefersReducedMotion()) return;
    el.getBoundingClientRect(); // commit the start before the transition begins
    el.style.transition = `transform ${t.durationMs}ms linear`;
    el.style.transform = `scaleX(${t.to})`;
  }, [snapshot, itemId, now]);

  useEffect(() => {
    if (!prefersReducedMotion()) return;
    return ticks.subscribe(() => {
      const el = fill.current;
      if (el)
        el.style.transform = `scaleX(${storageFraction(snapshot, itemId, serverNow(snapshot, now()))})`;
    });
  }, [ticks, snapshot, itemId, now]);

  return (
    <div
      role="meter"
      aria-label={`${name} storage`}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={round3(atSnapshot)}
      aria-valuetext={`${Math.round(atSnapshot * 100)}% full`}
      className={styles.bar}
    >
      <div ref={fill} className={styles.fill} data-fill />
    </div>
  );
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** S-14: a producing, unpaused row sweeps, faster as it makes more (W-18). */
function SatisfactionMeter({ row }: { row: RowModel }) {
  const cls = stateClass(row);
  const sweeps = row.production > 0 && !row.paused;
  const sweep = sweeps
    ? ({ "--sweep-period": `${sweepPeriodS(row.production)}s` } as CSSProperties)
    : undefined;
  return (
    <div
      role="meter"
      aria-label={`${row.name} satisfaction`}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={round3(row.satisfaction)}
      aria-valuetext={
        cls === "paused" || cls === "idle"
          ? cls
          : `${Math.round(row.satisfaction * 100)}% satisfied`
      }
      className={styles.sat}
      data-state={cls}
      data-sweep={sweeps ? "" : undefined}
      style={sweep}
    >
      <div
        className={`${styles.satFill} ${styles[`state-${cls}`] ?? ""}`}
        style={{ transform: `scaleX(${row.satisfaction})` }}
      />
    </div>
  );
}

const SPLIT_TONES = ["toneA", "toneB", "toneC"] as const;

function SplitBar({ split }: { split: NonNullable<RowModel["split"]> }) {
  return (
    <div className={styles.splitWrap}>
      <div className={styles.split} aria-hidden="true">
        {split.map((part, i) => (
          <div
            key={part.entryId}
            className={styles[SPLIT_TONES[i % SPLIT_TONES.length]!]}
            style={{ flexGrow: part.share }}
          />
        ))}
      </div>
      <div className={styles.splitLabels}>
        {split.map((part) => (
          <span
            key={part.entryId}
            className="num"
          >{`${Math.round(part.share * 100)}% ${part.label}`}</span>
        ))}
      </div>
    </div>
  );
}
