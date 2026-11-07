// @vitest-environment jsdom
// V-12: one inert pass for every modal; the live region is never inert, its controls are.
import { afterEach, describe, expect, it } from "vitest";
import { inertOutside, MODAL_HOSTS, openModal, trapTab } from "./dialog.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/** app > [header, content > [main, region > [button], card]] */
function tree() {
  document.body.innerHTML = `
    <div id="app">
      <header id="header"><button>cfg</button></header>
      <div id="content">
        <div id="main"><button>row</button></div>
        <div id="region" role="status"><button id="dismiss">Dismiss</button></div>
        <div id="card"><button id="inside">ok</button></div>
      </div>
    </div>`;
  const $ = (id: string) => document.getElementById(id)!;
  return {
    app: $("app"),
    header: $("header"),
    content: $("content"),
    main: $("main"),
    region: $("region"),
    dismiss: $("dismiss"),
    card: $("card"),
    inside: $("inside"),
  };
}

describe("inertOutside (V-12)", () => {
  it("6. inerts what holds neither the kept nor the region; the region's controls only", () => {
    const t = tree();
    const undo = inertOutside(t.app, [t.card], t.region);
    expect(t.header.hasAttribute("inert")).toBe(true);
    expect(t.main.hasAttribute("inert")).toBe(true);
    expect(t.content.hasAttribute("inert")).toBe(false);
    expect(t.region.hasAttribute("inert")).toBe(false);
    expect(t.region.closest("[inert]")).toBeNull();
    expect(t.dismiss.hasAttribute("inert")).toBe(true);
    expect(t.card.closest("[inert]")).toBeNull();
    expect(t.inside.hasAttribute("inert")).toBe(false);
    undo();
    expect(t.app.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("6b. without a region, and leaves an inert it didn't set alone", () => {
    const t = tree();
    t.main.setAttribute("inert", "");
    const undo = inertOutside(t.app, [t.card], null);
    expect(t.region.hasAttribute("inert")).toBe(true);
    undo();
    expect(t.main.hasAttribute("inert")).toBe(true);
    expect(t.region.hasAttribute("inert")).toBe(false);
  });
});

describe("trapTab", () => {
  it("wraps Tab past the last control to the first, and Shift+Tab before the first to the last", () => {
    document.body.innerHTML = `<div id="d"><button id="a">a</button><button id="b">b</button></div>`;
    const d = document.getElementById("d")!;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    b.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    trapTab(tab, d);
    expect(document.activeElement).toBe(a);
    expect(tab.defaultPrevented).toBe(true);
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    trapTab(back, d);
    expect(document.activeElement).toBe(b);
    const mid = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    trapTab(mid, d);
    expect(mid.defaultPrevented).toBe(false);
  });
});

// K-5: one modal at a time, and the inert pass finds whichever it is.
// Catches: an order that lets the NEXT_BUY sheet or help win over Settings, or a host left out.
describe("openModal (K-5)", () => {
  it("picks Settings over help over the NEXT_BUY sheet, and null with none open", () => {
    document.body.innerHTML = `
      <div id="app">
        <div data-next-buy-host id="sheet"></div>
        <div data-help-host id="help"></div>
        <div><div data-settings-host id="settings"></div></div>
      </div>`;
    const app = document.getElementById("app")!;
    const $ = (id: string) => document.getElementById(id)!;
    expect(MODAL_HOSTS.slice(0, 3)).toEqual([
      "[data-settings-host]",
      "[data-help-host]",
      "[data-next-buy-host]",
    ]);
    expect(openModal(app)).toBe($("settings"));
    $("settings").remove();
    expect(openModal(app)).toBe($("help"));
    $("help").remove();
    expect(openModal(app)).toBe($("sheet"));
    $("sheet").remove();
    expect(openModal(app)).toBeNull();
  });
});
