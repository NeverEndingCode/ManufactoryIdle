// @vitest-environment jsdom
// U-2: the viewport shell at three layouts, the lane tabs (lights, locked lanes, U-3e), the
// Panels tablists (V-15), one inert pass that spares the region (V-12), the notices overlay
// (U-2e) and About (W-25 moved).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { tabTarget } from "./tabs.js";
import {
  fakeStore,
  fixtureState,
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
let tier8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  tier8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => void setTheme("terminal"));
  history.replaceState(null, "", "/");
});

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

const app = () => document.querySelector<HTMLElement>(".app")!;
const panels = () => within(screen.getByRole("tablist", { name: "Panels" })).getAllByRole("tab");
const laneTabs = () => screen.queryByRole("tablist", { name: "Lanes" });
const title = () => document.querySelector("h1")!.textContent;

describe("tabTarget (V-15)", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  });
  const locked = (j: number) => j >= 1 && j <= 3;

  it("3. arrows skip the marked tabs and wrap; modifiers give null", () => {
    expect(tabTarget(key("ArrowRight"), 0, 5, locked)).toBe(4);
    expect(tabTarget(key("ArrowLeft"), 4, 5, locked)).toBe(0);
    expect(tabTarget(key("ArrowRight"), 4, 5, locked)).toBe(0);
    expect(tabTarget(key("ArrowLeft"), 0, 5, locked)).toBe(4);
    expect(tabTarget(key("Home"), 4, 5, (j) => j === 0)).toBe(1);
    expect(tabTarget(key("End"), 0, 5, (j) => j === 4)).toBe(3);
    expect(tabTarget(key("ArrowRight"), 0, 5)).toBe(1);
    for (const m of ["altKey", "ctrlKey", "metaKey"] as const)
      expect(tabTarget(key("ArrowRight", { [m]: true }), 0, 5, locked)).toBeNull();
    expect(tabTarget(key("a"), 0, 5)).toBeNull();
  });
});

