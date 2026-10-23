// The priority list's model (W-1 item 3, Q-8, Q-9): pure, over one snapshot. The satisfaction
// figures come from the display solve only (W-13); the controls' optimism is the component's.
import {
  POWER_ENTRY_ID,
  type ItemId,
  type PriorityKind,
  type PriorityMode,
} from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { satisfaction as itemSatisfaction } from "./derive.js";

export interface PriorityRowModel {
  entryId: string;
  kind: PriorityKind;
  itemId: ItemId | null;
  name: string;
  /** P-1 for items; min(1, power.ratio) for power. */
  satisfaction: number;
  mode: PriorityMode;
  share: number;
  targetRate: number | null;
  paused: boolean;
  /** 0–MAX_RESERVE_PERCENT; always 0 for power. */
  reserve: number;
  /** Neither produced nor consumed (power: no supply and no demand): the neutral chip. */
  idle: boolean;
  /** An advanced setting is in effect: mode, share, target or reserve (paused shows in Simple). */
  nonDefault: boolean;
}

/** Q-8: power, plus items at or under the tier in an unlocked lane. */
function isVisible(s: Snapshot, kind: PriorityKind, itemId: ItemId | null): boolean {
  if (kind === "power") return true;
  if (itemId === null) return false;
  const item = s.content.items.get(itemId);
  const lane = item === undefined ? undefined : s.content.lanes.get(item.lane);
  return (
    item !== undefined &&
    lane !== undefined &&
    item.tier <= s.state.tier &&
    lane.unlockTier <= s.state.tier
  );
}

export function isNonDefault(
  r: Pick<PriorityRowModel, "mode" | "share" | "targetRate" | "reserve">,
): boolean {
  return r.mode !== "guaranteed" || r.share !== 1 || r.targetRate !== null || r.reserve > 0;
}

/** Q-8: power + unlocked items, in list order. */
export function visiblePriority(s: Snapshot): PriorityRowModel[] {
  const solution = s.display.solution;
  return s.state.priority
    .filter((e) => isVisible(s, e.kind, e.itemId))
    .map((e) => {
      const power = e.kind === "power";
      const itemId = power ? null : e.itemId;
      const flow = itemId === null ? undefined : solution.itemRates.get(itemId);
      const reserve =
        itemId !== null && Object.hasOwn(s.state.reserve, itemId) ? s.state.reserve[itemId]! : 0;
      const row = {
        entryId: e.id,
        kind: e.kind,
        itemId,
        name: power ? "Power" : (s.content.items.get(itemId!)?.name ?? itemId!),
        satisfaction: power
          ? Math.min(1, solution.power.ratio)
          : itemSatisfaction(solution, itemId!),
        mode: e.mode,
        share: e.share,
        targetRate: e.targetRate,
        paused: e.paused,
        reserve,
        idle: power
          ? solution.power.fullDemandMw <= 0 && solution.power.supplyMw <= 0
          : !flow || (flow.production <= 0 && flow.consumption <= 0),
      };
      return { ...row, nonDefault: isNonDefault(row) };
    });
}

/** Q-8: the full permutation after moving `id` to visible index `to`; hidden ids keep their
 * absolute indices, and the visible ids fill the remaining slots in their new order. */
export function reorderVisible(
  all: readonly string[],
  visible: readonly string[],
  id: string,
  to: number,
): string[] {
  const shown = new Set(visible);
  const moved = visible.filter((v) => v !== id);
  if (moved.length === visible.length) return [...all];
  moved.splice(Math.max(0, Math.min(to, moved.length)), 0, id);
  let k = 0;
  return all.map((x) => (shown.has(x) ? moved[k++]! : x));
}

/** Q-9: true when `after` takes power off index 0, or puts an entry above it, and `before`
 * had it at 0. */
export function powerMoveNeedsConfirm(
  before: readonly string[],
  after: readonly string[],
): boolean {
  return before[0] === POWER_ENTRY_ID && after[0] !== POWER_ENTRY_ID;
}

/** The drop slot for a pointer at clientY over rows with these vertical midpoints (W-21):
 * the number of midpoints above it. */
export function dropIndex(midpoints: readonly number[], clientY: number): number {
  let n = 0;
  for (const m of midpoints) if (m < clientY) n += 1;
  return n;
}
