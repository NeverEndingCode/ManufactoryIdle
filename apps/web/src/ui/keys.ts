// U-7a, U-7b, K-2, K-5, K-7, K-8, K-10, K-21, K-22: the keyboard map, as one pure resolver.
// No React and no listeners: the dispatcher (use-keyboard) builds the context and acts on the
// command. KEYMAP is the help overlay's source, and keys.test resolves every probe in it.

export type Scope = "help" | "settings" | "sheet" | "card" | "drawer" | "global";
export type FocusKind = "rest" | "typing" | "arrows" | "control";
export type ViewName = "factory" | "priority" | "handbook" | "power";
export type SectionKey = "B" | "U" | "R" | "A" | "S" | "D";
export type RowMove = "next" | "prev" | "first" | "last";

export interface KeyInput {
  type: "keydown" | "keyup";
  key: string;
  repeat: boolean;
  isComposing: boolean;
  keyCode?: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

export interface KeyContext {
  scope: Scope;
  focus: FocusKind;
  /** Focus is the row list itself (Home/End, K-8). */
  onRows: boolean;
  view: ViewName;
  /** A row list is on screen: the factory view (any lane, power's FUEL included) or the phone power view. */
  rows: boolean;
  /** [data-why] exists: there's advice to explain (K-22). */
  advice: boolean;
  /** The open drawer is an item drawer, so ↑/↓ re-key it (U-5a); false for a generator drawer (K-12). */
  follows: boolean;
}

export type Command =
  | { kind: "run" } // click [data-command] [data-run] (K-4, K-21)
  | { kind: "runOne" } // click [data-next-buy] [data-run-one]
  | { kind: "why" } // open the card / phone sheet (K-6 opener)
  | { kind: "lane"; n: number; closeDrawer: boolean } // 1-based position in laneTabs; to the factory view
  | {
      kind: "view";
      view: "factory" | "priority" | "handbook";
      closeDrawer: boolean;
      closeCard: boolean;
    }
  | { kind: "move"; to: RowMove; follow: boolean }
  | { kind: "open" } // the selected row's drawer
  | { kind: "close" } // the drawer; focus to its opener (U-7c)
  | { kind: "section"; key: SectionKey } // click [data-drawer] [data-key=K]
  | { kind: "tap"; down: boolean }
  | { kind: "help" }; // toggle the overlay

export interface Resolved {
  command: Command;
  preventDefault: boolean;
}

const taken = (command: Command): Resolved => ({ command, preventDefault: true });

const VIEWS = {
  f1: "factory",
  f: "factory",
  f2: "priority",
  p: "priority",
  f3: "handbook",
  h: "handbook",
} as const;

const SECTIONS: Record<string, SectionKey> = { b: "B", u: "U", r: "R", a: "A", s: "S", d: "D" };

/** U-7a's table. Evaluated in order: the release, the ignored keydowns, the modal scopes, then the keys. */
export function resolveKey(e: KeyInput, ctx: KeyContext): Resolved | null {
  // 1. The T release, whatever the modifiers, the target or the scope (K-2).
  if (e.type === "keyup") {
    return e.key === "t" || e.key === "T"
      ? { command: { kind: "tap", down: false }, preventDefault: false }
      : null;
  }
  // 2. Never steal a key (K-2).
  if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return null;
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (ctx.focus === "typing") return null;
  // 3. Modal scopes take no keys; their own Esc closes them.
  if (ctx.scope === "settings" || ctx.scope === "sheet") return null;
  // 4. Help takes only ? (its own Esc closes it). A held ? never toggles it back.
  if (ctx.scope === "help") return e.key === "?" && !e.repeat ? taken({ kind: "help" }) : null;
  // 5. A held key never acts twice, except ↑ and ↓ walking the rows.
  if (e.repeat && e.key !== "ArrowUp" && e.key !== "ArrowDown") return null;
  // 6. Letters ignore Caps Lock; Shift is for ? only, so Shift+Tab is never taken.
  if (e.shiftKey && e.key !== "?") return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  const { scope, focus } = ctx;
  const rest = focus === "rest";
  const card = scope === "card";
  const drawer = scope === "drawer";
  const arrowsFree = ctx.rows && focus !== "arrows";
  const follow = drawer && ctx.follows;

  // 7. The keys.
  switch (key) {
    case "Enter":
      return rest ? taken({ kind: "run" }) : null;
    case "Tab":
      return !card && rest && ctx.advice ? taken({ kind: "why" }) : null;
    case "1":
    case "2":
    case "3":
    case "4":
    case "5": {
      const n = Number(key);
      if (card && n === 1) return taken({ kind: "runOne" });
      return taken({ kind: "lane", n, closeDrawer: drawer });
    }
    case "F1":
    case "f":
    case "F2":
    case "p":
    case "F3":
    case "h":
      return taken({
        kind: "view",
        view: VIEWS[key.toLowerCase() as keyof typeof VIEWS],
        // In the card too: F-keys close an open drawer (U-7a), and F/P/H agree with them (K-10).
        closeDrawer: drawer || card,
        closeCard: card,
      });
    case "ArrowUp":
    case "ArrowDown":
      return !card && arrowsFree
        ? taken({ kind: "move", to: key === "ArrowUp" ? "prev" : "next", follow })
        : null;
    case "Home":
    case "End":
      return !card && ctx.onRows
        ? taken({ kind: "move", to: key === "Home" ? "first" : "last", follow })
        : null;
    case "ArrowRight":
      return scope === "global" && arrowsFree ? taken({ kind: "open" }) : null;
    case " ":
      return scope === "global" && ctx.rows && rest ? taken({ kind: "open" }) : null;
    case "Escape":
      return drawer ? { command: { kind: "close" }, preventDefault: false } : null;
    case "t":
      return taken({ kind: "tap", down: true });
    case "b":
    case "u":
    case "r":
    case "a":
    case "s":
    case "d":
      return drawer ? taken({ kind: "section", key: SECTIONS[key]! }) : null;
    case "?":
      return taken({ kind: "help" });
    default:
      return null;
  }
}

const TYPING_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const NON_TYPING_INPUTS = new Set(["radio", "checkbox", "button", "submit", "reset"]);

/** The row list: ul[role=listbox][data-rows]. */
export function isRowList(el: Element | null): boolean {
  return el !== null && el.matches('ul[role="listbox"][data-rows]');
}

/** The focused element's kind (K-2, U-7b). null, <html> and <body> are "rest". */
export function focusKind(el: Element | null): FocusKind {
  if (el === null) return "rest";
  const tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "body") return "rest";
  const role = el.getAttribute("role");
  const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : null;

