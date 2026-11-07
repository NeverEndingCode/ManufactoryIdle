// @vitest-environment jsdom
// U-7 / K-2 / K-4 / K-6 / K-7 / K-8 / K-10: the dispatcher, wired into App. Every event is fired
// on the focused element (or <body>) so it bubbles to the document listener, as in the browser.
// jsdom has no native activation: a send counted here came from the dispatcher's click.
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ItemId, Solution } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { laneItemIds, laneRows } from "./derive.js";
import { drawerModel } from "./machines.js";
import { hintProbe, resolveKey, type Command, type KeyInput, type Scope } from "./keys.js";
import { currentRow, stepRow } from "./selection.js";
import {
  CLIENT_T0,
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  stubWidth,
  type FakeStore,
} from "./test-fixtures.js";

let fresh: Snapshot;
let tier8: Snapshot;
beforeAll(() => {
  const slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  tier8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
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
const FRAMELESS = {
  kind: "power",
  limitingTarget: "item:iron_plate",
  generatorRecipeId: null,
  machinesToClear: 0,
  mark: null,
} as const;

/** A topped fresh world: the advised run is affordable. */
const topped = () => fakeStore(fresh, { now: CLIENT_T0 + 60_000 });

function mount(store: FakeStore, width = 1280) {
  stubWidth(width);
  return render(<App store={store as unknown as GameStore} />);
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const listbox = () => q<HTMLUListElement>('ul[role="listbox"][data-rows]')!;
const active = () => listbox().getAttribute("aria-activedescendant");
const option = (item: string) => q(`li[role="option"][data-item="${item}"]`)!;
const drawer = () => q("[data-drawer]");
const card = () => q("[data-next-buy]");
const title = () => document.getElementById("drawer-title");
const focus = (el: HTMLElement) => act(() => el.focus());
const toBody = () => act(() => (document.activeElement as HTMLElement | null)?.blur());
/** keydown on the focused element; true when nothing called preventDefault. */
const key = (k: string, over: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...over });
const keyUp = (k: string, over: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyUp(document.activeElement ?? document.body, { key: k, ...over });
const pathname = () => location.pathname;

describe("the keyboard (U-7)", { timeout: 60_000 }, () => {
  // Catches: a dispatcher that calls store.send itself (it would skip Guarded's busy check).
  it("1. Enter at rest runs the advice, once", () => {
    const store = topped();
    mount(store);
    expect(document.activeElement).toBe(document.body);
    expect(key("Enter")).toBe(false);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith([P3_BUY], "bottleneck buy");
    // While that batch is pending: the run is busy, so no second send.
    const batch: Batch = { id: 1, key: "k1", actions: [P3_BUY], label: "bottleneck buy" };
    store.set({ pending: [batch] });
    key("Enter");
    expect(store.send).toHaveBeenCalledTimes(1);
    // A held Enter's repeats never buy.
    store.set({ pending: [] });
    expect(key("Enter", { repeat: true })).toBe(true);
    expect(store.send).toHaveBeenCalledTimes(1);
  });

  // Catches: treating a button as at rest (a double buy in the browser).
  it("2. Enter on a control is the control's; on the row list it runs", () => {
    const store = topped();
    mount(store);
    focus(q("[data-command] [data-run]")!);
    expect(key("Enter")).toBe(true);
    focus(document.getElementById("lane-tab-iron")!);
    expect(key("Enter")).toBe(true);
    expect(store.send).not.toHaveBeenCalled();
    focus(listbox());
    expect(key("Enter")).toBe(false);
    expect(store.send).toHaveBeenCalledTimes(1);
  });

  // Catches: preventDefault on a no-op (K-9).
  it("3. Enter runs off the factory view; with nothing to run it's left alone", () => {
    const store = topped();
    mount(store);
    key("F2");
    expect(document.getElementById("view-priority")).not.toBeNull();
    toBody();
    key("Enter");
    expect(store.send).toHaveBeenCalledTimes(1);
    cleanup();

    const frameless = fakeStore(withBottleneck(fresh, FRAMELESS));
    mount(frameless);
    expect(q("[data-why]")).not.toBeNull();
    expect(q("[data-command] [data-run]")).toBeNull();
    expect(key("Enter")).toBe(true);
    expect(frameless.send).not.toHaveBeenCalled();
  });

  // Catches: preventDefault on Enter when the bar's run is an off placeholder (K-9): the phone's
  // always-off "Nothing to run" is found, clicked to no effect, and the key still claimed.
  it("3b. the phone's Nothing to run: Enter does nothing and claims nothing", () => {
    const frameless = fakeStore(withBottleneck(fresh, FRAMELESS));
    mount(frameless, 390);
    const run = q("[data-command] [data-run]")!;
    expect(run.getAttribute("aria-label")).toBe("Nothing to run");
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(key("Enter")).toBe(true);
    expect(frameless.send).not.toHaveBeenCalled();
  });

  // Catches: returning focus to why (the next Enter would re-toggle the card, not buy).
  it("4. Tab at rest opens the card; Esc returns to the row list, never why", () => {
    const store = topped();
    mount(store);
    expect(key("Tab")).toBe(false);
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(card()!.querySelector("[data-run]"));
    key("Escape");
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(listbox());
    expect(document.activeElement).not.toBe(q("[data-why]"));
    key("Enter");
    expect(store.send).toHaveBeenCalledTimes(1);

    // Shift+Tab is never taken.
    toBody();
    expect(key("Tab", { shiftKey: true })).toBe(true);
    expect(card()).toBeNull();
    // Off the factory view, an opener on <body> is null: Esc leaves focus on <body>.
    key("F2");
    toBody();
    key("Tab");
    expect(card()).not.toBeNull();
    key("Escape");
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    cleanup();

    // Nothing to explain: Tab is native (K-22).
    mount(fakeStore(withBottleneck(fresh, null)));
    expect(q("[data-why]")).toBeNull();
    expect(key("Tab")).toBe(true);
    expect(card()).toBeNull();
  });

  // Catches (Task 2 review): a Tab-opened card's K-6 return outliving the card, so closing it
  // with a click on why (or Enter on the focused why) threw focus off why onto the row list.
  it("4b. a Tab-opened card closed from why leaves focus on why", () => {
    mount(topped());
    key("Tab");
    expect(card()).not.toBeNull();
    const why = q("[data-why]")!;
    focus(why);
    expect(card()).not.toBeNull();
    fireEvent.click(why);
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(why);
  });

  // Catches (Task 2 review): a digit or F1 that unmounts the view holding focus, leaving it on
  // <body>.
  it("4c. a key that leaves F2 or F3 from inside the view lands focus on the row list", () => {
    mount(fakeStore(fresh));
    for (const [to, back] of [
      ["F2", "1"],
      ["F2", "F1"],
      ["F3", "1"],
      ["h", "f"],
    ] as const) {
      key(to);
      const inside = q<HTMLElement>("[data-main-box] button, [data-main-box] a[href]")!;
      expect(inside, to).not.toBeNull();
      focus(inside);
      expect(key(back), back).toBe(false);
      expect(document.getElementById("view-factory"), back).not.toBeNull();
      expect(document.activeElement, `${to} then ${back}`).toBe(listbox());
    }
    // Focus outside the main box stays where it is.
    key("F2");
    const tab = document.getElementById("panel-tab-priority")!;
    focus(tab);
    key("1");
    expect(document.activeElement).toBe(tab);
  });

  it("5. ↑/↓, Home/End, → and Space on the listbox (the old RowList test 5)", () => {
    const store = fakeStore(fresh);
    mount(store);
    const ids = laneRows(fresh, "iron").map((r) => `row-${r.itemId}`);
    const at = ids.indexOf("row-iron_plate");
    expect(at).toBeGreaterThan(0);
    expect(active()).toBe("row-iron_plate");
    // A row holds nothing focusable (U-7d), and the list is one tab stop.
    expect(listbox().tabIndex).toBe(0);
    expect(listbox().querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);

    // From <body>, ↓ moves and focuses the list.
    expect(key("ArrowDown")).toBe(false);
    expect(active()).toBe(ids[at + 1]);
    expect(document.activeElement).toBe(listbox());
    key("ArrowUp");
    key("ArrowUp");
    expect(active()).toBe(ids[at - 1]);
    key("Home");
    expect(active()).toBe(ids[0]);
    key("ArrowUp");
    expect(active()).toBe(ids[0]);
    key("End");
    expect(active()).toBe(ids.at(-1));
    key("ArrowDown", { repeat: true });
    expect(active()).toBe(ids.at(-1));

    // Home and End are the list's only while it's focused: on a lane tab, the tablist's.
    focus(document.getElementById("lane-tab-iron")!);
    key("Home");
    expect(active()).toBe(ids.at(-1));
    expect(document.activeElement).toBe(document.getElementById("lane-tab-iron"));

    // Alt+↓ is the browser's.
    focus(listbox());
    key("Home");
    expect(key("ArrowDown", { altKey: true })).toBe(true);
    expect(active()).toBe(ids[0]);

    // → opens the active row's drawer; Esc comes back to the list, the row still active.
    key("ArrowRight");
    expect(drawer()?.getAttribute("data-drawer")).toBe(ids[0]!.slice(4));
    expect(document.activeElement).toBe(title());
    key("Escape");
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(listbox());
    expect(active()).toBe(ids[0]);

    // Space opens too, and Esc from <body> (the dispatcher's close) lands on the list.
    key("ArrowDown");
    expect(key(" ")).toBe(false);
    expect(drawer()?.getAttribute("data-drawer")).toBe(ids[1]!.slice(4));
    toBody();
    key("Escape");
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(listbox());
    expect(active()).toBe(ids[1]);
    expect(store.send).not.toHaveBeenCalled();
  });

  // Catches: a missing `arrows` check, and a follow that drops focus (opened.current).
  it("6. the drawer follows ↑/↓, focus on its new title; a radio keeps its arrows", () => {
    mount(fakeStore(fresh));
    const ids = laneItemIds(fresh, "iron");
    fireEvent.click(option(ids[0]!));
    expect(drawer()?.getAttribute("data-drawer")).toBe(ids[0]);
    const old = drawer();
    key("ArrowDown");
    expect(drawer()?.getAttribute("data-drawer")).toBe(ids[1]);
    expect(old!.isConnected).toBe(false);
    expect(document.activeElement).toBe(title());
    expect(title()!.getAttribute("aria-label")).toBe(fresh.content.items.get(ids[1]!)!.name);
    expect(active()).toBe(`row-${ids[1]}`);
    // From the row list (focus outside the drawer), the follow still lands on the new title.
    focus(listbox());
    key("ArrowUp");
    expect(drawer()?.getAttribute("data-drawer")).toBe(ids[0]);
    expect(document.activeElement).toBe(title());
    for (let i = 1; i < ids.length + 2; i += 1) key("ArrowDown");
    expect(drawer()?.getAttribute("data-drawer")).toBe(ids.at(-1));
    expect(document.activeElement).toBe(title());
    cleanup();

    // A recipe radio keeps ↑/↓ (tier 8's plastic).
    mount(fakeStore(tier8));
    const lane = tier8.content.items.get("plastic" as ItemId)!.lane;
    fireEvent.click(document.getElementById(`lane-tab-${lane}`)!);
    fireEvent.click(option("plastic"));
    const d = drawer()!;
    fireEvent.click(within(d).getByRole("button", { name: "Recipe", pressed: false }));
    focus(within(drawer()!).getAllByRole("radio")[0]!);
    key("ArrowDown");
    expect(drawer()?.getAttribute("data-drawer")).toBe("plastic");
    expect(active()).toBe("row-plastic");
  });

  // Catches: the drawer outliving a key lane switch, and F/P/H disagreeing with F1–F3.
  it("7. digits pick lanes; F-keys and F/P/H switch views and close what they should", () => {
    mount(fakeStore(fresh));
    expect(key("5")).toBe(false);
    expect(q("[data-power-panel]")).not.toBeNull();
    key("1");
    expect(q("[data-power-panel]")).toBeNull();
    expect(listbox().getAttribute("aria-label")).toBe("Iron lane");
    // Copper is locked on a fresh world: nothing happens, nothing is prevented.
    expect(key("2")).toBe(true);
    expect(listbox().getAttribute("aria-label")).toBe("Iron lane");
    // From F2, a digit goes back to the factory.
    key("F2");
    expect(document.getElementById("view-priority")).not.toBeNull();
    key("1");
    expect(document.getElementById("view-priority")).toBeNull();
    expect(listbox()).not.toBeNull();
    // With the drawer open, 1 closes it, and focus lands on the list, not <body>.
    fireEvent.click(option("iron_ore"));
    expect(document.activeElement).toBe(title());
    key("1");
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(listbox());

    for (const [k, id] of [
      ["F2", "view-priority"],
      ["F1", "view-factory"],
      ["p", "view-priority"],
      ["f", "view-factory"],
      ["F3", "view-handbook"],
      ["F1", "view-factory"],
      ["h", "view-handbook"],
      ["F", "view-factory"],
    ] as const) {
      expect(key(k), k).toBe(false);
      expect(document.getElementById(id), k).not.toBeNull();
    }

    // The drawer's [H]: this item's handbook entry, and the drawer is closed afterwards (K-10).
    fireEvent.click(option("iron_ore"));
    key("h");
    expect(pathname()).toBe("/handbook/iron_ore");
    expect(q("article[data-handbook-entry]")!.getAttribute("data-handbook-entry")).toBe("iron_ore");
    key("F1");
    expect(pathname()).toBe("/");
    expect(drawer()).toBeNull();

    // The card: F2 closes it.
    toBody();
    key("Tab");
    expect(card()).not.toBeNull();
    key("F2");
    expect(card()).toBeNull();
    expect(document.getElementById("view-priority")).not.toBeNull();
  });

  // Catches: the card's F-keys leaving a drawer open that they close everywhere else, and its
  // digits closing a drawer whose lane didn't change.
  it("7b. in the card, F-keys close the drawer and H opens its entry; digits follow the lane", () => {
    mount(fakeStore(tier8));
    const ids = laneItemIds(tier8, "iron");
    const openCard = () => {
      toBody();
      key("Tab");
      expect(card()).not.toBeNull();
    };
    fireEvent.click(option(ids[0]!));
    openCard();
    key("F1");
    expect(card()).toBeNull();
    expect(drawer()).toBeNull();

    fireEvent.click(option(ids[0]!));
    openCard();
    key("h");
    expect(card()).toBeNull();
    expect(pathname()).toBe(`/handbook/${ids[0]}`);
    key("f");
    expect(drawer()).toBeNull();

    // 1 in the card is buy 1, never a lane.
    fireEvent.click(document.getElementById("lane-tab-copper")!);
    fireEvent.click(document.getElementById("lane-tab-iron")!);
    fireEvent.click(option(ids[0]!));
    openCard();
    key("1");
    expect(listbox().getAttribute("aria-label")).toBe("Iron lane");
    // The current lane's digit keeps its drawer; another lane's closes it.
    const ironKey = String(
      [...document.querySelectorAll("[data-lane]")].findIndex(
        (t) => t.getAttribute("data-lane") === "iron",
      ) + 1,
    );
    expect(ironKey).toBe("1");
    key("2");
    expect(listbox().getAttribute("aria-label")).toBe("Copper lane");
    expect(drawer()).toBeNull();
  });

  // Catches: a stuck tap (Review Focus 4).
  it("8. a held T taps once and every way out releases it", () => {
    const store = fakeStore(fresh);
    mount(store);
    expect(key("t")).toBe(false);
    expect(store.pressTap).toHaveBeenCalledTimes(1);
    key("t", { repeat: true });
    expect(store.pressTap).toHaveBeenCalledTimes(1);
    keyUp("T", { shiftKey: true });
    expect(store.releaseTap).toHaveBeenCalledTimes(1);

    key("t");
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(store.releaseTap).toHaveBeenCalledTimes(2);

    key("t");
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    hidden.mockRestore();
    expect(store.releaseTap).toHaveBeenCalledTimes(3);

    // Settings opens over a held T: its keyup still releases.
    key("t");
    expect(store.pressTap).toHaveBeenCalledTimes(4);
    fireEvent.click(q("[data-open-settings]")!);
    expect(q("[data-settings-host]")).not.toBeNull();
    keyUp("t");
    expect(store.releaseTap).toHaveBeenCalledTimes(4);
    key("Escape");
    expect(q("[data-settings-host]")).toBeNull();

    // Typing a t taps nothing.
    key("F3");
    focus(q("[data-handbook-search]")!);
    key("t");
    keyUp("t");
    expect(store.pressTap).toHaveBeenCalledTimes(4);
    expect(store.releaseTap).toHaveBeenCalledTimes(4);

    // The footer TAP's own Space hold: one press, never the document's too.
    key("F1");
    const tap = q("[data-power] button[data-tap]")!;
    focus(tap);
    key(" ");
    expect(store.pressTap).toHaveBeenCalledTimes(5);
    expect(drawer()).toBeNull();
    keyUp(" ");
    expect(store.releaseTap).toHaveBeenCalledTimes(5);
  });

  // Catches: a shortcut firing while typing, behind Settings, or with Ctrl (Review Focus 1).
  it("9. never while typing, behind Settings, or with Ctrl", async () => {
    const user = userEvent.setup();
    const store = topped();
    mount(store);
    key("F3");
    const search = q<HTMLInputElement>("[data-handbook-search]")!;
    await user.click(search);
    await user.keyboard("1pt?{Enter}");
    expect(document.getElementById("view-handbook")).not.toBeNull();
    expect(search.value).toBe("1pt?");
    expect(store.send).not.toHaveBeenCalled();
    expect(store.pressTap).not.toHaveBeenCalled();
    key("F1");
    toBody();

    fireEvent.click(q("[data-open-settings]")!);
    expect(key("5")).toBe(true);
    expect(key("Enter")).toBe(true);
    expect(q("[data-power-panel]")).toBeNull();
    expect(store.send).not.toHaveBeenCalled();
    key("Escape");
    expect(q("[data-settings-host]")).toBeNull();

    key("5");
    expect(q("[data-power-panel]")).not.toBeNull();
    toBody();
    expect(key("1", { ctrlKey: true })).toBe(true);
    expect(q("[data-power-panel]")).not.toBeNull();
  });

  // Ruling (carried item 4): Esc typed in a field inside the drawer is the drawer's own Esc (it's
  // a dialog: "close the topmost thing", U-7a); the dispatcher's typing rule (K-2) is for the
  // document's shortcuts. Catches: a drawer whose Esc only works through the dispatcher.
  it("9b. Esc in a field inside the drawer still closes it, back to the list", () => {
    mount(fakeStore(fresh));
    fireEvent.click(option("iron_ore"));
    const field = document.createElement("input");
    field.type = "text";
    drawer()!.appendChild(field);
    focus(field);
    key("Escape");
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(listbox());
    expect(active()).toBe("row-iron_ore");
  });

  // Catches: a hint advertising a key that doesn't work (Review Focus 5).
  it("10. every rendered hint resolves, in its scope, to its own control's command", () => {
    const store = topped();
    mount(store);
    checkHints("global");
    key("Tab");
    expect(card()).not.toBeNull();
    checkHints("card");
    escapeCloses("[data-next-buy]");

    fireEvent.click(option("iron_ore"));
    checkHints("drawer");
    escapeCloses("[data-drawer]");
    cleanup();

    // A lane tab the digit can't select carries no hint.
    mount(fakeStore(fresh));
    const copper = document.getElementById("lane-tab-copper")!;
    expect(copper.getAttribute("aria-disabled")).toBe("true");
    expect(copper.querySelector(".key-hint")).toBeNull();

    // The power lane, with a FUEL row's drawer; then the priority and handbook views.
    fireEvent.click(document.querySelector<HTMLElement>('[data-lane="power"]')!);
    checkHints("global");
    fireEvent.click(option("biomass"));
    checkHints("drawer");
    escapeCloses("[data-drawer]");
    // K-12: the generator drawer, [B] and [D] and [ESC] only.
    fireEvent.click(q('[data-open-generator="biomass_burner"]')!);
    expect(drawer()!.getAttribute("data-drawer")).toBe("power:biomass_burner");
    checkHints("drawer");
    escapeCloses("[data-drawer]");
    key("F2");
    expect(document.querySelector('[data-view="priority"]')!.getAttribute("aria-selected")).toBe(
      "true",
    );
    checkHints("global", "priority");
    key("F3");
    checkHints("global", "handbook");
    cleanup();
    history.replaceState(null, "", "/");

    // The phone, on a fine pointer: no hint at all, and none in the drawer sheet (U-7e, K-17).
    mount(fakeStore(fresh), 390);
    checkHints("global", "factory", 0);
    fireEvent.click(option("iron_ore"));
    expect(drawer()!.getAttribute("data-presentation")).toBe("sheet");
    checkHints("sheet", "factory", 0);
  });

  // Catches: a drawer hint advertising a key the card's scope swallows (the final review's
  // item 1): with the card open, B/U/R/A/S/D, [↑↓] row and [ESC] close are all dead.
  it("10c. with the card and a drawer both open, the drawer shows no hint", () => {
    mount(topped());
    fireEvent.click(option("iron_ore"));
    expect(drawer()!.querySelectorAll(".key-hint").length).toBeGreaterThan(0);
    fireEvent.click(q("[data-why]")!);
    expect(card()).not.toBeNull();
    expect(drawer()).not.toBeNull();
    expect(drawer()!.querySelectorAll(".key-hint")).toHaveLength(0);
    checkHints("card");
  });

  // Catches (the final review's item 2): a resize below 600 px with the card and a drawer both
  // open rendering two modal sheets, focus stranded outside both.
  it("10d. resized to a phone with the card and a drawer open: one modal sheet, focus in it", () => {
    const media = stubWidth(1280);
    render(<App store={topped() as unknown as GameStore} />);
    fireEvent.click(option("iron_ore"));
    fireEvent.click(q("[data-why]")!);
    expect(card()).not.toBeNull();
    media.resize(390);
    const modals = document.querySelectorAll('[aria-modal="true"]');
    expect(modals).toHaveLength(1);
    expect(modals[0]!.hasAttribute("data-drawer")).toBe(true);
    expect(modals[0]!.contains(document.activeElement)).toBe(true);
  });

  // Catches (the final review's item 4): F2/F3 (or P/H) from the drawer or the card unmount
  // the focused control and leave focus on <body>. Each view has its own target: the priority
  // list's first row, the handbook's heading (never its search: the next letter would type).
  it("10e. F2/F3 from the drawer or the card focus the new view, never <body>", () => {
    mount(topped());
    fireEvent.click(option("iron_ore"));
    expect(document.activeElement!.id).toBe("drawer-title");
    key("F2");
    expect(document.activeElement!.matches("#view-priority li[data-entry]")).toBe(true);
    key("F1");
    fireEvent.click(option("iron_ore"));
    key("h");
    expect(document.activeElement!.matches("[data-handbook] h2")).toBe(true);
    key("F1");
    fireEvent.click(q("[data-why]")!);
    expect(card()!.contains(document.activeElement)).toBe(true);
    key("p");
    expect(card()).toBeNull();
    expect(document.activeElement!.matches("#view-priority li[data-entry]")).toBe(true);
    key("f");
    fireEvent.click(q("[data-why]")!);
    key("F3");
    expect(document.activeElement!.matches("[data-handbook] h2")).toBe(true);
  });

  // Catches: a section letter whose hint names another key, or a hint on the wrong control
  // (K-7: the hint is rendered from the control's own data-key).
  it("10b. the drawer's letters: [B] [U] [R] [A] [S] [D] [H] all resolve, each to its control", () => {
    mount(fakeStore(tier8));
    fireEvent.click(option("iron_rod"));
    const hints = [...drawer()!.querySelectorAll(".key-hint")].map((h) => h.textContent);
    for (const k of ["[B]", "[U]", "[R]", "[A]", "[S]", "[D]", "[H]"]) expect(hints).toContain(k);
    // Exactly one [B]: on the best mark's buy 1.
    const b = [...drawer()!.querySelectorAll(".key-hint")].filter((h) => h.textContent === "[B]");
    expect(b).toHaveLength(1);
    const best = drawerModelBest("iron_rod");
    expect(b[0]!.closest(`[data-mark-buy="${best}"][data-count="1"]`)).not.toBeNull();
    checkHints("drawer");
  });

  it("11. the listbox's description says what the keys do (U-7d)", () => {
    mount(fakeStore(fresh));
    const hint = document.getElementById(listbox().getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(
      "Arrow keys to move, right arrow or space for details, enter runs the next buy.",
    );
  });
});

/** Each control a hint sits on, and the command its key must give (K-7). */
const OWNERS: readonly [string, (c: Command, el: Element) => boolean][] = [
  // K-7 / K-10: a drawer letter clicks its own [data-key]; H is the handbook view.
  [
    "[data-key]",
    (c, el) =>
      el.getAttribute("data-key") === "H"
        ? c.kind === "view" && c.view === "handbook"
        : c.kind === "section" && c.key === el.getAttribute("data-key"),
  ],
  ["[data-lane]", (c, el) => c.kind === "lane" && laneKey(el) === c.n],
  ["[data-view]", (c, el) => c.kind === "view" && c.view === el.getAttribute("data-view")],
  ["[data-run-one]", (c) => c.kind === "runOne"],
  ["[data-run]", (c) => c.kind === "run"],
  ["[data-why]", (c) => c.kind === "why"],
  ["[data-tap]", (c) => c.kind === "tap" && c.down],
  ["[data-drawer]", (c) => c.kind === "move"],
];

/** The best unlocked mark of an item's machines, on tier 8. */
function drawerModelBest(itemId: string): number {
  return drawerModel(tier8, itemId as ItemId).machines!.bestMark!;
}

function laneKey(el: Element): number {
  const tabs = [...document.querySelectorAll("[data-lane]")];
  return tabs.indexOf(el.closest("[data-lane]")!) + 1;
}

function probeOf(p: Partial<KeyInput>): KeyInput {
  return {
    type: "keydown",
    key: "",
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...p,
  };
}

/** Every rendered .key-hint resolves in the scope it's rendered in, to its control's command.
 *  `count`: exactly that many hints (the phone has none), else at least one. */
/** U-7a's order of reach, as scopeOf applies it. */
const RANK: Readonly<Record<Scope, number>> = {
  global: 0,
  drawer: 1,
  card: 2,
  sheet: 3,
  settings: 4,
  help: 5,
};

function checkHints(
  appScope: Scope,
  view: "factory" | "priority" | "handbook" = "factory",
  count?: number,
) {
  const hints = [...document.querySelectorAll(".key-hint")];
  if (count === undefined) expect(hints.length).toBeGreaterThan(0);
  else expect(hints).toHaveLength(count);
  for (const h of hints) {
    const text = h.textContent ?? "";
    expect(h.getAttribute("aria-hidden"), text).toBe("true");
    const own: Scope =
      h.closest("[data-next-buy]") !== null
        ? "card"
        : h.closest('[data-drawer][data-presentation="sheet"]') !== null
          ? "sheet"
          : h.closest("[data-drawer]") !== null
            ? "drawer"
            : appScope;
    // The app's scope wins where it outranks the hint's own (U-7a, K-5): a drawer hint with
    // the card open is read in the card's scope.
    const scope: Scope = RANK[appScope] > RANK[own] ? appScope : own;
    const ctx = {
      scope,
      focus: "rest" as const,
      onRows: false,
      view,
      rows: true,
      advice: document.querySelector("[data-why]") !== null,
      follows: true,
    };
    const owner = OWNERS.find(([sel]) => h.closest(sel) !== null);
    for (const { probe, byComponent } of hintProbe(text)) {
      if (byComponent) continue; // Esc: escapeCloses fires it in its dialog
      const r = resolveKey(probeOf(probe), ctx);
      expect(r, `${text} in ${scope}`).not.toBeNull();
      if (owner !== undefined)
        expect(
          owner[1](r!.command, h.closest(owner[0])!),
          `${text} in ${scope}: ${JSON.stringify(r)}`,
        ).toBe(true);
    }
  }
}

function escapeCloses(sel: string) {
  const dialog = document.querySelector<HTMLElement>(sel)!;
  const hint = [...dialog.querySelectorAll(".key-hint")].some((h) =>
    hintProbe(h.textContent ?? "").some((p) => p.byComponent),
  );
  expect(hint, `${sel} shows [ESC]`).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(document.querySelector(sel), `${sel} closes on Esc`).toBeNull();
}

describe("hints under a section (K-9)", { timeout: 60_000 }, () => {
  // Catches: [B] left on screen while its target is hidden, so the hint lies.
  it("13. with a section open there's no [B] hint, and B does nothing", () => {
    const store = fakeStore(tier8);
    mount(store);
    fireEvent.click(option("iron_rod"));
    for (const section of ["upgrade", "recipe", "assign", "storage", "dismantle"]) {
      const toggle = q(`[data-drawer] [data-section="${section}"]`)!;
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      const hints = [...drawer()!.querySelectorAll(".key-hint")].map((h) => h.textContent);
      expect(hints, section).not.toContain("[B]");
      expect(q('[data-drawer] [data-key="B"]'), section).toBeNull();
      checkHints("drawer");
    }
    focus(listbox());
    expect(key("b")).toBe(true);
    expect(store.send).not.toHaveBeenCalled();
  });
});

describe("selection.ts (U-7d)", { timeout: 60_000 }, () => {
  const ids = ["a", "b", "c"] as ItemId[];
  const framed = (itemId: string | null) =>
    ({ itemId }) as unknown as Parameters<typeof currentRow>[2];

  // Catches: RowList and the dispatcher disagreeing about which row is current.
  it("12. currentRow falls from the selection to the bottleneck's row to the first", () => {
    expect(currentRow(ids, "b" as ItemId, framed("c"))).toBe("b");
    expect(currentRow(ids, "z" as ItemId, framed("c"))).toBe("c");
    expect(currentRow(ids, null, framed("z"))).toBe("a");
    expect(currentRow(ids, null, null)).toBe("a");
    expect(currentRow([], null, framed("a"))).toBeNull();
  });

  it("12. stepRow clamps at both ends and never wraps", () => {
    expect(stepRow(ids, "a" as ItemId, "prev")).toBe("a");
    expect(stepRow(ids, "a" as ItemId, "next")).toBe("b");
    expect(stepRow(ids, "c" as ItemId, "next")).toBe("c");
    expect(stepRow(ids, "b" as ItemId, "first")).toBe("a");
    expect(stepRow(ids, "b" as ItemId, "last")).toBe("c");
    expect(stepRow([], null, "next")).toBeNull();
  });

  it("12. the dispatcher's order is the screen's, on every tier-8 lane", () => {
    for (const lane of tier8.content.lanes.keys())
      expect(
        laneRows(tier8, lane).map((r) => r.itemId),
        lane,
      ).toEqual(laneItemIds(tier8, lane));
  });
});
