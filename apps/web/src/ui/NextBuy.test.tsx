// @vitest-environment jsdom
// U-4c: the NEXT_BUY card (desktop, non-modal) and sheet (phone, modal over the inert
// background, the live region spared: V-12), and the phone's split bar (U-4b).
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Solution } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { bottleneckRow, powerLaneId } from "./derive.js";
import {
  CLIENT_T0,
  fakeStore,
  freshState,
  loadSlice,
  snapshotOf,
  spokenIds,
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
    // U-1h: NEXT_BUY is seen, "Next buy" heard.
    expect(title.querySelector('[aria-hidden="true"]')!.textContent).toBe("NEXT_BUY");
    expect(title.querySelector(".visually-hidden")!.textContent).toBe("Next buy");
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

  it("6. a second click on why closes the card (it toggles)", async () => {
    const user = userEvent.setup();
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    await user.click(why());
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(card()!.querySelector("[data-run]"));
    // The mouse moves focus from the card to why first: that blur must not close it, or the
    // click would reopen it.
    await user.click(why());
    expect(card()).toBeNull();
    expect(why().getAttribute("aria-expanded")).toBe("false");
    await user.click(why());
    expect(card()).not.toBeNull();
  });

  it("6. frameless: the card shows the advice, and its close button takes focus", () => {
    const frameless = withBottleneck(fresh, {
      kind: "power",
      limitingTarget: "item:iron_plate",
      generatorRecipeId: null,
      machinesToClear: 0,
      mark: null,
    });
    const text = bottleneckRow(frameless)!.text;
    mount(fakeStore(frameless));
    fireEvent.click(why());
    expect(card()!.textContent).toContain(text);
    expect(card()!.querySelector("[data-run]")).toBeNull();
    expect(document.activeElement).toBe(card()!.querySelector("[data-close]"));
  });

  it("6. the card's run sends the same batch", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    fireEvent.click(why());
    fireEvent.click(card()!.querySelector("[data-run]")!);
    expect(store.send).toHaveBeenCalledWith([P3_BUY], "bottleneck buy");
  });

  it("6. Esc closes it with focus fallen to <body> (a buy unmounted the run, K-21)", () => {
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    fireEvent.click(why());
    expect(card()).not.toBeNull();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(card()).toBeNull();
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
    // Into a modal (the help, opened by ?) keeps it too: it sits inert under the modal.
    const host = document.createElement("div");
    host.setAttribute("data-help-host", "");
    const title = host.appendChild(document.createElement("h2"));
    document.body.appendChild(host);
    fireEvent.focusOut(inside, { relatedTarget: title });
    expect(card()).not.toBeNull();
    host.remove();
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

  // Catches: an id (CONSTRUCTOR_MK1, IRON_PLATE, NEXT_BUY) reaching a reader from the card's
  // action, why, cost, effect or buy-1 lines (U-1h).
  it("U-1h. terminal: the card says content names, never ids", () => {
    const many = withBottleneck(fresh, {
      kind: "recipe",
      recipeId: "make_iron_plate",
      limitingTarget: "item:iron_plate",
      machinesToClear: 3,
      mark: 1,
    });
    mount(fakeStore(many, { now: CLIENT_T0 + 3_600_000 }));
    fireEvent.click(why());
    const c = card()!;
    fireEvent.mouseEnter(c.querySelectorAll<HTMLElement>("[data-run]")[1]!.parentElement!);
    expect(c.textContent).toContain("+3 CONSTRUCTOR_MK1 → IRON_PLATE");
    expect(c.textContent).toContain("+3 Constructor Mk.1 → Iron Plate");
    expect(c.textContent).toContain("1: IRON_PLATE");
    expect(spokenIds(c)).toEqual([]);
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
    expect(open.getAttribute("aria-label")).toBe("open Iron Plate");
    fireEvent.click(open);
    expect(sheet()).toBeNull();
    // K-3: the drawer sheet is the modal now, the only one; the background stays inert.
    expect(q('[data-drawer="iron_plate"]')!.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(why().closest("[inert]")).not.toBeNull();
  });

  // Catches: a power-lane item's "open" picking the power lane, which the phone's lane tabs
  // don't have (the drawer would never show).
  it("7. open ITEM for a power-lane item shows the power view with its drawer", () => {
    stubWidth(375);
    const s = withBottleneck(fresh, {
      kind: "storage",
      itemId: "biomass",
      limitingTarget: "item:biomass",
      upgrade: "storage",
    });
    expect(s.content.items.get("biomass")!.lane).toBe(powerLaneId(s));
    mount(fakeStore(s, { now: CLIENT_T0 + 60_000 }));
    fireEvent.click(why());
    fireEvent.click(sheet()!.querySelector<HTMLButtonElement>("[data-open-item]")!);
    expect(sheet()).toBeNull();
    expect(q('[data-view="power"]')!.getAttribute("aria-selected")).toBe("true");
    expect(q("[data-power-panel]")).not.toBeNull();
    expect(q('[data-drawer="biomass"]')).not.toBeNull();
  });

  // Catches: the sheet's lines or its "open ITEM" button saying an id (U-1h).
  it("U-1h. terminal: the sheet says content names, never ids", () => {
    stubWidth(375);
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    fireEvent.click(why());
    const s = sheet()!;
    expect(s.textContent).toContain("IRON_PLATE");
    expect(spokenIds(s)).toEqual([]);
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
