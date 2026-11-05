// @vitest-environment jsdom
// U-6: the power panel (generator +1, load, FUEL, BIGGEST USERS, the kick line), the PWR footer
// and the floating TAP, and where each shows. PowerDock.test.tsx's hold tests (1, 2) moved here
// and run on both TAP buttons; its readout tests (3 to 5) became 4, 5 and 9.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { liquidCap, type WorldState } from "@manufactory/engine";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TAP_LABEL } from "../sync/constants.js";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore, StoreView } from "../sync/store.js";
import { App } from "./App.js";
import { bottleneckRow, powerLaneId } from "./derive.js";
import { dockModel, generatorLabel, mwText, nextMachineDrawMw, powerByLane } from "./dock-model.js";
import { FloatingTap } from "./FloatingTap.js";
import { PowerFooter } from "./PowerFooter.js";
import { PowerPanel } from "./PowerPanel.js";
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
import { createTickSource, TickContext } from "./use-tick.js";

const NO_TAPS: StoreView["taps"] = { pending: 0, lastTapAt: null, holding: false };

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

/** Every stock item's liquid stock at its cap, so a spend on it is affordable. */
function topped(state: WorldState): WorldState {
  const stored = { ...state.stored };
  for (const id of slice.content.stockItemIds) stored[id] = liquidCap(slice.content, state, id);
  return { ...state, stored };
}

function withTicks(store: FakeStore, node: ReactNode) {
  return render(
    <TickContext.Provider value={createTickSource(store)}>{node}</TickContext.Provider>,
  );
}

function panel(s: Snapshot, store: FakeStore = fakeStore(s)) {
  const view = () => store.getView();
  const node = () => (
    <PowerPanel
      store={store as unknown as GameStore}
      snapshot={s}
      view={view()}
      bottleneck={bottleneckRow(s)}
      selected={null}
      onSelect={() => {}}
      onOpen={() => {}}
      openItem={null}
      mode="desktop"
    />
  );
  const r = withTicks(store, node());
  const rerender = () =>
    r.rerender(
      <TickContext.Provider value={createTickSource(store)}>{node()}</TickContext.Provider>,
    );
  return { store, rerender, root: document.querySelector<HTMLElement>("[data-power-panel]")! };
}

type TapKind = "footer" | "floating";

function tapButton(kind: TapKind, s: Snapshot, store: FakeStore, taps = NO_TAPS) {
  const props = { store, snapshot: s, taps, pending: [] as Batch[] };
  const node = (p: typeof props) =>
    kind === "footer" ? <PowerFooter {...p} /> : <FloatingTap {...p} withCommand={false} />;
  const r = withTicks(store, node(props));
  const button = () => document.querySelector<HTMLElement>("[data-power] button[data-tap]")!;
  const update = (patch: Partial<typeof props>) =>
    r.rerender(
      <TickContext.Provider value={createTickSource(store)}>
        {node({ ...props, ...patch })}
      </TickContext.Provider>,
    );
  return { button, update };
}

function mount(s: Snapshot, width: number) {
  stubWidth(width);
  const store = fakeStore(s);
  render(<App store={store as unknown as GameStore} />);
  return store;
}

