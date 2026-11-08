// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  D,
  liquidCap,
  withInstalled,
  type Action,
  type Bottleneck,
  type WorldState,
} from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Outcome } from "../sync/errors.js";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { declarations } from "../styles/css-walk.js";
import { App } from "./App.js";
import { bottleneckRow, splitOf } from "./derive.js";
import { drawerLabel, sectionsOf } from "./Drawer.js";
import { buyAction, drawerModel } from "./machines.js";
import { fmt } from "./notation.js";
import { preview } from "./preview.js";
import { projectionLines } from "./Projection.js";
import { quote } from "./quote.js";
import { routePath } from "./route.js";
import { themeDef } from "./theme.js";
import {
  CLIENT_T0,
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  starvedPipeState,
  stubWidth,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";

/** The bottleneck's buy is the command line's (U-4): the frame is gone (U-3c). */
const inBar = () => within(document.querySelector<HTMLElement>("[data-command]")!);

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
  vi.restoreAllMocks();
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

/** A row is a listbox option (U-7d): a click selects it and opens its drawer. */
const option = (item: string) =>
  document.querySelector<HTMLElement>(`li[role="option"][data-item="${item}"]`)!;
const listbox = () => screen.getByRole("listbox");
/** U-7c: focus is back on the row list, with this row active. */
function expectBackOn(item: string) {
  expect(document.activeElement).toBe(listbox());
  expect(listbox().getAttribute("aria-activedescendant")).toBe(`row-${item}`);
}
const drawer = (item: string) => document.querySelector<HTMLElement>(`[data-drawer="${item}"]`);

function open(item: string): HTMLElement {
  fireEvent.click(option(item));
  const d = drawer(item);
  expect(d).not.toBeNull();
  return d!;
}

/** U-5c: a MORE button opens its section in place of MACHINES. */
function pick(d: HTMLElement, verb: string) {
  const toggle = d.querySelector<HTMLElement>(`[data-section="${verb.toLowerCase()}"]`);
  expect(toggle, `[data-section] ${verb}`).not.toBeNull();
  expect(toggle!.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(toggle!);
}

/** K-13: a mark row's buy, ×1, ×10 or max. */
const markBuy = (d: HTMLElement, mark: number, count: "1" | "10" | "max") =>
  d.querySelector<HTMLElement>(`[data-mark-buy="${mark}"][data-count="${count}"]`);
const bodyOf = (d: HTMLElement) => d.querySelector<HTMLElement>("[data-body]")!.dataset.body;
const followOf = (d: HTMLElement) => d.querySelector<HTMLElement>("[data-follow]")!;
/** keydown on the focused element; true when nothing called preventDefault. */
const key = (k: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k });
/** What a projection line's li reads: the shown text, then a reader's copy when they differ. */
const lineText = (l: { shown: string; said: string }) =>
  l.shown === l.said ? l.shown : `${l.shown}${l.said}`;

const BUY_PLATE: Action = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
};

/** jsdom focuses an inert element; a browser doesn't. This makes focus() refuse, as there. */
const honourInert = () => {
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    opts?: FocusOptions,
  ) {
    if (this.closest("[inert]") === null) focus.call(this, opts);
  });
};

const batch = (label: string, id = 1): Batch => ({ id, key: `k${id}`, actions: [], label });

