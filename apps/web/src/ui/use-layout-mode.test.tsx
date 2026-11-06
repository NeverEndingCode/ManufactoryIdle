// @vitest-environment jsdom
// U-2a: W-19's two widths. 600 is the tablet's first pixel, 1000 its last.
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubWidth } from "./test-fixtures.js";
import { useLayoutMode, type LayoutMode } from "./use-layout-mode.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useLayoutMode (U-2a)", () => {
  // Catches: an off-by-one at either breakpoint (min-width 601, or 1000 as desktop).
  it("the boundaries: 599 phone, 600 and 1000 tablet, 1001 desktop", () => {
    const cases: [number, LayoutMode][] = [
      [599, "phone"],
      [600, "tablet"],
      [1000, "tablet"],
      [1001, "desktop"],
    ];
    for (const [width, mode] of cases) {
      stubWidth(width);
      const { result, unmount } = renderHook(() => useLayoutMode());
      expect(result.current, `${width}px`).toBe(mode);
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it("a resize across a boundary re-renders with the new mode", () => {
    const media = stubWidth(1001);
    const { result } = renderHook(() => useLayoutMode());
    expect(result.current).toBe("desktop");
    media.resize(1000);
    expect(result.current).toBe("tablet");
    media.resize(599);
    expect(result.current).toBe("phone");
  });
});