  // Typing (K-2): a range counts, as U-7a's "slider" says.
  if (type !== null && !NON_TYPING_INPUTS.has(type)) return "typing";
  if (tag === "textarea" || tag === "select") return "typing";
  const editable = el.closest("[contenteditable]");
  if (editable !== null && editable.getAttribute("contenteditable") !== "false") return "typing";
  if (role !== null && TYPING_ROLES.has(role)) return "typing";

  // At rest (U-7b, K-18): the row list, the main box, the command bar's section itself.
  if (isRowList(el) || el.matches("[data-main-box], [data-command]")) return "rest";

  // L-9: the factory log scrolls natively under ↑/↓ (K-18 amended for this region only), and
  // Enter there runs nothing, since the focus isn't at rest.
  if (el.closest("[data-factory-log]") !== null) return "arrows";

  // Controls that use arrows (U-7a): a radio, a listbox other than the row list.
  if (type === "radio" || role === "radio" || el.closest('[role="radiogroup"]') !== null) {
    return "arrows";
  }
  const listbox = el.closest('[role="listbox"]');
  if (listbox !== null && !isRowList(listbox)) return "arrows";

  return "control";
}

/** help > settings > (log, or phone && (why || drawer) → sheet) > why → card > drawer > global
 * (K-5). L-11: the log sheet is always modal, on the phone and on a short tablet (L-10). */
export function scopeOf(open: {
  help: boolean;
  settings: boolean;
  phone: boolean;
  why: boolean;
  drawer: boolean;
  log: boolean;
}): Scope {
  if (open.help) return "help";
  if (open.settings) return "settings";
  if (open.log || (open.phone && (open.why || open.drawer))) return "sheet";
  if (open.why) return "card";
  if (open.drawer) return "drawer";
  return "global";
}

/** One help line (K-7): what it shows, what a reader hears, and the events that must resolve. */
export interface KeyRow {
  scope: "global" | "drawer" | "card" | "help";
  caps: readonly { shown: string; said: string }[]; // [{ shown: "[ENTER]", said: "Enter" }]
  does: string; // plain words, no ids (K-1)
  probes: readonly Partial<KeyInput>[];
  /** Esc: handled by the dialog's own onKeyDown, not by resolveKey. */
  byComponent?: true;
}

