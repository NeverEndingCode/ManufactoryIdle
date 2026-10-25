// @vitest-environment jsdom
// S-13 / W-19: the handbook's place in the panes, its routes, and the context-aware entry.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { GLOSSARY } from "./glossary.js";
import { fakeStore, fixtureState, loadSlice, snapshotOf, type FakeStore } from "./test-fixtures.js";

let tier8: Snapshot;
beforeAll(() => {
  tier8 = snapshotOf(loadSlice(), fixtureState("slice-tier-8.world.json"));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

/** matchMedia for a fixed viewport width (min-width queries only, as use-panes asks). */
function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (q: string) => {
    const min = /min-width:\s*(\d+)px/.exec(q);
    return {
      matches: min === null || width >= Number(min[1]),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList;
  });
}

function mount(store: FakeStore) {
  const push = vi.spyOn(history, "pushState");
  const utils = render(<App store={store as unknown as GameStore} />);
  return { ...utils, pushed: () => push.mock.calls.map((c) => c[2]) };
}

/** Go back one entry, as the browser does: the URL, then popstate. */
function back(path: string) {
  act(() => {
    history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

const entryTitle = () =>
  document.querySelector<HTMLElement>("article[data-handbook-entry] h2")?.textContent ?? null;

describe("Handbook (S-13, W-19)", () => {
  it("1. one pane: Handbook is the third tab; selecting it pushes /handbook; search filters", () => {
    stubWidth(400);
    const { pushed } = mount(fakeStore(tier8));
    const tabs = within(screen.getByRole("tablist", { name: "View" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Factory", "Priority", "Handbook"]);
    fireEvent.click(tabs[2]!);
    expect(pushed()).toContain("/handbook");
    expect(location.pathname).toBe("/handbook");
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");

    const items = () =>
      Array.from(document.querySelectorAll("[data-handbook-item]")).map((b) =>
        b.getAttribute("data-handbook-item"),
      );
    expect(items()).toHaveLength(32);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the handbook" }), {
      target: { value: "IRON" },
    });
    expect(items().length).toBeGreaterThan(0);
    expect(items().length).toBeLessThan(32);
    expect(items()).toContain("iron_plate");
    expect(items()).not.toContain("screw");

    // Factory goes back to the game.
    fireEvent.click(tabs[0]!);
    expect(location.pathname).toBe("/");
    expect(document.querySelector("[data-handbook]")).toBeNull();
  });

  it("2. an item opens its entry; a Used in chip opens its output; back returns to Screw", () => {
    stubWidth(1200);
    history.replaceState(null, "", "/handbook");
    const { pushed } = mount(fakeStore(tier8));
    fireEvent.click(screen.getByRole("button", { name: "Screw" }));
    expect(pushed()).toContain("/handbook/screw");
    expect(entryTitle()).toBe("Screw");
    const article = screen.getByRole("article", { name: "Screw" });
    expect(article.textContent).toContain("Iron Ore → Iron Ingot → Iron Rod → Screw");
    // Focus moves to the new entry, never left on <body>.
    expect(document.activeElement).toBe(within(article).getByRole("heading", { level: 2 }));

    const usedIn = within(article).getByRole("list", { name: "Used in" });
    fireEvent.click(within(usedIn).getByRole("button", { name: /^Reinforced Iron Plate/ }));
    expect(pushed()).toContain("/handbook/reinforced_iron_plate");
    expect(entryTitle()).toBe("Reinforced Iron Plate");

    back("/handbook/screw");
    expect(entryTitle()).toBe("Screw");

    fireEvent.click(screen.getByRole("button", { name: "Back to the handbook" }));
    expect(location.pathname).toBe("/handbook");
    const search = screen.getByRole("searchbox", { name: "Search the handbook" });
    // Focus goes to the index's title, never the search: that would open a phone's keyboard.
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Handbook" }));
    expect(document.activeElement).not.toBe(search);
  });

  it("3. three panes: with the iron plate drawer open, Handbook opens its entry in the detail pane", () => {
    stubWidth(1200);
    const { container, pushed } = mount(fakeStore(tier8));
    fireEvent.click(container.querySelector('[data-item="iron_plate"] [data-open-row]')!);
    expect(container.querySelector('[data-drawer="iron_plate"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Handbook" }));
    expect(pushed()).toContain("/handbook/iron_plate");
    // In place of the drawer, with the lanes still beside it.
    expect(container.querySelector("[data-drawer]")).toBeNull();
    const detail = container.querySelector("[data-handbook]")!;
    expect(
      detail.parentElement!.querySelector("article")!.getAttribute("data-handbook-entry"),
    ).toBe("iron_plate");
    expect(container.querySelector("#pane-factory")).not.toBeNull();

    // Opening a row goes back to the game, with that drawer.
    fireEvent.click(container.querySelector('[data-item="iron_rod"] [data-open-row]')!);
    expect(location.pathname).toBe("/");
    expect(container.querySelector('[data-drawer="iron_rod"]')).not.toBeNull();

    // Without a drawer, the header button opens the index.
    fireEvent.click(
      within(container.querySelector('[data-drawer="iron_rod"]')!).getByRole("button", {
        name: "Close",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Handbook" }));
    expect(location.pathname).toBe("/handbook");
  });

  it("3b. the drawer's Handbook entry goes to its item", () => {
    stubWidth(800);
    const { container } = mount(fakeStore(tier8));
    fireEvent.click(container.querySelector('[data-item="screw"] [data-open-row]')!);
    const drawer = container.querySelector<HTMLElement>('[data-drawer="screw"]')!;
    fireEvent.click(within(drawer).getByRole("link", { name: "Handbook entry" }));
    expect(location.pathname).toBe("/handbook/screw");
    expect(entryTitle()).toBe("Screw");
  });

  it("4. the glossary is a <dl> with Bottleneck, QS and BOUND", () => {
    stubWidth(1200);
    history.replaceState(null, "", "/handbook");
    mount(fakeStore(tier8));
    const terms = Array.from(document.querySelectorAll("[data-handbook] dl dt")).map(
      (dt) => dt.textContent,
    );
    for (const t of ["Bottleneck", "QS", "BOUND"]) expect(terms).toContain(t);
    expect(terms).toHaveLength(GLOSSARY.length);
  });

  it("5. one Escape with the settings sheet over the handbook closes only the sheet", () => {
    stubWidth(1200);
    history.replaceState(null, "", "/handbook/screw");
    mount(fakeStore(tier8));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(location.pathname).toBe("/handbook/screw");
    expect(entryTitle()).toBe("Screw");
  });

  it("6. an unknown item shows the index", () => {
    stubWidth(1200);
    history.replaceState(null, "", "/handbook/nope");
    mount(fakeStore(tier8));
    expect(document.querySelector("article[data-handbook-entry]")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search the handbook" })).toBeTruthy();
  });
});
