// The tap's hold (W-12, W-20, U-6c): PowerDock's handlers, moved, for the footer's TAP and the
// floating one. A pointer holds it (captured, so a drag off the button still releases on up), and
// so does a held Space or Enter on the focused button; key repeats are ignored, and keyup, blur,
// pointer up, cancel and lost capture release. The Space and Enter keys stop here, so a global
// Space (U-7a) never also fires. The store owns the repeat and the flush (Q-11).
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { GameStore } from "../sync/store.js";

const HOLD_KEYS = new Set([" ", "Enter"]);

export interface TapHold {
  onPointerDown(e: PointerEvent<HTMLButtonElement>): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  onLostPointerCapture(): void;
  onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void;
  onKeyUp(e: KeyboardEvent<HTMLButtonElement>): void;
  onBlur(): void;
  onContextMenu(e: { preventDefault(): void }): void;
}

export function useTapHold(store: Pick<GameStore, "pressTap" | "releaseTap">): TapHold {
  const keyHeld = useRef(false);
  const release = () => store.releaseTap();
  return {
    onPointerDown(e) {
      if (e.button !== 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // No capture (an old engine, or jsdom): pointerup on the button still releases.
      }
      store.pressTap();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onKeyDown(e) {
      if (!HOLD_KEYS.has(e.key)) return;
      e.preventDefault(); // no click, no page scroll
      e.stopPropagation(); // nor the global Space (U-7a)
      if (e.repeat || keyHeld.current) return;
      keyHeld.current = true;
      store.pressTap();
    },
    onKeyUp(e) {
      if (!HOLD_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!keyHeld.current) return;
      keyHeld.current = false;
      store.releaseTap();
    },
    onBlur() {
      keyHeld.current = false;
      store.releaseTap();
    },
    onContextMenu(e) {
      e.preventDefault();
    },
  };
}
