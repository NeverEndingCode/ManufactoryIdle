// @vitest-environment jsdom
// U-7a, U-7b, K-2, K-5, K-7, K-8, K-10, K-21, K-22: the pure key resolver, cell by cell.
import { afterEach, describe, expect, it } from "vitest";
import {
  focusKind,
  hintProbe,
  isRowList,
  KEYMAP,
  resolveKey,
  scopeOf,
  type Command,
  type FocusKind,
  type KeyContext,
  type KeyInput,
  type Resolved,
  type Scope,
} from "./keys.js";
import { ID_LIKE } from "./test-fixtures.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/** A plain keydown of `key`, with `over` on top. */
function ev(key: string, over: Partial<KeyInput> = {}): KeyInput {
  return {
    type: "keydown",
    key,
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: key === "?",
    defaultPrevented: false,
    ...over,
  };
}

/** Rows on screen, advice to explain, an item drawer; `onRows` follows focus at rest. */
function ctx(scope: Scope, focus: FocusKind, over: Partial<KeyContext> = {}): KeyContext {
  return {
    scope,
    focus,
    onRows: focus === "rest",
    view: "factory",
    rows: true,
    advice: true,
    follows: true,
    ...over,
  };
}

const R = (command: Command, preventDefault = true): Resolved => ({ command, preventDefault });
const lane = (n: number, closeDrawer = false) => R({ kind: "lane", n, closeDrawer });
const view = (v: "factory" | "priority" | "handbook", closeDrawer = false, closeCard = false) =>
  R({ kind: "view", view: v, closeDrawer, closeCard });
const move = (to: "next" | "prev" | "first" | "last", follow = false) =>
  R({ kind: "move", to, follow });

/** [rest, control] for each of global, drawer and card. */
type Cells = Record<"global" | "drawer" | "card", readonly [Resolved | null, Resolved | null]>;

const run = R({ kind: "run" });
const why = R({ kind: "why" });
const open = R({ kind: "open" });
const tap = R({ kind: "tap", down: true });
const help = R({ kind: "help" });
const same = (c: Resolved | null): readonly [Resolved | null, Resolved | null] => [c, c];

/** U-7a's table, written out cell by cell (K-8, K-10, K-21, K-22). In the card, F1–F3 and F/P/H
 *  close an open drawer as they do outside it (U-7a, K-10); the digits 2–5 are the global
 *  lane switch, whose drawer follows its lane (closing only when the lane changes). */
const TABLE: Record<string, Cells> = {
  Enter: { global: [run, null], drawer: [run, null], card: [run, null] },
  Tab: { global: [why, null], drawer: [why, null], card: [null, null] },
  "1": { global: same(lane(1)), drawer: same(lane(1, true)), card: same(R({ kind: "runOne" })) },
  "2": { global: same(lane(2)), drawer: same(lane(2, true)), card: same(lane(2)) },
  "3": { global: same(lane(3)), drawer: same(lane(3, true)), card: same(lane(3)) },
  "4": { global: same(lane(4)), drawer: same(lane(4, true)), card: same(lane(4)) },
  "5": { global: same(lane(5)), drawer: same(lane(5, true)), card: same(lane(5)) },
  F1: {
    global: same(view("factory")),
    drawer: same(view("factory", true)),
    card: same(view("factory", true, true)),
  },
  f: {
    global: same(view("factory")),
    drawer: same(view("factory", true)),
    card: same(view("factory", true, true)),
  },
  F2: {
    global: same(view("priority")),
    drawer: same(view("priority", true)),
    card: same(view("priority", true, true)),
  },
  p: {
    global: same(view("priority")),
    drawer: same(view("priority", true)),
    card: same(view("priority", true, true)),
  },
  F3: {
    global: same(view("handbook")),
    drawer: same(view("handbook", true)),
    card: same(view("handbook", true, true)),
  },
  h: {
    global: same(view("handbook")),
    drawer: same(view("handbook", true)),
    card: same(view("handbook", true, true)),
  },
  ArrowUp: { global: same(move("prev")), drawer: same(move("prev", true)), card: same(null) },
  ArrowDown: { global: same(move("next")), drawer: same(move("next", true)), card: same(null) },
  Home: { global: [move("first"), null], drawer: [move("first", true), null], card: same(null) },
  End: { global: [move("last"), null], drawer: [move("last", true), null], card: same(null) },
  ArrowRight: { global: same(open), drawer: same(null), card: same(null) },
  " ": { global: [open, null], drawer: same(null), card: same(null) },
  Escape: { global: same(null), drawer: same(R({ kind: "close" }, false)), card: same(null) },
  t: { global: same(tap), drawer: same(tap), card: same(tap) },
  ...Object.fromEntries(
    (["b", "u", "r", "a", "s", "d"] as const).map((k) => [
      k,
      {
        global: same(null),
        drawer: same(R({ kind: "section", key: k.toUpperCase() as "B" })),
        card: same(null),
      },
    ]),
  ),
  "?": { global: same(help), drawer: same(help), card: same(help) },
  ArrowLeft: { global: same(null), drawer: same(null), card: same(null) },
  x: { global: same(null), drawer: same(null), card: same(null) },
};
const KEYS = Object.keys(TABLE);
const ALL_SCOPES: readonly Scope[] = ["help", "settings", "sheet", "card", "drawer", "global"];