describe("Drawer", { timeout: 60_000 }, () => {
  it("1. a row opens the drawer; Escape closes it and focus goes back to the list", () => {
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    // The drawer is an overlay (U-5a): no pane, no hint.
    expect(screen.queryByText("Tap a row to buy, upgrade or store")).toBeNull();
    const d = open("iron_ore");
    expect(option("iron_ore").getAttribute("aria-selected")).toBe("true");
    expect(d.id).toBe("detail");
    expect(d.getAttribute("aria-labelledby")).toBe("drawer-title");
    expect(document.activeElement).toBe(document.getElementById("drawer-title"));
    expect(within(d).getByText("Miner Mk.1")).toBeTruthy();
    expect(within(d).getByText("8 more Miners → ×1.50")).toBeTruthy();

    // U-7c: back to the list, with that row active.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(drawer("iron_ore")).toBeNull();
    expect(document.activeElement).toBe(listbox());
    expect(listbox().getAttribute("aria-activedescendant")).toBe("row-iron_ore");

    // The Close button too.
    const again = open("iron_ore");
    fireEvent.click(within(again).getByRole("button", { name: "Close" }));
    expect(drawer("iron_ore")).toBeNull();
    expect(document.activeElement).toBe(listbox());
    expect(listbox().getAttribute("aria-activedescendant")).toBe("row-iron_ore");

    // The command line's buy does not open the drawer.
    fireEvent.click(inBar().getByRole("button", { name: /^Buy 1 Constructor$/ }));
    expect(document.querySelector("[data-drawer]")).toBeNull();
  });

  it("2. the projection shows the selected action's effect before purchase", () => {
    mount(fakeStore(fresh));
    const d = open("iron_plate");
    expect(followOf(d).textContent).toMatch(/^IF YOU BUY 1(?!\d)/);
    const p = d.querySelector<HTMLElement>("[data-preview]")!;
    expect(p.getAttribute("aria-live")).toBe("off");
    expect(p.textContent).toContain("Iron Plate");
    expect(p.textContent).toContain("+0.667/s");
    expect(within(p).getByText(/^Power /)).toBeTruthy();
  });

  it("3b. before it is affordable: disabled, the short cost red, a countdown", () => {
    mount(fakeStore(fresh));
    const d = open("iron_plate");
    const buy = markBuy(d, 1, "1")!;
    expect(buy.getAttribute("aria-disabled")).toBe("true");
    expect(buy.getAttribute("aria-label")).toMatch(
      /^Buy 1 Constructor Mk\.1, affordable in 4[2-4] seconds$/,
    );
    const follow = followOf(d);
    expect(follow.querySelector('[data-cost="iron_ingot"]')!.hasAttribute("data-short")).toBe(true);
    expect(follow.querySelector("[data-countdown]")!.textContent).toMatch(
      /^affordable in 4[2-4]s$/,
    );
    // The mark row's own cost reads short too (U-5c).
    expect(
      d.querySelector('[data-mark="1"] [data-each]')!.classList.contains("state-bottleneck"),
    ).toBe(true);
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

  it("7. the command line runs the reserve and storage actions, with one label", () => {
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
    expect(option("iron_ingot").getAttribute("aria-label")).toMatch(/, bottleneck$/);
    const reserve = inBar().getByRole("button", { name: "Reserve 25% of Iron Ingot" });
    expect((reserve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reserve);
    expect(store.send).toHaveBeenCalledWith(
      [{ type: "SET_RESERVE", itemId: "iron_ingot", percent: 0.25 }],
      "bottleneck buy",
    );
    // A setting: still enabled while its batch is pending.
    store.set({ pending: [batch("bottleneck buy")] });
    expect(
      (inBar().getByRole("button", { name: "Reserve 25% of Iron Ingot" }) as HTMLButtonElement)
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
    expect(option("iron_plate").getAttribute("aria-label")).toMatch(/, bottleneck$/);
    fireEvent.click(inBar().getByRole("button", { name: "Buy storage for Iron Plate" }));
    expect(storage.send).toHaveBeenCalledWith(
      [{ type: "BUY_STORAGE", itemId: "iron_plate", levels: 1 }],
      "bottleneck buy",
    );
    storage.set({ pending: [batch("bottleneck buy")] });
    const busy = inBar().getByRole("button", { name: "Buy storage for Iron Plate" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect((busy as HTMLButtonElement).disabled).toBe(false);
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
    expect(option("iron_plate").getAttribute("aria-label")).toMatch(/, bottleneck$/);
    expect(inBar().getByRole("button", { name: "Buy Quantum Storage for Iron" })).toBeTruthy();
  });

  it("8. the layout follows the viewport; the drawer is the panel, under 600 px the sheet", () => {
    stubWidth(1200);
    mount(fakeStore(fresh));
    const app = () => document.querySelector<HTMLElement>(".app")!;
    expect(app().dataset.layout).toBe("desktop");
    expect(screen.getByRole("tab", { name: "priority" })).toBeTruthy();
    cleanup();

    stubWidth(800);
    mount(fakeStore(fresh));
    expect(app().dataset.layout).toBe("tablet");
    expect(screen.getByRole("tab", { name: "factory" })).toBeTruthy();
    expect(open("iron_ore").dataset.presentation).toBe("panel");
    cleanup();

    stubWidth(400);
    mount(fakeStore(fresh));
    expect(app().dataset.layout).toBe("phone");
    expect(screen.getByRole("tab", { name: "factory" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "priority" })).toBeTruthy();
    const sheet = open("iron_ore");
    expect(sheet.dataset.presentation).toBe("sheet");
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    // The priority tab swaps the main box (once the modal sheet is closed).
    fireEvent.keyDown(sheet, { key: "Escape" });
    fireEvent.click(screen.getByRole("tab", { name: "priority" }));
    expect(document.querySelector('[data-item="iron_ore"]')).toBeNull();
  });

  it("10. Escape still closes while a focused spend is busy", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const d = open("iron_plate");
    const buy = markBuy(d, 1, "1")!;
    buy.focus();
    fireEvent.click(buy);
    store.set({ pending: [batch(drawerLabel("iron_plate", "buy"))] });
    const busy = markBuy(drawer("iron_plate")!, 1, "1")!;
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
    expectBackOn("iron_plate");
  });

  // Catches: a drawer outliving its lane, covering another lane's rows; focus dropped to body.
  it("11. a lane switch closes another lane's drawer; focus stays on the lane tabs", async () => {
    const user = userEvent.setup();
    mount(fakeStore(fresh));
    open("iron_ore");
    expect(document.activeElement).toBe(document.getElementById("drawer-title"));
    const power = screen.getByRole("tab", { name: /^Power/ });
    await user.click(power);
    expect(document.querySelector('[data-item="iron_ore"]')).toBeNull();
    expect(document.querySelector("[data-drawer]")).toBeNull();
    expect(document.activeElement).toBe(power);
    // Closed, not hidden: back on its lane it stays shut.
    await user.click(screen.getByRole("tab", { name: /^Iron/ }));
    expect(document.querySelector("[data-drawer]")).toBeNull();

    // The arrows on the lane tabs: the same, focus on the new tab.
    open("iron_ore");
    const iron = screen.getByRole("tab", { name: /^Iron/ });
    act(() => iron.focus());
    fireEvent.keyDown(iron, { key: "ArrowRight" });
    const lanes = within(screen.getByRole("tablist", { name: "Lanes" }));
    const now = lanes.getByRole("tab", { selected: true });
    expect(now).not.toBe(iron);
    expect(document.querySelector("[data-drawer]")).toBeNull();
    expect(document.activeElement).toBe(now);

    // Its own lane's tab keeps it: a FUEL row's drawer on the power tab.
    await user.click(power);
    open("biomass");
    await user.click(screen.getByRole("tab", { name: /^Power/ }));
    expect(drawer("biomass")).not.toBeNull();
  });

  // Catches: the drawer shown over a lane it isn't in when the lane changes without a tab press:
  // the phone has no power lane tab, so the factory view falls back to the first lane.
  it("11b. a FUEL row's drawer doesn't follow a resize onto the phone's factory lane", async () => {
    const user = userEvent.setup();
    const media = stubWidth(1280);
    mount(fakeStore(fresh));
    await user.click(screen.getByRole("tab", { name: /^Power/ }));
    open("biomass");
    act(() => listbox().focus());
    media.resize(390);
    expect(document.querySelector('li[role="option"][data-item="iron_ore"]')).not.toBeNull();
    expect(document.querySelector("[data-drawer]")).toBeNull();
  });

  it("12. the priority view hides the drawer; it's still open on the factory view (V-25)", () => {
    stubWidth(800);
    mount(fakeStore(fresh));
    open("iron_ore");
    fireEvent.click(screen.getByRole("tab", { name: "priority" }));
    expect(drawer("iron_ore")).toBeNull();
    const factory = screen.getByRole("tab", { name: "factory" });
    factory.focus();
    fireEvent.click(factory);
    // Back, without taking focus (claimFocus).
    const d = drawer("iron_ore")!;
    expect(d).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "factory" }));
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    expectBackOn("iron_ore");
  });

  // Catches: a panel remount stealing focus, or a modal sheet remount leaving focus behind the
  // inert background (Esc would then do nothing).
  it("13. a layout change re-lays out; a panel never steals focus, the modal sheet takes it", () => {
    const media = stubWidth(800);
    const r = mount(fakeStore(fresh));
    const app = () => r.container.querySelector<HTMLElement>(".app")!;
    const d = open("iron_ore");
    expect(d.dataset.presentation).toBe("panel");
    const lane = screen.getByRole("tab", { name: /^Iron/ });
    lane.focus();
    // Tablet and desktop are one tree (U-2c): the same drawer, the same focus.
    media.resize(1200);
    expect(app().dataset.layout).toBe("desktop");
    expect(drawer("iron_ore")).toBe(d);
    expect(document.activeElement).toBe(lane);
    // The phone is its own tree: the drawer is the modal sheet now, and a modal always takes
    // focus (K-3), or it would be stranded on the inert background (<body> in a browser).
    honourInert();
    media.resize(400);
    expect(app().dataset.layout).toBe("phone");
    const sheet = drawer("iron_ore")!;
    expect(sheet.dataset.presentation).toBe("sheet");
    expect(document.activeElement).toBe(document.getElementById("drawer-title"));
    expect(sheet.contains(document.activeElement)).toBe(true);
    media.resize(1200);
    expect(app().dataset.layout).toBe("desktop");
    expect(drawer("iron_ore")!.dataset.presentation).toBe("panel");
    expect(media.listeners).toBeGreaterThan(0);
    r.unmount();
    expect(media.listeners).toBe(0);
  });

  it("14. a remount across 600 px keeps focus in the drawer when the drawer had it", () => {
    const media = stubWidth(800);
    mount(fakeStore(fresh));
    open("iron_ore");
    const title = () => document.getElementById("drawer-title");
    expect(document.activeElement).toBe(title());
    // The phone is its own tree: the drawer remounts, and its title takes the focus back.
    media.resize(400);
    expect(drawer("iron_ore")!.dataset.presentation).toBe("sheet");
    expect(document.activeElement).toBe(title());
    // From a control inside it too, and back again.
    within(drawer("iron_ore")!).getByRole("button", { name: "Close" }).focus();
    media.resize(1200);
    expect(drawer("iron_ore")!.dataset.presentation).toBe("panel");
    expect(document.activeElement).toBe(title());
    // A flag that wasn't used dies with its commit: the split, the priority view and back
    // don't take focus later.
    const factory = screen.getByRole("tab", { name: "factory" });
    fireEvent.click(screen.getByRole("tab", { name: "priority" }));
    factory.focus();
    fireEvent.click(screen.getByRole("tab", { name: "factory" }));
    expect(drawer("iron_ore")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "factory" }));
  });

  it("15. the Panels tablist: arrows move and select, modifiers are ignored, controls rendered ids", () => {
    stubWidth(800);
    mount(fakeStore(fresh));
    const factory = screen.getByRole("tab", { name: "factory" });
    const priority = screen.getByRole("tab", { name: "priority" });
    expect(factory.getAttribute("aria-controls")).toBe("view-factory");
    expect(priority.getAttribute("aria-controls")).toBeNull();
    expect(document.getElementById("view-factory")).not.toBeNull();
    factory.focus();
    fireEvent.keyDown(factory, { key: "ArrowRight", altKey: true });
    expect(factory.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(factory, { key: "ArrowRight" });
    const p = screen.getByRole("tab", { name: "priority" });
    expect(p.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(p);
    expect(p.getAttribute("aria-controls")).toBe("view-priority");
    expect(document.getElementById("view-priority")).not.toBeNull();
    fireEvent.keyDown(p, { key: "Home" });
    expect(screen.getByRole("tab", { name: "factory" }).getAttribute("aria-selected")).toBe("true");
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

  it("16b. while a stepper's hold is pending, Move is off and sends nothing (7.3)", () => {
    const store = fakeStore(snapshotOf(slice, starvedPipeState(slice)));
    mount(store);
    fireEvent.click(screen.getByRole("tab", { name: /Coal/ }));
    const d = open("steel_pipe");
    pick(d, "Assign");
    const moveButton = () =>
      within(drawer("steel_pipe")!).getByRole("button", {
        name: "Move 3 idle Constructors to Steel Pipe",
      });
    expect(moveButton().getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(within(d).getByRole("button", { name: "One fewer on Concrete" }));
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(moveButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(moveButton());
    expect(store.send).toHaveBeenCalledTimes(1);
  });

  it("17. the command line's reserve ignores a second click while its send is unsettled", async () => {
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
    const reserve = inBar().getByRole("button", { name: "Reserve 25% of Iron Ingot" });
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

  it("18. a held recipe survives a section switch and a drawer close (Q-10)", async () => {
    const t8 = fakeStore(tier8);
    let settle!: (o: Outcome) => void;
    t8.send.mockImplementationOnce(() => new Promise<Outcome>((r) => (settle = r)));
    mount(t8);
    fireEvent.click(screen.getByRole("tab", { name: /Oil/ }));
    let p = open("plastic");
    pick(p, "Recipe");
    fireEvent.click(within(p).getByRole("radio", { name: /^Residual Plastic/ }));
    const residual = () =>
      (
        within(drawer("plastic")!).getByRole("radio", {
          name: /^Residual Plastic/,
        }) as HTMLInputElement
      ).checked;
    // Another section, then back: the radio still holds.
    pick(p, "Storage");
    pick(drawer("plastic")!, "Recipe");
    expect(residual()).toBe(true);
    // Close and reopen: still held.
    fireEvent.keyDown(drawer("plastic")!, { key: "Escape" });
    expect(drawer("plastic")).toBeNull();
    p = open("plastic");
    pick(p, "Recipe");
    expect(residual()).toBe(true);
    await act(async () => {
      settle({ kind: "rejected", body: { failedAction: null, index: 0, reason: "no" } } as never);
      await Promise.resolve();
    });
    expect(residual()).toBe(false);
  });
});

describe("the drawer's place (U-5a, V-19)", { timeout: 60_000 }, () => {
  const contentRow = () => document.querySelector<HTMLElement>("[data-content-row]")!;
  const mainBox = () => document.querySelector<HTMLElement>("[data-main-box]")!;

  it("1. desktop: a non-modal panel over the content row, the rows still live", () => {
    stubWidth(1280);
    mount(fakeStore(fresh));
    const d = open("iron_ore");
    expect(d.dataset.presentation).toBe("panel");
    // A sibling of the main box, never inside it: the rows keep their layout under it.
    expect(d.parentElement).toBe(contentRow());
    expect(mainBox().parentElement).toBe(contentRow());
    expect(mainBox().contains(d)).toBe(false);
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("false");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)).toBe(
      within(d).getByRole("heading", { level: 2 }),
    );
    // Non-modal: another row re-keys it.
    fireEvent.click(option("iron_plate"));
    expect(drawer("iron_ore")).toBeNull();
    expect(drawer("iron_plate")!.parentElement).toBe(contentRow());
  });

  it("2. tablet: the same panel", () => {
    stubWidth(800);
    mount(fakeStore(fresh));
    const d = open("iron_ore");
    expect(document.querySelector<HTMLElement>(".app")!.dataset.layout).toBe("tablet");
    expect(d.dataset.presentation).toBe("panel");
    expect(d.parentElement).toBe(contentRow());
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("false");
  });

  const host = () => document.querySelector<HTMLElement>("[data-drawer-host]");
  const grip = () => document.querySelector<HTMLElement>("[data-drawer] [data-grip]")!;
  const heading = (d: HTMLElement) => within(d).getByRole("heading", { level: 2 });
  const inert = (el: Element | null) => el !== null && el.closest("[inert]") !== null;
  const pointer = (
    type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel",
    el: HTMLElement,
    clientY: number,
    pointerId = 1,
  ) => fireEvent[type](el, { pointerId, clientY, button: 0 });

  // Catches (K-3): the host left out of MODAL_HOSTS (nothing goes inert), the sheet still
  // aria-modal="false", the notices region itself inerted (W-20), or its Dismiss left live.
  it("3. the phone: a modal sheet in a backdrop on the app root; the background is inert", () => {
    stubWidth(390);
    const store = fakeStore(fresh);
    mount(store);
    act(() => store.set({ notices: [{ kind: "rejected", text: "That didn't go through." }] }));
    const sheet = open("iron_plate");
    expect(sheet.dataset.presentation).toBe("sheet");
    expect(host()!.parentElement).toBe(document.querySelector(".app"));
    expect(sheet.parentElement).toBe(host());
    expect(sheet.tagName).toBe("SECTION");
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(document.activeElement).toBe(heading(sheet));
    expect(inert(document.querySelector("[data-power] button[data-tap]"))).toBe(true);
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    expect(tabs.length).toBeGreaterThan(4);
    for (const tab of tabs) expect(inert(tab), tab.textContent ?? "").toBe(true);
    expect(inert(listbox())).toBe(true);
    expect(inert(document.querySelector(".notices"))).toBe(false);
    expect(inert(screen.getByRole("button", { name: "Dismiss" }))).toBe(true);
    expect(inert(sheet)).toBe(false);
  });

  // Catches: no Tab wrap; a close path that leaves the background inert, or focus on <body>
  // (focus sent to the row list while it's still inert, before the sheet unmounts); a mousedown on the sheet itself read as
  // one on the backdrop.
  it("3b. Tab wraps in the sheet, the x first; Esc, the x and the backdrop each close it, back to the row", () => {
    stubWidth(390);
    honourInert();
    mount(fakeStore(fresh));
    const sheet = open("iron_plate");
    const tabbable = [
      ...sheet.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((el) => el.tabIndex >= 0);
    const first = tabbable[0]!;
    const last = tabbable.at(-1)!;
    // K-20: the grip is pointer-only, hidden from assistive tech and never a Tab stop; the x is.
    expect(grip().tagName).toBe("DIV");
    expect(grip().getAttribute("aria-hidden")).toBe("true");
    expect(grip().tabIndex).toBe(-1);
    expect(grip().hasAttribute("aria-label")).toBe(false);
    expect(tabbable).not.toContain(grip());
    expect(first).toBe(within(sheet).getByRole("button", { name: "Close" }));
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.mouseDown(sheet);
    fireEvent.mouseDown(heading(sheet));
    expect(drawer("iron_plate")).toBe(sheet);

    const paths: [string, () => void][] = [
      ["Esc", () => fireEvent.keyDown(document.activeElement!, { key: "Escape" })],
      [
        "the x",
        () => fireEvent.click(within(drawer("iron_plate")!).getByRole("button", { name: "Close" })),
      ],
      ["the backdrop", () => fireEvent.mouseDown(host()!)],
    ];
    for (const [name, close] of paths) {
      if (drawer("iron_plate") === null) open("iron_plate");
      expect(drawer("iron_plate")!.getAttribute("aria-modal"), name).toBe("true");
      close();
      expect(drawer("iron_plate"), name).toBeNull();
      expect(host(), name).toBeNull();
      expect(document.querySelector("[inert]"), name).toBeNull();
      expectBackOn("iron_plate");
    }
  });

  // Catches: the NEXT_BUY sheet's hand-off losing the modal (two modals, or none), or closing
  // to <body> because the opener (the open button) is gone.
  it("3c. opened from the NEXT_BUY sheet's open IRON_PLATE, it closes to the row list", () => {
    stubWidth(390);
    honourInert();
    mount(fakeStore(fresh, { now: CLIENT_T0 + 60_000 }));
    fireEvent.click(document.querySelector<HTMLElement>("[data-why]")!);
    const go = document.querySelector<HTMLElement>("[data-next-buy] [data-open-item]")!;
    expect(go.textContent).toBe("open IRON_PLATE");
    fireEvent.click(go);
    expect(document.querySelector("[data-next-buy]")).toBeNull();
    const sheet = drawer("iron_plate")!;
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    expect(document.activeElement).toBe(heading(sheet));
    expect(inert(document.querySelector("[data-why]"))).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(drawer("iron_plate")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expectBackOn("iron_plate");
  });

  // Catches (K-12): a generator sheet closing to the row list, or focusing its opener while it's
  // still inert (so focus falls to <body>).
  it("3d. a generator sheet returns focus to its [data-open-generator]", () => {
    stubWidth(390);
    honourInert();
    mount(fakeStore(fresh));
    fireEvent.click(screen.getByRole("tab", { name: "power" }));
    const gen = () =>
      document.querySelector<HTMLElement>('button[data-open-generator="biomass_burner"]');
    fireEvent.click(gen()!);
    const sheet = drawer("power:biomass_burner")!;
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(inert(gen())).toBe(true);
    fireEvent.mouseDown(host()!);
    expect(drawer("power:biomass_burner")).toBeNull();
    expect(document.activeElement).toBe(gen());
    fireEvent.click(gen()!);
    pointer("pointerDown", grip(), 100);
    pointer("pointerUp", grip(), 220);
    expect(drawer("power:biomass_burner")).toBeNull();
    expect(document.activeElement).toBe(gen());
  });

  // Catches (K-20): a threshold at >= 0 (a short drag closes), a sheet left translated after a
  // snap-back or a cancel, or a drag that doesn't follow the finger.
  it("3e. the grip: past 96 px closes; short of it, or cancelled, it snaps back", () => {
    stubWidth(390);
    mount(fakeStore(fresh));
    const sheet = open("iron_plate");
    pointer("pointerDown", grip(), 100);
    pointer("pointerMove", grip(), 180);
    expect(sheet.style.transform).toBe("translateY(80px)");
    expect(sheet.hasAttribute("data-dragging")).toBe(true);
    pointer("pointerUp", grip(), 180);
    expect(drawer("iron_plate")).toBe(sheet);
    expect(sheet.style.transform).toBe("");
    expect(sheet.hasAttribute("data-dragging")).toBe(false);

    pointer("pointerDown", grip(), 100, 2);
    pointer("pointerMove", grip(), 300, 2);
    pointer("pointerCancel", grip(), 300, 2);
    expect(drawer("iron_plate")).toBe(sheet);
    expect(sheet.style.transform).toBe("");

    pointer("pointerDown", grip(), 100, 3);
    pointer("pointerMove", grip(), 220, 3);
    expect(sheet.style.transform).toBe("translateY(120px)");
    pointer("pointerUp", grip(), 220, 3);
    expect(drawer("iron_plate")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expectBackOn("iron_plate");
  });

  // Catches: a scroll of the sheet's content read as a drag; the head dragging while the content
  // is scrolled down; the x's press swallowed by a head drag.
  it("3f. the head drags only when the content is at the top; the body never does", () => {
    stubWidth(390);
    mount(fakeStore(fresh));
    const sheet = open("iron_plate");
    const body = sheet.querySelector<HTMLElement>("[data-body]")!;
    pointer("pointerDown", body, 100);
    pointer("pointerMove", body, 300);
    expect(sheet.style.transform).toBe("");
    pointer("pointerUp", body, 300);
    expect(drawer("iron_plate")).toBe(sheet);

    const x = within(sheet).getByRole("button", { name: "Close" });
    pointer("pointerDown", x, 100, 2);
    pointer("pointerMove", x, 300, 2);
    expect(sheet.style.transform).toBe("");
    pointer("pointerUp", x, 300, 2);
    expect(drawer("iron_plate")).toBe(sheet);

    let top = 40;
    Object.defineProperty(sheet, "scrollTop", { configurable: true, get: () => top });
    pointer("pointerDown", heading(sheet), 100, 3);
    pointer("pointerMove", heading(sheet), 300, 3);
    expect(sheet.style.transform).toBe("");
    pointer("pointerUp", heading(sheet), 300, 3);
    expect(drawer("iron_plate")).toBe(sheet);

    // The grip drags wherever the content is scrolled.
    pointer("pointerDown", grip(), 100, 5);
    pointer("pointerMove", grip(), 150, 5);
    expect(sheet.style.transform).toBe("translateY(50px)");
    pointer("pointerUp", grip(), 150, 5);
    expect(drawer("iron_plate")).toBe(sheet);

    top = 0;
    pointer("pointerDown", heading(sheet), 100, 4);
    pointer("pointerMove", heading(sheet), 220, 4);
    expect(sheet.style.transform).toBe("translateY(120px)");
    pointer("pointerUp", heading(sheet), 220, 4);
    expect(drawer("iron_plate")).toBeNull();
    expectBackOn("iron_plate");
  });

  // Catches (U-5b): the sheet following the finger under reduced motion.
  it("3g. reduced motion: the sheet doesn't follow, and a long drag still closes", () => {
    stubWidth(390, { reducedMotion: true });
    mount(fakeStore(fresh));
    const sheet = open("iron_plate");
    pointer("pointerDown", grip(), 100);
    pointer("pointerMove", grip(), 220);
    expect(sheet.style.transform).toBe("");
    pointer("pointerUp", grip(), 220);
    expect(drawer("iron_plate")).toBeNull();
    expectBackOn("iron_plate");
  });

  // Catches (K-17): the dispatcher acting under the phone's modal sheet (a lane switch, a row
  // walk, a buy, or a tap through the inert TAP).
  it("3h. the keyboard under the sheet: 1, ↓, b and t do nothing; Esc closes", () => {
    stubWidth(390);
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const sheet = open("iron_plate");
    const at = listbox().getAttribute("aria-activedescendant");
    for (const k of ["1", "ArrowDown", "b", "t"]) {
      expect(key(k), k).toBe(true);
      fireEvent.keyUp(document.activeElement!, { key: k });
      expect(drawer("iron_plate"), k).toBe(sheet);
    }
    expect(listbox().getAttribute("aria-activedescendant")).toBe(at);
    expect(store.send).not.toHaveBeenCalled();
    expect(store.pressTap).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(heading(sheet));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(drawer("iron_plate")).toBeNull();
    expectBackOn("iron_plate");
  });

  it("4. the head: the label, the content name to a reader, the meta, the bottleneck's colour", () => {
    const st = fixtureState("slice-tier-8.world.json");
    const meta = (d: HTMLElement) => d.querySelector("[data-meta]")!.textContent;
    const title = (d: HTMLElement) => within(d).getByRole("heading", { level: 2 });
    // "IRON lane · -85.1/s · 3.14 K/89.18 K": stock/cap, no spaces around the slash.
    const n = String.raw`[\d.]+(?: ?[a-zA-Z]+)?`;
    const line = new RegExp(String.raw`^IRON lane · [+−-]?${n}/s · ${n}/${n}`);

    mount(fakeStore(snapshotOf(slice, { ...st, quantum: { ...st.quantum, iron_plate: D(0) } })));
    let d = open("iron_plate");
    expect(title(d).textContent).toBe("IRON_PLATE");
    expect(title(d).getAttribute("aria-label")).toBe("Iron Plate");
    expect(meta(d)).toMatch(line);
    expect(meta(d)).not.toContain("QS");
    cleanup();

    mount(fakeStore(snapshotOf(slice, { ...st, quantum: { ...st.quantum, iron_plate: D(40) } })));
    d = open("iron_plate");
    expect(meta(d)).toMatch(line);
    expect(meta(d)).toMatch(/ · QS 40(\.0)?$/);
    cleanup();

    // Only the bottleneck's title takes the bottleneck class (tier 8's is a generator's, in the
    // power panel; a fresh factory's is a row).
    const hot = bottleneckRow(fresh)?.itemId ?? null;
    expect(hot).not.toBeNull();
    mount(fakeStore(fresh));
    const lane = fresh.content.items.get(hot!)!.lane;
    const laneName = fresh.content.lanes.get(lane)!.name;
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${laneName}`) }));
    expect(title(open(hot!)).classList.contains("state-bottleneck")).toBe(true);
    const cold = [...document.querySelectorAll<HTMLElement>('li[role="option"]')]
      .map((o) => o.dataset.item!)
      .find((id) => id !== hot)!;
    expect(title(open(cold)).classList.contains("state-bottleneck")).toBe(false);
  });

  const z = (file: string, selector: string) => {
    const path = fileURLToPath(new URL(file, import.meta.url));
    const decl = declarations(file, readFileSync(path, "utf8")).find(
      (x) => x.stack.at(-1) === selector && x.property === "z-index",
    );
    expect(decl, `${file} ${selector}`).toBeDefined();
    return Number(decl!.value);
  };

  // Catches: SPLIT on the phone keeping the drawer open behind the priority view, so the factory
  // tab remounts the modal sheet with focus left on the (now inert) tab: <body> in a browser,
  // and Esc does nothing.
  it("3i. SPLIT → priority → factory: the remounted sheet takes focus, and Esc closes it", () => {
    stubWidth(390);
    honourInert();
    mount(fakeStore(snapshotOf(slice, fixtureState("slice-tier-8-reinforced-full.world.json"))));
    fireEvent.click(screen.getByRole("tab", { name: /Iron/ }));
    open("screw");
    const split = document.querySelector<HTMLElement>("[data-drawer] button[data-split]")!;
    expect(split).not.toBeNull();
    fireEvent.click(split);
    expect(document.getElementById("view-priority")).not.toBeNull();
    expect(drawer("screw")).toBeNull();
    const factory = screen.getByRole("tab", { name: "factory" });
    act(() => factory.focus());
    fireEvent.click(factory);
    const sheet = drawer("screw")!;
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(heading(sheet));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(drawer("screw")).toBeNull();
    expectBackOn("screw");
  });

  // Catches: the scrim (and the sheet in it) under the floating TAP, or over the NEXT_BUY sheet
  // or Settings.
  it("5. the phone sheet's backdrop sits above the floating TAP, under the modal sheets (V-19, K-3)", () => {
    const backdrop = z("./Drawer.module.css", ".backdrop");
    expect(backdrop).toBe(30);
    expect(backdrop).toBeGreaterThan(z("./Power.module.css", ".floating"));
    expect(backdrop).toBeLessThan(z("./NextBuy.module.css", ".backdrop"));
    expect(backdrop).toBeLessThan(z("./Settings.module.css", ".backdrop"));
  });

  // Catches: a rejection toast hidden under the scrim on the phone, or one painted over the modal
  // NEXT_BUY sheet or Settings.
  it("5b. on the phone the notices sit over the drawer sheet's scrim, under the modal sheets", () => {
    const notices = z("../styles/base.css", '.app[data-layout="phone"] .notices');
    expect(notices).toBeGreaterThan(z("./Drawer.module.css", ".backdrop"));
    expect(notices).toBeLessThan(z("./NextBuy.module.css", ".backdrop"));
    expect(notices).toBeLessThan(z("./Settings.module.css", ".backdrop"));
    // Elsewhere they stay at 3, over the desktop panel (2).
    expect(z("../styles/base.css", ".notices")).toBe(3);
  });

  // Catches: Close scrolling away; the scrim's fill hard-coded (contrast.test can't see it per
  // theme); the snap-back declared outside no-preference, or running while the finger drags.
  it("6. the sheet's head is sticky; the backdrop is the --scrim; the snap-back moves with motion only", () => {
    const file = "./Drawer.module.css";
    const path = fileURLToPath(new URL(file, import.meta.url));
    const css = declarations(file, readFileSync(path, "utf8"));
    const rule = (sel: string, media: string[] = []) =>
      Object.fromEntries(
        css
          .filter((x) => x.stack.join(" > ") === [...media, sel].join(" > "))
          .map((x) => [x.property, x.value]),
      );
    expect(rule(".sheet .head")).toMatchObject({
      position: "sticky",
      top: "0",
      background: "var(--s1)",
    });
    expect(rule(".backdrop")).toMatchObject({
      position: "fixed",
      inset: "0",
      "z-index": "30",
      background: "var(--scrim)",
    });
    // K-20: the grip's hit area is 44 px tall and the sheet's width; its bar is 44 × 4 in --t3.
    expect(rule(".grip")).toMatchObject({ height: "44px", "touch-action": "none" });
    expect(rule(".grip::before")).toMatchObject({
      width: "44px",
      height: "4px",
      background: "var(--t3)",
    });
    const snap = css.filter((x) => x.property === "transition" && x.value.includes("transform"));
    expect(snap.map((x) => x.stack)).toEqual([
      ["@media (prefers-reduced-motion: no-preference)", ".sheet:not([data-dragging])"],
    ]);
  });
});

describe("MACHINES and the sections (U-5c, K-9, K-11, K-13 – K-15)", { timeout: 60_000 }, () => {
  // Catches: the segmented tabs kept, a locked mark with buttons, the owned count unformatted.
  it("1. MACHINES by default: a row per mark, locked marks without buttons", () => {
    mount(fakeStore(fresh));
    const d = open("iron_ore");
    expect(bodyOf(d)).toBe("machines");
    expect(within(d).getByRole("heading", { level: 3, name: "MACHINES" })).toBeTruthy();
    const mk1 = d.querySelector<HTMLElement>('li[data-mark="1"]')!;
    expect(mk1.hasAttribute("data-locked")).toBe(false);
    expect(mk1.querySelector("[data-owned]")!.textContent).toBe("x2");
    // Seen in the theme's voice, heard by its content name (U-1h).
    expect(mk1.querySelector("[data-each]")!.textContent).toMatch(
      /^[\d.]+ IRON_ORE each[\d.]+ Iron Ore each$/,
    );
    expect(mk1.querySelectorAll("button")).toHaveLength(3);
    expect([...mk1.querySelectorAll("button")].map((b) => b.getAttribute("data-count"))).toEqual([
      "1",
      "10",
      "max",
    ]);
    for (const [mark, tier] of [
      [2, 3],
      [3, 6],
    ] as const) {
      const row = d.querySelector<HTMLElement>(`li[data-mark="${mark}"]`)!;
      expect(row.hasAttribute("data-locked")).toBe(true);
      expect(row.textContent).toContain(`locked · tier ${tier}`);
      expect(row.querySelectorAll("button")).toHaveLength(0);
    }
    expect(document.querySelector('[role="group"][aria-label="Action"]')).toBeNull();
    expect(document.querySelector('[class*="segBtn"]')).toBeNull();
  });

  // Catches: a [U] with no consolidation, a recipe toggle on a one-recipe item, a section that
  // spends when opened, a toggle that doesn't return.
  it("2. the sections: only what the model offers, in U R A S D order; a toggle returns", () => {
    const store = fakeStore(fresh);
    mount(store);
    let d = open("iron_plate");
    expect(d.querySelector('[data-section="upgrade"]')).toBeNull();
    expect(d.querySelector('[data-section="recipe"]')).toBeNull();
    const storage = d.querySelector<HTMLElement>('[data-section="storage"]')!;
    const cost = quote(fresh.content, fresh.state, {
      type: "BUY_STORAGE",
      itemId: "iron_plate",
      levels: 1,
    }).cost.get("iron_plate")!;
    expect(storage.textContent).toBe(`[S]storage · next ${fmt(cost)} IRON_PLATE`);
    expect(storage.getAttribute("aria-label")).toBe(`Storage, next ${fmt(cost)} Iron Plate`);
    expect(storage.getAttribute("data-key")).toBe("S");
    fireEvent.click(storage);
    expect(bodyOf(d)).toBe("storage");
    expect(storage.getAttribute("aria-pressed")).toBe("true");
    expect(within(d).getByRole("heading", { level: 3, name: "STORAGE" })).toBeTruthy();
    expect(store.send).not.toHaveBeenCalled();
    fireEvent.click(storage);
    expect(bodyOf(d)).toBe("machines");
    expect(storage.getAttribute("aria-pressed")).toBe("false");
    // The handbook link carries H, and keeps its name (Handbook.test 3b).
    const link = d.querySelector<HTMLElement>("a[data-handbook-link]")!;
    expect(link.getAttribute("data-key")).toBe("H");
    expect(link.getAttribute("aria-label")).toBe("Handbook entry");
    cleanup();

    // Nothing owned: no dismantle (a fresh Biomass Collector).
    mount(fakeStore(fresh));
    fireEvent.click(screen.getByRole("tab", { name: /^Power/ }));
    d = open("biomass");
    expect(d.querySelector('[data-section="dismantle"]')).toBeNull();
    cleanup();

    // Tier 8: everything, in order.
    mount(fakeStore(tier8));
    d = open("iron_rod");
    const order = [...d.querySelectorAll<HTMLElement>("[data-section]")].map(
      (b) => b.dataset.section,
    );
    expect(order).toEqual(["upgrade", "recipe", "assign", "storage", "dismantle"]);
    expect(order).toEqual(sectionsOf(drawerModel(tier8, "iron_rod")));
    expect(
      [...d.querySelectorAll<HTMLElement>("[data-section]")].map((b) => [
        b.dataset.key,
        b.getAttribute("aria-label"),
      ]),
    ).toEqual([
      ["U", "Upgrade"],
      ["R", "Recipe"],
      ["A", "Assign"],
      ["S", expect.stringMatching(/^Storage, /)],
      ["D", "Dismantle"],
    ]);
    expect(d.querySelector('[data-section="upgrade"]')!.textContent).toBe("[U]upgrade");
    cleanup();

    // A recipe toggle only with two recipes: tier 8's plastic has one, its iron ore none.
    mount(fakeStore(tier8));
    expect(open("iron_ore").querySelector('[data-section="recipe"]')).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Oil/ }));
    expect(open("plastic").querySelector('[data-section="recipe"]')).not.toBeNull();
  });

  // Catches: a follow line stuck on ×1, a projection of the wrong count or mark, an untinted
  // draining input.
  it("3. IF YOU BUY follows the hovered or focused count; a draining input is drawn as such", () => {
    mount(fakeStore(fresh));
    const d = open("iron_plate");
    const theme = themeDef("terminal");
    const lines = (actions: Action[]) =>
      projectionLines(fresh, preview(fresh, actions), "iron", theme).map(lineText);
    const shown = () =>
      [...d.querySelectorAll<HTMLElement>("[data-preview] li")].map((li) => li.textContent);
    expect(followOf(d).textContent).toMatch(/^IF YOU BUY 1(?!\d)/);
    expect(shown()).toEqual(lines([BUY_PLATE]));
    // K-14: buying a Constructor draws more ingots: drawn in --advice, "(still …)".
    const drain = d.querySelector<HTMLElement>("[data-preview] li[data-drain]");
    expect(drain).not.toBeNull();
    expect(drain!.textContent).toMatch(/^IRON_INGOT [−-][\d.]+\/s \(still [+−-]?[\d.]+\/s\)/);

    act(() => markBuy(d, 1, "10")!.focus());
    expect(followOf(d).textContent).toMatch(/^IF YOU BUY 10(?!\d)/);
    expect(shown()).toEqual(lines([{ ...BUY_PLATE, count: 10 }]));
    // The final review's item 7: it never sticks. Focus moving within the buttons keeps
    // following; focus leaving them, or the pointer leaving them, goes back to the default ×1.
    act(() => markBuy(d, 1, "max")!.focus());
    expect(followOf(d).textContent).toMatch(/^IF YOU BUY max|^IF YOU BUY \d/);
    act(() => d.querySelector<HTMLElement>("#drawer-title")!.focus());
    expect(followOf(d).textContent).toMatch(/^IF YOU BUY 1(?!\d)/);
    expect(shown()).toEqual(lines([BUY_PLATE]));
    const ten = markBuy(d, 1, "10")!;
    fireEvent.mouseEnter(ten);
    expect(followOf(d).textContent).toMatch(/^IF YOU BUY 10(?!\d)/);
    fireEvent.mouseLeave(ten.parentElement!);
    expect(followOf(d).textContent).toMatch(/^IF YOU BUY 1(?!\d)/);
    cleanup();

    // Tier 8: hovering mark 2's buy follows mark 2.
    mount(fakeStore(tier8));
    const t = open("iron_ore");
    fireEvent.mouseEnter(markBuy(t, 2, "1")!);
    expect(followOf(t).textContent).toMatch(/^IF YOU BUY 1(?!\d)/);
    const buy2 = buyAction(drawerModel(tier8, "iron_ore").machines!, 2, 1);
    expect(
      [...t.querySelectorAll<HTMLElement>("[data-preview] li")].map((li) => li.textContent),
    ).toEqual(projectionLines(tier8, preview(tier8, [buy2]), "iron", theme).map(lineText));
  });

  // Catches: an optimistic count, a busy button that still sends, max not maxAffordableCount.
  it("4. buy is pessimistic and exact", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const d = open("iron_plate");
    const owned = () => drawer("iron_plate")!.querySelector('[data-mark="1"] [data-owned]')!;
    expect(owned().textContent).toBe("x1");
    const buy = markBuy(d, 1, "1")!;
    expect(buy.getAttribute("aria-label")).toBe("Buy 1 Constructor Mk.1");
    expect(buy.getAttribute("data-key")).toBe("B");
    expect(buy.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(buy);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith([BUY_PLATE], "drawer:iron_plate:buy");
    expect(owned().textContent).toBe("x1");

    store.set({ pending: [batch(drawerLabel("iron_plate", "buy"))] });
    const busy = markBuy(drawer("iron_plate")!, 1, "1")!;
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    // Busy, so no countdown in its name.
    expect(busy.getAttribute("aria-label")).toBe("Buy 1 Constructor Mk.1");
    fireEvent.click(busy);
    expect(markBuy(drawer("iron_plate")!, 1, "max")!.getAttribute("aria-busy")).toBe("true");
    expect(store.send).toHaveBeenCalledTimes(1);

    // Only the snapshot moves the count.
    const after = snapshotOf(slice, withInstalled(fresh.state, "iron", "constructor", 1, 2), {
      stateVersion: 1,
    });
    store.set({ pending: [], snapshot: after });
    expect(owned().textContent).toBe("x2");
    cleanup();

    // max: maxAffordableCount, on a rich world.
    const rich = snapshotOf(slice, topped(freshState(slice), ["iron_ingot"]));
    const r = fakeStore(rich);
    mount(r);
    const max = markBuy(open("iron_plate"), 1, "max")!;
    const n = Number(/^Buy max \((\d+)\) /.exec(max.getAttribute("aria-label")!)![1]);
    expect(n).toBeGreaterThan(1);
    fireEvent.click(max);
    expect(r.send).toHaveBeenCalledWith([{ ...BUY_PLATE, count: n }], "drawer:iron_plate:buy");
  });

  // Catches: a red cost while its button is on, or the reverse (the old test 9, on [data-follow]).
  it("5. a cost is red exactly when its button is off for lack of that item", () => {
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
        // The follow line's cost is the followed button's: by default the best mark's buy 1.
        const button = block.hasAttribute("data-follow")
          ? d.querySelector('[data-key="B"]')!
          : block.querySelector("button")!;
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
    act(() => markBuy(d, 1, "1")!.focus());
    const follow = followOf(d);
    expect(follow.querySelector('[data-cost="iron_plate"]')!.hasAttribute("data-short")).toBe(true);
    expect(follow.querySelector('[data-cost="iron_rod"]')!.hasAttribute("data-short")).toBe(false);
    expect(markBuy(d, 1, "1")!.getAttribute("aria-disabled")).toBe("true");
    cleanup();
    // Both sides of the rule are exercised.
    expect(reds).toBeGreaterThan(0);
    expect(clear).toBeGreaterThan(0);
  });

  // Catches: a letter that sends on its own (a second path past Guarded), a key that acts with
  // its target hidden, a toggle that doesn't take focus (K-4, K-9, K-11).
  it("6. the letter keys click the drawer's own buttons", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    open("iron_plate");
    act(() => listbox().focus());
    expect(key("b")).toBe(false);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith([BUY_PLATE], "drawer:iron_plate:buy");
    store.set({ pending: [batch(drawerLabel("iron_plate", "buy"))] });
    key("b");
    expect(store.send).toHaveBeenCalledTimes(1);
    cleanup();

    // Fresh iron rod: two recipes, no consolidation.
    const s = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(s);
    const d = open("iron_rod");
    act(() => listbox().focus());
    expect(key("r")).toBe(false);
    expect(bodyOf(d)).toBe("recipe");
    expect(document.activeElement).toBe(d.querySelector('[data-section="recipe"]'));
    expect(key("s")).toBe(false);
    expect(bodyOf(d)).toBe("storage");
    expect(document.activeElement).toBe(d.querySelector('[data-section="storage"]'));
    // No upgrade to make: nothing happens, and the key is left alone.
    expect(key("u")).toBe(true);
    expect(bodyOf(d)).toBe("storage");
    // B's target is MACHINES' buy 1: hidden under another section, so B does nothing (K-9).
    expect(key("b")).toBe(true);
    expect(s.send).not.toHaveBeenCalled();
    // Its key again returns to MACHINES.
    expect(key("s")).toBe(false);
    expect(bodyOf(d)).toBe("machines");
    key("h");
    expect(location.pathname).toBe(routePath({ kind: "handbook", itemId: "iron_rod" }));
    history.replaceState(null, "", "/");
  });

  // Catches: focus dropped to <body> when its element goes (K-11), or a drawer that pulls focus
  // back from a click on blank space.
  it("7. focus never falls to body from the drawer", () => {
    const store = fakeStore(tier8);
    mount(store);
    const d = open("iron_plate");
    pick(d, "Dismantle");
    const row = d.querySelector<HTMLElement>('[data-dismantle="3"]')!;
    const all = within(row).getByRole("button", { name: "Dismantle all 17 Mk3" });
    act(() => all.focus());
    fireEvent.click(all);
    expect(store.send).toHaveBeenCalledWith(
      [{ type: "DISMANTLE", lane: "iron", machineClass: "constructor", mark: 3, count: 17 }],
      "drawer:iron_plate:dismantle",
    );
    const after = snapshotOf(slice, withInstalled(tier8.state, "iron", "constructor", 3, 0), {
      stateVersion: 1,
    });
    store.set({ pending: [], snapshot: after });
    expect(d.querySelector('[data-dismantle="3"]')).toBeNull();
    expect(drawer("iron_plate")).toBe(d);
    expect(document.activeElement).toBe(document.getElementById("drawer-title"));

    // A click on blank space: the element is still there, so focus stays where the click put it.
    const toggle = d.querySelector<HTMLElement>('[data-section="storage"]')!;
    act(() => toggle.focus());
    act(() => toggle.blur());
    expect(document.activeElement).toBe(document.body);
    store.set({ snapshot: { ...after } });
    expect(document.activeElement).toBe(document.body);
  });

  // Catches: the split as one opaque bar, a part that isn't a button, a part to the wrong entry.
  it("8. SPLIT: one button per part, to the item's priority entry (K-15)", () => {
    const full = snapshotOf(slice, fixtureState("slice-tier-8-reinforced-full.world.json"));
    mount(fakeStore(full));
    fireEvent.click(screen.getByRole("tab", { name: /Iron/ }));
    const d = open("screw");
    expect(within(d).getByRole("heading", { level: 3, name: "SPLIT" })).toBeTruthy();
    const parts = splitOf(full, "screw")!;
    const buttons = [...d.querySelectorAll<HTMLButtonElement>("button[data-split]")];
    expect(buttons).toHaveLength(parts.length);
    buttons.forEach((b, i) => {
      const pct = `${Math.round(parts[i]!.share * 100)}%`;
      expect(b.getAttribute("aria-label")).toBe(
        `${pct} ${parts[i]!.label}: show Screw in the priority list`,
      );
      expect(b.textContent!.startsWith(`${pct} `)).toBe(true);
    });
    Element.prototype.scrollIntoView = vi.fn();
    fireEvent.click(buttons.at(-1)!);
    expect(document.activeElement?.getAttribute("data-entry")).toBe("item:screw");
  });

  // Catches: the phone's section buttons in a desktop row, or under 48 px.
  // Catches: a drawer control the coarse-pointer rule doesn't reach (K-16), such as the
  // handbook link styled as a 36 px button.
  it("9b. every drawer control is a coarse 44 px target: base.css's coarse rule matches it", () => {
    const file = "../styles/base.css";
    const css = declarations(
      file,
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"),
    );
    const coarse = css.find(
      (x) => x.stack[0] === "@media (pointer: coarse)" && x.property === "min-height",
    )!;
    expect(coarse.value).toBe("44px");
    const selector = coarse.stack[1]!;
    for (const width of [1280, 390]) {
      stubWidth(width);
      mount(fakeStore(tier8));
      const d = open("iron_rod");
      const controls = [...d.querySelectorAll<HTMLElement>("button, a[href]")];
      expect(controls.length).toBeGreaterThan(5);
      for (const el of controls) expect(el.matches(selector), el.outerHTML.slice(0, 80)).toBe(true);
      expect(d.querySelector("a[data-handbook-link]")!.matches(selector)).toBe(true);
      cleanup();
    }
  });

  it("9. the phone sheet: MORE is a 2-column grid of 48 px buttons at the bottom (U-5b)", () => {
    stubWidth(390);
    mount(fakeStore(fresh));
    const d = open("iron_ore");
    expect(d.dataset.presentation).toBe("sheet");
    const more = d.querySelector<HTMLElement>("[data-more]")!;
    expect(more).toBe(d.lastElementChild);
    expect(more.querySelector("h3")).toBeNull();
    expect(more.querySelectorAll("button, a").length).toBeGreaterThan(1);
    // The phone has no hints (U-7e).
    expect(d.querySelectorAll(".key-hint")).toHaveLength(0);
    expect(within(d).getByRole("button", { name: "Close" }).textContent).toBe("x");

    const file = "./Drawer.module.css";
    const css = declarations(
      file,
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"),
    );
    const rule = (sel: string) =>
      Object.fromEntries(
        css
          .filter((x) => x.stack.length === 1 && x.stack[0] === sel)
          .map((x) => [x.property, x.value]),
      );
    expect(rule(".sheet .more")).toMatchObject({
      display: "grid",
      "grid-template-columns": "1fr 1fr",
    });
    expect(rule(".sheet .moreBtn")).toMatchObject({ height: "48px" });
    expect(rule(".sheet .markBtn")).toMatchObject({ height: "48px" });
    // Desktop: 36 px, by height, so the coarse rule's min-height still wins (K-16).
    expect(rule(".markBtn")).toMatchObject({ height: "36px" });
    expect(rule(".moreBtn")).toMatchObject({ height: "36px" });
  });
});

describe("the drawer's trend (U-9b)", { timeout: 60_000 }, () => {
  /** What a reader gets from the meta line: its text outside aria-hidden. */
  function heard(el: Element): string {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
    return copy.textContent ?? "";
  }
  /** `s` a minute on, arriving now, at the same rates. */
  const minuteOn = (s: Snapshot, receivedAt: number): Snapshot => ({
    ...s,
    schedule: { ...s.schedule, atMs: s.schedule.atMs + 60_000 },
    receivedAt,
  });

  // Catches: the trend missing on the tablet (where the TREND column is gone), shown on desktop
  // (where the column has it), read out cell by cell, or a word said with nothing known.
  it("on the tablet the meta line ends in the sparkline, and a reader hears the word", () => {
    stubWidth(800);
    const store = fakeStore(fresh);
    mount(store);
    store.adopt({ prev: null, next: fresh });
    const meta = () => drawer("iron_ore")!.querySelector("[data-meta]")!;
    expect(open("iron_ore").dataset.presentation).toBe("panel");
    const cells = () => /trend ([·▁▂▃▄▅▆▇█]+)/.exec(meta().textContent ?? "")?.[1];
    expect(cells()).toBe("··········");
    expect(heard(meta())).not.toMatch(/trend/);

    store.tick(60_000);
    store.adopt({ next: minuteOn(fresh, store.now()) });
    expect(meta().textContent).toContain("trend ");
    expect(cells()).toHaveLength(10);
    expect(cells()).toMatch(/^········▄▄$/);
    expect(heard(meta())).toMatch(/trend steady$/);
    // The separators are the line's own "·"; the cells (a run of ten) are never read.
    expect(heard(meta())).not.toMatch(/[▁▂▃▄▅▆▇█]|··/);
  });

  it("on desktop the meta line has no trend", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    store.adopt({ prev: null, next: fresh });
    store.tick(60_000);
    store.adopt({ next: minuteOn(fresh, store.now()) });
    expect(open("iron_ore").querySelector("[data-meta]")!.textContent).not.toContain("trend");
  });
});
