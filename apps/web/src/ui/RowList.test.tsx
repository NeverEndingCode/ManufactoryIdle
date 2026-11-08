// @vitest-environment jsdom
// U-3 / U-7d: the fixed rows, the listbox, the SAT cell and the Bar. The App-level tests
// that LaneView.test.tsx held (meters, the plateau, the root mirror, the region, the tween and
// the announcements) moved here with their selectors updated.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  D,
  DECIMAL_ZERO,
  liquidCap,
  withInstalled,
  type Bottleneck,
  type WorldState,
} from "@manufactory/engine";
import { Profiler } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { shownStock, storageFraction, storageTransition } from "../sync/interpolate.js";
import type { Batch } from "../sync/outbox.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { Bar } from "./Bar.js";
import {
  bottleneckRow,
  laneRows,
  machinesText,
  optionName,
  satText,
  stateClass,
  unlockedLanes,
} from "./derive.js";
import { easeOut, TWEEN_MS, tweenDec } from "./motion.js";
import { fmt } from "./notation.js";
import { defaultSelection } from "./RowList.js";
import {
  CLIENT_T0,
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  stubWidth,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";
import css from "./Row.module.css";
import { themeDef } from "./theme.js";
import { createTickSource, TickContext } from "./use-tick.js";

// L-12's render counter for the TREND cells: the real memo boundary, with a Profiler inside it,
// so a cell that re-renders on its own (a useTick in it) is counted as well as one its row pushes.
const trendRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock("./TrendCell.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("./TrendCell.js")>();
  const { createElement: h, memo: keep, Profiler: P } = await import("react");
  return {
    ...m,
    Trend: keep((p: Parameters<typeof m.TrendCells>[0]) =>
      h(P, { id: "trend", onRender: () => (trendRenders.n += 1) }, h(m.TrendCells, p)),
    ),
  };
});

let slice: Slice;
let fresh: Snapshot;
let tier8: Snapshot;
let full: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
  tier8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
  full = snapshotOf(slice, fixtureState("slice-tier-8-reinforced-full.world.json"));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(store: FakeStore) {
  return render(<App store={store as unknown as GameStore} />);
}

const option = (item: string) =>
  document.querySelector<HTMLElement>(`li[role="option"][data-item="${item}"]`)!;
const listbox = () => screen.getByRole("listbox");
const active = () => listbox().getAttribute("aria-activedescendant");
const drawer = (item: string) => document.querySelector<HTMLElement>(`[data-drawer="${item}"]`);

/** The element tree: tag names and attribute names, ignoring classes, text and aria-* (U-3a). */
function shape(el: Element): string {
  const attrs = [...el.attributes]
    .map((a) => a.name)
    .filter((n) => n !== "class" && !n.startsWith("aria-"))
    .sort();
  return `${el.tagName}[${attrs.join(" ")}](${[...el.children].map(shape).join(",")})`;
}

describe("RowList: fixed rows (U-3a)", { timeout: 60_000 }, () => {
  it("1. the framed row and an unframed row have the same tree, whatever happens to them", () => {
    const store = fakeStore(fresh, { now: CLIENT_T0 + 60_000 });
    mount(store);
    expect(bottleneckRow(fresh)!.itemId).toBe("iron_plate");
    const framed = () => shape(option("iron_plate"));
    const plain = () => shape(option("iron_ore"));
    const tree = plain();
    expect(framed()).toBe(tree);
    // Eight cells, the storage cell holding the bar, the trend cell (U-9b) after SAT.
    expect(option("iron_ore").children).toHaveLength(8);
    expect(trendCell("iron_ore").getAttribute("aria-hidden")).toBe("true");
    expect(trendCell("iron_ore").children).toHaveLength(10);

    // Selected (the default is the framed row) and unselected, through the keys (the
    // dispatcher's Home, on the focused list: K-8).
    act(() => listbox().focus());
    fireEvent.keyDown(listbox(), { key: "Home" });
    expect(option("iron_ore").getAttribute("aria-selected")).toBe("true");
    expect(framed()).toBe(tree);
    expect(plain()).toBe(tree);
    // An open drawer.
    fireEvent.click(option("iron_plate"));
    expect(drawer("iron_plate")).not.toBeNull();
    expect(framed()).toBe(tree);
    expect(plain()).toBe(tree);
    // A pending buy.
    const batch: Batch = { id: 1, key: "k1", actions: [], label: "bottleneck buy" };
    store.set({ pending: [batch] });
    expect(framed()).toBe(tree);
    expect(plain()).toBe(tree);
  });
});

