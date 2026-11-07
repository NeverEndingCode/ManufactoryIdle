// U-5b / K-20: the phone drawer sheet's grip. A drag down past DRAG_CLOSE_PX closes the sheet;
// short of it the sheet snaps back (a CSS transition under no-preference). With motion the
// sheet follows the finger by `offset`; under reduced motion it doesn't, and a long enough drag
// just closes. Pointer capture keeps the drag on the grip; a cancel or a lost capture ends it
// without closing. The grip is pointer-only (K-20): the x, Esc and the scrim are the
// accessible closes.
import { useRef, useState, type PointerEvent } from "react";
import { prefersReducedMotion } from "./use-tween.js";

export const DRAG_CLOSE_PX = 96;

/** How far the sheet has been dragged down: never negative, so it can't rise off its top. */
export function dragOffset(startY: number, y: number): number {
  return Math.max(0, y - startY);
}

type Handler = (e: PointerEvent<HTMLElement>) => void;

export interface SheetGrip {
  onPointerDown: Handler;
  onPointerMove: Handler;
  onPointerUp: Handler;
  onPointerCancel: Handler;
  onLostPointerCapture: Handler;
}

export function useSheetDrag(
  onClose: () => void,
  opts: { reduced?: () => boolean } = {},
): {
  grip: SheetGrip;
  /** px to translate the sheet by while dragging with motion; null when not dragging or reduced. */
  offset: number | null;
} {
  const drag = useRef<{ id: number; y: number } | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const reduced = opts.reduced ?? prefersReducedMotion;

  const mine = (e: PointerEvent<HTMLElement>) =>
    drag.current !== null && drag.current.id === e.pointerId ? drag.current : null;
  const end = () => {
    drag.current = null;
    setOffset(null);
  };

  const grip: SheetGrip = {
    onPointerDown(e) {
      if (e.button !== 0 || drag.current !== null) return;
      drag.current = { id: e.pointerId, y: e.clientY };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove(e) {
      const d = mine(e);
      if (d === null) return;
      if (!reduced()) setOffset(dragOffset(d.y, e.clientY));
    },
    onPointerUp(e) {
      const d = mine(e);
      if (d === null) return;
      const dy = dragOffset(d.y, e.clientY);
      end();
      if (dy > DRAG_CLOSE_PX) onClose();
    },
    onPointerCancel(e) {
      if (mine(e) !== null) end();
    },
    onLostPointerCapture(e) {
      if (mine(e) !== null) end();
    },
  };
  return { grip, offset };
}
