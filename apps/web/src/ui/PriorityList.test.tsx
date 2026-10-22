// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { WorldState } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Outcome } from "../sync/errors.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { PRIORITY_LABEL, PriorityList } from "./PriorityList.js";
import { reorderVisible, visiblePriority } from "./priority-model.js";
import {
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";

let slice: Slice;
let fresh: Snapshot;
let tier8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  tier8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

const REJECTED = {
  kind: "rejected",
  body: { failedAction: null, index: 0, reason: "no" },
} as unknown as Outcome;

function mount(s: Snapshot, store: FakeStore = fakeStore(s)) {
  const r = render(<PriorityList store={store} snapshot={s} />);
  return { store, ...r };
}

/** The send's promise, settled by hand. */
function deferred(store: FakeStore) {
  let settle!: (o: Outcome) => void;
  store.send.mockImplementationOnce(() => new Promise<Outcome>((r) => (settle = r)));
  return (o: Outcome) =>
    act(async () => {
      settle(o);
      await Promise.resolve();
      await Promise.resolve();
    });
}

const list = () => screen.getByRole("list", { name: "Output priority" });
const order = () =>
  [...list().querySelectorAll<HTMLElement>(":scope > li[data-entry]")].map(
    (li) => li.dataset.entry,
  );
const row = (entry: string) => list().querySelector<HTMLElement>(`li[data-entry="${entry}"]`)!;
const nameOf = (item: string) => slice.content.items.get(item)!.name;
const altKey = (el: HTMLElement, key: "ArrowUp" | "ArrowDown") =>
  fireEvent.keyDown(el, { key, altKey: true });
const advanced = () => fireEvent.click(screen.getByRole("button", { name: "Advanced" }));

/** Test 2's payload: iron_rod to visible index 1 on a fresh world. */
function rodUp(): string[] {
  return reorderVisible(
    fresh.state.priority.map((e) => e.id),
    visiblePriority(fresh).map((r) => r.entryId),
    "item:iron_rod",
    1,
  );
}

const FRESH_ORDER = [
  "power",
  "item:iron_plate",
  "item:iron_rod",
  "item:iron_ingot",
  "item:iron_ore",
  "item:biomass",
];

/** Rows 40 px tall from y 0, and a pointer-capture spy (jsdom has neither). */
function layoutRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const li = this.closest("li[data-entry]");
    const i = li === null ? 0 : [...li.parentElement!.children].indexOf(li);
    return {
      top: i * 40,
      height: 40,
      bottom: i * 40 + 40,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: i * 40,
      toJSON() {},
    } as DOMRect;
  });
  const capture = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: capture,
  });
  return capture;
}