/** The row's TREND cell: the fifth, after SAT (U-3b). */
const trendCell = (item: string) => option(item).children[4] as HTMLElement;

/** `s` as a later response: the clock `dMs` on, arriving now, with some rates replaced. */
function later(
  s: Snapshot,
  dMs: number,
  receivedAt: number,
  rates: Record<string, number> = {},
): Snapshot {
  const items = { ...s.schedule.items };
  for (const [id, r] of Object.entries(rates)) items[id] = { ...items[id]!, netPerSecond: r };
  return { ...s, schedule: { ...s.schedule, atMs: s.schedule.atMs + dMs, items }, receivedAt };
}

describe("RowList: the TREND column (U-9b, L-12, L-15)", { timeout: 60_000 }, () => {
  // Catches: the trend read at the 4 Hz tick (a useTick in the cell, or the window computed in
  // the row on every render), or a minute timer that never bumps the rows.
  it("12. the cells re-render on an adoption and at the server minute, never at 4 Hz", () => {
    stubWidth(1280);
    const store = fakeStore(tier8);
    mount(store);
    fireEvent.click(screen.getByRole("tab", { name: /Iron/ }));
    const rows = laneRows(tier8, "iron").length;
    expect(rows).toBeGreaterThan(3);
    store.adopt({ prev: null, next: tier8 });
    expect(trendCell(laneRows(tier8, "iron")[0]!.itemId).textContent).toBe("··········");

    trendRenders.n = 0;
    for (let i = 0; i < 10; i++) store.tick(250);
    expect(trendRenders.n).toBe(0);

    const next = later(tier8, 20_000, store.now());
    store.adopt({ next });
    expect(trendRenders.n).toBe(rows);
    expect(trendCell(laneRows(tier8, "iron")[0]!.itemId).textContent).toBe("·········▄");

    // The server minute: just before it, nothing; past it, each cell once.
    const sNow = serverNow(next, store.now());
    const toMinute = 60_000 - (sNow % 60_000);
    trendRenders.n = 0;
    store.tick(toMinute - 50);
    expect(trendRenders.n).toBe(0);
    store.tick(100);
    expect(trendRenders.n).toBe(rows);
    // tier-8's boundary comes before the minute: the new minute is unknown, not stale.
    expect(trendCell(laneRows(tier8, "iron")[0]!.itemId).textContent).toBe("········▄·");
  });

  // Catches: the trend word after ", bottleneck", or a word with one known bucket.
  it("14. the option's name says the trend before bottleneck, and nothing with < 2 buckets", () => {
    const store = fakeStore(fresh);
    mount(store);
    const row = laneRows(fresh, "iron").find((r) => r.itemId === "iron_plate")!;
    const r = row.netPerSecond;
    expect(r).toBeGreaterThan(0);
    store.adopt({ prev: null, next: fresh });
    const name = () => option("iron_plate").getAttribute("aria-label")!;
    expect(name()).toBe(optionName(fresh, row, true));
    const s1 = later(fresh, 60_000, store.now(), { iron_plate: 2 * r });
    store.adopt({ next: s1 });
    // Two known minutes, both at r so far: steady.
    expect(name()).toMatch(/, steady, bottleneck$/);
    store.tick(60_000);
    const s2 = later(fresh, 120_000, store.now(), { iron_plate: 2 * r });
    store.adopt({ next: s2 });
    expect(name()).toMatch(/ percent satisfied, rising, bottleneck$/);
    expect(option("iron_ore").getAttribute("aria-label")).not.toMatch(/bottleneck/);
  });

  // Catches: the down colour from anything but the rate's sign, or the bottleneck's colour on
  // every row.
  it("15. the colour classes: down below 0, state-bottleneck on the framed row, else neither", () => {
    const store = fakeStore(fresh);
    mount(store);
    store.adopt({ prev: null, next: later(fresh, 0, CLIENT_T0, { iron_ore: -1 }) });
    const has = (item: string, c: string) => trendCell(item).classList.contains(c);
    expect(has("iron_ore", css.down!)).toBe(true);
    expect(has("iron_ore", "state-bottleneck")).toBe(false);
    expect(has("iron_plate", "state-bottleneck")).toBe(true);
    expect(has("iron_plate", css.down!)).toBe(false);
    expect(has("iron_rod", css.down!)).toBe(false);
    expect(has("iron_rod", "state-bottleneck")).toBe(false);
    expect(has("iron_rod", css.trend!)).toBe(true);
    // Unknown cells carry their own class (L-14: --t3, --t2 on the selected row).
    expect(trendCell("iron_rod").children[0]!.classList.contains(css.unknown!)).toBe(true);
  });

  it("the header names the column between SAT and MACHINES", () => {
    mount(fakeStore(fresh));
    const head = [...document.querySelectorAll(`.${css.head} > span`)].map((e) => e.textContent);
    expect(head).toEqual([
      "",
      "ITEM",
      "RATE",
      "SAT",
      "LAST 10 MIN",
      "MACHINES",
      "STORAGE",
      "STOCK",
    ]);
  });
});

