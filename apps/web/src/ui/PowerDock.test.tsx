// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { D, format } from "@manufactory/engine";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore, StoreView } from "../sync/store.js";
import { App } from "./App.js";
import { PowerDock } from "./PowerDock.js";
import {
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";
import { TierReadout } from "./TierReadout.js";
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
afterEach(cleanup);

function withTicks(store: FakeStore, node: ReactNode) {
  return render(
    <TickContext.Provider value={createTickSource(store)}>{node}</TickContext.Provider>,
  );
}

function dock(s: Snapshot, store: FakeStore = fakeStore(s), taps = NO_TAPS) {
  withTicks(store, <PowerDock store={store} snapshot={s} taps={taps} />);
  return { store, tap: screen.getByRole("button", { name: "Tap: hold to keep the kick" }) };
}

describe("PowerDock (W-12, W-20, Q-12)", () => {
  it("1. the pointer holds the tap; up, cancel and lost capture release it", () => {
    const { store, tap } = dock(fresh);
    fireEvent.pointerDown(tap, { pointerId: 1 });
    expect(store.pressTap).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(tap, { pointerId: 1 });
    expect(store.releaseTap).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(tap, { pointerId: 2 });
    fireEvent.pointerCancel(tap, { pointerId: 2 });
    expect(store.releaseTap).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(tap, { pointerId: 3 });
    fireEvent.lostPointerCapture(tap, { pointerId: 3 });
    expect(store.releaseTap).toHaveBeenCalledTimes(3);
    expect(store.pressTap).toHaveBeenCalledTimes(3);
  });

  it("2. a held Space or Enter: key repeats are ignored, keyup and blur release", () => {
    const { store, tap } = dock(fresh);
    fireEvent.keyDown(tap, { key: " " });
    fireEvent.keyDown(tap, { key: " ", repeat: true });
    fireEvent.keyDown(tap, { key: " ", repeat: true });
    expect(store.pressTap).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(tap, { key: " " });
    expect(store.releaseTap).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tap, { key: "Enter" });
    fireEvent.blur(tap);
    expect(store.pressTap).toHaveBeenCalledTimes(2);
    expect(store.releaseTap).toHaveBeenCalledTimes(2);
  });

  it("3. the grid is a meter; stacks, kick and injection show from pending taps", () => {
    const store = fakeStore(fresh);
    const at = store.now();
    dock(fresh, store, { pending: 5, lastTapAt: at, holding: true });
    expect(screen.getByRole("meter", { name: "Grid" })).toBeTruthy();
    const root = document.querySelector("[data-dock]")!;
    expect(root.getAttribute("data-stacks")).toBe("5");
    expect(root.textContent).toContain("×1.25");
    expect(root.textContent).toContain("+25 MW");
    expect(root.textContent).toContain("30s");
    store.tick(1_000);
    expect(root.textContent).toContain("29s");
  });

  it("4. when power limits production the bar says so, and the frame keeps the one 'bottleneck'", () => {
    const store = fakeStore(tier8);
    render(<App store={store as unknown as GameStore} />);
    const root = document.querySelector<HTMLElement>("[data-dock]")!;
    const meter = within(root).getByRole("meter", { name: "Grid" });
    expect(meter.classList.contains("state-bottleneck")).toBe(true);
    expect(root.textContent).toContain("Power limits production");
    expect(root.textContent).toContain("needs");
    // Show the framed row's lane, so the frame is on screen.
    const mark = screen.queryByRole("img", { name: "bottleneck" });
    if (mark) fireEvent.click(mark.closest("button")!);
    expect(screen.getAllByText(/bottleneck/i)).toHaveLength(1);
    expect(document.querySelector(".app")!.getAttribute("data-polling")).toBe("armed");
  });

  it("5. no limit on a fresh world", () => {
    dock(fresh);
    const meter = screen.getByRole("meter", { name: "Grid" });
    expect(meter.classList.contains("state-bottleneck")).toBe(false);
    expect(document.querySelector("[data-dock]")!.textContent).not.toContain("limits");
  });
});

describe("TierReadout (Q-13)", () => {
  it("6. the tier, the next milestone, and each requirement's progress", () => {
    const store = fakeStore(tier8);
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} />);
    const el = document.querySelector<HTMLElement>("[data-tier]")!;
    expect(el.getAttribute("data-tier")).toBe("8");
    expect(el.textContent).toContain("Tier 8");
    const next = slice.content.milestoneByTier.get(9)!;
    expect(el.textContent).toContain(`next: ${next.name}`);
    for (const [id, amount] of [
      ["smart_plating", 512_000],
      ["polymer_resin", 2_048_000],
    ] as const) {
      const line = el.querySelector<HTMLElement>(`[data-requirement="${id}"]`)!;
      expect(line.textContent).toContain(slice.content.items.get(id)!.name);
      expect(line.textContent).toContain(`/ ${format(D(amount), "hybrid")}`);
    }
  });

  it("7. tier 10 is complete", () => {
    const s = snapshotOf(slice, { ...freshState(slice), tier: 10 });
    const store = fakeStore(s);
    withTicks(store, <TierReadout snapshot={s} now={store.now} />);
    expect(document.querySelector("[data-tier]")!.textContent).toBe("Tier 10 · complete");
  });
});
