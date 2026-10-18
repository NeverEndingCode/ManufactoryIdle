// Straight lines between snapshots (W-7, P-4). No solve and no resolve: the server's stock
// and rate, clamped to [0, liquidCap] and stopped at the plateau. Dec arithmetic here runs
// at the 4 Hz text tick and once per snapshot for the bars, never per frame.
import {
  D,
  DECIMAL_ZERO,
  fromCanonical,
  liquidCap,
  type Dec,
  type ItemId,
} from "@manufactory/engine";
import { plateauAtMs, type Snapshot } from "./snapshot.js";

export function shownStock(s: Snapshot, itemId: ItemId, serverMs: number): Dec {
  const item = s.schedule.items[itemId];
  if (!item) return DECIMAL_ZERO;
  const t = Math.min(serverMs, plateauAtMs(s));
  const elapsedMs = Math.max(0, t - s.schedule.atMs);
  const raw = fromCanonical(item.stock).plus(D((item.netPerSecond * elapsedMs) / 1000));
  if (raw.lt(DECIMAL_ZERO)) return DECIMAL_ZERO;
  const cap = liquidCap(s.content, s.state, itemId);
  return raw.gt(cap) ? cap : raw;
}

/** shown / liquidCap, in [0, 1]. */
export function storageFraction(s: Snapshot, itemId: ItemId, serverMs: number): number {
  const cap = liquidCap(s.content, s.state, itemId);
  if (cap.lte(DECIMAL_ZERO)) return 0;
  const f = shownStock(s, itemId, serverMs).div(cap).toNumber();
  return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
}

export interface BarTransition {
  from: number;
  to: number;
  durationMs: number;
}

/** One CSS transition per snapshot: from the fraction now to the fraction at
 * min(full/empty, nextBoundary, plateau). */
export function storageTransition(s: Snapshot, itemId: ItemId, serverMs: number): BarTransition {
  const from = storageFraction(s, itemId, serverMs);
  const net = s.schedule.items[itemId]?.netPerSecond ?? 0;
  let end = Math.min(s.schedule.nextBoundaryAtMs ?? Infinity, plateauAtMs(s));
  let to: number | null = null;
  if (net !== 0) {
    const shown = shownStock(s, itemId, serverMs);
    const room = net > 0 ? liquidCap(s.content, s.state, itemId).minus(shown) : shown;
    const edge = serverMs + (room.toNumber() / Math.abs(net)) * 1000;
    if (edge <= end) {
      end = edge;
      to = net > 0 ? 1 : 0;
    }
  }
  if (!Number.isFinite(end) || end <= serverMs) return { from, to: from, durationMs: 0 };
  return { from, to: to ?? storageFraction(s, itemId, end), durationMs: end - serverMs };
}

/** P-4: the snapshot is at or past the plateau, so nothing moves until the player acts. */
export function isPlateaued(s: Snapshot): boolean {
  return s.schedule.atMs >= plateauAtMs(s);
}
