// @vitest-environment jsdom
// U-4c: the NEXT_BUY card (desktop, non-modal) and sheet (phone, modal over the inert
// background, the live region spared: V-12), and the phone's split bar (U-4b).
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Solution } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import {
  CLIENT_T0,
  fakeStore,
  freshState,
  loadSlice,
  snapshotOf,
  stubWidth,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";

let slice: Slice;
let fresh: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const P3_BUY = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
} as const;

const withBottleneck = (s: Snapshot, b: Solution["bottleneck"]): Snapshot => ({
  ...s,
  display: { ...s.display, solution: { ...s.display.solution, bottleneck: b } },
});

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const why = () => q<HTMLButtonElement>("[data-why]")!;
const card = () => q("[data-next-buy]");

describe("the NEXT_BUY card (U-4c, desktop)", { timeout: 60_000 }, () => {
  it("6. why opens the card on its primary; Esc closes it and returns focus to why", () => {
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    expect(card()).toBeNull();
    expect(why().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(why());
    const c = card()!;
    expect(c.tagName).toBe("SECTION");
    expect(c.getAttribute("role")).toBe("dialog");
    expect(c.getAttribute("aria-modal")).toBe("false");
    const title = document.getElementById(c.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("NEXT_BUY");
    expect(c.textContent).toContain("+1 CONSTRUCTOR_MK1 → IRON_PLATE");
    expect(why().getAttribute("aria-expanded")).toBe("true");
    const primary = c.querySelector<HTMLButtonElement>("[data-run]")!;
    expect(primary.getAttribute("aria-label")).toBe("Buy 1 Constructor");
    expect(document.activeElement).toBe(primary);
    // Count 1: no "buy 1".
    expect(c.querySelectorAll("[data-run]")).toHaveLength(1);

    fireEvent.keyDown(primary, { key: "Escape" });
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(why());
  });

  it("6. the card's run sends the same batch", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    fireEvent.click(why());
    fireEvent.click(card()!.querySelector("[data-run]")!);
    expect(store.send).toHaveBeenCalledWith([P3_BUY], "bottleneck buy");
  });

  it("6. focus leaving it for an outside element closes it", () => {
    mount(fakeStore(fresh));
    fireEvent.click(why());
    const inside = card()!.querySelector<HTMLElement>("[data-run]")!;
    const outside = document.getElementById("lane-tab-iron")!;
    // Moving inside, or to nowhere (a button that unmounts), keeps it.
    fireEvent.focusOut(inside, { relatedTarget: card()!.querySelector("[data-close]") });
    fireEvent.focusOut(inside, { relatedTarget: null });
    expect(card()).not.toBeNull();
    fireEvent.focusOut(inside, { relatedTarget: outside });
    expect(card()).toBeNull();
  });

  it("6. across a buy the card stays open and shows the next advice", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    fireEvent.click(why());
    expect(card()!.textContent).toContain("+1 CONSTRUCTOR_MK1 → IRON_PLATE");
    const next = withBottleneck(
      { ...fresh, stateVersion: 1 },
      { kind: "storage", itemId: "iron_rod", limitingTarget: "item:iron_rod", upgrade: "quantum" },
    );
    store.set({ snapshot: next });
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("+1 qs → IRON");
    expect(card()!.textContent).toContain("IRON quantum +1 level");
  });

  it("6. buy 1 is there for a count above 1 and sends count 1 under the same label", () => {
    const many = withBottleneck(fresh, {
      kind: "recipe",
      recipeId: "make_iron_plate",
      limitingTarget: "item:iron_plate",
      machinesToClear: 3,
      mark: 1,
    });
    const store = fakeStore(many, { now: CLIENT_T0 + 3_600_000 });
    mount(store);
    fireEvent.click(why());
    const buttons = card()!.querySelectorAll<HTMLButtonElement>("[data-run]");
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.getAttribute("aria-label")).toBe("Buy 1 Constructor");
    fireEvent.click(buttons[1]!);
    expect(store.send).toHaveBeenCalledWith([P3_BUY], "bottleneck buy");
  });
});

describe("the phone: the split bar and the sheet (U-4b, U-4c)", { timeout: 60_000 }, () => {
  const sheet = () => q("[data-next-buy]");

  it("7. the right button sends the same batch; the left one names the advice", () => {
    stubWidth(375);
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const split = q("[data-command]")!;
    const runs = split.querySelectorAll<HTMLButtonElement>("[data-run]");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.textContent).toBe("[ buy 1 ]");
    fireEvent.click(runs[0]!);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith([P3_BUY], "bottleneck buy");
    expect(why().getAttribute("aria-label")).toBe(
      "Why: next buy is 1 Constructor for Iron Plate. Open details",
    );
    expect(why().textContent).toContain("1 constructor → IRON_PLATE");
  });

  it("7. the sheet is modal: the background inert, the region live, Tab wrapping", () => {
    stubWidth(375);
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    fireEvent.click(why());
    const s = sheet()!;
    expect(s.getAttribute("role")).toBe("dialog");
    expect(s.getAttribute("aria-modal")).toBe("true");
    expect(s.closest("[inert]")).toBeNull();
    expect(document.getElementById("lane-tab-iron")!.closest("[inert]")).not.toBeNull();
    expect(why().closest("[inert]")).not.toBeNull();
    // W-20: the one region keeps speaking.
    expect(q(".notices")!.closest("[inert]")).toBeNull();
    expect(s.contains(document.activeElement)).toBe(true);

    const tabbable = [...s.querySelectorAll<HTMLElement>("button")];
    const first = tabbable[0]!;
    const last = tabbable.at(-1)!;
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("7. open ITEM closes the sheet and opens that item's drawer", () => {
    stubWidth(375);
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    fireEvent.click(why());
    const open = sheet()!.querySelector<HTMLButtonElement>("[data-open-item]")!;
    expect(open.textContent).toBe("open IRON_PLATE");
    fireEvent.click(open);
    expect(sheet()).toBeNull();
    expect(q('[data-drawer="iron_plate"]')).not.toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("7. the backdrop, the close button and Esc close it, returning focus to why", () => {
    stubWidth(375);
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    fireEvent.click(why());
    fireEvent.mouseDown(q("[data-next-buy-host]")!);
    expect(sheet()).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expect(document.activeElement).toBe(why());

    fireEvent.click(why());
    fireEvent.click(sheet()!.querySelector("[data-close]")!);
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(why());

    fireEvent.click(why());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(why());
  });
});
