// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { liquidCap, withInstalled, type Bottleneck, type WorldState } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Outcome } from "../sync/errors.js";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { drawerLabel } from "./Drawer.js";
import {
  CLIENT_T0,
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  starvedPipeState,
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
  vi.unstubAllGlobals();
});

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

/** The state with these items' liquid stock at their caps, so their spends are affordable. */
function topped(state: WorldState, items: readonly string[]): WorldState {
  const stored = { ...state.stored };
  for (const id of items) stored[id] = liquidCap(slice.content, state, id);
  return { ...state, stored };
}

const rowButton = (item: string) =>
  document.querySelector<HTMLButtonElement>(
    `[data-item="${item}"] button[aria-controls="detail"]`,
  )!;
const drawer = (item: string) => document.querySelector<HTMLElement>(`[data-drawer="${item}"]`);

function open(item: string): HTMLElement {
  fireEvent.click(rowButton(item));
  const d = drawer(item);
  expect(d).not.toBeNull();
  return d!;
}

function pick(d: HTMLElement, verb: string) {
  fireEvent.click(within(d).getByRole("button", { name: verb, pressed: false }));
}

const batch = (label: string, id = 1): Batch => ({ id, key: `k${id}`, actions: [], label });

/** matchMedia for a viewport this wide: min-width / max-width queries; never reduced motion. */
function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (q: string) => {
    const min = /min-width:\s*(\d+)px/.exec(q);
    const max = /max-width:\s*(\d+)px/.exec(q);
    const matches =
      !q.includes("reduce") &&
      (min === null || width >= Number(min[1])) &&
      (max === null || width <= Number(max[1]));
    return {
      matches,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList;
  });
}

