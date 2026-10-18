// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { storageTransition } from "../sync/interpolate.js";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore, StoreView } from "../sync/store.js";
import { App } from "./App.js";
import {
  CLIENT_T0,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
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
afterEach(() => cleanup());

const P3_BUY = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "constructor",
  mark: 1,
  count: 1,
  recipeId: "make_iron_plate",
} as const;

/** What App reads from a GameStore, driven by hand: set() a view, tick() the 4 Hz text. */
function fakeStore(snapshot: Snapshot | null, opts: { now?: number } = {}) {
  let view: StoreView = {
    status: snapshot ? "ready" : "loading",
    snapshot,
    pending: [],
    notices: [],
    failures: 0,
  };
  let clock = opts.now ?? CLIENT_T0;
  const listeners = new Set<() => void>();
  const tickers = new Set<() => void>();
  const fake = {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getView: () => view,
    subscribeTick: (fn: () => void) => {
      tickers.add(fn);
      return () => tickers.delete(fn);
    },
    now: () => clock,
    send: vi.fn(() => new Promise<never>(() => {})),
    newFactory: vi.fn(() => Promise.resolve()),
    dismiss: vi.fn(),
    set(patch: Partial<StoreView>) {
      view = { ...view, ...patch };
      act(() => listeners.forEach((fn) => fn()));
    },
    tick(ms: number) {
      clock += ms;
      act(() => tickers.forEach((fn) => fn()));
    },
    get tickers() {
      return tickers.size;
    },
  };
  return fake;
}

function mount(store: ReturnType<typeof fakeStore>) {
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

  it("4. the bottleneck buy sends the P-3 action once, then waits busy", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    const buy = screen.getByRole("button", { name: /^Buy 1 Constructor$/ });
    expect((buy as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(buy);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith([P3_BUY], "bottleneck buy");

    const batch: Batch = { id: 1, key: "k1", actions: [P3_BUY], label: "bottleneck buy" };
    store.set({ pending: [batch] });
    const busy = screen.getByRole("button", { name: /^Buy 1 Constructor$/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
  });

  it("4b. before it is affordable the button counts down, disabled", () => {
    mount(fakeStore(fresh));
    const wait = screen.getByRole("button", { name: /^affordable in \d+s$/ });
    expect((wait as HTMLButtonElement).disabled).toBe(true);
    expect(wait.textContent).toMatch(/^affordable in (4[2-4])s$/);
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
