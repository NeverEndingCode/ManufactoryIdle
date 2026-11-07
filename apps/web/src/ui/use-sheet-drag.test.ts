// @vitest-environment jsdom
// U-5b / K-20: the phone drawer sheet's grip, as a hook. The App-level cases (the sheet's inline
// transform, closing through App's close) are in Drawer.test's place tests.
import { act, renderHook } from "@testing-library/react";
import type { PointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { DRAG_CLOSE_PX, dragOffset, useSheetDrag } from "./use-sheet-drag.js";

/** A React pointer event with what the hook reads. */
function ev(pointerId: number, clientY: number, button = 0) {
  const setPointerCapture = vi.fn();
  return {
    e: {
      pointerId,
      clientY,
      button,
      currentTarget: { setPointerCapture },
    } as unknown as PointerEvent<HTMLElement>,
    setPointerCapture,
  };
}

function hook(reduced = false) {
  const onClose = vi.fn();
  const r = renderHook(() => useSheetDrag(onClose, { reduced: () => reduced }));
  const g = () => r.result.current.grip;
  return { onClose, r, g };
}

describe("useSheetDrag (U-5b, K-20)", () => {
  // Catches: a drag up read as a negative offset (the sheet would rise off its top edge).
  it("1. dragOffset is the downward distance, never negative", () => {
    expect(dragOffset(100, 220)).toBe(120);
    expect(dragOffset(100, 100)).toBe(0);
    expect(dragOffset(100, 40)).toBe(0);
    expect(DRAG_CLOSE_PX).toBe(96);
  });

  // Catches: a threshold of >= 0 or one read off the last move, not the release.
  it("2. past 96 px closes; 96 or less snaps back; the offset follows the move", () => {
    const { onClose, r, g } = hook();
    const down = ev(1, 100);
    act(() => g().onPointerDown(down.e));
    expect(down.setPointerCapture).toHaveBeenCalledWith(1);
    act(() => g().onPointerMove(ev(1, 196).e));
    expect(r.result.current.offset).toBe(96);
    act(() => g().onPointerUp(ev(1, 196).e));
    expect(onClose).not.toHaveBeenCalled();
    expect(r.result.current.offset).toBeNull();

    act(() => g().onPointerDown(ev(2, 100).e));
    act(() => g().onPointerMove(ev(2, 220).e));
    expect(r.result.current.offset).toBe(120);
    act(() => g().onPointerUp(ev(2, 220).e));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(r.result.current.offset).toBeNull();
  });

  // Catches: a cancelled or lost pointer left mid-drag (the sheet stuck off its place), or a
  // later release of that pointer still closing.
  it("3. cancel and a lost capture end the drag without closing", () => {
    const { onClose, r, g } = hook();
    act(() => g().onPointerDown(ev(1, 100).e));
    act(() => g().onPointerMove(ev(1, 300).e));
    act(() => g().onPointerCancel(ev(1, 300).e));
    expect(r.result.current.offset).toBeNull();
    act(() => g().onPointerUp(ev(1, 300).e));
    expect(onClose).not.toHaveBeenCalled();

    act(() => g().onPointerDown(ev(2, 100).e));
    act(() => g().onPointerMove(ev(2, 300).e));
    act(() => g().onLostPointerCapture(ev(2, 300).e));
    expect(r.result.current.offset).toBeNull();
    act(() => g().onPointerUp(ev(2, 300).e));
    expect(onClose).not.toHaveBeenCalled();
  });

  // Catches: a second finger, or a secondary button, steering the drag.
  it("4. only the pointer that started it, with the primary button", () => {
    const { onClose, r, g } = hook();
    act(() => g().onPointerDown(ev(1, 100, 2).e));
    act(() => g().onPointerMove(ev(1, 300).e));
    expect(r.result.current.offset).toBeNull();
    act(() => g().onPointerDown(ev(1, 100).e));
    act(() => g().onPointerMove(ev(7, 300).e));
    expect(r.result.current.offset).toBeNull();
    act(() => g().onPointerUp(ev(7, 300).e));
    expect(onClose).not.toHaveBeenCalled();
  });

  // Catches: the sheet following the finger under reduced motion (U-5b: it just closes).
  it("5. reduced motion: no offset, and a long drag still closes", () => {
    const { onClose, r, g } = hook(true);
    act(() => g().onPointerDown(ev(1, 100).e));
    act(() => g().onPointerMove(ev(1, 220).e));
    expect(r.result.current.offset).toBeNull();
    act(() => g().onPointerUp(ev(1, 220).e));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