describe("Drawer", () => {
  it("1. a row's first line opens the drawer; Escape closes it and focus goes back", () => {
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    expect(screen.getByText("Tap a row to buy, upgrade or store")).toBeTruthy();
    const btn = rowButton("iron_ore");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    const d = open("iron_ore");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(d.id).toBe("detail");
    expect(d.getAttribute("aria-labelledby")).toBe("drawer-title");
    expect(document.activeElement).toBe(document.getElementById("drawer-title"));
    expect(within(d).getByText("Miner")).toBeTruthy();
    expect(within(d).getByText("8 more Miners → ×1.50")).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(drawer("iron_ore")).toBeNull();
    expect(document.activeElement).toBe(rowButton("iron_ore"));

    // The Close button too.
    const again = open("iron_ore");
    fireEvent.click(within(again).getByRole("button", { name: "Close" }));
    expect(drawer("iron_ore")).toBeNull();
    expect(document.activeElement).toBe(rowButton("iron_ore"));

    // The frame's own buy does not open the drawer.
    fireEvent.click(screen.getByRole("button", { name: /^Buy 1 Constructor$/ }));
    expect(document.querySelector("[data-drawer]")).toBeNull();
  });

  it("2. the projection shows the selected action's effect before purchase", () => {
    mount(fakeStore(fresh));
    const d = open("iron_plate");
    expect(within(d).getByRole("button", { name: "×1" }).getAttribute("aria-pressed")).toBe("true");
    const p = d.querySelector<HTMLElement>("[data-preview]")!;
    expect(p.getAttribute("aria-live")).toBe("off");
    expect(p.textContent).toContain("Iron Plate");
    expect(p.textContent).toContain("+0.667/s");
    expect(within(p).getByText(/^Power /)).toBeTruthy();
  });

  it("3. Buy is pessimistic and exact", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const d = open("iron_plate");
    const owned = () => d.querySelector("[data-owned]")!.textContent;
    expect(owned()).toBe("1 owned");
    const buy = within(d).getByRole("button", { name: /^Buy 1 Constructor$/ });
    expect((buy as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(buy);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith(
      [
        {
          type: "BUY_MACHINE",
          lane: "iron",
          machineClass: "constructor",
          mark: 1,
          count: 1,
          recipeId: "make_iron_plate",
        },
      ],
      "drawer:iron_plate:buy",
    );
    expect(owned()).toBe("1 owned");

    store.set({ pending: [batch(drawerLabel("iron_plate", "buy"))] });
    const busy = within(d).getByRole("button", { name: /^Buy 1 Constructor$/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(owned()).toBe("1 owned");

    // Only the snapshot moves the count.
    const after = snapshotOf(slice, withInstalled(fresh.state, "iron", "constructor", 1, 2), {
      stateVersion: 1,
    });
    store.set({ pending: [], snapshot: after });
    expect(drawer("iron_plate")!.querySelector("[data-owned]")!.textContent).toBe("2 owned");
  });

  it("3b. before it is affordable: disabled, the short cost red, a countdown", () => {
    mount(fakeStore(fresh));
    const d = open("iron_plate");
    const buy = within(d).getByRole("button", { name: /^Buy 1 Constructor$/ });
    expect((buy as HTMLButtonElement).disabled).toBe(true);
    expect(d.querySelector('[data-cost="iron_ingot"]')!.hasAttribute("data-short")).toBe(true);
    expect(d.querySelector("[data-countdown]")!.textContent).toMatch(/^affordable in 4[2-4]s$/);
  });

  it("4. tier 8: upgrade with its consolidation, and dismantle with its refund", () => {
    const s = snapshotOf(slice, topped(tier8.state, ["iron_plate"]));
    const store = fakeStore(s);
    mount(store);
    const d = open("iron_plate");
    pick(d, "Upgrade");
    expect(within(d).getByText("11 Mk1 → 5 Mk2")).toBeTruthy();
    expect(within(d).getByText("3 Mk2 → 1 Mk3")).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: "Upgrade 11 Mk1 → 5 Mk2" }));
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "UPGRADE_MARK", lane: "iron", machineClass: "constructor", fromMark: 1 }],
      "drawer:iron_plate:upgrade",
    );

    pick(d, "Dismantle");
    const mk1 = d.querySelector<HTMLElement>('[data-dismantle="1"]')!;
    expect(mk1.querySelector("[data-refund]")!.textContent).toBe(
      "refunds 37.8 Iron Ingot; to Quantum Storage first, then BOUND",
    );
    fireEvent.click(within(mk1).getByRole("button", { name: "Dismantle 1 Mk1" }));
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "DISMANTLE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 }],
      "drawer:iron_plate:dismantle",
    );
    expect(store.send).toHaveBeenCalledTimes(2);

    // Each verb is busy only on its own label.
    store.set({ pending: [batch(drawerLabel("iron_plate", "buy"))] });
    const one = within(mk1).getByRole("button", { name: "Dismantle 1 Mk1" });
    expect(one.getAttribute("aria-busy")).toBe("false");
    store.set({ pending: [batch(drawerLabel("iron_plate", "dismantle"))] });
    expect(
      within(d.querySelector<HTMLElement>('[data-dismantle="1"]')!)
        .getByRole("button", { name: "Dismantle 1 Mk1" })
        .getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("4b. an unaffordable upgrade is disabled, its cost red", () => {
    // A minute on, tier 8's iron plate has drained below the Mk2 upgrade's price.
    mount(fakeStore(tier8, { now: CLIENT_T0 + 60_000 }));
    const d = open("iron_plate");
    pick(d, "Upgrade");
    const up = within(d).getByRole("button", { name: "Upgrade 11 Mk1 → 5 Mk2" });
    expect((up as HTMLButtonElement).disabled).toBe(true);
    expect(
      d.querySelector('[data-upgrade="1"] [data-cost="iron_plate"]')!.hasAttribute("data-short"),
    ).toBe(true);
  });

  it("4c. a null action is disabled even though its empty quote is 'affordable'", () => {
    const st = freshState(slice);
    const maxed = { ...st, storageLevel: { ...st.storageLevel, iron_plate: 22 } };
    mount(fakeStore(snapshotOf(slice, maxed)));
    const d = open("iron_plate");
    pick(d, "Storage");
    expect(within(d).getByText("Lv 22 / 22")).toBeTruthy();
    expect(
      (within(d).getByRole("button", { name: "Storage +1" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // A fresh world's Mk1 has no Mk2 unlocked: no upgrade at all, so no Upgrade section.
    expect(within(d).queryByRole("button", { name: "Upgrade" })).toBeNull();
  });

  it("5. storage and QS +1; the recipe radio is optimistic and reverts on a rejection", async () => {
    const s = snapshotOf(slice, topped(freshState(slice), ["iron_plate"]));
    const store = fakeStore(s);
    mount(store);
    const d = open("iron_plate");
    pick(d, "Storage");
    expect(within(d).getByText("Lv 0 / 22")).toBeTruthy();
    fireEvent.click(within(d).getByRole("button", { name: "Storage +1" }));
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "BUY_STORAGE", itemId: "iron_plate", levels: 1 }],
      "drawer:iron_plate:storage",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Quantum Storage +1" }));
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "BUY_QS", lane: "iron", levels: 1 }],
      "drawer:iron_plate:qs",
    );
    cleanup();

    const t8 = fakeStore(tier8);
    mount(t8);
    fireEvent.click(screen.getByRole("tab", { name: /Oil/ }));
    const p = open("plastic");
    pick(p, "Recipe");
    const residual = within(p).getByRole("radio", { name: /^Residual Plastic/ });
    const current = within(p).getByRole("radio", { name: /^Plastic/ });
    const cycle = within(p).getByRole("radio", { name: /^Recycled Plastic/ });
    expect((current as HTMLInputElement).checked).toBe(true);
    expect((cycle as HTMLInputElement).disabled).toBe(true);
    expect(within(p).getByText("unlocks at tier 10")).toBeTruthy();

    let settle!: (o: Outcome) => void;
    t8.send.mockImplementationOnce(() => new Promise<Outcome>((r) => (settle = r)));
    fireEvent.click(residual);
    expect(t8.send).toHaveBeenCalledTimes(1);
    expect(t8.send).toHaveBeenCalledWith(
      [{ type: "SELECT_RECIPE", itemId: "plastic", recipeId: "refine_residual_plastic" }],
      "drawer:plastic:recipe",
    );
    expect((residual as HTMLInputElement).checked).toBe(true);
    // A snapshot meanwhile doesn't move the control.
    t8.set({ snapshot: { ...tier8 } });
    expect(
      (
        within(drawer("plastic")!).getByRole("radio", {
          name: /^Residual Plastic/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await act(async () => {
      settle({ kind: "rejected", body: { failedAction: null, index: 0, reason: "no" } } as never);
      await Promise.resolve();
    });
    const after = drawer("plastic")!;
    expect(
      (within(after).getByRole("radio", { name: /^Plastic/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("6. assign: the idle move is one batch, donor first; the steppers are optimistic", () => {
    const store = fakeStore(snapshotOf(slice, starvedPipeState(slice)));
    mount(store);
    fireEvent.click(screen.getByRole("tab", { name: /Coal/ }));
    const d = open("steel_pipe");
    pick(d, "Assign");
    fireEvent.click(
      within(d).getByRole("button", { name: "Move 3 idle Constructors to Steel Pipe" }),
    );
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith(
      [
        { type: "ASSIGN_MACHINES", recipeId: "make_concrete", count: 3 },
        { type: "ASSIGN_MACHINES", recipeId: "make_steel_pipe", count: 3 },
      ],
      "drawer:steel_pipe:assign",
    );
    // Optimistic: the counts move at once.
    const count = (r: string) =>
      d.querySelector(`[data-assign="${r}"] [data-assigned]`)!.textContent;
    expect(count("make_concrete")).toBe("3");
    expect(count("make_steel_pipe")).toBe("3");
    // The pool is full: no + anywhere, and − on an empty recipe is off.
    const beam = d.querySelector<HTMLElement>('[data-assign="make_steel_beam"]')!;
    expect(
      (within(beam).getByRole("button", { name: "One more on Steel Beam" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(beam).getByRole("button", { name: "One fewer on Steel Beam" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const concrete = d.querySelector<HTMLElement>('[data-assign="make_concrete"]')!;
    fireEvent.click(within(concrete).getByRole("button", { name: "One fewer on Concrete" }));
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "ASSIGN_MACHINES", recipeId: "make_concrete", count: 2 }],
      "drawer:steel_pipe:assign",
    );
    expect(count("make_concrete")).toBe("2");
    expect(
      (within(beam).getByRole("button", { name: "One more on Steel Beam" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("7. the frame renders the reserve and storage actions, with one label", () => {
    const withBottleneck = (b: Bottleneck, base: Snapshot = fresh): Snapshot => ({
      ...base,
      display: { ...base.display, solution: { ...base.display.solution, bottleneck: b } },
    });
    const store = fakeStore(
      withBottleneck({
        kind: "reserve",
        itemId: "iron_ingot",
        percent: 0.25,
        limitingTarget: "item:iron_plate",
      }),
    );
    mount(store);
    expect(screen.getAllByText("bottleneck")).toHaveLength(1);
    const reserve = screen.getByRole("button", { name: "Reserve 25% of Iron Ingot" });
    expect((reserve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reserve);
    expect(store.send).toHaveBeenCalledWith(
      [{ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0.25 }],
      "bottleneck buy",
    );
    // A setting: still enabled while its batch is pending.
    store.set({ pending: [batch("bottleneck buy")] });
    expect(
      (screen.getByRole("button", { name: "Reserve 25% of Iron Ingot" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    cleanup();

    const rich = snapshotOf(slice, topped(freshState(slice), ["iron_plate"]));
    const storage = fakeStore(
      withBottleneck(
        {
          kind: "storage",
          itemId: "iron_plate",
          limitingTarget: "item:iron_rod",
          upgrade: "storage",
        },
        rich,
      ),
    );
    mount(storage);
    expect(screen.getAllByText("bottleneck")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Buy storage for Iron Plate" }));
    expect(storage.send).toHaveBeenCalledWith(
      [{ type: "BUY_STORAGE", itemId: "iron_plate", levels: 1 }],
      "bottleneck buy",
    );
    storage.set({ pending: [batch("bottleneck buy")] });
    const busy = screen.getByRole("button", { name: "Buy storage for Iron Plate" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    mount(
      fakeStore(
        withBottleneck(
          {
            kind: "storage",
            itemId: "iron_plate",
            limitingTarget: "item:iron_rod",
            upgrade: "quantum",
          },
          rich,
        ),
      ),
    );
    expect(screen.getAllByText("bottleneck")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Buy Quantum Storage for Iron" })).toBeTruthy();
  });

  it("8. the pane count follows the viewport; under 600 px the drawer is a dialog sheet", () => {
    stubWidth(1200);
    let r = mount(fakeStore(fresh));
    const layout = () => r.container.querySelector<HTMLElement>("[data-panes]")!;
    expect(layout().dataset.panes).toBe("3");
    expect(screen.queryByRole("tab", { name: "Priority" })).toBeNull();
    cleanup();

    stubWidth(800);
    r = mount(fakeStore(fresh));
    expect(layout().dataset.panes).toBe("2");
    expect(screen.getByRole("tab", { name: "Factory" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Priority" })).toBeTruthy();
    expect(open("iron_ore").getAttribute("role")).toBeNull();
    cleanup();

    stubWidth(400);
    r = mount(fakeStore(fresh));
    expect(layout().dataset.panes).toBe("1");
    expect(screen.getByRole("tab", { name: "Factory" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Priority" })).toBeTruthy();
    // No hint in one column: the sheet appears on demand.
    expect(screen.queryByText("Tap a row to buy, upgrade or store")).toBeNull();
    const sheet = open("iron_ore");
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("false");
    // The Priority tab swaps the column.
    fireEvent.click(screen.getByRole("tab", { name: "Priority" }));
    expect(document.querySelector('[data-item="iron_ore"]')).toBeNull();
  });
});
