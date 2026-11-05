// @vitest-environment jsdom
// U-1a / U-1i / V-6 / V-7: the registry, migration, the lock, applyTheme's side effects, and the
// inline pre-paint script in index.html agreeing with migrateTheme.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Capability } from "./capabilities.js";
import {
  applyTheme,
  DEFAULT_THEME,
  migrateTheme,
  resolveTheme,
  setTheme,
  storedTheme,
  syncCapabilities,
  THEME_KEY,
  THEMES,
  themeDef,
  type ThemeId,
} from "./theme.js";

const IDS: ThemeId[] = [
  "terminal",
  "clean-dark",
  "clean-oled",
  "clean-light",
  "cosy",
  "industrial",
];
const NONE: ReadonlySet<Capability> = new Set();

/** Test 2's table: every old value and every ThemeId. */
const MIGRATION: [string | null, ThemeId][] = [
  ["dark", "clean-dark"],
  ["light", "clean-light"],
  ["system", "terminal"],
  [null, "terminal"],
  ["junk", "terminal"],
  ["", "terminal"],
  ...IDS.map((id): [string, ThemeId] => [id, id]),
];

afterEach(() => {
  vi.restoreAllMocks();
  syncCapabilities(new Set());
  setTheme("terminal");
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
});

describe("the theme registry (U-1a)", () => {
  it("1. six themes in U-1a's order, terminal the default", () => {
    expect(THEMES.map((t) => t.id)).toEqual(IDS);
    expect(DEFAULT_THEME).toBe("terminal");
    expect(THEME_KEY).toBe("mi.theme");
    expect(THEMES.map((t) => t.name)).toEqual([
      "Retro terminal",
      "Clean (Dark)",
      "Clean (OLED Dark)",
      "Clean (Light)",
      "Cosy",
      "Industrial",
    ]);
  });

  it("1b. the locks: cosy and industrial only", () => {
    expect(themeDef("cosy").lock).toBe("theme:cosy");
    expect(themeDef("industrial").lock).toBe("theme:industrial");
    for (const id of ["terminal", "clean-dark", "clean-oled", "clean-light"] as const)
      expect(themeDef(id).lock).toBeNull();
  });

  it("1c. voices, name styles, schemes and effects match U-1a's table", () => {
    const row = (t: (typeof THEMES)[number]) => [t.id, t.scheme, t.voice, t.names, t.effects];
    expect(THEMES.map(row)).toEqual([
      ["terminal", "dark", "shell", "id", true],
      ["clean-dark", "dark", "plain", "title", false],
      ["clean-oled", "dark", "plain", "title", false],
      ["clean-light", "light", "plain", "title", false],
      ["cosy", "light", "plain", "title", false],
      ["industrial", "dark", "plain", "upper", false],
    ]);
  });
});

describe("migration (U-1i)", () => {
  it("2. old values migrate, unknown ones become terminal, ThemeIds pass through", () => {
    for (const [raw, want] of MIGRATION) expect(migrateTheme(raw), String(raw)).toBe(want);
  });

  it("2b. storedTheme reads and migrates mi.theme", () => {
    expect(storedTheme()).toBe("terminal");
    localStorage.setItem(THEME_KEY, "light");
    expect(storedTheme()).toBe("clean-light");
  });

  it("2c. a throwing localStorage gives terminal", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(storedTheme()).toBe("terminal");
  });
});

describe("the lock (U-1i)", () => {
  it("3. a locked stored theme renders terminal, and the stored value stays", () => {
    localStorage.setItem(THEME_KEY, "cosy");
    expect(resolveTheme("cosy", NONE, { dev: false })).toBe("terminal");
    expect(localStorage.getItem(THEME_KEY)).toBe("cosy");
    expect(resolveTheme("cosy", new Set<Capability>(["theme:cosy"]), { dev: false })).toBe("cosy");
    expect(resolveTheme("industrial", new Set<Capability>(["theme:cosy"]), { dev: false })).toBe(
      "terminal",
    );
  });

  it("3b. setTheme on a locked theme does nothing", () => {
    expect(setTheme("clean-dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("clean-dark");
    expect(setTheme("industrial")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe("clean-dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("clean-dark");
  });

  it("3c. ?theme=<id> wins in dev only", () => {
    expect(resolveTheme("terminal", NONE, { search: "?theme=cosy", dev: true })).toBe("cosy");
    expect(resolveTheme("terminal", NONE, { search: "?theme=cosy", dev: false })).toBe("terminal");
    expect(resolveTheme("clean-dark", NONE, { search: "?theme=junk", dev: true })).toBe(
      "clean-dark",
    );
    const root = document.createElement("html");
    expect(applyTheme("terminal", NONE, root, { search: "?theme=cosy", dev: true })).toBe("cosy");
    expect(root.getAttribute("data-theme")).toBe("cosy");
  });

  it("3d. syncCapabilities re-applies when a grant arrives", () => {
    localStorage.setItem(THEME_KEY, "cosy");
    // A fresh read, as main.tsx does at boot.
    applyTheme(storedTheme(), NONE);
    expect(document.documentElement.getAttribute("data-theme")).toBe("terminal");
    // The store's own stored value only follows setTheme; take the locked value through a grant.
    syncCapabilities(new Set<Capability>(["theme:cosy"]));
    expect(setTheme("cosy")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("cosy");
    // The grant goes away: the same stored value renders terminal.
    syncCapabilities(new Set());
    expect(document.documentElement.getAttribute("data-theme")).toBe("terminal");
    expect(localStorage.getItem(THEME_KEY)).toBe("cosy");
  });
});

describe("applyTheme (U-1i, V-6)", () => {
  it("4. sets data-theme always, terminal included, and the theme-color meta", () => {
    for (const id of IDS) {
      const caps = new Set<Capability>(["theme:cosy", "theme:industrial"]);
      const applied = applyTheme(id, caps, document.documentElement, { dev: false });
      expect(applied).toBe(id);
      expect(document.documentElement.getAttribute("data-theme")).toBe(id);
      const meta = document.head.querySelectorAll('meta[name="theme-color"]');
      expect(meta).toHaveLength(1);
      expect(meta[0]!.getAttribute("content")).toBe(themeDef(applied).swatch.bg);
    }
    // A locked theme's meta is terminal's.
    applyTheme("cosy", NONE, document.documentElement, { dev: false });
    expect(document.head.querySelector('meta[name="theme-color"]')!.getAttribute("content")).toBe(
      themeDef("terminal").swatch.bg,
    );
  });
});

describe("the inline pre-paint script (V-6)", () => {
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../index.html"),
    "utf8",
  );
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

  it("5. index.html has one inline script in <head> and the theme-color meta", () => {
    expect(inline).toHaveLength(1);
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain(inline[0]);
    expect(head).toMatch(/<meta name="theme-color" content="#050a06"\s*\/?>/);
  });

  it("5b. it agrees with resolveTheme(migrateTheme(raw)) for every row", () => {
    const run = new Function("localStorage", "document", inline[0]!);
    for (const [raw] of MIGRATION) {
      const attrs = new Map<string, string>();
      const storage = { getItem: (k: string) => (k === THEME_KEY ? raw : null) };
      const doc = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
      run(storage, doc);
      expect(attrs.get("data-theme"), String(raw)).toBe(
        resolveTheme(migrateTheme(raw), NONE, { dev: false }),
      );
    }
  });

  it("5c. it survives a throwing localStorage", () => {
    const run = new Function("localStorage", "document", inline[0]!);
    const attrs = new Map<string, string>();
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    run(storage, { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } });
    expect(attrs.get("data-theme")).toBe("terminal");
  });
});
