// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { D, liquidCap, withInstalled, type Bottleneck, type WorldState } from "@manufactory/engine";
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
  document.querySelector<HTMLButtonElement>(`[data-item="${item}"] button[data-open-row]`)!;
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

/** matchMedia for a viewport this wide: min-width / max-width queries, never reduced motion.
 * resize() changes the width and fires `change` on each list whose answer flipped. */
function stubWidth(initial: number) {
  let width = initial;
  const lists: { q: string; matches: boolean; fns: Set<() => void> }[] = [];
  const evaluate = (q: string) => {
    const min = /min-width:\s*(\d+)px/.exec(q);
    const max = /max-width:\s*(\d+)px/.exec(q);
    return (
      !q.includes("reduce") &&
      (min === null || width >= Number(min[1])) &&
      (max === null || width <= Number(max[1]))
    );
  };
  vi.stubGlobal("matchMedia", (q: string) => {
    const entry = { q, matches: evaluate(q), fns: new Set<() => void>() };
    lists.push(entry);
    return {
      get matches() {
        return evaluate(q);
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => entry.fns.add(fn),
      removeEventListener: (_: string, fn: () => void) => entry.fns.delete(fn),
    } as unknown as MediaQueryList;
  });
  return {
    resize(w: number) {
      width = w;
      act(() => {
        for (const l of lists) {
          const now = evaluate(l.q);
          if (now === l.matches) continue;
          l.matches = now;
          for (const fn of [...l.fns]) fn();
        }
      });
    },
    get listeners() {
      return lists.reduce((n, l) => n + l.fns.size, 0);
    },
  };
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
    expect((buy as HTMLButtonElement).getAttribute("aria-disabled") === "true").toBe(false);
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
    expect((busy as HTMLButtonElement).getAttribute("aria-disabled") === "true").toBe(true);
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
    expect((buy as HTMLButtonElement).getAttribute("aria-disabled") === "true").toBe(true);
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
    fireEvent.click(within(mk1).getByRole("button", { name: "Dismantle ×1 Mk1" }));
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "DISMANTLE", lane: "iron", machineClass: "constructor", mark: 1, count: 1 }],
      "drawer:iron_plate:dismantle",
    );
    expect(store.send).toHaveBeenCalledTimes(2);

    // Each verb is busy only on its own label.
    store.set({ pending: [batch(drawerLabel("iron_plate", "buy"))] });
    const one = within(mk1).getByRole("button", { name: "Dismantle ×1 Mk1" });
    expect(one.getAttribute("aria-busy")).toBe("false");
    store.set({ pending: [batch(drawerLabel("iron_plate", "dismantle"))] });
    expect(
      within(d.querySelector<HTMLElement>('[data-dismantle="1"]')!)
        .getByRole("button", { name: "Dismantle ×1 Mk1" })
        .getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("4b. an unaffordable upgrade is disabled, its cost red", () => {
    // A minute on, tier 8's iron plate has drained below the Mk2 upgrade's price.
    mount(fakeStore(tier8, { now: CLIENT_T0 + 60_000 }));
    const d = open("iron_plate");
    pick(d, "Upgrade");
    const up = within(d).getByRole("button", { name: "Upgrade 11 Mk1 → 5 Mk2" });
    expect((up as HTMLButtonElement).getAttribute("aria-disabled") === "true").toBe(true);
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
      (within(d).getByRole("button", { name: "Storage +1" }) as HTMLButtonElement).getAttribute(
        "aria-disabled",
      ) === "true",
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
      (
        within(beam).getByRole("button", { name: "One more on Steel Beam" }) as HTMLButtonElement
      ).getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(
      (
        within(beam).getByRole("button", { name: "One fewer on Steel Beam" }) as HTMLButtonElement
      ).getAttribute("aria-disabled") === "true",
    ).toBe(true);
    const concrete = d.querySelector<HTMLElement>('[data-assign="make_concrete"]')!;
    fireEvent.click(within(concrete).getByRole("button", { name: "One fewer on Concrete" }));
    expect(store.send).toHaveBeenLastCalledWith(
      [{ type: "ASSIGN_MACHINES", recipeId: "make_concrete", count: 2 }],
      "drawer:steel_pipe:assign",
    );
    expect(count("make_concrete")).toBe("2");
    expect(
      (
        within(beam).getByRole("button", { name: "One more on Steel Beam" }) as HTMLButtonElement
      ).getAttribute("aria-disabled") === "true",
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

  it("9. a cost is red exactly when its button is off for lack of that item", () => {
    const cases: [Snapshot, number, string, string][] = [
      [fresh, CLIENT_T0, "iron_plate", "Buy"],
      [fresh, CLIENT_T0 + 60_000, "iron_plate", "Buy"],
      [tier8, CLIENT_T0, "iron_plate", "Upgrade"],
      [tier8, CLIENT_T0 + 60_000, "iron_plate", "Upgrade"],
      [fresh, CLIENT_T0 + 60_000, "iron_plate", "Storage"],
    ];
    let reds = 0;
    let clear = 0;
    for (const [snap, now, item, verb] of cases) {
      mount(fakeStore(snap, { now }));
      const d = open(item);
      if (verb !== "Buy") pick(d, verb);
      for (const cost of d.querySelectorAll<HTMLElement>('ul[aria-label="Cost"]')) {
        const block = cost.parentElement!;
        const button = block.querySelector("button")!;
        const short = cost.querySelectorAll("[data-short]").length > 0;
        expect(button.getAttribute("aria-disabled")).toBe(String(short));
        if (short) reds += 1;
        else clear += 1;
      }
      cleanup();
    }
    // Per item, not per list: a two-item cost with one item short (tier 8's Reinforced Iron
    // Plate at Mk1 costs iron plate and iron rod; no plate, rod at its cap).
    const t8 = fixtureState("slice-tier-8.world.json");
    const mixed = topped({ ...t8, stored: { ...t8.stored, iron_plate: D(0) } }, ["iron_rod"]);
    mount(fakeStore(snapshotOf(slice, mixed)));
    const d = open("reinforced_iron_plate");
    fireEvent.change(within(d).getByLabelText("Mark"), { target: { value: "1" } });
    expect(d.querySelector('[data-cost="iron_plate"]')!.hasAttribute("data-short")).toBe(true);
    expect(d.querySelector('[data-cost="iron_rod"]')!.hasAttribute("data-short")).toBe(false);
    expect(
      within(d)
        .getByRole("button", { name: /^Buy 1 / })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    cleanup();
    // Both sides of the rule are exercised.
    expect(reds).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(0);
  });

  it("10. Escape still closes while a focused spend is busy", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const d = open("iron_plate");
    const buy = within(d).getByRole("button", { name: /^Buy 1 Constructor$/ });
    buy.focus();
    fireEvent.click(buy);
    store.set({ pending: [batch(drawerLabel("iron_plate", "buy"))] });
    const busy = within(drawer("iron_plate")!).getByRole("button", { name: /^Buy 1 Constructor$/ });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(busy);
    // Off by aria-disabled, never the native disabled: a focused disabled button loses its
    // keyboard events in a browser (jsdom doesn't model that, so this pins it directly).
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    // A busy button ignores clicks.
    fireEvent.click(busy);
    expect(store.send).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(busy, { key: "Escape" });
    expect(drawer("iron_plate")).toBeNull();
    expect(document.activeElement).toBe(rowButton("iron_plate"));
  });

  it("11. closing after the row left: focus goes to the selected lane tab", () => {
    mount(fakeStore(fresh));
    const d = open("iron_ore");
    fireEvent.click(screen.getByRole("tab", { name: /Power/ }));
    expect(document.querySelector('[data-item="iron_ore"]')).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    expect(drawer("iron_ore")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Power/ }));
  });

  it("12. at 2 panes the Priority view hides the row; closing focuses the view tab", () => {
    stubWidth(800);
    mount(fakeStore(fresh));
    const d = open("iron_ore");
    fireEvent.click(screen.getByRole("tab", { name: "Priority" }));
    // The drawer stays in the detail pane.
    expect(drawer("iron_ore")).toBe(d);
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Priority" }));
  });

  it("13. a pane-count change re-lays out in place and never steals focus", () => {
    const media = stubWidth(800);
    const r = mount(fakeStore(fresh));
    const layout = () => r.container.querySelector<HTMLElement>("[data-panes]")!;
    const d = open("iron_ore");
    expect(d.getAttribute("role")).toBeNull();
    const lane = screen.getByRole("tab", { name: /Iron/ });
    lane.focus();
    media.resize(400);
    expect(layout().dataset.panes).toBe("1");
    expect(layout().dataset.sheet).toBe("open");
    // The same element, now a dialog sheet; focus stayed put.
    expect(drawer("iron_ore")).toBe(d);
    expect(d.getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(lane);
    media.resize(1200);
    expect(layout().dataset.panes).toBe("3");
    expect(media.listeners).toBeGreaterThan(0);
    r.unmount();
    expect(media.listeners).toBe(0);
  });

  it("14. the sheet: focus moves to its title, and back to the row on Escape", () => {
    stubWidth(400);
    mount(fakeStore(fresh));
    const sheet = open("iron_ore");
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(within(sheet).getByRole("heading", { name: "Iron Ore" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(drawer("iron_ore")).toBeNull();
    expect(document.activeElement).toBe(rowButton("iron_ore"));

    // Priority, then Factory again: the sheet comes back (a remount) without taking focus.
    open("iron_ore");
    fireEvent.click(screen.getByRole("tab", { name: "Priority" }));
    expect(drawer("iron_ore")).toBeNull();
    const factory = screen.getByRole("tab", { name: "Factory" });
    factory.focus();
    fireEvent.click(factory);
    expect(drawer("iron_ore")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Factory" }));
  });

  it("15. the View tablist: arrows move and select, modifiers are ignored, controls rendered ids", () => {
    stubWidth(800);
    mount(fakeStore(fresh));
    const factory = screen.getByRole("tab", { name: "Factory" });
    const priority = screen.getByRole("tab", { name: "Priority" });
    expect(factory.getAttribute("aria-controls")).toBe("pane-factory");
    expect(priority.getAttribute("aria-controls")).toBeNull();
    expect(document.getElementById("pane-factory")).not.toBeNull();
    factory.focus();
    fireEvent.keyDown(factory, { key: "ArrowRight", altKey: true });
    expect(factory.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(factory, { key: "ArrowRight" });
    const p = screen.getByRole("tab", { name: "Priority" });
    expect(p.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(p);
    expect(p.getAttribute("aria-controls")).toBe("pane-priority");
    expect(document.getElementById("pane-priority")).not.toBeNull();
    fireEvent.keyDown(p, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Factory" }).getAttribute("aria-selected")).toBe("true");
    // A closed row's button controls nothing; an open one controls #detail.
    expect(rowButton("iron_ore").getAttribute("aria-controls")).toBeNull();
    open("iron_ore");
    expect(rowButton("iron_ore").getAttribute("aria-controls")).toBe("detail");
  });

  it("16. an assign 409 reverts the steppers to the server's counts", async () => {
    const store = fakeStore(snapshotOf(slice, starvedPipeState(slice)));
    mount(store);
    fireEvent.click(screen.getByRole("tab", { name: /Coal/ }));
    const d = open("steel_pipe");
    pick(d, "Assign");
    let settle!: (o: Outcome) => void;
    store.send.mockImplementationOnce(() => new Promise<Outcome>((r) => (settle = r)));
    const count = (r: string) =>
      drawer("steel_pipe")!.querySelector(`[data-assign="${r}"] [data-assigned]`)!.textContent;
    fireEvent.click(
      within(d).getByRole("button", { name: "Move 3 idle Constructors to Steel Pipe" }),
    );
    expect(count("make_concrete")).toBe("3");
    expect(count("make_steel_pipe")).toBe("3");
    await act(async () => {
      settle({ kind: "rejected", body: { failedAction: null, index: 0, reason: "no" } } as never);
      await Promise.resolve();
    });
    expect(count("make_concrete")).toBe("6");
    expect(count("make_steel_pipe")).toBe("0");
  });

  it("17. the frame's reserve ignores a second click while its send is unsettled", async () => {
    const b: Bottleneck = {
      kind: "reserve",
      itemId: "iron_ingot",
      percent: 0.25,
      limitingTarget: "item:iron_plate",
    };
    const store = fakeStore({
      ...fresh,
      display: { ...fresh.display, solution: { ...fresh.display.solution, bottleneck: b } },
    });
    let settle!: (o: Outcome) => void;
    store.send.mockImplementation(() => new Promise<Outcome>((r) => (settle = r)));
    mount(store);
    const reserve = screen.getByRole("button", { name: "Reserve 25% of Iron Ingot" });
    fireEvent.click(reserve);
    fireEvent.click(reserve);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(reserve.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      settle({ kind: "rejected", body: { failedAction: null, index: 0, reason: "no" } } as never);
      await Promise.resolve();
    });
    expect(reserve.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(reserve);
    expect(store.send).toHaveBeenCalledTimes(2);
  });
});
