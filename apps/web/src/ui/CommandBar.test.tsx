// @vitest-environment jsdom
// U-4a / U-4b: the command line. The run button is the frame's logic moved (V-23): the same
// batch under the same label, busy and the countdown carried over, and the reserve never busy
// (W-13). A frameless bottleneck is the comment line, and it's announced (V-14).
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Solution } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { bottleneckRow } from "./derive.js";
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
import { setTheme } from "./theme.js";

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
  act(() => void setTheme("terminal"));
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

const RESERVE = {
  kind: "reserve",
  itemId: "iron_plate",
  percent: 0.25,
  limitingTarget: "item:iron_rod",
} as const;

const NO_GENERATOR = {
  kind: "power",
  limitingTarget: "item:iron_plate",
  generatorRecipeId: null,
  machinesToClear: 0,
  mark: null,
} as const;

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

const bar = () => document.querySelector<HTMLElement>("[data-command]")!;
const run = () => bar().querySelector<HTMLButtonElement>("[data-run]");
const announced = () => document.querySelector("[data-announce]");

describe("the command bar (U-4a)", { timeout: 60_000 }, () => {
  it("3. the run button sends the P-3 batch once, then waits busy, keeping focus", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    expect(bar().tagName).toBe("SECTION");
    expect(bar().getAttribute("aria-label")).toBe("Command line");
    const command = "buy 1 constructor_mk1 --lane iron --for iron_plate";
    // The typed span is aria-hidden; a visually hidden sibling carries the same words.
    const typed = bar().querySelector("[data-typed]")!;
    expect(typed.getAttribute("aria-hidden")).toBe("true");
    expect(typed.textContent).toBe(command);
    expect(bar().querySelector("[data-command-text]")!.textContent).toBe(command);

    const button = run()!;
    expect(button.getAttribute("aria-label")).toBe("Buy 1 Constructor");
    expect(button.textContent).toBe("[ENTER]run");
    expect(button.getAttribute("aria-disabled")).toBe("false");
    button.focus();
    fireEvent.click(button);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith([P3_BUY], "bottleneck buy");

    const batch: Batch = { id: 1, key: "k1", actions: [P3_BUY], label: "bottleneck buy" };
    store.set({ pending: [batch] });
    const busy = run()!;
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.disabled).toBe(false);
    expect(busy.textContent).toBe("[ENTER]running…");
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(store.send).toHaveBeenCalledTimes(1);
  });

  it("4. unaffordable: the label counts down on the 4 Hz tick, off but focusable", () => {
    const store = fakeStore(fresh);
    mount(store);
    const wait = run()!;
    expect(wait.getAttribute("aria-disabled")).toBe("true");
    expect(wait.disabled).toBe(false);
    const m = /^\[ENTER\]affordable in (\d+)s$/.exec(wait.textContent!);
    expect(m).not.toBeNull();
    const n = Number(m![1]);
    expect(n).toBeGreaterThanOrEqual(42);
    expect(n).toBeLessThanOrEqual(44);
    expect(wait.getAttribute("aria-label")).toBe(`Buy 1 Constructor, affordable in ${n} seconds`);
    store.tick(1_000);
    expect(run()!.textContent).toBe(`[ENTER]affordable in ${n - 1}s`);
    expect(run()!.getAttribute("aria-label")).toMatch(/, affordable in \d+ seconds$/);
    fireEvent.click(run()!);
    expect(store.send).not.toHaveBeenCalled();
  });

  it("5. the reserve is never busy, sends once on a double click, and is gone once set", () => {
    const s = withBottleneck(fresh, RESERVE);
    const store = fakeStore(s);
    mount(store);
    expect(bar().textContent).toContain("reserve iron_plate 25%");
    const button = run()!;
    expect(button.getAttribute("aria-label")).toBe("Reserve 25% of Iron Plate");
    expect(button.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(run()!);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith(
      [{ type: "SET_RESERVE", itemId: "iron_plate", percent: 0.25 }],
      "bottleneck buy",
    );
    expect(run()!.getAttribute("aria-busy")).toBeNull();
    // A pending batch under the label doesn't make it busy either: it's a setting.
    store.set({
      pending: [{ id: 1, key: "k", actions: [], label: "bottleneck buy" } satisfies Batch],
    });
    expect(run()!.getAttribute("aria-busy")).toBeNull();

    cleanup();
    const set: Snapshot = { ...s, state: { ...s.state, reserve: { iron_plate: 0.25 } } };
    expect(bottleneckRow(set)!.action).toBeNull();
    mount(fakeStore(set));
    expect(run()).toBeNull();
    expect(bar().textContent).toContain("# iron plate never banks");
  });

  it("8. frameless: the comment line, no run button, no notice line, announced once", () => {
    const store = fakeStore(fresh);
    mount(store);
    const frameless = withBottleneck(fresh, NO_GENERATOR);
    const text = bottleneckRow(frameless)!.text;
    expect(text).toMatch(/^Power is short, /);
    store.set({ snapshot: frameless });
    expect(bar().querySelector("[data-command-text]")!.textContent).toBe(`# ${text.toLowerCase()}`);
    expect(run()).toBeNull();
    expect(document.querySelector('[data-notice="bottleneck"]')).toBeNull();
    const said = announced();
    expect(said?.textContent).toBe(`Bottleneck: ${text}`);
    store.set({ snapshot: { ...frameless } });
    expect(announced()).toBe(said);
  });

  it("8. frameless on the phone: an aria-disabled dash", () => {
    stubWidth(375);
    mount(fakeStore(withBottleneck(fresh, NO_GENERATOR)));
    const dash = run()!;
    expect(dash.textContent).toBe("—");
    expect(dash.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector('[data-notice="bottleneck"]')).toBeNull();
  });

  it("the plain voice: the prompt is Next, the command its plain form", () => {
    act(() => void setTheme("clean-dark"));
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    expect(bar().textContent).toContain("Next");
    expect(bar().querySelector("[data-command-text]")!.textContent).toBe(
      "Buy 1 Constructor Mk.1 for Iron Plate",
    );
    expect(run()!.textContent).toBe("[ENTER]Run");
  });
});
