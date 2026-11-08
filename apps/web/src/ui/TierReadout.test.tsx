// @vitest-environment jsdom
// Q-13 / V-24: the header's tier readout. Ticking numbers, never a live region.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { D, format, type ItemId } from "@manufactory/engine";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { shownStock } from "../sync/interpolate.js";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import { declarations } from "../styles/css-walk.js";
import {
  fakeStore,
  fixtureState,
  freshState,
  loadSlice,
  snapshotOf,
  spokenIds,
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
/** The readout as seen; in terminal it's aria-hidden beside the words a reader hears. */
const shown = () => readout().querySelector<HTMLElement>("[data-shown]")!;
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
    expect(shown().textContent).toBe(`[TIER 8] next: ${a} · ${b}`);
    // The full text is the title: the tablet ellipsizes it (U-2c). It's on the seen part, which
    // is aria-hidden in terminal (U-1h).
    expect(shown().getAttribute("title")).toBe(shown().textContent);
    expect(readout().getAttribute("title")).toBeNull();
    for (const [id] of REQS) {
      expect(readout().querySelector(`[data-requirement="${id}"]`)!.textContent).toContain(
        id.toUpperCase(),
      );
    }
    // Never a live region.
    expect(readout().closest("[aria-live]")).toBeNull();
  });

  // Catches: SMART_PLATING or the like in the readout's text or title reaching a reader (U-1h).
  it("U-1h. terminal: a reader hears the content names, desktop and phone", () => {
    const store = fakeStore(tier8);
    const r = withTicks(store, <TierReadout snapshot={tier8} now={store.now} />);
    expect(shown().textContent).toContain("SMART_PLATING");
    expect(shown().getAttribute("aria-hidden")).toBe("true");
    const said = readout().querySelector(".visually-hidden")!.textContent!;
    expect(said).toMatch(/^Tier 8 · next: /);
    expect(said).toContain(slice.content.items.get("smart_plating")!.name);
    expect(spokenIds(readout())).toEqual([]);
    r.unmount();
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} phone />);
    expect(spokenIds(readout())).toEqual([]);
  });

  it("8b. the plain voice: Tier 8 · next: Name n/m · Name n/m", () => {
    act(() => void setTheme("clean-dark"));
    const store = fakeStore(tier8);
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} />);
    const [a, b] = REQS.map(
      ([id, amount]) =>
        `${slice.content.items.get(id)!.name} ${progress(tier8, store, id, amount)}`,
    );
    expect(shown().textContent).toBe(`Tier 8 · next: ${a} · ${b}`);
  });

  it("8c. tier 10 is complete, in each voice", () => {
    const s = snapshotOf(slice, { ...freshState(slice), tier: 10 });
    const store = fakeStore(s);
    withTicks(store, <TierReadout snapshot={s} now={store.now} />);
    expect(shown().textContent).toBe("[TIER 10] complete");
    act(() => void setTheme("clean-light"));
    expect(shown().textContent).toBe("Tier 10 · complete");
  });

  it("8d. the phone shows one requirement, the furthest from done", () => {
    const store = fakeStore(tier8);
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} phone />);
    const at = serverNow(tier8, store.now());
    const ratio = ([id, amount]: (typeof REQS)[number]) =>
      shownStock(tier8, id, at).toNumber() / amount;
    const lowest = [...REQS].sort((x, y) => ratio(x) - ratio(y))[0]!;
    expect(shown().textContent).toBe(
      `[TIER 8] ${lowest[0].toUpperCase()} ${progress(tier8, store, lowest[0], lowest[1])}`,
    );
    expect(readout().querySelectorAll("[data-requirement]")).toHaveLength(1);
    act(() => void setTheme("clean-dark"));
    expect(shown().textContent).toBe(
      `Tier 8 · ${slice.content.items.get(lowest[0])!.name} ${progress(tier8, store, lowest[0], lowest[1])}`,
    );
  });

  // jsdom lays nothing out, so this pins the CSS. In the phone's readouts box (a column aligned
  // to the end) an item is as wide as its one unbroken line, so without a cap the readout ran
  // out of its box over the title at tier 1 (`[TIER 1] REINFORCED_IRON_PLATE 0/500`) instead of
  // ellipsizing. Catches: the cap gone.
  it("8e. on the phone the readout is capped to its box; only the name ellipsizes", () => {
    const store = fakeStore(tier8);
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} phone />);
    // A variable, so Vite leaves the URL alone (it rewrites new URL("./literal", import.meta.url)).
    const file = "../styles/base.css";
    const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    const rule = (sel: string) =>
      Object.fromEntries(
        declarations(file, text)
          .filter((d) => d.stack.join(" > ") === sel)
          .map((d) => [d.property, d.value]),
      );
    expect(rule('.app[data-layout="phone"] .tier-readout')["max-width"]).toBe("100%");
    // Only the name gives way: the tier and the numbers always show (expectNoOverflow at 320).
    // The name asks for no width of its own (width 0), grows into what's left up to its length.
    expect(rule('.app[data-layout="phone"] .tier-readout [data-shown]').display).toBe("flex");
    expect(rule('.app[data-layout="phone"] .tier-readout [data-requirement]').display).toBe(
      "contents",
    );
    const name = rule('.app[data-layout="phone"] .tier-readout .req-name');
    expect(name.width).toBe("0");
    expect(name.flex).toBe("1 1 0");
    expect(name["max-width"]).toBe("max-content");
    expect(name.overflow).toBe("hidden");
    expect(name["text-overflow"]).toBe("ellipsis");
    expect(
      rule(
        '.app[data-layout="phone"] .tier-readout .req-lead, .app[data-layout="phone"] .tier-readout .num',
      ).flex,
    ).toBe("none");
    const req = readout().querySelector("[data-requirement]");
    expect(req?.querySelector(".req-name")).not.toBeNull();
    const base = rule(".tier-readout");
    expect(base.overflow).toBe("hidden");
    expect(base["text-overflow"]).toBe("ellipsis");
    expect(base["white-space"]).toBe("nowrap");
  });

  // The phone header's priority (jsdom lays nothing out, so the CSS is pinned): the readout's
  // tier and numbers never give way (the slot's automatic minimum, the name asking for none);
  // then the title, which ellipsizes rather than being cut mid-letter; the slot takes the rest,
  // which the name grows into. Catches: the title clipped with no ellipsis, or sharing the
  // shrink evenly with the readout (MANUFACTO beside an item name cut to "I…").
  it("8f. the phone header: tier and numbers first, then the title, then the name", () => {
    const store = fakeStore(tier8);
    withTicks(store, <TierReadout snapshot={tier8} now={store.now} phone />);
    const rules = (file: string) => {
      const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      return (sel: string) =>
        Object.fromEntries(
          declarations(file, text)
            .filter((d) => d.stack.join(" > ") === sel)
            .map((d) => [d.property, d.value]),
        );
    };
    // Variables, so Vite leaves the URLs alone.
    const shellCss = "./Shell.module.css";
    const baseCss = "../styles/base.css";
    const title = rules(shellCss)(".phoneHeader .title");
    expect(title.overflow).toBe("hidden");
    expect(title["text-overflow"]).toBe("ellipsis");
    expect(title["min-width"]).toBe("0");
    const slot = rules(shellCss)(".phoneHeader .tierSlot");
    expect(slot.flex).toBe("1 1 auto");
    expect(slot["min-width"]).toBe("auto");
    const box = rules(shellCss)(".readouts");
    expect(box.flex).toBe("1 1 auto");
    expect(box["min-width"]).toBeUndefined();
    expect(rules(baseCss)('.app[data-layout="phone"] .tier-readout')["align-self"]).toBe("stretch");
    expect(
      rules(baseCss)(
        '.app[data-layout="phone"] .tier-readout .req-lead, .app[data-layout="phone"] .tier-readout .num',
      ).flex,
    ).toBe("none");
    const lead = readout().querySelector("[data-shown] > .req-lead");
    expect(lead?.textContent).toBe("[TIER 8] ");
  });
});