describe("PowerPanel, PowerFooter and FloatingTap (U-6)", { timeout: 60_000 }, () => {
  // Catches: the wrong action, mark, count or recipe; the wrong label (busy together with
  // something else); an optimistic +1 (W-13); a button on a locked class.
  it("3. +1 sends one BUY_MACHINE under power:<class>:buy, busy while pending; locked classes have none", () => {
    const s = snapshotOf(slice, topped(freshState(slice)));
    const { store, rerender, root } = panel(s);
    const gens = within(root).getByRole("region", { name: "Generators" });
    const plus = within(gens).getByRole("button", { name: "Buy 1 Biomass Burner" });
    expect(plus.textContent).toBe("+1");
    expect(plus.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(plus);
    expect(store.send).toHaveBeenCalledTimes(1);
    expect(store.send).toHaveBeenCalledWith(
      [
        {
          type: "BUY_MACHINE",
          lane: "power",
          machineClass: "biomass_burner",
          mark: 1,
          count: 1,
          recipeId: "burn_biomass",
        },
      ],
      "power:biomass_burner:buy",
    );
    expect(generatorLabel("biomass_burner")).toBe("power:biomass_burner:buy");
    // Pessimistic: busy until the batch's response lands, and a second click sends nothing.
    store.set({
      pending: [
        {
          id: 1,
          key: "k",
          label: "power:biomass_burner:buy",
          actions: store.send.mock.calls[0]![0],
        },
      ],
    });
    rerender();
    const busy = within(gens).getByRole("button", { name: "Buy 1 Biomass Burner" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(store.send).toHaveBeenCalledTimes(1);
    // The locked classes: their text, no button.
    const coal = gens.querySelector<HTMLElement>('[data-generator="coal_generator"]')!;
    expect(coal.textContent).toBe("COAL_GENERATOR x0 · unlocks at tier 4");
    expect(within(coal).queryByRole("button")).toBeNull();
    const fuel = gens.querySelector<HTMLElement>('[data-generator="fuel_generator"]')!;
    expect(fuel.textContent).toBe("FUEL_GENERATOR x0 · unlocks at tier 7");
    expect(gens.querySelectorAll("button")).toHaveLength(1);
  });

  // Catches: an unaffordable +1 that sends, or a countdown frozen between ticks.
  it("3b. before it's affordable, +1 counts down and sends nothing", () => {
    const { store, root } = panel(fresh);
    const gens = within(root).getByRole("region", { name: "Generators" });
    const plus = within(gens).getByRole("button", { name: /^Buy 1 Biomass Burner, affordable in/ });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    const first = plus.textContent!;
    expect(first).toMatch(/^\d+s$/);
    fireEvent.click(plus);
    expect(store.send).not.toHaveBeenCalled();
    store.tick(5_000);
    expect(Number.parseInt(plus.textContent!)).toBeLessThan(Number.parseInt(first));
  });

  // Catches: headroom off the wrong fields; "up to" off drawPerMachine; the short line missing
  // its state class.
  it("4. load: headroom and up to on a fresh world; the short line on tier 8", () => {
    const { root } = panel(fresh);
    const load = within(root).getByRole("region", { name: "Load" });
    const { supplyMw, demandMw } = fresh.display.solution.power;
    expect(load.textContent).toContain(
      `headroom ${mwText(supplyMw - demandMw)} MW · next machine needs up to ${mwText(nextMachineDrawMw(fresh))} MW`,
    );
    expect(within(load).getByRole("meter", { name: "Grid" }).classList).not.toContain(
      "state-bottleneck",
    );
    expect(load.querySelector(".state-bottleneck")).toBeNull();
    cleanup();

    const t8 = panel(tier8).root;
    const l8 = within(t8).getByRole("region", { name: "Load" });
    expect(tier8.display.solution.power.ratio).toBeLessThan(1);
    const short = l8.querySelector<HTMLElement>("span.state-bottleneck")!;
    expect(short.textContent).toBe(
      `power is short · needs ${mwText(tier8.display.solution.power.fullDemandMw)} MW`,
    );
    expect(l8.textContent).not.toContain("headroom");
    expect(within(l8).getByRole("meter", { name: "Grid" }).classList).toContain("state-bottleneck");
  });

  // Catches: the users not from powerByLane, more than three, or unsorted.
  it("4b. BIGGEST USERS: the top three lanes by drawn MW; FUEL is the power lane's rows", () => {
    const { root } = panel(tier8);
    const users = within(root).getByRole("region", { name: "Biggest users" });
    const top = powerByLane(tier8).slice(0, 3);
    const rows = [...users.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual(
      top.map(
        (g) => `${tier8.content.lanes.get(g.laneId)!.name.toUpperCase()} lane${mwText(g.mw)} MW`,
      ),
    );
    const fuel = within(root).getByRole("region", { name: "Fuel" });
    expect(within(fuel).getByRole("listbox").getAttribute("aria-label")).toBe("Power lane");
    expect(fuel.querySelector('li[role="option"][data-item="biomass"]')).not.toBeNull();
  });

  // Catches: tapName computed in the 4 Hz render (the label would count down with the text).
  it("5. the TAP's name: per snapshot and per tap, never at 4 Hz", () => {
    for (const kind of ["footer", "floating"] as const) {
      const store = fakeStore(fresh);
      const taps = { pending: 7, lastTapAt: store.now() - 9_000, holding: false };
      const { button, update } = tapButton(kind, fresh, store, taps);
      const name = "Tap, hold to keep tapping. Kick times 1.35, 7 of 10 stacks, 21 seconds left";
      expect(button().getAttribute("aria-label"), kind).toBe(name);
      const root = button().closest<HTMLElement>("[data-power]")!;
      expect(root.dataset.stacks).toBe("7");
      expect(root.textContent).toContain(kind === "footer" ? "21s" : "x1.35");
      for (let i = 0; i < 4; i += 1) store.tick(250);
      expect(button().getAttribute("aria-label"), kind).toBe(name);
      if (kind === "footer") expect(root.textContent).toContain("20s");
      // A new snapshot names the time left again.
      update({ snapshot: snapshotOf(slice, freshState(slice), { stateVersion: 1 }) });
      expect(button().getAttribute("aria-label"), kind).toBe(
        "Tap, hold to keep tapping. Kick times 1.35, 7 of 10 stacks, 20 seconds left",
      );
      update({ taps: NO_TAPS, snapshot: fresh });
      expect(button().getAttribute("aria-label"), kind).toBe("Tap, hold to keep the kick");
      cleanup();
    }
  });

  it("5b. the floating TAP: ten ■□ ticks and a time-left bar, all aria-hidden", () => {
    const store = fakeStore(fresh);
    const taps = { pending: 7, lastTapAt: store.now() - 9_000, holding: true };
    const { button } = tapButton("floating", fresh, store, taps);
    const ticks = button().querySelector<HTMLElement>("[data-ticks]")!;
    expect(ticks.textContent).toBe("■■■■■■■□□□");
    expect(ticks.getAttribute("aria-hidden")).toBe("true");
    const time = button().querySelector<HTMLElement>("[data-time-left]")!;
    expect(time.getAttribute("aria-hidden")).toBe("true");
    expect(time.querySelector<HTMLElement>("[data-fill]")!.style.transform).toBe("scaleX(0.7)");
    expect(button().closest("[data-power]")!.hasAttribute("data-holding")).toBe(true);
  });

  // PowerDock.test 1 and 2, moved, on both buttons; plus U-6c's stopped propagation.
  it("6. the hold: pointer and held keys, repeats ignored, keyup and blur release; Space stops", () => {
    for (const kind of ["footer", "floating"] as const) {
      const store = fakeStore(fresh);
      const tap = tapButton(kind, fresh, store).button();
      fireEvent.pointerDown(tap, { pointerId: 1 });
      expect(store.pressTap, kind).toHaveBeenCalledTimes(1);
      fireEvent.pointerUp(tap, { pointerId: 1 });
      expect(store.releaseTap).toHaveBeenCalledTimes(1);
      fireEvent.pointerDown(tap, { pointerId: 2 });
      fireEvent.pointerCancel(tap, { pointerId: 2 });
      expect(store.releaseTap).toHaveBeenCalledTimes(2);
      fireEvent.pointerDown(tap, { pointerId: 3 });
      fireEvent.lostPointerCapture(tap, { pointerId: 3 });
      expect(store.releaseTap).toHaveBeenCalledTimes(3);
      expect(store.pressTap).toHaveBeenCalledTimes(3);
      // A secondary button doesn't tap.
      fireEvent.pointerDown(tap, { pointerId: 4, button: 2 });
      expect(store.pressTap).toHaveBeenCalledTimes(3);

      const seen = vi.fn();
      document.addEventListener("keydown", seen);
      document.addEventListener("keyup", seen);
      fireEvent.keyDown(tap, { key: " " });
      fireEvent.keyDown(tap, { key: " ", repeat: true });
      fireEvent.keyDown(tap, { key: " ", repeat: true });
      expect(store.pressTap).toHaveBeenCalledTimes(4);
      fireEvent.keyUp(tap, { key: " " });
      expect(store.releaseTap).toHaveBeenCalledTimes(4);
      fireEvent.keyDown(tap, { key: "Enter" });
      fireEvent.keyUp(tap, { key: "Enter" });
      expect(seen).not.toHaveBeenCalled();
      fireEvent.keyDown(tap, { key: "Enter" });
      fireEvent.blur(tap);
      expect(store.pressTap).toHaveBeenCalledTimes(6);
      expect(store.releaseTap).toHaveBeenCalledTimes(6);
      // Other keys pass through.
      fireEvent.keyDown(tap, { key: "x" });
      expect(seen).toHaveBeenCalledTimes(1);
      document.removeEventListener("keydown", seen);
      document.removeEventListener("keyup", seen);
      cleanup();
    }
  });

  it("7. phone: ~ power shows the panel; the floating TAP is on all four tabs; no dock", () => {
    mount(fresh, 390);
    for (const view of ["factory", "power", "priority", "handbook"]) {
      fireEvent.click(screen.getByRole("tab", { name: view }));
      expect(document.querySelectorAll("div[data-power] > button[data-tap]"), view).toHaveLength(1);
      expect(document.querySelector("footer[data-power]")).toBeNull();
      expect(document.querySelector("[data-dock]")).toBeNull();
    }
    fireEvent.click(screen.getByRole("tab", { name: "power" }));
    expect(
      document.getElementById("view-power")!.querySelector("[data-power-panel]"),
    ).not.toBeNull();
    // Over the command bar on the factory tab, lower elsewhere.
    const floating = () => document.querySelector<HTMLElement>("div[data-power]")!;
    expect(floating().hasAttribute("data-with-command")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "factory" }));
    expect(floating().hasAttribute("data-with-command")).toBe(true);
    // The header's PWR reading: PWR d/s MW, or the load on the power tab.
    const { demandMw, supplyMw } = fresh.display.solution.power;
    const header = document.querySelector("header")!;
    expect(header.textContent).toContain(`PWR ${mwText(demandMw)}/${mwText(supplyMw)} MW`);
    fireEvent.click(screen.getByRole("tab", { name: "power" }));
    expect(header.textContent).toContain(`${mwText(demandMw)} / ${mwText(supplyMw)} MW`);
    expect(header.textContent).toContain(`${Math.round((demandMw / supplyMw) * 100)}% load`);
  });

  it("7b. desktop: the 5 POWER lane tab shows the panel; the footer holds the TAP; no dock", () => {
    mount(fresh, 1280);
    expect(document.querySelector("footer[data-power] button[data-tap]")).not.toBeNull();
    expect(document.querySelector("div[data-power]")).toBeNull();
    expect(document.querySelector("[data-power-panel]")).toBeNull();
    const power = document.querySelector<HTMLElement>('[role="tab"][data-lane="power"]')!;
    expect(power.textContent).toContain("5");
    fireEvent.click(power);
    expect(
      document.getElementById("view-factory")!.querySelector("[data-power-panel]"),
    ).not.toBeNull();
    expect(document.querySelector("[data-dock]")).toBeNull();
    const { demandMw, supplyMw } = fresh.display.solution.power;
    const footer = document.querySelector<HTMLElement>("footer[data-power]")!;
    expect(footer.textContent).toContain("PWR");
    expect(footer.textContent).toContain(`${mwText(demandMw)}/${mwText(supplyMw)} MW`);
    expect(footer.textContent).toContain("KICK off · hold TAP");
  });

  // PowerDock.test 4, moved: power limits production on tier 8, and the framed row is marked.
  it("8. tier 8: the footer's bar says power limits; the panel's FUEL row carries the mark", () => {
    mount(tier8, 1280);
    const footer = document.querySelector<HTMLElement>("footer[data-power]")!;
    expect(within(footer).getByRole("meter", { name: "Grid" }).classList).toContain(
      "state-bottleneck",
    );
    const b = bottleneckRow(tier8)!;
    expect(b.laneId).toBe(powerLaneId(tier8));
    fireEvent.click(screen.getByRole("tab", { name: /, bottleneck$/ }));
    const root = document.querySelector<HTMLElement>("[data-power-panel]")!;
    const marked = root.querySelectorAll("li[role=option][aria-label$=', bottleneck']");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.firstElementChild!.textContent).toBe("!");
    expect(document.querySelector(".app")!.getAttribute("data-polling")).toBe("armed");
  });

  // PowerDock.test 3, moved: pending taps show at once in the footer, and the panel's kick line.
  it("9. pending taps: the footer's KICK and STK; the panel's kick line", () => {
    const store = fakeStore(fresh);
    const at = store.now();
    store.set({ taps: { pending: 5, lastTapAt: at, holding: true } });
    stubWidth(1280);
    render(<App store={store as unknown as GameStore} />);
    const footer = document.querySelector<HTMLElement>("footer[data-power]")!;
    expect(footer.dataset.stacks).toBe("5");
    expect(footer.hasAttribute("data-holding")).toBe(true);
    expect(footer.textContent).toContain("KICK x1.25 · 5 STK · 30s");
    store.tick(1_000);
    expect(footer.textContent).toContain("KICK x1.25 · 5 STK · 29s");
    fireEvent.click(document.querySelector<HTMLElement>('[role="tab"][data-lane="power"]')!);
    const kick = document.querySelector<HTMLElement>("[data-kick-line]")!;
    expect(kick.textContent).toBe("KICK x1.25 · 5 / 10 stacks · 29s left · hold TAP to keep it up");
    store.set({ taps: NO_TAPS });
    expect(kick.textContent).toBe("KICK off · hold TAP to start it");
    expect(dockModel(fresh, NO_TAPS, CLIENT_T0).stacks).toBe(0);
    // An in-flight TAP batch still counts (dockModel's 2b, through the view).
    store.set({
      taps: { pending: 0, lastTapAt: store.now(), holding: false },
      pending: [
        {
          id: 1,
          key: "k",
          label: TAP_LABEL,
          actions: [{ type: "TAP", count: 3, clientElapsedMs: 50 }],
        },
      ],
    });
    expect(footer.dataset.stacks).toBe("3");
  });
});