describe("resolveKey", () => {
  // Catches: a wrong cell, e.g. Space resolving on a control, or Esc resolving globally.
  it("1. resolves every cell of U-7a's table, preventDefault included", () => {
    for (const key of KEYS) {
      for (const scope of ["global", "drawer", "card"] as const) {
        const [rest, control] = TABLE[key]![scope];
        expect(resolveKey(ev(key), ctx(scope, "rest")), `${key} ${scope} rest`).toEqual(rest);
        expect(resolveKey(ev(key), ctx(scope, "control")), `${key} ${scope} control`).toEqual(
          control,
        );
      }
    }
  });

  it("1b. honours the context's conditions", () => {
    // No rows on screen: no move, no open.
    for (const key of ["ArrowUp", "ArrowDown", "ArrowRight", " "])
      expect(resolveKey(ev(key), ctx("global", "rest", { rows: false })), key).toBeNull();
    // An arrow control keeps its arrows (U-7a), and Space isn't at rest there.
    for (const key of ["ArrowUp", "ArrowDown", "ArrowRight", " ", "Enter", "Tab"])
      expect(resolveKey(ev(key), ctx("global", "arrows")), key).toBeNull();
    // Nothing to explain: Tab is native (K-22).
    expect(resolveKey(ev("Tab"), ctx("global", "rest", { advice: false }))).toBeNull();
    // Home/End only on the row list itself (K-8).
    expect(resolveKey(ev("Home"), ctx("global", "rest", { onRows: false }))).toBeNull();
    expect(resolveKey(ev("End"), ctx("drawer", "rest", { onRows: false }))).toBeNull();
    // A generator drawer doesn't follow (K-12).
    expect(resolveKey(ev("ArrowDown"), ctx("drawer", "rest", { follows: false }))).toEqual(
      move("next", false),
    );
    expect(resolveKey(ev("End"), ctx("drawer", "rest", { follows: false }))).toEqual(
      move("last", false),
    );
  });

  // Catches: treating `select` as a control (digits would switch lanes mid-select).
  it("2b. with focus typing, every key is null in every scope", () => {
    for (const key of KEYS)
      for (const scope of ALL_SCOPES)
        expect(resolveKey(ev(key), ctx(scope, "typing")), `${key} ${scope}`).toBeNull();
  });

  // Catches: accepting Shift generally (Shift+Tab would be a WCAG 2.1.2 trap).
  it("3. ignores modifiers, composition and handled keys", () => {
    for (const key of KEYS) {
      for (const over of [
        { ctrlKey: true },
        { altKey: true },
        { metaKey: true },
        { isComposing: true },
        { keyCode: 229 },
        { defaultPrevented: true },
      ] satisfies Partial<KeyInput>[]) {
        for (const scope of ["global", "drawer", "card"] as const)
          expect(
            resolveKey(ev(key, over), ctx(scope, "rest")),
            `${key} ${scope} ${JSON.stringify(over)}`,
          ).toBeNull();
      }
    }
    expect(resolveKey(ev("?", { shiftKey: true }), ctx("global", "rest"))).toEqual(help);
    for (const key of ["t", "T", "Enter", "1", "!", "Tab", "ArrowDown", "F1"])
      expect(resolveKey(ev(key, { shiftKey: true }), ctx("global", "rest")), key).toBeNull();
  });

  // Catches: a digit switching lanes behind Settings.
  it("4. settings and the sheet take no keys; help takes only ?", () => {
    for (const key of KEYS) {
      expect(resolveKey(ev(key), ctx("settings", "rest")), key).toBeNull();
      expect(resolveKey(ev(key), ctx("sheet", "rest")), key).toBeNull();
      expect(resolveKey(ev(key), ctx("help", "rest")), key).toEqual(key === "?" ? help : null);
    }
  });

  // Catches: the double buy from a held Enter (Review Focus 2).
  it("5. repeats are ignored except on ↑ and ↓", () => {
    for (const key of ["Enter", "t", "b", "1", "Tab", "?", " ", "ArrowRight", "F1"]) {
      expect(resolveKey(ev(key, { repeat: true }), ctx("drawer", "rest")), key).toBeNull();
      expect(resolveKey(ev(key, { repeat: true }), ctx("global", "rest")), key).toBeNull();
    }
    // A held ? never toggles help back closed.
    expect(resolveKey(ev("?", { repeat: true }), ctx("help", "rest"))).toBeNull();
    expect(resolveKey(ev("ArrowUp", { repeat: true }), ctx("global", "rest"))).toEqual(
      move("prev"),
    );
    expect(resolveKey(ev("ArrowDown", { repeat: true }), ctx("drawer", "rest"))).toEqual(
      move("next", true),
    );
  });

  // Catches: a stuck tap (Review Focus 4).
  it("6. a T keyup releases whatever the modifiers, target or scope", () => {
    const up = R({ kind: "tap", down: false }, false);
    const cases: [Partial<KeyInput>, KeyContext][] = [
      [{ shiftKey: true }, ctx("global", "rest")],
      [{ ctrlKey: true }, ctx("global", "rest")],
      [{ altKey: true, metaKey: true }, ctx("drawer", "control")],
      [{ repeat: true, defaultPrevented: true, isComposing: true }, ctx("card", "rest")],
      [{}, ctx("global", "typing")],
      [{}, ctx("settings", "rest")],
      [{}, ctx("sheet", "rest")],
      [{}, ctx("help", "rest")],
    ];
    for (const key of ["T", "t"])
      for (const [over, c] of cases)
        expect(resolveKey(ev(key, { type: "keyup", ...over }), c), JSON.stringify(over)).toEqual(
          up,
        );
    for (const key of ["Enter", "1", "?", "ArrowDown", "Escape", "b"])
      expect(resolveKey(ev(key, { type: "keyup" }), ctx("drawer", "rest")), key).toBeNull();
  });

  // Catches: the card column's "F/P/H as global" mismatch (K-10).
  it("7. F-keys and their letters agree in every scope and focus", () => {
    const pairs = [
      ["F1", "f", "F"],
      ["F2", "p", "P"],
      ["F3", "h", "H"],
    ] as const;
    for (const scope of ALL_SCOPES)
      for (const focus of ["rest", "control", "arrows", "typing"] as const)
        for (const [fkey, ...letters] of pairs) {
          const want = resolveKey(ev(fkey), ctx(scope, focus));
          for (const l of letters)
            expect(resolveKey(ev(l), ctx(scope, focus)), `${l} ${scope} ${focus}`).toEqual(want);
        }
  });

  it("lowercases letters, so Caps Lock doesn't matter", () => {
    expect(resolveKey(ev("T"), ctx("global", "rest"))).toEqual(tap);
    expect(resolveKey(ev("B"), ctx("drawer", "rest"))).toEqual(R({ kind: "section", key: "B" }));
  });
});