describe("the shell (U-2)", { timeout: 60_000 }, () => {
  it("4a. desktop: three Panels tabs, five lane tabs, no Handbook button", () => {
    stubWidth(1280);
    mount(fakeStore(fresh));
    expect(app().dataset.layout).toBe("desktop");
    expect(panels().map((t) => t.textContent)).toEqual(["F1factory", "F2priority", "F3handbook"]);
    expect(panels().map((t) => t.getAttribute("data-view"))).toEqual([
      "factory",
      "priority",
      "handbook",
    ]);
    // The key hints are hidden from the accessible name (V-9).
    expect(screen.getByRole("tab", { name: "factory" })).toBe(panels()[0]);
    const lanes = within(laneTabs()!).getAllByRole("tab");
    expect(lanes.map((t) => t.getAttribute("data-lane"))).toEqual([
      "iron",
      "copper",
      "coal",
      "oil",
      "power",
    ]);
    expect(document.querySelector("[data-open-handbook]")).toBeNull();
    expect(title()).toBe("MANUFACTORY_");
    expect(screen.getByRole("heading", { level: 1 }).getAttribute("aria-label")).toBe(
      "Manufactory Idle",
    );
    expect(screen.getByRole("button", { name: "Settings" }).textContent).toBe("cfg");
    // The factory panel is the main box, labelled by the selected lane tab.
    const panel = document.getElementById("view-factory")!;
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe("lane-tab-iron");
    expect(panel.hasAttribute("data-main-box")).toBe(true);
    // The priority view is the main box too.
    fireEvent.click(screen.getByRole("tab", { name: "priority" }));
    expect(document.getElementById("view-priority")).not.toBeNull();
    expect(laneTabs()).toBeNull();
  });

  it("4b. tablet: the desktop chrome", () => {
    stubWidth(800);
    mount(fakeStore(fresh));
    expect(app().dataset.layout).toBe("tablet");
    expect(panels()).toHaveLength(3);
    expect(within(laneTabs()!).getAllByRole("tab")).toHaveLength(5);
  });

  it("4c. phone: four bottom tabs; ~ power titles POWER_GRID and drops the lane tabs", () => {
    stubWidth(390);
    mount(fakeStore(fresh));
    expect(app().dataset.layout).toBe("phone");
    expect(panels().map((t) => t.getAttribute("data-view"))).toEqual([
      "factory",
      "power",
      "priority",
      "handbook",
    ]);
    expect(panels().map((t) => t.textContent)).toEqual([
      "factory",
      "~ power",
      "priority",
      "handbook",
    ]);
    expect(title()).toBe("MANUFACTORY_");
    expect(screen.getByRole("button", { name: "Settings" }).textContent).toBe("≡");
    // Four production lanes; power is a bottom tab.
    expect(
      within(laneTabs()!)
        .getAllByRole("tab")
        .map((t) => t.dataset.lane),
    ).toEqual(["iron", "copper", "coal", "oil"]);
    fireEvent.click(screen.getByRole("tab", { name: "power" }));
    expect(title()).toBe("POWER_GRID");
    expect(laneTabs()).toBeNull();
    expect(
      document.getElementById("view-power")!.querySelector("[data-power-panel]"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "priority" }));
    expect(title()).toBe("PRIORITY.CFG");
    // The plain voice names the tab.
    act(() => void setTheme("clean-dark"));
    expect(title()).toBe("Priority");
  });

  it("4d. a resize from desktop to the phone keeps the selected lane", () => {
    const media = stubWidth(1280);
    mount(fakeStore(tier8));
    fireEvent.click(screen.getByRole("tab", { name: /^Copper/ }));
    expect(screen.getByRole("tab", { name: /^Copper/ }).getAttribute("aria-selected")).toBe("true");
    media.resize(390);
    expect(app().dataset.layout).toBe("phone");
    expect(screen.getByRole("tab", { name: /^Copper/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-item="copper_ore"]')).not.toBeNull();
    media.resize(1280);
    expect(screen.getByRole("tab", { name: /^Copper/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("5. locked lanes: named, marked off, unclickable and skipped by the arrows", async () => {
    const user = userEvent.setup();
    stubWidth(1280);
    mount(fakeStore(fresh));
    const tab = (lane: string) => document.querySelector<HTMLElement>(`[data-lane="${lane}"]`)!;
    expect(screen.getByRole("tab", { name: "Oil, unlocks at tier 6" })).toBe(tab("oil"));
    expect(screen.getByRole("tab", { name: "Iron, bottleneck" })).toBe(tab("iron"));
    expect(tab("oil").getAttribute("aria-disabled")).toBe("true");
    expect(tab("oil").textContent).toContain("T6");
    expect(tab("oil").textContent).toContain("OIL");
    // The light and the mark are hidden; the name carries the status (W-20).
    const iron = tab("iron");
    const light = [...iron.querySelectorAll("span")].find((e) => e.textContent === "●")!;
    expect(light.getAttribute("aria-hidden")).toBe("true");
    expect(light.classList.contains("state-bottleneck")).toBe(true);
    const mark = [...iron.querySelectorAll("span")].find((e) => e.textContent === " !")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    // A click on a locked lane does nothing.
    fireEvent.click(tab("oil"));
    expect(tab("iron").getAttribute("aria-selected")).toBe("true");
    expect(tab("oil").getAttribute("aria-selected")).toBe("false");
    // The arrows pass the locked lanes: iron → power → iron.
    act(() => tab("iron").focus());
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tab("power"));
    expect(tab("power").getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tab("iron"));
    expect(tab("iron").getAttribute("aria-selected")).toBe("true");
    // Roving tabindex: the selected lane is the tablist's one tab stop.
    const lanes = [...document.querySelectorAll<HTMLElement>('[role="tab"][data-lane]')];
    expect(lanes.length).toBeGreaterThan(2);
    expect(lanes.map((t) => t.tabIndex)).toEqual(lanes.map((t) => (t === tab("iron") ? 0 : -1)));
  });

  it("5b. the phone swaps the bottleneck's light for its !", () => {
    stubWidth(390);
    mount(fakeStore(fresh));
    const iron = document.querySelector<HTMLElement>('[data-lane="iron"]')!;
    expect(iron.textContent).toBe("!IRON");
    expect(iron.querySelector("span")!.getAttribute("aria-hidden")).toBe("true");
    expect(iron.getAttribute("aria-label")).toBe("Iron, bottleneck");
  });

  // Catches: "Lanes" and "Panels" said twice (the nav's label and the tablist's own); the marked
  // power tab in lower case beside "Iron, bottleneck".
  it("5c. each tablist is named by its nav; the marked power tab is cased like the lanes", () => {
    stubWidth(390);
    const s: Snapshot = {
      ...fresh,
      display: {
        ...fresh.display,
        solution: {
          ...fresh.display.solution,
          bottleneck: {
            kind: "storage",
            itemId: "biomass",
            limitingTarget: "item:biomass",
            upgrade: "storage",
          },
        },
      },
    };
    mount(fakeStore(s));
    for (const name of ["Lanes", "Panels"]) {
      const list = screen.getByRole("tablist", { name });
      expect(list.hasAttribute("aria-label")).toBe(false);
      const nav = document.getElementById(list.getAttribute("aria-labelledby")!)!;
      expect(nav.tagName).toBe("NAV");
      expect(nav.getAttribute("aria-label")).toBe(name);
    }
    const power = document.querySelector<HTMLElement>('[data-view="power"]')!;
    expect(power.getAttribute("aria-label")).toBe("Power, bottleneck");
  });

  it("6. with Settings open the region is never inert, and its notice controls are", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    store.set({ notices: [{ kind: "rejected", text: "That didn't go through." }] });
    mount(store);
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const region = screen.getByRole("status");
    expect(region.closest("[inert]")).toBeNull();
    expect(dismiss.hasAttribute("inert")).toBe(true);
    expect(document.querySelector("header")!.hasAttribute("inert")).toBe(true);
    expect(document.querySelector("[data-main-box]")!.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("dialog", { name: "Settings" }).closest("[inert]")).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("7. the notices are an overlay in the content row, not in the .app flow", () => {
    stubWidth(1280);
    const store = fakeStore(fresh);
    mount(store);
    const region = screen.getByRole("status");
    const main = document.querySelector<HTMLElement>("[data-main-box]")!;
    const top = main.getBoundingClientRect().top;
    store.set({
      status: "offline",
      notices: [
        { kind: "rejected", text: "That didn't go through." },
        { kind: "tier-up", text: "Tier 2 reached." },
      ],
    });
    const shown = region.querySelectorAll("[data-notice]");
    expect(shown).toHaveLength(3);
    const list = shown[0]!.parentElement!;
    expect(region.contains(list)).toBe(true);
    expect(list.classList.contains("notice-overlay")).toBe(true);
    // The region's parent is the content row, beside the main box, never the .app column.
    expect(region.parentElement!.hasAttribute("data-content-row")).toBe(true);
    expect(region.parentElement).toBe(main.parentElement);
    expect(region.parentElement!.parentElement).toBe(app());
    expect(main.getBoundingClientRect().top).toBe(top);
  });

  it("9. About: the source and license links in Settings; the footer is the power bar", () => {
    stubWidth(1280);
    mount(fakeStore(fresh));
    // U-2e: the one footer is PWR (U-6); the GPL notice left it.
    const footers = () => [...document.querySelectorAll("footer")];
    expect(footers().map((f) => f.hasAttribute("data-power"))).toEqual([true]);
    expect(document.querySelector("footer a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const about = within(dialog).getByRole("region", { name: "About" });
    expect(about.textContent).toContain("GPL-3.0");
    const source = about.querySelector<HTMLAnchorElement>("a[data-source-link]")!;
    const license = about.querySelector<HTMLAnchorElement>("a[data-license-link]")!;
    expect(source.getAttribute("href")).toMatch(/^https:\/\//);
    expect(license.textContent).toBe("License");
    expect(document.querySelector("footer a")).toBeNull();
  });
});
