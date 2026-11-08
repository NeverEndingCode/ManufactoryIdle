// @vitest-environment jsdom
// L-3: one feel pair per store, subscribed once, outside React.
import { describe, expect, it, vi } from "vitest";
import type { AdoptEvent } from "../sync/store.js";
import { feelOf, type FeelStore } from "./feel.js";
import { fakeStore, freshState, loadSlice, snapshotOf } from "./test-fixtures.js";

function store() {
  const listeners: ((e: AdoptEvent) => void)[] = [];
  const s = {
    onAdopt: vi.fn((fn: (e: AdoptEvent) => void) => {
      listeners.push(fn);
      return () => {};
    }),
    later: vi.fn(() => () => {}),
    now: () => 0,
  } satisfies FeelStore;
  return { s, listeners };
}

describe("feelOf (L-3)", () => {
  // Catches: a new pair (and new subscriptions) per call, as a StrictMode remount would make.
  it("1. one pair per store, each book subscribed once", () => {
    const { s, listeners } = store();
    const feel = feelOf(s);
    expect(feelOf(s)).toBe(feel);
    expect(feel.log).not.toBe(feel.trend);
    expect(s.onAdopt).toHaveBeenCalledTimes(2);
    expect(listeners).toHaveLength(2);
  });

  // Catches: one module-wide pair shared by every store.
  it("2. a second store gets its own pair", () => {
    const a = store();
    const b = store();
    const fa = feelOf(a.s);
    const fb = feelOf(b.s);
    expect(fb).not.toBe(fa);
    expect(fb.log).not.toBe(fa.log);
    expect(fb.trend).not.toBe(fa.trend);
    expect(b.s.onAdopt).toHaveBeenCalledTimes(2);
  });

  // Catches: a FakeStore whose adopt() runs the view listeners first, or swaps the view before
  // the adopt listeners (the real store's getView() still reads prev there), or whose tick() fires
  // later() timers out of order, early, or after their cancel.
  it("3. FakeStore mirrors onAdopt and later", () => {
    const slice = loadSlice();
    const s0 = snapshotOf(slice, freshState(slice));
    const s1 = snapshotOf(slice, freshState(slice), { stateVersion: 1 });
    const fake = fakeStore(s0);
    feelOf(fake);
    const seen: string[] = [];
    // As the real store: inside an adopt listener the view still reads prev (store test 36).
    fake.onAdopt((e) =>
      seen.push(
        `adopt ${e.prev?.stateVersion} ${e.next.stateVersion} seen ${fake.getView().snapshot?.stateVersion}`,
      ),
    );
    fake.subscribe(() => seen.push(`view ${fake.getView().snapshot!.stateVersion}`));
    const batch = { id: 7, key: "k", actions: [], label: "drawer:iron_ore:buy" };
    let settled: unknown = undefined;
    const off = fake.onAdopt((e) => (settled = e.settled));
    fake.adopt({ next: s1, settled: batch });
    expect(seen).toEqual(["adopt 0 1 seen 0", "view 1"]);
    expect(settled).toBe(batch);
    off();
    fake.adopt({ prev: null, next: s0 });
    expect(seen.at(-2)).toBe("adopt undefined 0 seen 1");
    expect(settled).toBe(batch);

    const fired: string[] = [];
    const t0 = fake.now();
    fake.later(() => fired.push(`b ${fake.now() - t0}`), 300);
    fake.later(() => {
      fired.push(`a ${fake.now() - t0}`);
      fake.later(() => fired.push(`c ${fake.now() - t0}`), 150);
    }, 100);
    const cancel = fake.later(() => fired.push("cancelled"), 200);
    cancel();
    fake.tick(249);
    expect(fired).toEqual(["a 100"]);
    fake.tick(51);
    expect(fired).toEqual(["a 100", "c 250", "b 300"]);
    expect(fake.now() - t0).toBe(300);
  });

  // Catches: feelOf still handing out a stub log, or not feeding it the store's adoptions.
  it("4. the log book is the factory log, fed by the store's adoptions", () => {
    const slice = loadSlice();
    const s0 = snapshotOf(slice, freshState(slice));
    const fake = fakeStore(s0);
    const { log } = feelOf(fake);
    const buy = {
      id: 1,
      key: "k",
      actions: [
        { type: "BUY_MACHINE" as const, lane: "iron", machineClass: "miner", mark: 1, count: 1 },
      ],
      label: "drawer:iron_ore:buy",
    };
    fake.adopt({ next: snapshotOf(slice, freshState(slice), { stateVersion: 1 }), settled: buy });
    expect(log.entries().map((e) => e.key)).toEqual(["buy:1"]);
    // A world change: the next adoption has prev null, and the log empties.
    fake.adopt({ prev: null, next: s0 });
    expect(log.entries()).toEqual([]);
  });
});