describe("focusKind", () => {
  function el(html: string, sel = "#t"): Element {
    document.body.innerHTML = html;
    return document.querySelector(sel)!;
  }

  // Catches: dropping `range` from typing, or treating `select` as a control.
  it("2. classifies the focused element", () => {
    const typing = [
      ...["text", "search", "email", "number", "range"].map((t) => `<input id="t" type="${t}">`),
      `<input id="t">`,
      `<textarea id="t"></textarea>`,
      `<select id="t"><option>a</option></select>`,
      `<div id="t" contenteditable></div>`,
      `<div id="t" contenteditable="true"></div>`,
      ...["textbox", "searchbox", "combobox", "spinbutton", "slider"].map(
        (r) => `<div id="t" role="${r}" tabindex="0"></div>`,
      ),
    ];
    for (const h of typing) expect(focusKind(el(h)), h).toBe("typing");

    const arrows = [
      `<input id="t" type="radio">`,
      `<div id="t" role="radio" tabindex="0"></div>`,
      `<div role="radiogroup"><button id="t">a</button></div>`,
      `<ul id="t" role="listbox" tabindex="0"><li role="option">a</li></ul>`,
      `<ul role="listbox"><li id="t" role="option" tabindex="0">a</li></ul>`,
    ];
    for (const h of arrows) expect(focusKind(el(h)), h).toBe("arrows");

    expect(focusKind(null)).toBe("rest");
    expect(focusKind(document.body)).toBe("rest");
    expect(focusKind(document.documentElement)).toBe("rest");
    const rest = [
      `<ul id="t" role="listbox" data-rows tabindex="0"><li role="option">a</li></ul>`,
      `<div id="t" data-main-box></div>`,
      `<section id="t" data-command tabindex="-1"><button>run</button></section>`,
    ];
    for (const h of rest) expect(focusKind(el(h)), h).toBe("rest");

    const control = [
      `<button id="t">a</button>`,
      `<a id="t" href="/x">a</a>`,
      `<div id="t" role="tab" tabindex="0"></div>`,
      `<h2 id="t" tabindex="-1">Rotor</h2>`,
      `<section data-command><button id="t">run</button></section>`,
      `<input id="t" type="checkbox">`,
      `<input id="t" type="button">`,
      `<div id="t" contenteditable="false" tabindex="0"></div>`,
    ];
    for (const h of control) expect(focusKind(el(h)), h).toBe("control");
  });

  it("isRowList is the row list only", () => {
    expect(isRowList(null)).toBe(false);
    expect(isRowList(el(`<ul id="t" role="listbox" data-rows></ul>`))).toBe(true);
    expect(isRowList(el(`<ul id="t" role="listbox"></ul>`))).toBe(false);
    expect(isRowList(el(`<ul id="t" data-rows></ul>`))).toBe(false);
  });
});

