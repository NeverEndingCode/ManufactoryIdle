// WAI-ARIA tabs, automatic activation (V-15): one rule for the lane tabs and both Panels navs.
// The arrows wrap, Home and End go to the ends, and `skip` passes over locked lanes (U-3e).
// Modifiers are left to the browser and the OS.

/** The index to select, or null. */
export function tabTarget(
  e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">,
  i: number,
  n: number,
  skip?: (j: number) => boolean,
): number | null {
  if (e.altKey || e.ctrlKey || e.metaKey || i === -1 || n === 0) return null;
  const ok = (j: number) => skip === undefined || !skip(j);
  /** From `from`, stepping by `step`, the first index not skipped (at most n tries). */
  const walk = (from: number, step: 1 | -1): number | null => {
    for (let k = 0, j = from; k < n; k += 1, j = (j + step + n) % n) if (ok(j)) return j;
    return null;
  };
  switch (e.key) {
    case "ArrowRight":
      return walk((i + 1) % n, 1);
    case "ArrowLeft":
      return walk((i - 1 + n) % n, -1);
    case "Home":
      return walk(0, 1);
    case "End":
      return walk(n - 1, -1);
    default:
      return null;
  }
}