const ENTER = { shown: "[ENTER]", said: "Enter" };
const TAB = { shown: "[TAB]", said: "Tab" };
const ESC = { shown: "[ESC]", said: "Escape" };
const ARROWS = { shown: "[↑↓]", said: "Up or down arrow" };
const DIGITS = { shown: "[1]–[5]", said: "1 to 5" };
const QUESTION = { shown: "[?]", said: "Question mark" };
const k = (key: string): Partial<KeyInput> => ({ key });
const LANES = ["1", "2", "3", "4", "5"].map(k);
const SHIFTED_QUESTION: Partial<KeyInput> = { key: "?", shiftKey: true };

/** The help overlay's lines (U-7e), grouped by scope. Rows with no probes are prose rules. */
export const KEYMAP: readonly KeyRow[] = [
  // Global.
  {
    scope: "global",
    caps: [],
    does: "At rest means nothing is focused, or the row list, the main box or the command line is. On a button, link or tab, Enter and Space do what that control does.",
    probes: [],
  },
  {
    scope: "global",
    caps: [],
    does: "No shortcut works while you type in a field, or with Ctrl, Alt or Meta held.",
    probes: [],
  },
  {
    scope: "global",
    caps: [ENTER],
    does: "Run the advice, when focus is at rest.",
    probes: [k("Enter")],
  },
  {
    scope: "global",
    caps: [TAB],
    does: "Open why, when focus is at rest and there's advice to explain. The next Tab moves on through it. Shift+Tab is never taken.",
    probes: [k("Tab")],
  },
  { scope: "global", caps: [DIGITS], does: "Pick a lane, and show the factory.", probes: LANES },
  {
    scope: "global",
    caps: [
      { shown: "F1", said: "F1" },
      { shown: "[F]", said: "F" },
    ],
    does: "Show the factory.",
    probes: [k("F1"), k("f")],
  },
  {
    scope: "global",
    caps: [
      { shown: "F2", said: "F2" },
      { shown: "[P]", said: "P" },
    ],
    does: "Show the priority list.",
    probes: [k("F2"), k("p")],
  },
  {
    scope: "global",
    caps: [
      { shown: "F3", said: "F3" },
      { shown: "[H]", said: "H" },
    ],
    does: "Show the handbook. On a Mac the F-keys may not reach the page, so the letters always work.",
    probes: [k("F3"), k("h")],
  },
  {
    scope: "global",
    caps: [ARROWS],
    does: "Move the row selection.",
    probes: [k("ArrowUp"), k("ArrowDown")],
  },
  {
    scope: "global",
    caps: [
      { shown: "[HOME]", said: "Home" },
      { shown: "[END]", said: "End" },
    ],
    does: "First or last row, on the row list.",
    probes: [k("Home"), k("End")],
  },
  {
    scope: "global",
    caps: [
      { shown: "[→]", said: "Right arrow" },
      { shown: "[SPACE]", said: "Space" },
    ],
    does: "Open the selected row's details.",
    probes: [k("ArrowRight"), k(" ")],
  },
  {
    scope: "global",
    caps: [{ shown: "[T]", said: "T" }],
    does: "Tap. Hold it to keep tapping.",
    probes: [k("t")],
  },
  {
    scope: "global",
    caps: [QUESTION],
    does: "Show or hide this help.",
    probes: [SHIFTED_QUESTION],
  },

  // Drawer.
  {
    scope: "drawer",
    caps: [ARROWS],
    does: "Move the row selection; the details follow it.",
    probes: [k("ArrowUp"), k("ArrowDown")],
  },
  {
    scope: "drawer",
    caps: [{ shown: "[B]", said: "B" }],
    does: "Buy 1 of the best machine.",
    probes: [k("b")],
  },
  {
    scope: "drawer",
    caps: [{ shown: "[U]", said: "U" }],
    does: "Upgrade, when there's one to make.",
    probes: [k("u")],
  },
  { scope: "drawer", caps: [{ shown: "[R]", said: "R" }], does: "Recipe.", probes: [k("r")] },
  { scope: "drawer", caps: [{ shown: "[A]", said: "A" }], does: "Assign.", probes: [k("a")] },
  { scope: "drawer", caps: [{ shown: "[S]", said: "S" }], does: "Storage.", probes: [k("s")] },
  { scope: "drawer", caps: [{ shown: "[D]", said: "D" }], does: "Dismantle.", probes: [k("d")] },
  {
    scope: "drawer",
    caps: [{ shown: "[H]", said: "H" }],
    does: "This item's handbook entry.",
    probes: [k("h")],
  },
  {
    scope: "drawer",
    caps: [DIGITS],
    does: "Pick a lane, and close the details.",
    probes: LANES,
  },
  {
    scope: "drawer",
    caps: [ESC],
    does: "Close the details; focus goes back to the row.",
    probes: [k("Escape")],
  },

  // The why card.
  {
    scope: "card",
    caps: [ENTER],
    does: "Buy the advised batch, from the focused button or at rest.",
    probes: [k("Enter")],
  },
  { scope: "card", caps: [{ shown: "[1]", said: "1" }], does: "Buy 1.", probes: [k("1")] },
  {
    scope: "card",
    caps: [TAB],
    does: "Move through the card. Leaving it closes it.",
    probes: [],
  },
  {
    scope: "card",
    caps: [
      { shown: "F1", said: "F1" },
      { shown: "[F]", said: "F" },
    ],
    does: "Close the card, then show the factory.",
    probes: [k("F1"), k("f")],
  },
  {
    scope: "card",
    caps: [
      { shown: "F2", said: "F2" },
      { shown: "[P]", said: "P" },
    ],
    does: "Close the card, then show the priority list.",
    probes: [k("F2"), k("p")],
  },
  {
    scope: "card",
    caps: [
      { shown: "F3", said: "F3" },
      { shown: "[H]", said: "H" },
    ],
    does: "Close the card, then show the handbook.",
    probes: [k("F3"), k("h")],
  },
  {
    scope: "card",
    caps: [ESC],
    does: "Close the card; focus goes back to where it came from.",
    probes: [k("Escape")],
    byComponent: true,
  },

  // Help.
  { scope: "help", caps: [QUESTION], does: "Close this help.", probes: [SHIFTED_QUESTION] },
  {
    scope: "help",
    caps: [ESC],
    does: "Close this help.",
    probes: [k("Escape")],
    byComponent: true,
  },
];

