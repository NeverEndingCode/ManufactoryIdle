// @vitest-environment jsdom
// U-9d, U-8a, L-17, L-18: the tier-up banner. The store's tier-up notice is said once, hidden, in
// the one region, naming the unlocks; the banner is its picture: aria-hidden, never focusable,
// laid over the tier readout (so the header never moves), gone after 8 s or a click, and either
// way the notice is dismissed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { declarations } from "../styles/css-walk.js";
import { App } from "./App.js";
import {
  fakeStore,
  freshState,
  ID_LIKE,
  loadSlice,
  snapshotOf,
  stubWidth,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";
import { setTheme } from "./theme.js";
import { tierUpSaid, unlockedAt, unlockSummary } from "./unlocks.js";

let slice: Slice;
let tier1: Snapshot;
let tier2: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  tier1 = snapshotOf(slice, { ...freshState(slice), tier: 1 });
  tier2 = snapshotOf(slice, { ...freshState(slice), tier: 2 }, { stateVersion: 1 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  act(() => void setTheme("terminal"));
});

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

/** As the real store does it: the adoption, and the tier-up notice it raises. */
function tierUp(store: FakeStore) {
  store.adopt({ next: tier2 });
  store.set({ notices: [{ kind: "tier-up", text: "Tier 2 reached." }] });
}

const banner = () => document.querySelector<HTMLElement>("[data-tier-banner]");
const region = () => document.querySelector<HTMLElement>('[role="status"]')!;
const header = () => document.querySelector<HTMLElement>("header")!;

const css = (file: string) => {
  const path = fileURLToPath(new URL(file, import.meta.url));
  return declarations(file, readFileSync(path, "utf8"));
};
const rule = (file: string, selector: string) =>
  Object.fromEntries(
    css(file)
      .filter((d) => d.stack.join(" > ") === selector)
      .map((d) => [d.property, d.value]),
  );

describe("the tier-up banner (U-9d, L-17, L-18)", { timeout: 60_000 }, () => {
  // Catches: the wrong tier, ids where the summary should be, or a banner a reader can hear.
  it("6. it reads the unlock summary for the new tier, and is aria-hidden", () => {
    stubWidth(1280);
    const store = fakeStore(tier1);
    mount(store);
    expect(banner()).toBeNull();
    tierUp(store);
    const summary = unlockSummary(tier2, unlockedAt(tier2.content, 2), "shell");
    expect(summary).not.toBe("");
    const b = banner()!;
    expect(b.textContent).toBe(`*** TIER 2 REACHED · ${summary} unlocked ***`);
    expect(b.getAttribute("aria-hidden")).toBe("true");
    expect(b.getAttribute("role")).toBeNull();
    // Plain voice: content names, title case, no stars.
    act(() => void setTheme("clean-dark"));
    const plain = unlockSummary(tier2, unlockedAt(tier2.content, 2), "plain");
    expect(banner()!.textContent).toBe(`Tier 2 reached · ${plain} unlocked`);
  });

  // Catches: a banner that never ends, ends early, forgets to dismiss the notice, or fades
  // under reduced motion.
  it("7. it shows for 8 s, then dismisses the notice and fades out over 400 ms", () => {
    stubWidth(1280);
    const store = fakeStore(tier1);
    mount(store);
    tierUp(store);
    store.tick(7_999);
    expect(banner()).not.toBeNull();
    expect(store.dismiss).not.toHaveBeenCalled();
    store.tick(1);
    expect(store.dismiss).toHaveBeenCalledWith("tier-up");
    expect(store.dismiss).toHaveBeenCalledTimes(1);
    expect(banner()).not.toBeNull();
    expect(banner()!.hasAttribute("data-out")).toBe(true);
    store.tick(399);
    expect(banner()).not.toBeNull();
    store.tick(1);
    expect(banner()).toBeNull();
    // The notice object is still in the fake's view (its dismiss is a mock): no second banner.
    store.tick(20_000);
    expect(banner()).toBeNull();
    expect(store.dismiss).toHaveBeenCalledTimes(1);
  });

  it("7b. under reduced motion it's gone at 8 s, with no 400 ms tail", () => {
    stubWidth(1280, { reducedMotion: true });
    const store = fakeStore(tier1);
    mount(store);
    tierUp(store);
    expect(banner()).not.toBeNull();
    store.tick(7_999);
    expect(banner()).not.toBeNull();
    store.tick(1);
    expect(store.dismiss).toHaveBeenCalledWith("tier-up");
    expect(banner()).toBeNull();
  });

  // Catches: the timer outliving the banner: a world change (the store drops the notice) or an
  // unmount leaves a timer that dismisses a later tier-up early.
  it("7c. a world change ends it at once, and its timer with it", () => {
    stubWidth(1280);
    const store = fakeStore(tier1);
    const view = mount(store);
    tierUp(store);
    store.tick(4_000);
    store.set({ notices: [] });
    expect(banner()).toBeNull();
    store.tick(10_000);
    expect(store.dismiss).not.toHaveBeenCalled();
    // A new tier-up starts a new 8 s.
    store.set({ notices: [{ kind: "tier-up", text: "Tier 2 reached." }] });
    store.tick(7_999);
    expect(banner()).not.toBeNull();
    view.unmount();
    store.tick(10_000);
    expect(store.dismiss).not.toHaveBeenCalled();
  });

  // Catches: a focusable banner, one that takes focus, or a mousedown that moves focus off the
  // row list onto <body>.
  it("8. a click dismisses it, and focus never moves", () => {
    stubWidth(1280);
    const store = fakeStore(tier1);
    mount(store);
    const rows = document.querySelector<HTMLElement>('ul[role="listbox"][data-rows]')!;
    act(() => rows.focus());
    expect(document.activeElement).toBe(rows);
    tierUp(store);
    const b = banner()!;
    expect(document.activeElement).toBe(rows);
    expect(b.hasAttribute("tabindex")).toBe(false);
    expect(b.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);
    // The mousedown's default (focusing the nearest focusable, or <body>) is prevented.
    expect(fireEvent.mouseDown(b)).toBe(false);
    fireEvent.click(b);
    expect(store.dismiss).toHaveBeenCalledWith("tier-up");
    expect(document.activeElement).toBe(rows);
    store.tick(400);
    expect(banner()).toBeNull();
    expect(document.activeElement).toBe(rows);
  });

  // U-8a. Catches: the tier-up back in TOASTS (a visible toast and its Dismiss beside the
  // banner), the announcement without the unlocks or with ids, the banner as a second region
  // or inside the one, or the hidden span remounted (said twice).
  it("9. said once, hidden, in the one region, naming the unlocks", () => {
    stubWidth(1280);
    const store = fakeStore(tier1);
    mount(store);
    tierUp(store);
    const said = region().querySelectorAll<HTMLElement>('[data-notice="tier-up"]');
    expect(said).toHaveLength(1);
    const span = said[0]!;
    expect(span.classList.contains("visually-hidden")).toBe(true);
    expect(span.textContent).toBe(tierUpSaid(tier2, 2));
    expect(span.textContent).toMatch(/^Tier 2 reached\. .+ unlocked\.$/);
    expect(span.textContent).not.toMatch(ID_LIKE);
    // No visible toast, no Dismiss.
    expect(region().querySelector(".notice-overlay [data-notice]")).toBeNull();
    expect(
      [...region().querySelectorAll("button")].filter((b) => b.textContent === "Dismiss"),
    ).toHaveLength(0);
    // The banner is the picture, outside the region; still one live region.
    expect(region().contains(banner())).toBe(false);
    const live = [...document.querySelectorAll("[aria-live]")].filter(
      (el) => el.getAttribute("aria-live") !== "off",
    );
    expect(live).toHaveLength(1);
    expect(document.querySelectorAll('[role="status"], [role="alert"], [role="log"]')).toHaveLength(
      1,
    );
    // Not said again through announce.ts, and the 4 Hz tick doesn't remount it.
    expect(document.querySelector("[data-announce]")?.textContent ?? "").not.toMatch(/Tier 2/);
    store.tick(1_000);
    expect(region().querySelector('[data-notice="tier-up"]')).toBe(span);
  });

  // L-18. jsdom lays nothing out, so the heights below are equal by construction; what pins
  // the overlay is the structure (the banner inside [data-tier-slot], beside the readout it
  // covers, every header child the same element) and the CSS (absolute, inset 0, in a
  // position: relative slot). Catches: the banner laid out in flow.
  it("10. the header doesn't move: an absolute overlay in the tier slot", () => {
    const slot = rule("./Shell.module.css", ".tierSlot");
    expect(slot.position).toBe("relative");
    expect(slot["min-width"]).toBe("0");
    const box = rule("./TierBanner.module.css", ".banner");
    expect(box.position).toBe("absolute");
    expect(box.inset).toBe("0");
    expect(box.background).toBe("var(--bg)");
    expect(box["text-shadow"]).toBe("var(--glow-banner)");
    expect(box.border).toBe("1px solid var(--advice-hi)");
    expect(box.padding).toBe("4px 10px");
    expect(box.color).toBe("var(--advice-hi)");

    for (const width of [1280, 820, 390]) {
      cleanup();
      vi.unstubAllGlobals();
      stubWidth(width);
      const store = fakeStore(tier1);
      mount(store);
      const before = header().getBoundingClientRect().height;
      const children = [...header().children];
      const tierSlot = header().querySelector<HTMLElement>("[data-tier-slot]")!;
      expect(tierSlot, `${width}`).not.toBeNull();
      const covered = [...tierSlot.children];
      // Desktop and tablet: the tier readout; the phone: the readouts box (U-9d).
      expect(covered, `${width}`).toHaveLength(1);
      if (width === 390) expect(covered[0]!.querySelector(".tier-readout")).not.toBeNull();
      else expect(covered[0]!.classList.contains("tier-readout")).toBe(true);
      tierUp(store);
      const b = banner()!;
      expect(b.parentElement, `${width}`).toBe(tierSlot);
      expect([...header().children], `${width}`).toEqual(children);
      expect(
        [...tierSlot.children].filter((c) => c !== b),
        `${width}`,
      ).toEqual(covered);
      expect(header().getBoundingClientRect().height, `${width}`).toBe(before);
    }
  });
});
