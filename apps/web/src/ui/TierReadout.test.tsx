// @vitest-environment jsdom
// Q-13 / V-24: the header's tier readout. Ticking numbers, never a live region.
import { act, cleanup, render } from "@testing-library/react";
import { D, format, type ItemId } from "@manufactory/engine";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { shownStock } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import {
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  type FakeStore,
  type Slice,
} from "./test-fixtures.js";
import { setTheme } from "./theme.js";
import { TierReadout } from "./TierReadout.js";
import { createTickSource, TickContext } from "./use-tick.js";

let slice: Slice;
let tier8: Snapshot;
beforeAll(() => {
  slice = loadSlice();
  tier8 = snapshotOf(slice, fixtureState("slice-tier-8.world.json"));
});
afterEach(() => {
  cleanup();
  act(() => void setTheme("terminal"));
});

function withTicks(store: FakeStore, node: ReactNode) {
  return render(
    <TickContext.Provider value={createTickSource(store)}>{node}</TickContext.Provider>,
  );
}

const readout = () => document.querySelector<HTMLElement>("[data-tier]")!;
/** Tier 8's two requirements, as the content has them. */
const REQS = [
  ["smart_plating", 512_000],
  ["polymer_resin", 2_048_000],
] as const;

function progress(s: Snapshot, store: FakeStore, id: ItemId, amount: number): string {
  const shown = shownStock(s, id, serverNow(s, store.now()));
  return `${format(shown, "hybrid")}/${format(D(amount), "hybrid")}`;
}

describe("TierReadout (Q-13, V-24)", () => {
  it("8a. the shell voice: [TIER 8] next: ID n/m · ID n/m, each requirement tagged", () => {
    const store = fakeStore(tier8);
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} />);
    expect(readout().getAttribute("data-tier")).toBe("8");
    const [a, b] = REQS.map(
      ([id, amount]) => `${id.toUpperCase()} ${progress(tier8, store, id, amount)}`,
    );
    expect(readout().textContent).toBe(`[TIER 8] next: ${a} · ${b}`);
    // The full text is the title: the tablet ellipsizes it (U-2c).
    expect(readout().getAttribute("title")).toBe(readout().textContent);
    for (const [id] of REQS) {
      expect(readout().querySelector(`[data-requirement="${id}"]`)!.textContent).toContain(
        id.toUpperCase(),
      );
    }
    // Never a live region.
    expect(readout().closest("[aria-live]")).toBeNull();
  });

  it("8b. the plain voice: Tier 8 · next: Name n/m · Name n/m", () => {
    act(() => void setTheme("clean-dark"));
    const store = fakeStore(tier8);
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} />);
    const [a, b] = REQS.map(
      ([id, amount]) =>
        `${slice.content.items.get(id)!.name} ${progress(tier8, store, id, amount)}`,
    );
    expect(readout().textContent).toBe(`Tier 8 · next: ${a} · ${b}`);
  });

  it("8c. tier 10 is complete, in each voice", () => {
    const s = snapshotOf(slice, { ...freshState(slice), tier: 10 });
    const store = fakeStore(s);
    withTicks(store, <TierReadout snapshot={s} now={store.now} />);
    expect(readout().textContent).toBe("[TIER 10] complete");
    act(() => void setTheme("clean-light"));
    expect(readout().textContent).toBe("Tier 10 · complete");
  });

  it("8d. the phone shows one requirement, the furthest from done", () => {
    const store = fakeStore(tier8);
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} phone />);
    const at = serverNow(tier8, store.now());
    const ratio = ([id, amount]: (typeof REQS)[number]) =>
      shownStock(tier8, id, at).toNumber() / amount;
    const lowest = [...REQS].sort((x, y) => ratio(x) - ratio(y))[0]!;
    expect(readout().textContent).toBe(
      `[TIER 8] ${lowest[0].toUpperCase()} ${progress(tier8, store, lowest[0], lowest[1])}`,
    );
    expect(readout().querySelectorAll("[data-requirement]")).toHaveLength(1);
    act(() => void setTheme("clean-dark"));
    expect(readout().textContent).toBe(
      `Tier 8 · ${slice.content.items.get(lowest[0])!.name} ${progress(tier8, store, lowest[0], lowest[1])}`,
    );
  });
});