describe("RowList: SAT, names and selection (U-3b, U-7d)", { timeout: 60_000 }, () => {
  it("3. satText: empty when fed, a percentage throttled, paused, a dash when idle", () => {
    const all = (s: Snapshot) => unlockedLanes(s).flatMap((l) => laneRows(s, l.id));
    const fed = all(tier8).find((r) => stateClass(r) === "fed")!;
    expect(satText(fed)).toEqual({ text: "", cls: "fed" });
    const throttled = all(tier8).find((r) => stateClass(r) === "throttled")!;
    expect(throttled).toBeDefined();
    expect(satText(throttled)).toEqual({
      text: `${Math.round(throttled.satisfaction * 100)}%`,
      cls: "throttled",
    });
    expect(satText({ satisfaction: 0.72, paused: false, idle: false }).text).toBe("72%");
    const paused = snapshotOf(slice, {
      ...tier8.state,
      priority: tier8.state.priority.map((e) =>
        e.id === "item:iron_ingot" ? { ...e, paused: true } : e,
      ),
    });
    const ingot = laneRows(paused, "iron").find((r) => r.itemId === "iron_ingot")!;
    expect(satText(ingot)).toEqual({ text: "paused", cls: "paused" });
    const idle = laneRows(fresh, "iron").find((r) => r.idle)!;
    expect(satText(idle)).toEqual({ text: "—", cls: "idle" });
  });

  it("3b. machinesText: one mark by its name, several by the class, none a dash, and split", () => {
    const terminal = themeDef("terminal");
    const clean = themeDef("clean-dark");
    expect(machinesText(fresh, "iron_plate", terminal)).toBe("CONSTRUCTOR_MK1 x1");
    expect(machinesText(fresh, "iron_plate", clean)).toMatch(/^Constructor Mk\.1 x1$/);
    const idle = laneRows(fresh, "iron").find((r) => r.idle)!;
    expect(machinesText(fresh, idle.itemId, terminal)).toBe("—");
    // A second mark in the pool: the class, the count, and the number of marks.
    const two = snapshotOf(slice, withInstalled(freshState(slice), "iron", "constructor", 2, 1));
    const count = two.display.solution.capacity.machinesByRecipe.get("make_iron_plate")!;
    expect(machinesText(two, "iron_plate", terminal)).toBe(`CONSTRUCTOR x${count} (2 marks)`);
    // A contested item says so.
    expect(machinesText(full, "screw", terminal)).toMatch(/ · split$/);
  });

  it("4. the option's name is one phrase, ending in bottleneck on the framed row", () => {
    const row = laneRows(fresh, "iron").find((r) => r.itemId === "iron_plate")!;
    const rotor = { ...row, name: "Rotor", netPerSecond: 0.4, satisfaction: 0.41 };
    const full = Math.round(storageFraction(fresh, "iron_plate", fresh.schedule.atMs) * 100);
    expect(optionName(fresh, rotor, true)).toBe(
      `Rotor, plus ${fmt(D(0.4))} per second, ${full} percent full, 41 percent satisfied, bottleneck`,
    );
    expect(optionName(fresh, { ...rotor, netPerSecond: -2 }, false)).toBe(
      `Rotor, minus ${fmt(D(2))} per second, ${full} percent full, 41 percent satisfied`,
    );
    mount(fakeStore(fresh));
    expect(option("iron_plate").getAttribute("aria-label")).toBe(optionName(fresh, row, true));
    expect(option("iron_plate").getAttribute("aria-label")).toMatch(/, bottleneck$/);
    expect(option("iron_ore").getAttribute("aria-label")).not.toMatch(/bottleneck/);
  });

  it("4. defaultSelection: the bottleneck's row in the lane, else the first row", () => {
    const rows = laneRows(fresh, "iron");
    expect(rows[0]!.itemId).not.toBe("iron_plate");
    const b = bottleneckRow(fresh);
    expect(defaultSelection(rows, b)).toBe("iron_plate");
    expect(defaultSelection(rows, null)).toBe(rows[0]!.itemId);
    // Tier 8's bottleneck is in power: the iron lane takes its first row.
    const t8 = bottleneckRow(tier8)!;
    expect(t8.laneId).not.toBe("iron");
    const iron = laneRows(tier8, "iron");
    expect(defaultSelection(iron, t8)).toBe(iron[0]!.itemId);
    expect(defaultSelection([], b)).toBeNull();
  });

  it("4. the selection survives a lane switch and a snapshot, and is dropped with its item", () => {
    const store = fakeStore(tier8);
    mount(store);
    fireEvent.click(screen.getByRole("tab", { name: /Iron/ }));
    const iron = laneRows(tier8, "iron");
    expect(active()).toBe(`row-${iron[0]!.itemId}`);
    act(() => listbox().focus());
    fireEvent.keyDown(listbox(), { key: "End" });
    const last = iron.at(-1)!.itemId;
    expect(active()).toBe(`row-${last}`);
    fireEvent.click(screen.getByRole("tab", { name: /Copper/ }));
    expect(listbox().getAttribute("aria-label")).toBe("Copper lane");
    fireEvent.click(screen.getByRole("tab", { name: /Iron/ }));
    expect(listbox().getAttribute("aria-label")).toBe("Iron lane");
    expect(active()).toBe(`row-${last}`);
    store.set({ snapshot: { ...tier8 } });
    expect(active()).toBe(`row-${last}`);
    expect(option(last).getAttribute("aria-selected")).toBe("true");

    // A snapshot without it (a fresh world has no tier-8 rows): the default, and it stays dropped.
    expect(laneRows(fresh, "iron").some((r) => r.itemId === last)).toBe(false);
    store.set({ snapshot: fresh });
    expect(active()).toBe("row-iron_plate");
    store.set({ snapshot: tier8 });
    expect(active()).toBe(`row-${iron[0]!.itemId}`);
  });

  it("4. a click selects the row and opens its drawer", () => {
    mount(fakeStore(fresh));
    fireEvent.click(option("iron_ore"));
    expect(active()).toBe("row-iron_ore");
    expect(option("iron_ore").getAttribute("aria-selected")).toBe("true");
    expect(option("iron_plate").getAttribute("aria-selected")).toBe("false");
    expect(drawer("iron_ore")).not.toBeNull();
    expect(document.activeElement).toBe(document.getElementById("drawer-title"));
  });
});

