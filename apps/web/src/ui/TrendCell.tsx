// U-9b / L-12: a row's TREND cell. A memo of strings and flags only, so it re-renders when its
// cells change (an adoption, or the book's minute) and never with the 4 Hz tick. Hidden from
// readers: the row's name carries the word (L-15). One span per cell, so the cell's element
// tree is the same whatever is known (U-3a); unknown cells carry `.unknown` (L-14).
import { memo } from "react";
import css from "./Row.module.css";

export interface TrendCellProps {
  /** sparkline(): ten cells, "·" where unknown. */
  cells: string;
  down: boolean;
  bottleneck: boolean;
}

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function TrendCells({ cells, down, bottleneck }: TrendCellProps) {
  return (
    <span
      className={cx(css.trend, down && css.down, bottleneck && "state-bottleneck")}
      aria-hidden="true"
    >
      {[...cells].map((c, i) => (
        <span key={i} className={c === "·" ? css.unknown : undefined}>
          {c}
        </span>
      ))}
    </span>
  );
}

export const Trend = memo(TrendCells);
