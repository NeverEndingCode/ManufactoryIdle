// @vitest-environment jsdom
// Q-6, Q-14: every one of spec D.1's eleven actions is reachable through the UI. Each case
// mounts the whole App over a fake store, drives only the DOM, and checks that the one batch
// sent carries the action and that the engine accepts it on the state the client's numbers
// describe (snapshot.display.state).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { apply, applyBatch, liquidCap, type Action, type WorldState } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { TapAccumulator } from "../sync/taps.js";
import { App } from "./App.js";
import {
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  starvedPipeState,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";

/** All eleven: a twelfth member of the union fails to compile here. */
const ALL_ACTIONS = {
  BUY_MACHINE: true,
  DISMANTLE: true,
  UPGRADE_MARK: true,
  ASSIGN_MACHINES: true,
  SELECT_RECIPE: true,
  REORDER_PRIORITY: true,
  SET_PRIORITY_MODE: true,
  SET_RESERVE: true,
  BUY_STORAGE: true,
  BUY_QS: true,
  TAP: true,
} as const satisfies Record<Action["type"], true>;

const covered = new Set<Action["type"]>();

let slice: Slice;
beforeAll(() => {
  slice = loadSlice();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

/** Every stock item's liquid stock at its cap, so a spend on it is affordable. */
function topped(state: WorldState): WorldState {
  const stored = { ...state.stored };
  for (const id of slice.content.stockItemIds) stored[id] = liquidCap(slice.content, state, id);
  return { ...state, stored };
}

function mount(s: Snapshot): FakeStore {
  const store = fakeStore(s);
  render(<App store={store as unknown as GameStore} />);
  return store;
}

/** Exactly one batch was sent, it carries `type`, and the engine accepts it. */
function expectSent(store: FakeStore, s: Snapshot, type: Action["type"]): Action[] {
  expect(store.send).toHaveBeenCalledTimes(1);
  const batch = store.send.mock.calls[0]![0];
  expect(batch.map((a) => a.type)).toContain(type);
  const result = applyBatch(s.display.state, s.content, batch, s.display.state.seed);
  expect(result.rejected ? result.reason : "accepted").toBe("accepted");
  covered.add(type);
  return batch;
}

const lane = (name: RegExp) => fireEvent.click(screen.getByRole("tab", { name }));

function open(item: string): HTMLElement {
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(`[data-item="${item}"] button[data-open-row]`)!,
  );
  const d = document.querySelector<HTMLElement>(`[data-drawer="${item}"]`);
  expect(d).not.toBeNull();
  return d!;
}

function pick(d: HTMLElement, verb: string) {
  fireEvent.click(within(d).getByRole("button", { name: verb, pressed: false }));
}

const entry = (id: string) =>
  screen
    .getByRole("list", { name: "Output priority" })
    .querySelector<HTMLElement>(`li[data-entry="${id}"]`)!;

describe("D.1 coverage (Q-6, Q-14)", () => {
  it("BUY_MACHINE: the drawer's Buy, tier 8 power / collector", () => {
    const s = snapshotOf(slice, topped(fixtureState("slice-tier-8.world.json")));
    const store = mount(s);
    lane(/Power/);
    const d = open("biomass");
    expect(d.querySelector("[data-class]")!.textContent).toBe("Biomass Collector");
    fireEvent.click(within(d).getByRole("button", { name: /^Buy 1 Biomass Collector$/ }));
    const [a] = expectSent(store, s, "BUY_MACHINE");
    expect(a).toMatchObject({ lane: "power", machineClass: "collector", count: 1 });
  });

  it("DISMANTLE: the drawer's Dismantle", () => {
    const s = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
    const store = mount(s);
    const d = open("iron_plate");
    pick(d, "Dismantle");
    const mk1 = d.querySelector<HTMLElement>('[data-dismantle="1"]')!;
    fireEvent.click(within(mk1).getByRole("button", { name: "Dismantle ×1 Mk1" }));
    expectSent(store, s, "DISMANTLE");
  });

  it("UPGRADE_MARK: the drawer's Upgrade, tier 8 iron Constructor Mk1", () => {
    const s = snapshotOf(slice, topped(fixtureState("slice-tier-8.world.json")));
    const store = mount(s);
    const d = open("iron_plate");
    pick(d, "Upgrade");
    fireEvent.click(within(d).getByRole("button", { name: "Upgrade 11 Mk1 → 5 Mk2" }));
    const [a] = expectSent(store, s, "UPGRADE_MARK");
    expect(a).toEqual({
      type: "UPGRADE_MARK",
      lane: "iron",
      machineClass: "constructor",
      fromMark: 1,
    });
  });

  it("ASSIGN_MACHINES: a drawer stepper", () => {
    const s = snapshotOf(slice, starvedPipeState(slice));
    const store = mount(s);
    lane(/Coal/);
    const d = open("steel_pipe");
    pick(d, "Assign");
    const concrete = d.querySelector<HTMLElement>('[data-assign="make_concrete"]')!;
    fireEvent.click(within(concrete).getByRole("button", { name: "One fewer on Concrete" }));
    const batch = expectSent(store, s, "ASSIGN_MACHINES");
    expect(batch).toEqual([{ type: "ASSIGN_MACHINES", recipeId: "make_concrete", count: 5 }]);
  });

  it("SELECT_RECIPE: the drawer's Recipe radio, tier 8 plastic", () => {
    const s = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
    const store = mount(s);
    lane(/Oil/);
    const d = open("plastic");
    pick(d, "Recipe");
    fireEvent.click(within(d).getByRole("radio", { name: /^Residual Plastic/ }));
    const [a] = expectSent(store, s, "SELECT_RECIPE");
    expect(a).toEqual({
      type: "SELECT_RECIPE",
      itemId: "plastic",
      recipeId: "refine_residual_plastic",
    });
  });

  it("REORDER_PRIORITY: the priority list, Alt+↓ on an item", () => {
    const s = snapshotOf(slice, freshState(slice));
    const store = mount(s);
    const plate = entry("item:iron_plate");
    plate.focus();
    fireEvent.keyDown(plate, { key: "ArrowDown", altKey: true });
    const [a] = expectSent(store, s, "REORDER_PRIORITY");
    expect(a!.type === "REORDER_PRIORITY" && a.entries.slice(0, 3)).toEqual([
      "power",
      "item:iron_rod",
      "item:iron_plate",
    ]);
  });

  it("SET_PRIORITY_MODE: Advanced mode, the mode chip", () => {
    const s = snapshotOf(slice, freshState(slice));
    const store = mount(s);
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.click(
      within(entry("item:iron_plate")).getByRole("button", { name: "Mode of Iron Plate" }),
    );
    const [a] = expectSent(store, s, "SET_PRIORITY_MODE");
    expect(a).toEqual({ type: "SET_PRIORITY_MODE", entryId: "item:iron_plate", mode: "share" });
  });

  it("SET_RESERVE: the Advanced reserve slider", () => {
    const s = snapshotOf(slice, freshState(slice));
    const store = mount(s);
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    const slider = within(entry("item:iron_plate")).getByRole("slider", {
      name: "Reserve of Iron Plate",
    });
    fireEvent.change(slider, { target: { value: "25" } });
    const [a] = expectSent(store, s, "SET_RESERVE");
    expect(a).toEqual({ type: "SET_RESERVE", itemId: "iron_plate", percent: 0.25 });
  });

  it("BUY_STORAGE: the drawer's Storage +1", () => {
    const s = snapshotOf(slice, topped(freshState(slice)));
    const store = mount(s);
    const d = open("iron_plate");
    pick(d, "Storage");
    fireEvent.click(within(d).getByRole("button", { name: "Storage +1" }));
    const [a] = expectSent(store, s, "BUY_STORAGE");
    expect(a).toEqual({ type: "BUY_STORAGE", itemId: "iron_plate", levels: 1 });
  });

  it("BUY_QS: the drawer's Quantum Storage +1", () => {
    const s = snapshotOf(slice, topped(freshState(slice)));
    const store = mount(s);
    const d = open("iron_plate");
    pick(d, "Storage");
    fireEvent.click(within(d).getByRole("button", { name: "Quantum Storage +1" }));
    const [a] = expectSent(store, s, "BUY_QS");
    expect(a).toEqual({ type: "BUY_QS", lane: "iron", levels: 1 });
  });

  it("TAP: the dock's tap holds and releases; the store's flush is accepted", () => {
    const s = snapshotOf(slice, freshState(slice));
    const store = mount(s);
    const tap = screen.getByRole("button", { name: "Tap: hold to keep the kick" });
    fireEvent.pointerDown(tap, { pointerId: 1, button: 0 });
    expect(store.pressTap).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(tap, { pointerId: 1, button: 0 });
    expect(store.releaseTap).toHaveBeenCalledTimes(1);
    // The tap is the store's: nothing goes through send. The fake store has no flush, so build
    // the one the store would send, from its own accumulator: a press, a second's hold.
    expect(store.send).not.toHaveBeenCalled();
    let clock = 0;
    const acc = new TapAccumulator(() => clock, 0);
    for (let i = 0; i < 10; i += 1) acc.tap();
    clock = 1_000;
    const flush = acc.take()!;
    expect(flush).toEqual({ type: "TAP", count: 10, clientElapsedMs: 1_000 });
    const result = apply(s.display.state, s.content, flush, s.display.state.seed);
    expect(result.rejected ? result.reason : "accepted").toBe("accepted");
    covered.add("TAP");
  });

  it("covers all eleven action types", () => {
    expect([...covered].sort()).toEqual(Object.keys(ALL_ACTIONS).sort());
  });
});