/** Bar in isolation, under a tick source. */
function renderBar(props: Partial<Parameters<typeof Bar>[0]> = {}) {
  const store = fakeStore(fresh);
  const ui = (p: Partial<Parameters<typeof Bar>[0]>) => (
    <TickContext.Provider value={createTickSource(store)}>
      <Bar
        label="Iron Ore storage"
        valueNow={0.25}
        valueText="25% full"
        tone="normal"
        transition={{ from: 0.25, to: 1, durationMs: 4000 }}
        {...p}
      />
    </TickContext.Provider>
  );
  const r = render(ui(props));
  return { ...r, store, rerender: (p: Partial<Parameters<typeof Bar>[0]>) => r.rerender(ui(p)) };
}

const tx = (f: number) => `translateX(${(f - 1) * 100}%)`;
const neg = (f: number) => `translateX(${(1 - f) * 100}%)`;

describe("Bar: the reveal (U-3d, W-7)", { timeout: 60_000 }, () => {
  it("6. the clip and the fill start at from, then move to to, together, in one commit", () => {
    const seen: { clip: string; fill: string; clipT: string; fillT: string }[] = [];
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const meter = this.closest("[role=meter]");
      const clip = meter?.querySelector<HTMLElement>("[data-clip]");
      const fill = meter?.querySelector<HTMLElement>("[data-fill]");
      if (clip && fill)
        seen.push({
          clip: clip.style.transform,
          fill: fill.style.transform,
          clipT: clip.style.transition,
          fillT: fill.style.transition,
        });
      return real.call(this);
    });
    renderBar({ transition: { from: 0.3, to: 1, durationMs: 4000 } });
    // At the reflow: from, with no transition yet.
    expect(seen).toEqual([{ clip: tx(0.3), fill: neg(0.3), clipT: "none", fillT: "none" }]);
    const meter = screen.getByRole("meter", { name: "Iron Ore storage" });
    const clip = meter.querySelector<HTMLElement>("[data-clip]")!;
    const fill = meter.querySelector<HTMLElement>("[data-fill]")!;
    expect(fill.parentElement).toBe(clip);
    expect(clip.style.transform).toBe(tx(1));
    expect(fill.style.transform).toBe(neg(1));
    expect(clip.style.transition).toBe("transform 4000ms linear");
    expect(fill.style.transition).toBe("transform 4000ms linear");
    expect(clip.style.width).toBe("");
    expect(fill.style.width).toBe("");
  });

  it("6. a zero-length transition sits still at to; the meter's value is its prop", () => {
    const { rerender } = renderBar({ transition: { from: 0.5, to: 0.5, durationMs: 0 } });
    const meter = screen.getByRole("meter", { name: "Iron Ore storage" });
    const clip = meter.querySelector<HTMLElement>("[data-clip]")!;
    expect(clip.style.transform).toBe(tx(0.5));
    expect(clip.style.transition).toBe("none");
    expect(meter.getAttribute("aria-valuenow")).toBe("0.25");
    expect(meter.getAttribute("aria-valuetext")).toBe("25% full");
    rerender({
      valueNow: 0.5,
      valueText: "50% full",
      transition: { from: 0.5, to: 0.5, durationMs: 0 },
    });
    expect(meter.getAttribute("aria-valuenow")).toBe("0.5");
  });

  it("6. in a row: aria-valuenow moves per snapshot only; the tick moves the stock text", () => {
    const store = fakeStore(fresh);
    mount(store);
    const ore = option("iron_ore");
    const meter = within(ore).getByRole("meter");
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("1");
    const before = meter.getAttribute("aria-valuenow");
    expect(before).not.toBeNull();
    const clip = meter.querySelector<HTMLElement>("[data-clip]")!;
    const t = storageTransition(fresh, "iron_ore", serverNow(fresh, store.now()));
    expect(t.durationMs).toBeGreaterThan(0);
    expect(clip.style.transform).toBe(tx(t.to));
    expect(clip.style.transition).toBe(`transform ${t.durationMs}ms linear`);

    const stock = () => ore.querySelector("[data-stock]")!.textContent;
    const text0 = stock();
    store.tick(10_000);
    expect(stock()).not.toBe(text0);
    expect(within(option("iron_ore")).getByRole("meter").getAttribute("aria-valuenow")).toBe(
      before,
    );
    // The transition is the snapshot's: the tick leaves it alone.
    expect(clip.style.transform).toBe(tx(t.to));

    const cap = liquidCap(slice.content, fresh.state, "iron_ore");
    const half = snapshotOf(slice, {
      ...fresh.state,
      stored: { ...fresh.state.stored, iron_ore: cap.div(2) },
    });
    store.set({ snapshot: half });
    expect(within(option("iron_ore")).getByRole("meter").getAttribute("aria-valuenow")).not.toBe(
      before,
    );
  });

  it("6. under reduced motion there is no transition, and the 4 Hz tick steps both", () => {
    stubWidth(1280, { reducedMotion: true });
    const store = fakeStore(fresh);
    mount(store);
    const meter = within(option("iron_ore")).getByRole("meter");
    const clip = meter.querySelector<HTMLElement>("[data-clip]")!;
    const fill = meter.querySelector<HTMLElement>("[data-fill]")!;
    const t = storageTransition(fresh, "iron_ore", serverNow(fresh, store.now()));
    expect(clip.style.transition).toBe("none");
    expect(fill.style.transition).toBe("none");
    expect(clip.style.transform).toBe(tx(t.from));
    expect(fill.style.transform).toBe(neg(t.from));
    store.tick(10_000);
    const later = storageFraction(fresh, "iron_ore", serverNow(fresh, store.now()));
    expect(later).toBeGreaterThan(t.from);
    expect(clip.style.transform).toBe(tx(later));
    expect(fill.style.transform).toBe(neg(later));
  });

  it("6. the bottleneck's bar takes the state class; others don't", () => {
    mount(fakeStore(fresh));
    const framed = within(option("iron_plate")).getByRole("meter");
    expect(framed.classList.contains("state-bottleneck")).toBe(true);
    expect(
      within(option("iron_ore")).getByRole("meter").classList.contains("state-bottleneck"),
    ).toBe(false);
    const gutter = option("iron_plate").firstElementChild!;
    expect(gutter.textContent).toBe("!");
    expect(gutter.getAttribute("aria-hidden")).toBe("true");
    expect(gutter.classList.contains("state-bottleneck")).toBe(true);
    expect(option("iron_ore").firstElementChild!.textContent).toBe("");
  });
});

