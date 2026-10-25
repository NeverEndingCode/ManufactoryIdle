// W-7 / W-18 / S-14: a snapshot correction to a row's stock tweens instead of snapping. When a
// new snapshot's value differs from the old snapshot's at the same moment by more than 1%, a
// requestAnimationFrame loop writes the span's text through its ref for TWEEN_MS, in
// log10(1 + x) space with an ease-out. React renders nothing at 60 Hz; the 4 Hz tick stays the
// steady path (a tick mid-tween writes the steady value, and the next frame takes over again).
// Nothing tweens under reduced motion, and rAF doesn't run in a hidden tab.
import { useLayoutEffect, useRef, type RefObject } from "react";
import { shownStock } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import { easeOut, shouldTween, TWEEN_MS, tweenDec } from "./motion.js";
import { fmt } from "./notation.js";

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export function useTween(
  span: RefObject<HTMLElement>,
  snapshot: Snapshot,
  itemId: string,
  now: () => number,
): void {
  const prev = useRef<Snapshot | null>(null);
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = snapshot;
    const el = span.current;
    if (before === null || before === snapshot || el === null) return;
    const target = () => shownStock(snapshot, itemId, serverNow(snapshot, now()));
    // A tween this replaced may have left its text: start from the steady value.
    el.textContent = fmt(target());
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") return;
    const from = shownStock(before, itemId, serverNow(before, now()));
    if (!shouldTween(from, target())) return;
    const t0 = performance.now();
    let frame = 0;
    const draw = () => {
      const f = (performance.now() - t0) / TWEEN_MS;
      el.textContent = fmt(f >= 1 ? target() : tweenDec(from, target(), easeOut(f)));
      if (f < 1) frame = requestAnimationFrame(draw);
    };
    draw(); // the old value before the first paint, so the new one never flashes
    return () => cancelAnimationFrame(frame);
  }, [span, snapshot, itemId, now]);
}
