// @vitest-environment jsdom
// U-9a, L-9..L-12: the factory log on screen. Desktop and tablet (700 px tall or more) get the
// 96 px tail -f box between the content row and the command line; the phone and short viewports
// get a ticker that opens a modal log sheet. Never a live region, never a key taken from the
// rows, and a new line never moves or re-renders a row.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { liquidCap } from "@manufactory/engine";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { declarations } from "../styles/css-walk.js";
import { App } from "./App.js";
import { feelOf } from "./feel.js";
import { focusKind } from "./keys.js";
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
import { setTheme } from "./theme.js";

// L-12's render counter: every Row render, through the real component.
const rowRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock("./Row.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("./Row.js")>();
  return {
    ...m,
    Row: (p: Parameters<typeof m.Row>[0]) => {
      rowRenders.n += 1;
      return createElement(m.Row, p);
    },
  };
});

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

const BUY = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
} as const;

let batchId = 0;
const bought = (): Batch => {
  const id = ++batchId;
  return { id, key: `k${id}`, actions: [BUY], label: "drawer:iron_plate:buy" };
};

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

/** One purchase adopted: a line in the log, a new snapshot object, the same rows. */
function buy(store: FakeStore) {
  const prev = store.getView().snapshot!;
  store.adopt({ next: { ...prev, stateVersion: prev.stateVersion + 1 }, settled: bought() });
}

/** A log-only update: the book records an event the view never sees (storage fills). */
function fillPlates(store: FakeStore) {
  const s = store.getView().snapshot!;
  const cap = liquidCap(s.content, s.state, "iron_plate");
  const full = snapshotOf(slice, { ...s.state, stored: { ...s.state.stored, iron_plate: cap } });
  act(() => feelOf(store).log.record({ prev: s, next: full, settled: null }));
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const box = () => q("[data-factory-log]");
const ticker = () => q<HTMLButtonElement>("[data-log-ticker]");
const sheet = () => q("[data-log-sheet]");
const lines = () => [...(box()?.querySelectorAll("li") ?? [])];
const selectedRow = () => q('[role="option"][aria-selected="true"]')?.getAttribute("data-item");

/** The scroll box's geometry, which jsdom doesn't lay out. */
function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }) {
  let top = 0;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => (top = v),
  });
}

