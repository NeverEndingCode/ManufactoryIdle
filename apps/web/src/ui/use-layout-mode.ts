// U-2a: the layout from the viewport width alone, W-19's two widths. > 1000 px: desktop;
// 600–1000 px: tablet (the desktop chrome, U-2c); < 600 px: the phone. data-layout carries it,
// so the CSS and the React tree never disagree.
import { useSyncExternalStore } from "react";

export type LayoutMode = "phone" | "tablet" | "desktop";

export const DESKTOP_QUERY = "(min-width: 1001px)";
export const TABLET_QUERY = "(min-width: 600px)";

function query(q: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(q)
    : null;
}

function subscribe(fn: () => void): () => void {
  const lists = [query(DESKTOP_QUERY), query(TABLET_QUERY)];
  for (const l of lists) l?.addEventListener?.("change", fn);
  return () => {
    for (const l of lists) l?.removeEventListener?.("change", fn);
  };
}

/** Without matchMedia (a test with no stub), the widest layout. */
function layoutMode(): LayoutMode {
  const desktop = query(DESKTOP_QUERY);
  if (desktop === null || desktop.matches) return "desktop";
  return query(TABLET_QUERY)?.matches ? "tablet" : "phone";
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, layoutMode, () => "desktop");
}