describe("scopeOf", () => {
  const none = { help: false, settings: false, phone: false, why: false, drawer: false };
  it("8. the topmost scope wins (K-5)", () => {
    expect(scopeOf({ ...none, help: true, settings: true })).toBe("help");
    expect(scopeOf({ ...none, settings: true, why: true })).toBe("settings");
    expect(scopeOf({ ...none, phone: true, drawer: true })).toBe("sheet");
    expect(scopeOf({ ...none, phone: true, why: true })).toBe("sheet");
    expect(scopeOf({ ...none, why: true, drawer: true })).toBe("card");
    expect(scopeOf({ ...none, drawer: true })).toBe("drawer");
    expect(scopeOf(none)).toBe("global");
    expect(scopeOf({ ...none, phone: true })).toBe("global");
  });
});

describe("KEYMAP", () => {
  // Catches: the help overlay advertising a key the resolver doesn't take (K-7).
  it("9. every probe resolves in its row's scope, and every cap is said in words", () => {
    const full: Partial<KeyContext> = { rows: true, advice: true, follows: true, onRows: true };
    let probes = 0;
    for (const row of KEYMAP) {
      for (const cap of row.caps) {
        expect(cap.said.length, cap.shown).toBeGreaterThan(0);
        expect(ID_LIKE.test(cap.said), cap.said).toBe(false);
      }
      expect(ID_LIKE.test(row.does), row.does).toBe(false);
      if (row.byComponent) continue;
      const got = row.probes.map((p) => {
        probes += 1;
        const r = resolveKey(ev(p.key ?? "", p), ctx(row.scope, "rest", full));
        expect(r, `${row.does}: ${p.key}`).not.toBeNull();
        return r;
      });
      // An F-key and its letter on one line are one command (K-10).
      if (got.every((r) => r?.command.kind === "view"))
        for (const r of got) expect(r, row.does).toEqual(got[0]);
    }
    expect(probes).toBeGreaterThan(20);
    for (const scope of ["global", "drawer", "card", "help"] as const)
      expect(KEYMAP.some((r) => r.scope === scope)).toBe(true);
  });
});

