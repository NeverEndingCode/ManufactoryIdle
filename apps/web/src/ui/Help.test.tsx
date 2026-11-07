// @vitest-environment jsdom
// U-7e / K-1 / K-5 / K-6: the `?` help overlay, built from KEYMAP, modal, and ending with the GPL
// line. Every key event is fired on the focused element (or <body>) so it bubbles to the
// document listener, as in the browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { declarations } from "../styles/css-walk.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { GameStore } from "../sync/store.js";
import { App } from "./App.js";
import { NOTICE_CONTROLS } from "./dialog.js";
import { KEYMAP } from "./keys.js";
import { currentBuildInfo, sourceLinks } from "./source-link.js";
import { setTheme } from "./theme.js";
import {
  CLIENT_T0,
  fakeStore,
  freshState,
  loadSlice,
  snapshotOf,
  spokenIds,
  stubWidth,
  type FakeStore,
} from "./test-fixtures.js";

let fresh: Snapshot;
beforeAll(() => {
  const slice = loadSlice();
  fresh = snapshotOf(slice, freshState(slice));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  act(() => {
    setTheme("terminal");
  });
  localStorage.clear();
  history.replaceState(null, "", "/");
});

/** A topped fresh world: the advised run is affordable. */
const topped = () => fakeStore(fresh, { now: CLIENT_T0 + 60_000 });

function mount(store: FakeStore, width = 1280) {
  stubWidth(width);
  return render(<App store={store as unknown as GameStore} />);
}

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const help = () => q("[data-help]");
const host = () => q("[data-help-host]");
const listbox = () => q<HTMLUListElement>('ul[role="listbox"][data-rows]')!;
const focus = (el: HTMLElement) => act(() => el.focus());
const toBody = () => act(() => (document.activeElement as HTMLElement | null)?.blur());
/** keydown on the focused element; true when nothing called preventDefault. */
const key = (k: string, over: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...over });
const question = () => key("?", { shiftKey: true });
const modals = () => document.querySelectorAll('[aria-modal="true"]').length;

/** What a screen reader hears inside `el`: its text outside aria-hidden. */
function heard(el: Element): string {
  let out = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n.parentElement?.closest('[aria-hidden="true"]') == null) out += n.textContent ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

const z = (file: string, selector: string) => {
  const path = fileURLToPath(new URL(file, import.meta.url));
  const decl = declarations(file, readFileSync(path, "utf8")).find(
    (x) => x.stack.at(-1) === selector && x.property === "z-index",
  );
  expect(decl, `${file} ${selector}`).toBeDefined();
  return Number(decl!.value);
};

