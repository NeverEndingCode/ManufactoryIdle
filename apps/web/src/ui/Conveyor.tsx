// S-14 / W-18 / §13.6: the background conveyor, one aria-hidden strip in the visible lane
// panel. Its blocks and speed come from the lane's summed production, so a starved lane runs
// sparse and slow. The strip is two identical halves, twice the panel's width, looping by
// translateX(-50% → 0): left to right (S-14 rules out §13.6's "toward the priority target").
// Static under reduced motion; paused with every animation in a hidden tab (base.css).
import type { CSSProperties } from "react";
import styles from "./LaneView.module.css";
import { conveyor } from "./motion.js";

export function Conveyor({ production }: { production: number }) {
  const { blocks, periodS } = conveyor(production);
  const half = (
    <div className={styles.half}>
      {Array.from({ length: blocks }, (_, i) => (
        <span key={i} className={styles.block} />
      ))}
    </div>
  );
  return (
    <div
      className={styles.conveyor}
      aria-hidden="true"
      data-conveyor
      data-blocks={blocks}
      style={{ "--conveyor-period": `${periodS}s` } as CSSProperties}
    >
      <div className={styles.belt}>
        {half}
        {half}
      </div>
    </div>
  );
}