/** Each hint token's probe: bracketed caps (every KEYMAP cap too), F-keys, and the lane tabs'
 *  bare digits. */
const HINT_KEYS: Record<string, readonly string[]> = {
  "[ENTER]": ["Enter"],
  "[TAB]": ["Tab"],
  "[T]": ["t"],
  "[1]": ["1"],
  "[2]": ["2"],
  "[3]": ["3"],
  "[4]": ["4"],
  "[5]": ["5"],
  "[F]": ["f"],
  "[P]": ["p"],
  "[→]": ["ArrowRight"],
  "[SPACE]": [" "],
  "[HOME]": ["Home"],
  "[END]": ["End"],
  "[↑↓]": ["ArrowUp", "ArrowDown"],
  "[ESC]": ["Escape"],
  "[?]": ["?"],
  "[B]": ["b"],
  "[U]": ["u"],
  "[R]": ["r"],
  "[A]": ["a"],
  "[S]": ["s"],
  "[D]": ["d"],
  "[H]": ["h"],
  F1: ["F1"],
  F2: ["F2"],
  F3: ["F3"],
  "1": ["1"],
  "2": ["2"],
  "3": ["3"],
  "4": ["4"],
  "5": ["5"],
};

/** A rendered hint's text → its probes: "[ENTER]" → Enter, "[↑↓] row  [ESC] close" → ArrowUp,
 *  ArrowDown, Escape; "F1" → F1; "3" → "3"; "[B]" → "b". Unknown text throws (a new hint must be mapped). */
export function hintProbe(text: string): { probe: Partial<KeyInput>; byComponent: boolean }[] {
  const tokens = text.match(/\[[^\]]*\]|\bF\d+\b|\b\d\b/g);
  if (tokens === null) throw new Error(`hintProbe: no key in hint "${text}"`);
  return tokens.flatMap((token) => {
    const keys = HINT_KEYS[token];
    if (keys === undefined) throw new Error(`hintProbe: unmapped hint "${token}" in "${text}"`);
    return keys.map((key) => ({
      probe: key === "?" ? { key, shiftKey: true } : { key },
      byComponent: key === "Escape",
    }));
  });
}
