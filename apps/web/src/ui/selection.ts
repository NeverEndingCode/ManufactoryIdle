// U-7d: the row selection's one rule, for RowList (what's drawn active) and the dispatcher (what
// ↑/↓, Home, End, → and Space act on), so the two can't disagree.
import type { ItemId } from "@manufactory/engine";
import type { BottleneckModel } from "./derive.js";
import type { RowMove } from "./keys.js";

/** The selected row if it's shown, else the bottleneck's row in this lane, else the first row. */
export function currentRow(
  ids: readonly ItemId[],
  selected: ItemId | null,
  bottleneck: BottleneckModel | null,
): ItemId | null {
  if (selected !== null && ids.includes(selected)) return selected;
  const framed = bottleneck?.itemId ?? null;
  if (framed !== null && ids.includes(framed)) return framed;
  return ids[0] ?? null;
}

/** One step, or to an end. Clamps; never wraps. null with no rows. */
export function stepRow(
  ids: readonly ItemId[],
  current: ItemId | null,
  to: RowMove,
): ItemId | null {
  if (ids.length === 0) return null;
  const last = ids.length - 1;
  const at = current === null ? -1 : ids.indexOf(current);
  const next =
    to === "first"
      ? 0
      : to === "last"
        ? last
        : at === -1
          ? 0
          : Math.min(last, Math.max(0, at + (to === "next" ? 1 : -1)));
  return ids[next]!;
}