describe("PriorityList", () => {
  it("5. Alt+↑ is one optimistic REORDER_PRIORITY, focus follows, and a rejection reverts", async () => {
    const { store } = mount(fresh);
    expect(order()).toEqual(FRESH_ORDER);
    const settle = deferred(store);
    const rod = row("item:iron_rod");
    rod.focus();
    altKey(rod, "ArrowUp");
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith(
      [{ type: "REORDER_PRIORITY", entries: rodUp() }],
      PRIORITY_LABEL,
    );
    expect(PRIORITY_LABEL).toBe("priority");
    expect(order().slice(0, 3)).toEqual(["power", "item:iron_rod", "item:iron_plate"]);
    expect(document.activeElement).toBe(row("item:iron_rod"));
    await settle(REJECTED);
    expect(order()).toEqual(FRESH_ORDER);
  });

  it("5b. the held order survives an unmount within the round trip (a tab switch)", async () => {
    const store = fakeStore(fresh);
    const first = mount(fresh, store);
    const settle = deferred(store);
    altKey(row("item:iron_rod"), "ArrowUp");
    first.unmount();
    mount(fresh, store);
    expect(order().slice(0, 3)).toEqual(["power", "item:iron_rod", "item:iron_plate"]);
    await settle(REJECTED);
    expect(order()).toEqual(FRESH_ORDER);
  });

  it("5d. per key, the newest move wins: an older one settling doesn't release it", async () => {
    const { store } = mount(fresh);
    const first = deferred(store);
    altKey(row("item:iron_ingot"), "ArrowUp");
    const second = deferred(store);
    altKey(row("item:iron_ingot"), "ArrowUp");
    expect(store.send).toHaveBeenCalledTimes(2);
    const held = ["power", "item:iron_ingot", "item:iron_plate", "item:iron_rod"];
    expect(order().slice(0, 4)).toEqual(held);
    await first(REJECTED);
    expect(order().slice(0, 4)).toEqual(held);
    await second(REJECTED);
    expect(order()).toEqual(FRESH_ORDER);
  });

  it("5c. the ▲ / ▼ buttons move one place; the ends are off", () => {
    const { store } = mount(fresh);
    const plate = nameOf("iron_plate");
    fireEvent.click(screen.getByRole("button", { name: `Move ${plate} down` }));
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(order().slice(1, 3)).toEqual(["item:iron_rod", "item:iron_plate"]);
    const last = screen.getByRole("button", { name: `Move ${nameOf("biomass")} down` });
    expect(last.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(last);
    expect(store.send).toHaveBeenCalledTimes(1);
  });

  it("6. moving power asks first (C.4); Cancel sends nothing, Move sends once", () => {
    const { store } = mount(fresh);
    const power = row("power");
    power.focus();
    altKey(power, "ArrowDown");
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("C.4");
    expect(store.send).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(store.send).not.toHaveBeenCalled();
    expect(order()).toEqual(FRESH_ORDER);

    altKey(row("power"), "ArrowDown");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Move" }));
    expect(store.send).toHaveBeenCalledTimes(1);
    const all = fresh.state.priority.map((e) => e.id);
    expect(store.send).toHaveBeenCalledWith(
      [{ type: "REORDER_PRIORITY", entries: reorderVisible(all, FRESH_ORDER, "power", 1) }],
      PRIORITY_LABEL,
    );
    expect(order().slice(0, 2)).toEqual(["item:iron_plate", "power"]);
    cleanup();

    // An item between items 1 and 2: no dialog.
    const again = mount(fresh);
    altKey(row("item:iron_plate"), "ArrowDown");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(again.store.send).toHaveBeenCalledTimes(1);
  });

  it("6b. the drag handle: pointer capture, a translateY ghost, drop on release; cancel reverts", () => {
    const capture = layoutRows();
    const { store } = mount(fresh);
    const handle = screen.getByRole("button", { name: `Drag to reorder ${nameOf("iron_ore")}` });
    // Cancel first: no send, no ghost.
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 180, button: 0 });
    expect(capture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 50 });
    expect(row("item:iron_ore").style.transform).toBe("translateY(-130px)");
    expect(list().querySelector("[data-drop]")).not.toBeNull();
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(row("item:iron_ore").style.transform).toBe("");
    expect(store.send).not.toHaveBeenCalled();
    expect(order()).toEqual(FRESH_ORDER);

    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 180, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 50 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: 50 });
    expect(store.send).toHaveBeenCalledTimes(1);
    const all = fresh.state.priority.map((e) => e.id);
    expect(store.send).toHaveBeenCalledWith(
      [{ type: "REORDER_PRIORITY", entries: reorderVisible(all, FRESH_ORDER, "item:iron_ore", 1) }],
      PRIORITY_LABEL,
    );
    expect(order().slice(0, 3)).toEqual(["power", "item:iron_ore", "item:iron_plate"]);
    expect(row("item:iron_ore").style.transform).toBe("");
    delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
  });

  it("6c. a drag ends with no send on lost capture or Escape", () => {
    layoutRows();
    const { store } = mount(fresh);
    const handle = screen.getByRole("button", { name: `Drag to reorder ${nameOf("iron_ore")}` });
    fireEvent.pointerDown(handle, { pointerId: 3, clientY: 180, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientY: 50 });
    expect(list().querySelector("[data-drop]")).not.toBeNull();
    fireEvent.lostPointerCapture(handle, { pointerId: 3 });
    expect(row("item:iron_ore").style.transform).toBe("");
    expect(list().querySelector("[data-drop]")).toBeNull();
    expect(list().querySelector("[data-dragging]")).toBeNull();
    // A late pointerup after the capture is gone drops nothing.
    fireEvent.pointerUp(handle, { pointerId: 3, clientY: 50 });
    expect(store.send).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, { pointerId: 4, clientY: 180, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 4, clientY: 50 });
    fireEvent.keyDown(handle, { key: "Escape" });
    expect(list().querySelector("[data-dragging]")).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 4, clientY: 50 });
    expect(store.send).not.toHaveBeenCalled();
    expect(order()).toEqual(FRESH_ORDER);
    delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
  });

  it("6d. a move is announced politely, and so is its undoing", async () => {
    const { store } = mount(fresh);
    const status = list().parentElement!.querySelector<HTMLElement>("[data-announce]")!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("");
    const settle = deferred(store);
    altKey(row("item:iron_rod"), "ArrowUp");
    expect(status.textContent).toBe(`${nameOf("iron_rod")} moved to position 2 of 6`);
    await settle(REJECTED);
    expect(status.textContent).toBe(`${nameOf("iron_rod")} move undone`);

    // A confirmed power move is announced too.
    altKey(row("power"), "ArrowDown");
    expect(status.textContent).toBe(`${nameOf("iron_rod")} move undone`);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Move" }));
    expect(status.textContent).toBe("Power moved to position 2 of 6");
  });

  it("7. Simple / Advanced: the indicator, mode, target, reserve; power has none", () => {
    const state: WorldState = {
      ...tier8.state,
      priority: tier8.state.priority.map((e) =>
        e.id === "item:iron_rod" ? { ...e, mode: "share" as const } : e,
      ),
    };
    const s = snapshotOf(slice, state);
    const { store } = mount(s);
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Mode of/ })).toBeNull();
    const dots = screen.getAllByRole("button", { name: "advanced settings in effect" });
    expect(dots).toHaveLength(1);
    expect(row("item:iron_rod").contains(dots[0]!)).toBe(true);
    fireEvent.click(dots[0]!);
    expect(screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryAllByRole("spinbutton").length).toBeGreaterThan(0);

    const plate = nameOf("iron_plate");
    const plateRow = row("item:iron_plate");
    fireEvent.click(within(plateRow).getByRole("button", { name: `Mode of ${plate}` }));
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "SET_PRIORITY_MODE", entryId: "item:iron_plate", mode: "share" }],
      PRIORITY_LABEL,
    );
    // The chip shows the new mode at once.
    expect(
      within(row("item:iron_plate")).getByRole("button", { name: `Mode of ${plate}` }).textContent,
    ).toBe("share 1");

    const target = within(row("item:iron_rod")).getByRole("spinbutton", {
      name: `Target rate of ${nameOf("iron_rod")}`,
    });
    fireEvent.change(target, { target: { value: "5" } });
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "SET_PRIORITY_MODE", entryId: "item:iron_rod", mode: "share", targetRate: 5 }],
      PRIORITY_LABEL,
    );
    fireEvent.change(target, { target: { value: "" } });
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "SET_PRIORITY_MODE", entryId: "item:iron_rod", mode: "share", targetRate: null }],
      PRIORITY_LABEL,
    );

    const slider = within(row("item:iron_plate")).getByRole("slider", {
      name: `Reserve of ${plate}`,
    });
    expect(slider.getAttribute("max")).toBe("50");
    const calls = store.send.mock.calls.length;
    fireEvent.input(slider, { target: { value: "20" } });
    expect(store.send.mock.calls.length).toBe(calls);
    fireEvent.change(slider, { target: { value: "25" } });
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "SET_RESERVE", itemId: "iron_plate", percent: 0.25 }],
      PRIORITY_LABEL,
    );
    expect(within(row("item:iron_plate")).getByText("25%")).toBeTruthy();

    const power = row("power");
    expect(within(power).queryAllByRole("spinbutton")).toHaveLength(0);
    expect(within(power).queryAllByRole("slider")).toHaveLength(0);
    expect(within(power).queryByRole("button", { name: /^Mode of/ })).toBeNull();
    expect(within(power).queryByRole("button", { name: /^Pause/ })).toBeNull();
  });

  it("7b. the view choice is remembered per viewer, and Simple is the default", () => {
    mount(fresh);
    expect(screen.getByRole("button", { name: "Simple" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    advanced();
    expect(localStorage.getItem("mi.priorityView")).toBe("advanced");
    cleanup();
    mount(fresh);
    expect(screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("8. pause is one SET_PRIORITY_MODE with its mode, and shows paused at once", () => {
    const { store } = mount(fresh);
    const plate = row("item:iron_plate");
    expect(within(plate).queryByText("paused")).toBeNull();
    fireEvent.click(within(plate).getByRole("button", { name: `Pause ${nameOf("iron_plate")}` }));
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith(
      [{ type: "SET_PRIORITY_MODE", entryId: "item:iron_plate", mode: "guaranteed", paused: true }],
      PRIORITY_LABEL,
    );
    const chip = row("item:iron_plate").querySelector("[data-chip]")!;
    expect(chip.textContent).toBe("paused");
    expect(chip.getAttribute("data-state")).toBe("paused");
  });

  it("9. a split bar focuses its item's entry in the list", () => {
    // slice-tier-8-reinforced-full: screw is contested (derive test 4).
    const full = snapshotOf(slice, fixtureState("slice-tier-8-reinforced-full.world.json"));
    render(<App store={fakeStore(full) as unknown as GameStore} />);
    fireEvent.click(screen.getByRole("tab", { name: /Iron/ }));
    const split = document.querySelector<HTMLButtonElement>(
      '[data-item="screw"] button[data-split]',
    );
    expect(split).not.toBeNull();
    const item = "screw";
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    fireEvent.click(split!);
    expect(document.activeElement).toBe(row(`item:${item}`));
    expect(scroll).toHaveBeenCalled();
  });
});
