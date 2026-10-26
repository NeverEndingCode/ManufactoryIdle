// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DECIMAL_ZERO, liquidCap, type Bottleneck, type WorldState } from "@manufactory/engine";
import { Profiler } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { shownStock, storageTransition } from "../sync/interpolate.js";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { bottleneckRow } from "./derive.js";
import { easeOut, sweepPeriodS, TWEEN_MS, tweenDec } from "./motion.js";
import { fmt } from "./notation.js";
import {
  CLIENT_T0,
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";

/** Paths from strings: under jsdom the global URL is jsdom's (test-fixtures.ts). */
const HERE = dirname(fileURLToPath(import.meta.url));

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const P3_BUY = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
} as const;

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

const row = (c: HTMLElement, item: string) =>
  c.querySelector<HTMLElement>(`[data-item="${item}"]`)!;

describe("LaneView", () => {
  it("1. a fresh world: one frame, the iron tab marked, no chips", () => {
    const { container } = mount(fakeStore(fresh));
    expect(screen.getAllByText("bottleneck")).toHaveLength(1);
    expect(within(row(container, "iron_plate")).getByText("bottleneck")).toBeTruthy();
    const iron = screen.getByRole("tab", { name: /Iron/ });
    expect(iron.getAttribute("aria-selected")).toBe("true");
    expect(within(iron).getByLabelText("bottleneck").textContent).toBe("!");
    expect(
      within(screen.getByRole("tab", { name: /Power/ })).queryByLabelText("bottleneck"),
    ).toBeNull();
    expect(screen.queryByText(/^QS /)).toBeNull();
    expect(screen.queryByText(/^BOUND /)).toBeNull();
    expect(screen.getByText("Limiting iron plate. 1 more Constructor clears it.")).toBeTruthy();
  });

  it("2. tier 8: QS chips on iron, the frame on biomass in power, none in copper", () => {
    const { container } = mount(fakeStore(tier8));
    expect(screen.getAllByText(/^QS /).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("bottleneck")).toHaveLength(0);

    fireEvent.click(screen.getByRole("tab", { name: /Power/ }));
    expect(screen.getAllByText("bottleneck")).toHaveLength(1);
    expect(within(row(container, "biomass")).getByText("bottleneck")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Copper/ }));
    expect(screen.queryAllByText("bottleneck")).toHaveLength(0);
    // Only the visible lane renders.
    expect(row(container, "biomass")).toBeNull();
  });

  it("2b. the lane tabs follow the WAI-ARIA keyboard pattern", async () => {
    const user = userEvent.setup();
    mount(fakeStore(tier8));
    const tab = (name: RegExp) => screen.getByRole("tab", { name });
    const expectOn = (name: RegExp) => {
      const t = tab(name);
      expect(t.getAttribute("aria-selected")).toBe("true");
      expect(t.tabIndex).toBe(0);
      expect(document.activeElement).toBe(t);
    };
    // The lanes' one tab stop (the header's buttons come before it in the Tab order).
    act(() => tab(/Iron/).focus());
    expectOn(/Iron/);
    await user.keyboard("{ArrowRight}");
    expectOn(/Power/);
    expect(tab(/Iron/).tabIndex).toBe(-1);
    await user.keyboard("{End}");
    expectOn(/Oil/);
    await user.keyboard("{ArrowRight}");
    expectOn(/Iron/);
    await user.keyboard("{ArrowLeft}");
    expectOn(/Oil/);
    await user.keyboard("{Home}");
    expectOn(/Iron/);
  });

  it("2c. lane tabs leave modified arrows to the browser", async () => {
    const user = userEvent.setup();
    mount(fakeStore(tier8));
    act(() => screen.getByRole("tab", { name: /Iron/ }).focus());
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Iron/ }));
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(screen.getByRole("tab", { name: /Iron/ }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Control>}{ArrowRight}{/Control}");
    expect(screen.getByRole("tab", { name: /Iron/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("3. meters carry aria-valuenow per snapshot; the 4 Hz tick moves only the text", () => {
    const store = fakeStore(fresh);
    const { container } = mount(store);
    const ore = row(container, "iron_ore");
    const meters = within(ore).getAllByRole("meter");
    expect(meters).toHaveLength(2);
    for (const m of meters) {
      expect(m.getAttribute("aria-valuemin")).toBe("0");
      expect(m.getAttribute("aria-valuemax")).toBe("1");
      expect(m.getAttribute("aria-valuenow")).not.toBeNull();
    }
    const before = meters.map((m) => m.getAttribute("aria-valuenow"));
    const stock = () => ore.querySelector("[data-stock]")!.textContent;
    const text0 = stock();
    expect(store.tickers).toBeGreaterThan(0);
    store.tick(10_000);
    expect(stock()).not.toBe(text0);
    expect(
      within(ore)
        .getAllByRole("meter")
        .map((m) => m.getAttribute("aria-valuenow")),
    ).toEqual(before);
  });

  it("4. the bottleneck buy sends the P-3 action once, then waits busy, keeping focus", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const buy = screen.getByRole("button", { name: /^Buy 1 Constructor$/ });
    expect(buy.getAttribute("aria-disabled")).toBe("false");
    buy.focus();
    fireEvent.click(buy);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith([P3_BUY], "bottleneck buy");

    const batch: Batch = { id: 1, key: "k1", actions: [P3_BUY], label: "bottleneck buy" };
    store.set({ pending: [batch] });
    const busy = screen.getByRole("button", { name: /^Buy 1 Constructor$/ });
    // 7.2: Guarded, never the native disabled, so the focused button keeps focus.
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(store.send).toHaveBeenCalledTimes(1);
  });

  it("4b. before it is affordable the button counts down, off but focusable", () => {
    const store = fakeStore(fresh);
    mount(store);
    const wait = screen.getByRole("button", { name: /^affordable in \d+s$/ });
    expect(wait.getAttribute("aria-disabled")).toBe("true");
    expect((wait as HTMLButtonElement).disabled).toBe(false);
    expect(wait.textContent).toMatch(/^affordable in (4[2-4])s$/);
    fireEvent.click(wait);
    expect(store.send).not.toHaveBeenCalled();
  });

  it("5. the storage bar is one scaleX transition per snapshot, never a width", () => {
    const store = fakeStore(fresh);
    const { container } = mount(store);
    const fill = row(container, "iron_ore").querySelector<HTMLElement>("[data-fill]")!;
    const t = storageTransition(fresh, "iron_ore", serverNow(fresh, store.now()));
    expect(t.durationMs).toBeGreaterThan(0);
    expect(fill.style.transform).toBe(`scaleX(${t.to})`);
    expect(fill.style.transition).toBe(`transform ${t.durationMs}ms linear`);
    expect(fill.style.width).toBe("");
    // The tick does not touch it.
    store.tick(250);
    expect(fill.style.transform).toBe(`scaleX(${t.to})`);
  });

  it("5b. under reduced motion the bar has no transition; the 4 Hz tick steps it", () => {
    const media = vi.fn((q: string) => ({ matches: q.includes("reduce") }) as MediaQueryList);
    vi.stubGlobal("matchMedia", media);
    try {
      const store = fakeStore(fresh);
      const { container } = mount(store);
      const fill = row(container, "iron_ore").querySelector<HTMLElement>("[data-fill]")!;
      const t = storageTransition(fresh, "iron_ore", serverNow(fresh, store.now()));
      expect(fill.style.transition).toBe("none");
      expect(fill.style.transform).toBe(`scaleX(${t.from})`);
      store.tick(10_000);
      const later = storageTransition(fresh, "iron_ore", serverNow(fresh, store.now()));
      expect(later.from).toBeGreaterThan(t.from);
      expect(fill.style.transform).toBe(`scaleX(${later.from})`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("6. the plateau notice renders on a plateaued snapshot", () => {
    const s = fresh;
    const plateaued: Snapshot = { ...s, persistedAtMs: s.schedule.atMs - s.content.offlineCapMs };
    mount(fakeStore(plateaued));
    expect(screen.getByText(/^Production paused 8 h after your last action/)).toBeTruthy();
    cleanup();
    mount(fakeStore(fresh));
    expect(screen.queryByText(/^Production paused/)).toBeNull();
  });

  it("the root mirrors the store for e2e (P-9)", () => {
    const store = fakeStore(null);
    const { container } = mount(store);
    const root = container.querySelector<HTMLElement>("[data-sync]")!;
    expect(root.dataset.sync).toBe("loading");
    store.set({ status: "ready", snapshot: { ...fresh, stateVersion: 3 } });
    expect(root.dataset.sync).toBe("ready");
    expect(root.dataset.stateVersion).toBe("3");
  });

  it("notices share one polite live region; guest-expired offers a new factory", () => {
    const store = fakeStore(fresh);
    mount(store);
    store.set({
      status: "error",
      notices: [{ kind: "guest-expired", text: "This guest factory was removed." }],
    });
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(within(region).getByRole("button", { name: "Start a new factory" }));
    expect(store.newFactory).toHaveBeenCalledTimes(1);
    expect(within(region).queryByRole("button", { name: /dismiss/i })).toBeNull();
  });
});

/** The snapshot with the display solve's bottleneck replaced (null clears it). */
function withBottleneck(s: Snapshot, b: Bottleneck | null): Snapshot {
  return { ...s, display: { ...s.display, solution: { ...s.display.solution, bottleneck: b } } };
}

const announced = () => document.querySelector("[data-announce]");

/** W-20: exactly one live region, and every notice inside it. */
function theOneRegion(): HTMLElement {
  const live = [...document.querySelectorAll<HTMLElement>("[aria-live]")].filter(
    (el) => el.getAttribute("aria-live") !== "off",
  );
  expect(live).toHaveLength(1);
  expect(document.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(1);
  const region = live[0]!;
  expect(region.getAttribute("role")).toBe("status");
  for (const n of document.querySelectorAll<HTMLElement>("[data-notice]")) {
    expect(region.contains(n)).toBe(true);
    expect(region.textContent).toContain(n.textContent);
  }
  return region;
}

/** A fake frame clock: requestAnimationFrame queues, performance.now() reads `at`. */
function fakeFrames() {
  let at = 0;
  let queue: FrameRequestCallback[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => at);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    queue = [];
  });
  return {
    /** Advance to `ms` and run the frames that were waiting. */
    to(ms: number) {
      at = ms;
      const run = queue;
      queue = [];
      act(() => run.forEach((cb) => cb(at)));
    },
    get waiting() {
      return queue.length;
    },
  };
}

describe("motion (S-14, W-18)", () => {
  it("3a. a producing, unpaused row sweeps at sweepPeriodS(production); a paused one doesn't", () => {
    const pausedState: WorldState = {
      ...tier8.state,
      priority: tier8.state.priority.map((e) =>
        e.id === "item:iron_ingot" ? { ...e, paused: true } : e,
      ),
    };
    const s = snapshotOf(slice, pausedState);
    const { container } = mount(fakeStore(s));
    const meter = (item: string) =>
      within(row(container, item)).getByRole("meter", { name: /satisfaction$/ });
    const producing = ["iron_ore", "iron_plate", "iron_rod"].filter(
      (id) => (s.display.solution.itemRates.get(id)?.production ?? 0) > 0,
    );
    expect(producing.length).toBeGreaterThan(0);
    for (const id of producing) {
      const m = meter(id);
      const p = s.display.solution.itemRates.get(id)!.production;
      expect(m.hasAttribute("data-sweep")).toBe(true);
      expect(m.style.getPropertyValue("--sweep-period")).toBe(`${sweepPeriodS(p)}s`);
    }
    const paused = meter("iron_ingot");
    expect(paused.getAttribute("data-state")).toBe("paused");
    expect(paused.hasAttribute("data-sweep")).toBe(false);
    expect(paused.style.getPropertyValue("--sweep-period")).toBe("");
  });

  it("3b. the lane panel has one aria-hidden conveyor, at most 12 blocks, clipped", () => {
    mount(fakeStore(tier8));
    const panel = document.getElementById("lane-panel")!;
    const strips = panel.querySelectorAll<HTMLElement>("[data-conveyor]");
    expect(strips).toHaveLength(1);
    const strip = strips[0]!;
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    const blocks = Number(strip.dataset.blocks);
    expect(blocks).toBeGreaterThan(0);
    expect(blocks).toBeLessThanOrEqual(12);
    // Its wrapper clips the translateX, or the strip would widen the page at 320 px.
    expect(strip.className).toMatch(/conveyor/);
    const css = readFileSync(join(HERE, "LaneView.module.css"), "utf8");
    const rule = /(^|\n)\.conveyor\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![2]).toMatch(/overflow:\s*hidden/);
  });

  it("4a. a 100× stock correction tweens in log space over 300 ms with no React render", () => {
    const frames = fakeFrames();
    const base = tier8.state;
    const cap = liquidCap(slice.content, base, "iron_plate");
    const low: WorldState = {
      ...base,
      stored: { ...base.stored, iron_plate: cap.div(1e4) },
      quantum: { ...base.quantum, iron_plate: DECIMAL_ZERO },
    };
    const a = snapshotOf(slice, low);
    const store = fakeStore(a);
    let renders = 0;
    const { container } = render(
      <Profiler id="app" onRender={() => (renders += 1)}>
        <App store={store as unknown as GameStore} />
      </Profiler>,
    );
    const stock = () => row(container, "iron_plate").querySelector("[data-stock]")!.textContent;
    const from = shownStock(a, "iron_plate", serverNow(a, store.now()));
    expect(stock()).toBe(fmt(from));

    const high: WorldState = { ...low, stored: { ...low.stored, iron_plate: from.times(100) } };
    const b = snapshotOf(slice, high);
    const to = shownStock(b, "iron_plate", serverNow(b, store.now()));
    expect(to.div(from).toNumber()).toBeCloseTo(100, 0);
    store.set({ snapshot: b });
    // The old value at once, then frames.
    expect(stock()).toBe(fmt(from));
    expect(frames.waiting).toBe(1);
    const after = renders;

    frames.to(TWEEN_MS / 2);
    const mid = tweenDec(from, to, easeOut(0.5));
    expect(stock()).toBe(fmt(mid));
    expect(mid.gt(from) && mid.lt(to)).toBe(true);
    // Log space, near the log midpoint (10×), far from the linear one (50.5×).
    const ratio = mid.div(from).toNumber();
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(50);

    frames.to(TWEEN_MS);
    expect(stock()).toBe(fmt(to));
    expect(frames.waiting).toBe(0);
    expect(renders).toBe(after);
  });

  it("4b. under reduced motion a correction snaps at once", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: q.includes("reduce") }) as MediaQueryList),
    );
    const frames = fakeFrames();
    const base = tier8.state;
    const cap = liquidCap(slice.content, base, "iron_plate");
    const low: WorldState = { ...base, stored: { ...base.stored, iron_plate: cap.div(1e4) } };
    const a = snapshotOf(slice, low);
    const store = fakeStore(a);
    const { container } = mount(store);
    const from = shownStock(a, "iron_plate", serverNow(a, store.now()));
    const b = snapshotOf(slice, {
      ...low,
      stored: { ...low.stored, iron_plate: from.times(100) },
    });
    store.set({ snapshot: b });
    const to = shownStock(b, "iron_plate", serverNow(b, store.now()));
    expect(row(container, "iron_plate").querySelector("[data-stock]")!.textContent).toBe(fmt(to));
    expect(frames.waiting).toBe(0);
  });
});

