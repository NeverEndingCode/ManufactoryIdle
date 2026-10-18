// Q-7 / W-19: the pane count from the viewport width alone. > 1000 px: three panes;
// 600–1000 px: two; < 600 px: one column with the drawer as a bottom sheet.
import { useSyncExternalStore } from "react";

export type Panes = 1 | 2 | 3;

export const THREE_PANES = "(min-width: 1001px)";
export const TWO_PANES = "(min-width: 600px)";

function query(q: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(q)
    : null;
}

function subscribe(fn: () => void): () => void {
  const lists = [query(THREE_PANES), query(TWO_PANES)];
  for (const l of lists) l?.addEventListener?.("change", fn);
  return () => {
    for (const l of lists) l?.removeEventListener?.("change", fn);
  };
}

/** Without matchMedia (a test with no stub), the widest layout. */
function panes(): Panes {
  const three = query(THREE_PANES);
  if (three === null) return 3;
  if (three.matches) return 3;
  return query(TWO_PANES)?.matches ? 2 : 1;
}

export function usePanes(): Panes {
  return useSyncExternalStore(subscribe, panes, () => 3);
}