describe("hintProbe", () => {
  const keys = (text: string) => hintProbe(text).map((h) => h.probe.key);

  it("10. maps each rendered hint to its probes", () => {
    for (const [text, key] of [
      ["[ENTER]", "Enter"],
      ["[TAB]", "Tab"],
      ["[T]", "t"],
      ["[1]", "1"],
      ["F1", "F1"],
      ["F2", "F2"],
      ["F3", "F3"],
      ["1", "1"],
      ["2", "2"],
      ["3", "3"],
      ["4", "4"],
      ["5", "5"],
      ["[B]", "b"],
      ["[U]", "u"],
      ["[R]", "r"],
      ["[A]", "a"],
      ["[S]", "s"],
      ["[D]", "d"],
      ["[H]", "h"],
    ] as const) {
      const got = hintProbe(text);
      expect(got, text).toHaveLength(1);
      expect(got[0]!.probe.key, text).toBe(key);
      expect(got[0]!.byComponent, text).toBe(false);
    }
    expect(hintProbe("[↑↓] row  [ESC] close")).toEqual([
      { probe: { key: "ArrowUp" }, byComponent: false },
      { probe: { key: "ArrowDown" }, byComponent: false },
      { probe: { key: "Escape" }, byComponent: true },
    ]);
    expect(hintProbe("[ESC]")).toEqual([{ probe: { key: "Escape" }, byComponent: true }]);
    expect(keys("  [ENTER] ")).toEqual(["Enter"]);
    expect(() => hintProbe("[Q]")).toThrow();
    expect(() => hintProbe("why")).toThrow();
    expect(() => hintProbe("[ENTER] [Q]")).toThrow();
  });

  // Catches: the help overlay showing a cap the hint test can't read (a real hint would throw).
  it("10b. reads every cap KEYMAP shows, and each resolves in its row's scope", () => {
    const full: Partial<KeyContext> = { rows: true, advice: true, follows: true, onRows: true };
    for (const row of KEYMAP)
      for (const cap of row.caps) {
        const got = hintProbe(cap.shown);
        expect(got.length, cap.shown).toBeGreaterThan(0);
        // Esc is the dialog's own; a row with no probes is native (the card's Tab).
        if (row.byComponent || row.probes.length === 0) continue;
        for (const { probe, byComponent } of got) {
          if (byComponent) continue;
          const r = resolveKey(ev(probe.key ?? "", probe), ctx(row.scope, "rest", full));
          expect(r, `${row.scope} ${cap.shown}`).not.toBeNull();
        }
      }
    expect(keys("[1]–[5]")).toEqual(["1", "5"]);
    expect(keys("[→] [SPACE] [HOME] [END]")).toEqual(["ArrowRight", " ", "Home", "End"]);
    expect(keys("[F] [P] [H] [?]")).toEqual(["f", "p", "h", "?"]);
  });
});
