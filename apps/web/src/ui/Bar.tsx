// U-3d / V-3: one bar for every storage row and the power panel. A role=meter whose value moves
// per snapshot only (W-20), drawn by the compositor: the fill is revealed, never scaled, so the
// terminal's segments stay still while the edge moves. The clip wrapper is translated by
// (f − 1) × 100% and the fill inside it by the negation, with the same transition on both: W-7's
// one transition per snapshot, on two elements. Under reduced motion the 4 Hz tick steps both.
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import css from "./Bar.module.css";
import { useTickSource } from "./use-tick.js";
import { prefersReducedMotion } from "./use-tween.js";

export interface BarProps {
  label: string;
  /** Per snapshot (W-20). */
  valueNow: number;
  valueMax?: number;
  valueText: string;
  /** The bottleneck's colour only through its state class (8a). */
  tone: "normal" | "bottleneck" | "body";
  /** The W-7 transition: from/to fractions over durationMs; none → static at `to`. */
  transition: { from: number; to: number; durationMs: number };
  /** Reduced motion: the 4 Hz step's fraction. */
  stepAt?: () => number;
  /** 16 on phone rows, 20 on the power panel; terminal only (a cell is 1ch there). */
  cells?: number;
}

const TONE: Record<BarProps["tone"], string> = {
  normal: css.normal!,
  bottleneck: "state-bottleneck",
  body: css.body!,
};

/** The reveal at fraction f: the clip slides left, the fill slides back by as much. */
function place(clip: HTMLElement, fill: HTMLElement, f: number): void {
  clip.style.transform = `translateX(${(f - 1) * 100}%)`;
  fill.style.transform = `translateX(${(1 - f) * 100}%)`;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function Bar({
  label,
  valueNow,
  valueMax = 1,
  valueText,
  tone,
  transition,
  stepAt,
  cells,
}: BarProps) {
  const clip = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const ticks = useTickSource();
  const { from, to, durationMs } = transition;
  const step = useRef(stepAt);
  step.current = stepAt;

  useLayoutEffect(() => {
    const c = clip.current;
    const f = fill.current;
    if (!c || !f) return;
    c.style.transition = "none";
    f.style.transition = "none";
    const reduced = prefersReducedMotion();
    if (durationMs <= 0 || reduced) {
      place(c, f, reduced ? from : to);
      return;
    }
    place(c, f, from);
    c.getBoundingClientRect(); // commit the start before the transition begins
    const run = `transform ${durationMs}ms linear`;
    c.style.transition = run;
    f.style.transition = run;
    place(c, f, to);
  }, [from, to, durationMs]);

  useEffect(() => {
    if (!prefersReducedMotion()) return;
    return ticks.subscribe(() => {
      const c = clip.current;
      const f = fill.current;
      const at = step.current;
      if (c && f && at) place(c, f, at());
    });
  }, [ticks]);

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={valueMax}
      aria-valuenow={round3(valueNow)}
      aria-valuetext={valueText}
      className={`${css.bar} ${TONE[tone]}`}
      style={cells === undefined ? undefined : ({ "--bar-cells": cells } as CSSProperties)}
    >
      <div className={css.track} />
      <div ref={clip} className={css.clip} data-clip>
        <div ref={fill} className={css.fill} data-fill />
      </div>
    </div>
  );
}
