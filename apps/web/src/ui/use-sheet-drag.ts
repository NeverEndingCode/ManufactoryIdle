// U-5b / K-20: the phone drawer sheet's grip. A drag down past DRAG_CLOSE_PX closes the sheet;
// short of it the sheet snaps back (a CSS transition under no-preference). With motion the
// sheet follows the finger by `offset`; under reduced motion it doesn't, and a long enough drag
// just closes. Pointer capture keeps the drag on the grip; a cancel or a lost capture ends it
// without closing. The grip is also a button: its click is a close, except the click that
// ends a drag (the browser sends one after a release on the grip). A key press's click
// (detail 0) always closes.
import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { prefersReducedMotion } from "./use-tween.js";

export const DRAG_CLOSE_PX = 96;

/** Movement under this many pixels is a tap, not a drag: its click still closes. */
const TAP_SLOP_PX = 8;

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
  /** The grip as a button (a key press, a screen reader, a tap): a close. */
  onClick(e: Pick<MouseEvent, "detail">): void;
}

export function useSheetDrag(
  onClose: () => void,
  opts: { reduced?: () => boolean } = {},
): {
  grip: SheetGrip;
  /** px to translate the sheet by while dragging with motion; null when not dragging or reduced. */
  offset: number | null;
} {
  const drag = useRef<{ id: number; y: number; moved: number } | null>(null);
  const swallowClick = useRef(false);
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
      drag.current = { id: e.pointerId, y: e.clientY, moved: 0 };
      swallowClick.current = false;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove(e) {
      const d = mine(e);
      if (d === null) return;
      d.moved = Math.max(d.moved, Math.abs(e.clientY - d.y));
      if (!reduced()) setOffset(dragOffset(d.y, e.clientY));
    },
    onPointerUp(e) {
      const d = mine(e);
      if (d === null) return;
      const dy = dragOffset(d.y, e.clientY);
      swallowClick.current = Math.max(d.moved, Math.abs(e.clientY - d.y)) >= TAP_SLOP_PX;
      end();
      if (dy > DRAG_CLOSE_PX) onClose();
    },
    onPointerCancel(e) {
      if (mine(e) !== null) end();
    },
    onLostPointerCapture(e) {
      if (mine(e) !== null) end();
    },
    onClick(e) {
      // detail 0: a key press or an assistive tech's click, never the end of a drag.
      if (e.detail !== 0 && swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      onClose();
    },
  };
  return { grip, offset };
}