describe("announcements (S-15, W-20)", () => {
  it("5. a bottleneck change is said once, never on first load; clearing says so", () => {
    const store = fakeStore(fresh);
    mount(store);
    // A: the framed iron plate. Nothing said on first load.
    expect(bottleneckRow(fresh)!.itemId).toBe("iron_plate");
    expect(announced()).toBeNull();

    const b = withBottleneck(fresh, {
      kind: "reserve",
      itemId: "iron_ingot",
      percent: 0.25,
      limitingTarget: "item:iron_plate",
    });
    const bText = bottleneckRow(b)!.text;
    store.set({ snapshot: b });
    const first = announced();
    expect(first?.textContent).toBe(`Bottleneck: ${bText}`);

    // The same bottleneck again, in a new snapshot: nothing new.
    store.set({ snapshot: { ...b } });
    expect(announced()).toBe(first);
    expect(announced()?.textContent).toBe(`Bottleneck: ${bText}`);

    store.set({ snapshot: withBottleneck(fresh, null) });
    expect(announced()?.textContent).toBe("No bottleneck");
  });

  it("6. one live region in every state, with every notice inside it", () => {
    const store = fakeStore(fresh);
    mount(store);
    // Idle.
    theOneRegion();
    expect(document.querySelectorAll("[data-notice]")).toHaveLength(0);
    // Offline.
    store.set({ status: "offline" });
    expect(theOneRegion().querySelector('[data-notice="offline"]')).not.toBeNull();
    // A tier-up toast.
    store.set({ status: "ready", notices: [{ kind: "tier-up", text: "Tier 2 reached." }] });
    expect(theOneRegion().querySelector('[data-notice="tier-up"]')).not.toBeNull();
    // A rejection.
    store.set({ notices: [{ kind: "rejected", text: "Not enough iron plate." }] });
    expect(theOneRegion().querySelector('[data-notice="rejected"]')).not.toBeNull();
    // A frameless bottleneck: a line in the region, no frame.
    store.set({
      notices: [],
      snapshot: withBottleneck(fresh, {
        kind: "power",
        limitingTarget: "power",
        generatorRecipeId: null,
        machinesToClear: 0,
        mark: null,
      }),
    });
    expect(theOneRegion().querySelector('[data-notice="bottleneck"]')).not.toBeNull();
    expect(document.querySelector("[data-frame]")).toBeNull();
    // After a priority move's announcement.
    store.set({ snapshot: fresh });
    const rod = document.querySelector<HTMLElement>('li[data-entry="item:iron_rod"]')!;
    rod.focus();
    fireEvent.keyDown(rod, { key: "ArrowUp", altKey: true });
    const region = theOneRegion();
    expect(region.querySelector("[data-announce]")?.textContent).toMatch(/moved to position 2/);
  });

  it("7.5. nothing under the region has an inline style but the hidden announcement", () => {
    const store = fakeStore(fresh);
    mount(store);
    const styled = (r: Element) =>
      [r, ...r.querySelectorAll("*")].filter((el) => el.hasAttribute("style"));
    expect(styled(theOneRegion())).toEqual([]);
    store.set({ status: "offline", notices: [{ kind: "tier-up", text: "Tier 2 reached." }] });
    store.set({ snapshot: withBottleneck(fresh, null) });
    const region = theOneRegion();
    expect(styled(region)).toEqual([region.querySelector("[data-announce]")]);
  });
});

describe("the dock's height (7.4)", () => {
  it("7.4a. a ResizeObserver on the dock slot sets --dock-h on the layout", () => {
    class StubObserver {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element) {
        this.cb(
          [
            {
              target,
              contentRect: { height: 130 } as DOMRectReadOnly,
              borderBoxSize: [{ blockSize: 130, inlineSize: 320 }],
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubObserver);
    mount(fakeStore(fresh));
    const layout = document.querySelector<HTMLElement>(".layout")!;
    expect(layout.style.getPropertyValue("--dock-h")).toBe("130px");
  });

  it("7.4b. without ResizeObserver the CSS fallback is 6rem", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    mount(fakeStore(fresh));
    expect(document.querySelector<HTMLElement>(".layout")!.style.getPropertyValue("--dock-h")).toBe(
      "",
    );
    const css = readFileSync(join(HERE, "Layout.module.css"), "utf8");
    expect(css).toMatch(/--dock-h:\s*6rem;/);
  });
});