describe("the factory log on screen (U-9a, L-9..L-12)", { timeout: 60_000 }, () => {
  // Catches: role="log" (or any second live region) on the box (U-8a, L-9).
  it("1. the box is no second live region", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    buy(store);
    const log = box()!;
    expect(log.tagName).toBe("SECTION");
    expect(log.getAttribute("aria-live")).toBe("off");
    expect(log.getAttribute("role")).toBeNull();
    expect(log.getAttribute("aria-label")).toBe("Factory log");
    expect(lines()).toHaveLength(1);
    expect(
      document.querySelectorAll(
        '[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="log"], [role="alert"]',
      ),
    ).toHaveLength(1);
  });

  // Catches: a log line announced through the one region.
  it("2. a line is never announced", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    const said = () => q(".notices")!.textContent;
    const before = said();
    buy(store);
    fillPlates(store);
    expect(lines()).toHaveLength(2);
    expect(said()).toBe(before);
    expect(said()).not.toMatch(/bought|storage full/i);
  });

  // Catches: the box inside the content row (min-height in the row list's box) or a height that
  // grows with its lines, either of which moves or shrinks the rows (U-3a).
  it("3. rows don't move: a fixed 96 px box outside the content row", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    const row = q('[role="option"]')!;
    const top = row.getBoundingClientRect().top;
    const log = box()!;
    expect(log.closest("[data-content-row]")).toBeNull();
    expect(q("[data-content-row]")!.nextElementSibling).toBe(log);
    expect(log.nextElementSibling).toBe(q("[data-command]"));
    for (let i = 0; i < 5; i++) buy(store);
    expect(lines()).toHaveLength(5);
    expect(q('[role="option"]')!.getBoundingClientRect().top).toBe(top);
    // jsdom lays nothing out, so the box's own CSS is read: fixed, never min-height.
    // A variable, so Vite leaves the URL alone (it rewrites new URL("./literal", import.meta.url)).
    const file = "./FactoryLog.module.css";
    const css = declarations(
      file,
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"),
    );
    const rule = (sel: string) =>
      Object.fromEntries(
        css
          .filter((d) => d.stack.length === 1 && d.stack[0] === sel)
          .map((d) => [d.property, d.value]),
      );
    expect(rule(".box")).toMatchObject({ flex: "none", height: "96px" });
    expect(
      css.filter(
        (d) => d.stack.some((s) => s.includes(".box")) && /^(min|max)-height$/.test(d.property),
      ),
    ).toEqual([]);
  });

  // Catches: the log subscribing through App (useTick, the view), so a line re-renders rows.
  it("4. a log-only update re-renders the log and no row (L-12)", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    expect(rowRenders.n).toBeGreaterThan(0);
    const before = rowRenders.n;
    fillPlates(store);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.textContent).toContain("IRON_PLATE storage full");
    expect(rowRenders.n).toBe(before);
  });

  // Catches: never sticking (a line lands out of sight), or always sticking (a player who
  // scrolled up to read is yanked back down).
  it("5. sticks to the bottom, unless scrolled up", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    const log = box()!;
    const g = { scrollHeight: 80, clientHeight: 80 };
    geometry(log, g);
    g.scrollHeight = 200;
    buy(store);
    expect(log.scrollTop).toBe(200);
    // Overflowing: a Tab stop (L-9).
    expect(log.tabIndex).toBe(0);
    // At the bottom, a new line scrolls down.
    log.scrollTop = 120;
    fireEvent.scroll(log);
    g.scrollHeight = 216;
    buy(store);
    expect(log.scrollTop).toBe(216);
    // Scrolled up 50 px: it stays put.
    log.scrollTop = 216 - 80 - 50;
    fireEvent.scroll(log);
    g.scrollHeight = 232;
    buy(store);
    expect(log.scrollTop).toBe(86);
  });

  it("5b. not a Tab stop while it fits", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    buy(store);
    expect(box()!.hasAttribute("tabindex")).toBe(false);
  });

  // Catches: dropping the "arrows" case for [data-factory-log], so ↓ there moves the rows
  // (L-9, amending K-18 for this region).
  it("6. focus on the log: ↓ scrolls it, never the rows; Enter sends nothing", () => {
    stubWidth(1280);
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const log = box()!;
    geometry(log, { scrollHeight: 200, clientHeight: 80 });
    buy(store);
    expect(log.tabIndex).toBe(0);
    expect(focusKind(log)).toBe("arrows");
    expect(focusKind(log.querySelector("li"))).toBe("arrows");
    const row = selectedRow();
    act(() => log.focus());
    expect(document.activeElement).toBe(log);
    const down = fireEvent.keyDown(log, { key: "ArrowDown" });
    expect(down).toBe(true); // not prevented: the browser scrolls the box
    expect(selectedRow()).toBe(row);
    fireEvent.keyDown(log, { key: "Enter" });
    expect(store.send).not.toHaveBeenCalled();
  });

  // Catches: a ticker with no lines, a wrong name or count, a sheet that isn't modal, the
  // background (the TAP) left live, Tab escaping, or focus not returned to the ticker.
  it("7. the phone ticker opens the modal log sheet", () => {
    stubWidth(390);
    const store = fakeStore(fresh);
    mount(store);
    expect(box()).toBeNull();
    expect(ticker()).toBeNull();
    buy(store);
    const t = ticker()!;
    expect(t.tagName).toBe("BUTTON");
    expect(t.getAttribute("aria-label")).toBe("Factory log, 1 entry");
    expect(t.textContent).toContain("bought 1 CONSTRUCTOR_MK1 (IRON)");
    // Before the command line, on the factory tab.
    expect(t.compareDocumentPosition(q("[data-command]")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    buy(store);
    expect(ticker()!.getAttribute("aria-label")).toBe("Factory log, 2 entries");

    fireEvent.click(ticker()!);
    const s = sheet()!;
    expect(s.getAttribute("role")).toBe("dialog");
    expect(s.getAttribute("aria-modal")).toBe("true");
    expect(s.closest("[data-log-host]")).not.toBeNull();
    expect(s.querySelectorAll("li")).toHaveLength(2);
    expect(s.contains(document.activeElement)).toBe(true);
    expect(q("[data-power][data-with-command]")!.closest("[inert]")).not.toBeNull();
    expect(ticker()!.closest("[inert]")).not.toBeNull();
    expect(q(".notices")!.closest("[inert]")).toBeNull();
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);

    const tabbable = [...s.querySelectorAll<HTMLElement>("button, [tabindex='0']")];
    const first = tabbable[0]!;
    const last = tabbable.at(-1)!;
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(sheet()).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expect(document.activeElement).toBe(ticker());

    // The x and the backdrop close it too.
    fireEvent.click(ticker()!);
    fireEvent.click(sheet()!.querySelector("[data-close]")!);
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(ticker());
    fireEvent.click(ticker()!);
    fireEvent.mouseDown(q("[data-log-host]")!);
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(ticker());
  });

  it("7b. the ticker is on the factory tab only", () => {
    stubWidth(390);
    const store = fakeStore(fresh);
    mount(store);
    buy(store);
    expect(ticker()).not.toBeNull();
    fireEvent.click(q('[data-view="priority"]')!);
    expect(ticker()).toBeNull();
  });

  // Catches: the sheet surviving a layout that has the box (two logs, or a modal over nothing).
  it("8. a resize to desktop closes the sheet, focus on the row list", () => {
    const vp = stubWidth(390);
    const store = fakeStore(fresh);
    mount(store);
    buy(store);
    fireEvent.click(ticker()!);
    expect(sheet()).not.toBeNull();
    vp.resize(1280);
    expect(sheet()).toBeNull();
    expect(document.querySelectorAll('[aria-modal="true"]').length).toBeLessThanOrEqual(1);
    expect(document.querySelector("[inert]")).toBeNull();
    expect(box()).not.toBeNull();
    expect(document.activeElement).toBe(q('ul[role="listbox"][data-rows]'));
    // Back to the phone: closed stays closed.
    vp.resize(390);
    expect(sheet()).toBeNull();
  });

  // Catches: the box on a short viewport, where it would take half the rows (L-10).
  it("9. a short viewport gets the ticker, not the box", () => {
    const vp = stubWidth(1280, { height: 650 });
    const store = fakeStore(fresh);
    mount(store);
    buy(store);
    expect(box()).toBeNull();
    expect(ticker()).not.toBeNull();
    fireEvent.click(ticker()!);
    expect(sheet()!.getAttribute("aria-modal")).toBe("true");
    vp.resize(1280, 820);
    expect(sheet()).toBeNull();
    expect(ticker()).toBeNull();
    expect(box()).not.toBeNull();
  });

  // Catches: ids said in the terminal (U-1h), or the shell voice shown in a plain theme (L-5).
  it("10. the voices: terminal says names, Clean shows them", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    buy(store);
    const log = box()!;
    expect(log.textContent).toContain("$ tail -f factory.log");
    expect(log.textContent).toContain("bought 1 CONSTRUCTOR_MK1 (IRON)");
    expect(spokenIds(log)).toEqual([]);
    act(() => void setTheme("clean-dark"));
    const plain = box()!;
    expect(plain.textContent).toContain("Factory log");
    expect(plain.textContent).not.toContain("tail -f");
    expect(plain.textContent).toContain("Bought 1 Constructor Mk.1 (Iron)");
    expect(plain.textContent).not.toContain("CONSTRUCTOR_MK1");
  });

  it("10b. the sheet says names too", () => {
    stubWidth(390);
    const store = fakeStore(fresh);
    mount(store);
    buy(store);
    expect(spokenIds(ticker()!)).toEqual([]);
    fireEvent.click(ticker()!);
    expect(sheet()!.textContent).toContain("factory.log");
    expect(spokenIds(sheet()!)).toEqual([]);
  });
});
