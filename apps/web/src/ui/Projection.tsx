// The projected effect of the drawer's selected action (W-13, Q-2): client-against-client,
// memoised per snapshot, never recomputed at 4 Hz. Not a live region: it changes as the
// player points at actions, and a screen reader reads it on demand.
import type { Action, LaneId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { rateText } from "./derive.js";
import styles from "./Drawer.module.css";
import { itemLabel, itemName } from "./names.js";
import { preview, shownDeltas, summaryLines, type Preview, type RateDelta } from "./preview.js";
import { Spoken } from "./Spoken.js";
import { useTheme, type ThemeDef } from "./theme.js";

/** One projection line: what the theme shows, what a reader hears, and whether it's an input
 *  draining (K-14). */
export interface ProjectionLine {
  shown: string;
  said: string;
  drain: boolean;
}

/** "+0.4" from "+0.4/s": the before half of "ROTOR +0.4 → +0.6/s". */
const bare = (n: number) => rateText(n).replace(/\/s$/, "");

function rateLine(d: RateDelta, name: string): string {
  // K-14: an input the action draws harder reads as the drain and what's left.
  if (d.after < d.before)
    return `${name} ${rateText(d.after - d.before)} (still ${rateText(d.after)})`;
  return `${name} ${bare(d.before)} → ${rateText(d.after)}`;
}

/**
 * K-14: preview()'s deltas, themed. "IRON_PLATE -0.8/s (still +11.2/s)" when a rate falls
 * (drain), else "ROTOR +0.4 → +0.6/s"; a reader hears the content names. The lane's items first,
 * at most four rate lines (shownDeltas), then summaryLines, which carry no names. A rejection is its reason.
 */
export function projectionLines(
  s: Snapshot,
  p: Preview,
  laneId: LaneId,
  theme: ThemeDef,
): ProjectionLine[] {
  if (!p.ok) return [{ shown: p.reason, said: p.reason, drain: false }];
  const rates = shownDeltas(s, p, laneId).map((d) => ({
    shown: rateLine(d, itemLabel(s, d.itemId, theme)),
    said: rateLine(d, itemName(s, d.itemId)),
    // Any falling rate is drawn as a drain (K-14): in a buy's preview that's an input.
    drain: d.after < d.before,
  }));
  const rest = summaryLines(p).map((line) => ({ shown: line, said: line, drain: false }));
  return [...rates, ...rest];
}

export function Projection({
  snapshot,
  actions,
  laneId,
  caption = "Projected effect",
}: {
  snapshot: Snapshot;
  actions: readonly Action[] | null;
  laneId: LaneId;
  /** The box's caption; "" for none (MACHINES' IF YOU BUY line is its caption). */
  caption?: string;
}) {
  const theme = useTheme().applied;
  // The store's snapshot object as is: preview() memoises per (snapshot, actions' JSON), so a
  // re-render with the same action is a lookup.
  const lines =
    actions === null ? [] : projectionLines(snapshot, preview(snapshot, actions), laneId, theme);
  return (
    <div className={styles.preview} data-preview aria-live="off">
      {caption !== "" && <div className={styles.caption}>{caption}</div>}
      {actions === null ? (
        <p className={styles.muted}>Nothing to project</p>
      ) : (
        <ul className={styles.lines}>
          {lines.map((line, i) => (
            <li
              key={`${i}:${line.said}`}
              className={line.drain ? `num ${styles.drain}` : "num"}
              data-drain={line.drain ? "" : undefined}
            >
              <Spoken shown={line.shown} said={line.said} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
