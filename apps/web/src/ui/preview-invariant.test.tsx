// @vitest-environment jsdom
// An invariant break in preview() (a residue past SPEND_RESIDUAL_TOLERANCE) must reject the
// preview, not throw out of a render.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { D } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { PREVIEW_UNAVAILABLE, preview } from "./preview.js";
import { fakeStore, freshState, loadSlice, snapshotOf, type Slice } from "./test-fixtures.js";

// applyBatch leaves a residue of 1 in iron_ingot, far past the tolerance.
vi.mock("@manufactory/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@manufactory/engine")>();
  return {
    ...real,
    applyBatch: (...args: Parameters<typeof real.applyBatch>) => {
      const r = real.applyBatch(...args);
      if (r.rejected) return r;
      return { ...r, state: { ...r.state, stored: { ...r.state.stored, iron_ingot: D(1) } } };
    },
  };
});

let slice: Slice;
beforeAll(() => {
  slice = loadSlice();
});
afterEach(cleanup);

const BUY = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
} as const;

describe("preview invariant", () => {
  it("a residue past the tolerance returns a rejected preview and logs, never throws", () => {
    const fresh = snapshotOf(slice, freshState(slice));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = preview(fresh, [BUY]);
    expect(p).toEqual({ ok: false, reason: PREVIEW_UNAVAILABLE });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("residue"));
    err.mockRestore();
  });

  it("the drawer renders the reason", () => {
    const fresh = snapshotOf(slice, freshState(slice));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App store={fakeStore(fresh) as unknown as GameStore} />);
    fireEvent.click(
      document.querySelector<HTMLElement>('li[role="option"][data-item="iron_plate"]')!,
    );
    const p = document.querySelector<HTMLElement>("[data-drawer] [data-preview]")!;
    expect(p.textContent).toContain(PREVIEW_UNAVAILABLE);
    // MACHINES' buy 1 is still there (K-13's name, with its countdown while short).
    expect(screen.getByRole("button", { name: /^Buy 1 Constructor Mk\.1(,|$)/ })).toBeTruthy();
    err.mockRestore();
  });
});