describe("RowList: what moved into the drawer (V-18)", { timeout: 60_000 }, () => {
  it("7. the iron rows show no QS chip; the drawer's meta has QS", () => {
    mount(fakeStore(tier8));
    fireEvent.click(screen.getByRole("tab", { name: /Iron/ }));
    const qs = laneRows(tier8, "iron").find((r) => r.quantum !== null)!;
    expect(qs).toBeDefined();
    expect(listbox().textContent).not.toMatch(/QS |BOUND /);
    expect(listbox().querySelector("[data-split]")).toBeNull();
    fireEvent.click(option(qs.itemId));
    const meta = drawer(qs.itemId)!.querySelector("[data-meta]")!;
    expect(meta.textContent).toContain(`QS ${fmt(qs.quantum!)}`);
    expect(meta.textContent).toMatch(/^IRON lane · /);
    expect(meta.textContent).not.toContain("BOUND");
  });

  it("7. the contested screw's drawer has the split, and its row says split", () => {
    mount(fakeStore(full));
    fireEvent.click(screen.getByRole("tab", { name: /Iron/ }));
    expect(option("screw").textContent).toContain(" · split");
    fireEvent.click(option("screw"));
    // SPLIT (K-15): a button per part, each to screw's priority entry.
    const parts = [...drawer("screw")!.querySelectorAll<HTMLButtonElement>("button[data-split]")];
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(
      parts.some((b) =>
        /^\d+% Reinforced Iron Plate: show Screw in the priority list$/.test(
          b.getAttribute("aria-label")!,
        ),
      ),
    ).toBe(true);
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

describe("the App around the rows", { timeout: 60_000 }, () => {
  it("the lane tabs: the iron tab marked on a fresh world, power on tier 8", () => {
    mount(fakeStore(fresh));
    // The mark is aria-hidden; the tab's name says it (U-3e).
    const iron = screen.getByRole("tab", { name: "Iron, bottleneck" });
    expect(iron.getAttribute("aria-selected")).toBe("true");
    expect(iron.textContent).toContain(" !");
    expect(screen.getByRole("tab", { name: /^Power, / }).textContent).not.toContain("!");
    // The advice is the NEXT_BUY card's now (U-4c, NextBuy.test); the row says only "!".
    cleanup();

    mount(fakeStore(tier8));
    fireEvent.click(screen.getByRole("tab", { name: /Power/ }));
    expect(option("biomass").getAttribute("aria-label")).toMatch(/, bottleneck$/);
    fireEvent.click(screen.getByRole("tab", { name: /Copper/ }));
    expect(document.querySelectorAll("li[role=option][aria-label$=', bottleneck']")).toHaveLength(
      0,
    );
    // Only the visible lane renders.
    expect(option("biomass")).toBeNull();
  });

  it("the plateau notice renders on a plateaued snapshot", () => {
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

describe("the stock tween (W-7, W-18)", { timeout: 60_000 }, () => {
  it("a 100× stock correction tweens in log space over 300 ms with no React render", () => {
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
    render(
      <Profiler id="app" onRender={() => (renders += 1)}>
        <App store={store as unknown as GameStore} />
      </Profiler>,
    );
    const stock = () => option("iron_plate").querySelector("[data-stock]")!.textContent;
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

  it("under reduced motion a correction snaps at once", () => {
    stubWidth(1280, { reducedMotion: true });
    const frames = fakeFrames();
    const base = tier8.state;
    const cap = liquidCap(slice.content, base, "iron_plate");
    const low: WorldState = { ...base, stored: { ...base.stored, iron_plate: cap.div(1e4) } };
    const a = snapshotOf(slice, low);
    const store = fakeStore(a);
    mount(store);
    const from = shownStock(a, "iron_plate", serverNow(a, store.now()));
    const b = snapshotOf(slice, {
      ...low,
      stored: { ...low.stored, iron_plate: from.times(100) },
    });
    store.set({ snapshot: b });
    const to = shownStock(b, "iron_plate", serverNow(b, store.now()));
    expect(option("iron_plate").querySelector("[data-stock]")!.textContent).toBe(fmt(to));
    expect(frames.waiting).toBe(0);
  });
});

describe("announcements (S-15, W-20)", { timeout: 60_000 }, () => {
  it("a bottleneck change is said once, never on first load; clearing says so", () => {
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

    // V-14: a frameless bottleneck is said too, once; it's no longer a notice line.
    const frameless = withBottleneck(fresh, {
      kind: "power",
      limitingTarget: "power",
      generatorRecipeId: null,
      machinesToClear: 0,
      mark: null,
    });
    const fText = bottleneckRow(frameless)!.text;
    store.set({ snapshot: frameless });
    const said = announced();
    expect(said?.textContent).toBe(`Bottleneck: ${fText}`);
    store.set({ snapshot: { ...frameless } });
    expect(announced()).toBe(said);
  });

  it("one live region in every state, with every notice inside it", () => {
    const store = fakeStore(fresh);
    mount(store);
    // Idle.
    theOneRegion();
    expect(document.querySelectorAll("[data-notice]")).toHaveLength(0);
    // Offline.
    store.set({ status: "offline" });
    expect(theOneRegion().querySelector('[data-notice="offline"]')).not.toBeNull();
    // A tier-up: no toast now, but still said inside the one region, hidden (L-17); the banner
    // outside it is aria-hidden and no region.
    store.set({ status: "ready", notices: [{ kind: "tier-up", text: "Tier 2 reached." }] });
    const tierUp = theOneRegion().querySelector('[data-notice="tier-up"]')!;
    expect(tierUp.classList.contains("visually-hidden")).toBe(true);
    expect(document.querySelector("[data-tier-banner]")!.getAttribute("aria-hidden")).toBe("true");
    // A rejection.
    store.set({ notices: [{ kind: "rejected", text: "Not enough iron plate." }] });
    expect(theOneRegion().querySelector('[data-notice="rejected"]')).not.toBeNull();
    // A frameless bottleneck: no row marked, and no line in the region (U-3e).
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
    expect(theOneRegion().querySelector('[data-notice="bottleneck"]')).toBeNull();
    expect(document.querySelectorAll("li[role=option][aria-label$=', bottleneck']")).toHaveLength(
      0,
    );
    // After a priority move's announcement (on the priority view).
    store.set({ snapshot: fresh });
    fireEvent.click(screen.getByRole("tab", { name: "priority" }));
    const rod = document.querySelector<HTMLElement>('li[data-entry="item:iron_rod"]')!;
    rod.focus();
    fireEvent.keyDown(rod, { key: "ArrowUp", altKey: true });
    const region = theOneRegion();
    expect(region.querySelector("[data-announce]")?.textContent).toMatch(/moved to position 2/);
  });

  it("nothing under the region has an inline style but the hidden announcement", () => {
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