describe("the help overlay (U-7e)", { timeout: 60_000 }, () => {
  // Catches: a help action left unwired (the dispatcher's no-op), or an overlay that isn't modal.
  it("1. ? at rest opens it, modal, focus on its title", () => {
    mount(fakeStore(fresh));
    expect(help()).toBeNull();
    expect(question()).toBe(false);
    const d = help()!;
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.closest("[data-help-host]")).not.toBeNull();
    expect(document.activeElement).toBe(d.querySelector("h2"));
  });

  // Catches: a header button that isn't wired, or one on the phone (K-17).
  it("1. the header's ? button opens it too; the phone has none", () => {
    mount(fakeStore(fresh));
    const b = q<HTMLButtonElement>("[data-open-help]")!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("aria-haspopup")).toBe("dialog");
    expect(b.getAttribute("aria-label")).toBe("Keyboard shortcuts");
    expect(b.textContent).toBe("?");
    fireEvent.click(b);
    expect(help()).not.toBeNull();
    cleanup();

    mount(fakeStore(fresh), 800);
    expect(q("[data-open-help]")).not.toBeNull();
    cleanup();

    mount(fakeStore(fresh), 375);
    expect(q("[data-open-help]")).toBeNull();
  });

  // Catches: ? taken while typing (K-2).
  it("1. ? typed into the handbook search doesn't open it", async () => {
    const user = userEvent.setup();
    mount(fakeStore(fresh));
    key("F3");
    const search = q<HTMLInputElement>("[data-handbook-search]")!;
    await user.click(search);
    await user.keyboard("?");
    expect(search.value).toBe("?");
    expect(help()).toBeNull();
  });

  // Catches: a hand-written table drifting from the real map (K-7), caps read aloud as
  // "[ENTER]" rather than "Enter", and ids in what a reader hears (K-1).
  it("2. the content is KEYMAP, spoken as names, ending with the GPL line", () => {
    mount(fakeStore(fresh));
    question();
    const d = help()!;
    const text = d.textContent ?? "";
    for (const row of KEYMAP) expect(text, row.does).toContain(row.does);
    expect(text).toContain("F1–F3 may be taken by your browser or OS: F, P and H always work");

    // One section per scope, each a dl of the rows with keys.
    const sections = d.querySelectorAll("section");
    expect(sections).toHaveLength(4);
    const dts = [...d.querySelectorAll("dl > dt")];
    const keyed = KEYMAP.filter((r) => r.caps.length > 0);
    expect(dts).toHaveLength(keyed.length);
    dts.forEach((dt, i) => {
      const row = keyed[i]!;
      expect(heard(dt), row.does).toBe(row.caps.map((c) => c.said).join(" or "));
      expect(dt.nextElementSibling?.tagName).toBe("DD");
      expect(dt.nextElementSibling?.textContent).toBe(row.does);
    });

    // K-1: under terminal, nothing a reader hears looks like an id, and the name is plain.
    expect(spokenIds(d)).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBe(d);
    expect(d.querySelector("h2")!.textContent).toContain("man manufactory");

    // U-2e: the same links as About.
    const links = sourceLinks(currentBuildInfo());
    const last = d.querySelector("[data-gpl]")!;
    expect(last.textContent).toContain("Free software under the GPL-3.0");
    expect([...last.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"))).toEqual([
      links.source.href,
      links.license.href,
    ]);
    expect(last.textContent).toContain(links.source.text);
  });

  it("2. the plain voice titles it Keyboard shortcuts", () => {
    act(() => {
      setTheme("clean-dark");
    });
    mount(fakeStore(fresh));
    question();
    expect(help()!.querySelector("h2")!.textContent).toBe("Keyboard shortcuts");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBe(help());
  });

  // Catches: a modal the inert pass doesn't find (K-5), and a muted live region (W-20).
  it("3. everything outside is inert but the region; its controls are", () => {
    const store = fakeStore(fresh);
    mount(store);
    act(() => store.set({ notices: [{ kind: "rejected", text: "That didn't go through." }] }));
    question();
    expect(host()!.closest("[inert]")).toBeNull();
    expect(q("header")!.closest("[inert]")).not.toBeNull();
    expect(q("[data-open-help]")!.closest("[inert]")).not.toBeNull();
    expect(listbox().closest("[inert]")).not.toBeNull();
    const region = q(".notices")!;
    expect(region.closest("[inert]")).toBeNull();
    const controls = [...region.querySelectorAll(NOTICE_CONTROLS)];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c.closest("[inert]")).not.toBeNull();

    key("Escape");
    expect(help()).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("3. Tab and Shift+Tab wrap inside it", () => {
    mount(fakeStore(fresh));
    question();
    const d = help()!;
    const tabbable = [...d.querySelectorAll<HTMLElement>("button, a[href]")];
    expect(tabbable.length).toBeGreaterThan(1);
    const first = tabbable[0]!;
    const last = tabbable.at(-1)!;
    focus(last);
    expect(key("Tab")).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(key("Tab", { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  // Catches: a help scope that lets the global keys through behind it.
  it("3. 1, 5 and Enter do nothing while it's open", () => {
    const store = topped();
    mount(store);
    question();
    expect(key("5")).toBe(true);
    expect(key("1")).toBe(true);
    expect(key("Enter")).toBe(true);
    expect(q("[data-power-panel]")).toBeNull();
    expect(store.send).not.toHaveBeenCalled();
    expect(help()).not.toBeNull();
    toBody();
    expect(key("Enter")).toBe(true);
    expect(store.send).not.toHaveBeenCalled();
  });

  // Catches: a modal with no way out (Review Focus 4).
  it("3. Esc, ?, Close and the backdrop each close it", () => {
    mount(fakeStore(fresh));
    const closes: [string, () => void][] = [
      ["Esc", () => key("Escape")],
      ["Esc from <body>", () => (toBody(), key("Escape"))],
      ["?", () => question()],
      ["Close", () => fireEvent.click(within(help()!).getByRole("button", { name: "Close" }))],
      ["backdrop", () => fireEvent.mouseDown(host()!)],
    ];
    for (const [name, close] of closes) {
      toBody();
      question();
      expect(help(), name).not.toBeNull();
      close();
      expect(help(), name).toBeNull();
      expect(document.querySelector("[inert]"), name).toBeNull();
    }
    // A mousedown inside the panel isn't the backdrop's.
    question();
    fireEvent.mouseDown(help()!);
    expect(help()).not.toBeNull();
    expect(question()).toBe(false);
    expect(help()).toBeNull();
    // A held ? never toggles it back.
    question();
    key("?", { shiftKey: true, repeat: true });
    expect(help()).not.toBeNull();
  });

  // Catches: focus dropped to <body> on close, or a keyboard opener lost (K-6).
  it("3. focus returns: to the ? button after a click, to the row list after a key from <body>", () => {
    mount(fakeStore(fresh));
    const b = q<HTMLButtonElement>("[data-open-help]")!;
    fireEvent.click(b);
    key("Escape");
    expect(document.activeElement).toBe(b);

    toBody();
    question();
    expect(document.activeElement).toBe(help()!.querySelector("h2"));
    question();
    expect(document.activeElement).toBe(listbox());

    // From a focused control, back to that control.
    const tab = document.getElementById("lane-tab-iron")!;
    focus(tab);
    question();
    fireEvent.click(within(help()!).getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(tab);

    // Off the factory view, from <body>, nowhere to return: focus stays on <body>.
    key("F2");
    toBody();
    question();
    key("Escape");
    expect(document.activeElement).toBe(document.body);
  });

  // Catches: two modals stacked (K-5), from any scope.
  it("4. opening it from each scope leaves exactly one modal", () => {
    mount(topped());
    question();
    expect(modals()).toBe(1);
    key("Escape");

    // The drawer.
    fireEvent.click(q('li[role="option"][data-item="iron_ore"]')!);
    expect(q("[data-drawer]")).not.toBeNull();
    question();
    expect(help()).not.toBeNull();
    expect(modals()).toBe(1);
    key("Escape");
    key("Escape");
    expect(q("[data-drawer]")).toBeNull();

    // The card.
    toBody();
    key("Tab");
    expect(q("[data-next-buy]")).not.toBeNull();
    question();
    expect(help()).not.toBeNull();
    expect(modals()).toBe(1);
    key("Escape");

    // Settings: the help can't open over it.
    toBody();
    fireEvent.click(q("[data-open-settings]")!);
    expect(question()).toBe(true);
    expect(help()).toBeNull();
    expect(modals()).toBe(1);
    key("Escape");
    cleanup();

    // The phone: ? opens it at rest, but not over the modal NEXT_BUY sheet.
    mount(topped(), 375);
    question();
    expect(help()).not.toBeNull();
    expect(modals()).toBe(1);
    key("Escape");
    fireEvent.click(q("[data-why]")!);
    expect(q("[data-next-buy-host]")).not.toBeNull();
    expect(question()).toBe(true);
    expect(help()).toBeNull();
    expect(modals()).toBe(1);
  });

  // The stack (K-3): help over every other layer; on the --s2 fill, policed by contrast.test.
  it("5. it sits above Settings, the NEXT_BUY sheet and the phone notices, on --s2", () => {
    const top = z("./Help.module.css", ".backdrop");
    expect(top).toBe(55);
    expect(top).toBeGreaterThan(z("./Settings.module.css", ".backdrop"));
    expect(top).toBeGreaterThan(z("./NextBuy.module.css", ".backdrop"));
    expect(top).toBeGreaterThan(z("../styles/base.css", '.app[data-layout="phone"] .notices'));
    const file = "./Help.module.css";
    const path = fileURLToPath(new URL(file, import.meta.url));
    const panel = declarations(file, readFileSync(path, "utf8")).filter(
      (x) => x.stack.at(-1) === ".help",
    );
    expect(panel.find((x) => x.property === "background")?.value).toBe("var(--s2)");
    expect(panel.find((x) => x.property === "z-index")).toBeUndefined();
  });
});
