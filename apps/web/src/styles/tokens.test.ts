// W-17 and W-18 over the CSS source: what may animate, where motion may live, and where the
// four state colours may be used. Every src/**/*.css file, read as text.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEMES } from "../ui/theme.js";
import { block, declarations, resolve, themePrelude, themeTokens } from "./css-walk.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? cssFiles(join(dir, e.name))
      : e.name.endsWith(".css")
        ? [join(dir, e.name)]
        : [],
  );
}

const files = cssFiles(SRC);
const all = files.flatMap((f) => declarations(relative(SRC, f), readFileSync(f, "utf8")));

/** U-1b's semantic tokens: every theme block defines each one (8d). */
const SEMANTIC_TOKENS: readonly string[] = [
  "--bg",
  "--s1",
  "--s2",
  "--s-hi",
  "--line",
  "--line-soft",
  "--rule",
  "--t1",
  "--t-body",
  "--t2",
  "--t3",
  "--accent",
  "--on-accent",
  "--advice",
  "--advice-dim",
  "--advice-hi",
  "--advice-line",
  "--advice-fill",
  "--on-advice-fill",
  "--link",
  "--link-hover",
  "--rate-up",
  "--rate-down",
  "--state-fed",
  "--state-throttled",
  "--state-bottleneck",
  "--state-paused",
  "--scrim",
  "--font-ui",
  "--font-mono",
  "--font-display",
  "--radius",
  "--radius-pill",
  "--bar-h",
  "--bar-open",
  "--bar-close",
  "--bar-track",
  "--bar-wash",
  "--bar-paint",
  "--glow-text",
  "--glow-title",
  "--glow-advice",
  "--glow-banner",
  "--glow-tap",
  "--scanlines",
  "--fw-name",
];

/** V-1's legacy aliases and the deleted dock/sheet/motion sizes: gone in Task 8 (8g). */
const RETIRED: readonly string[] = [
  "--sans",
  "--mono",
  "--fs-1",
  "--fs-2",
  "--fs-3",
  "--fw-regular",
  "--fw-strong",
  "--line2",
  "--s3",
  "--hairline",
  "--dock-h",
  "--tabbar-h",
  "--sheet-max",
  "--sheet-bottom",
  "--sweep-period",
  "--conveyor-period",
];

const tokensCss = all.filter((d) => d.file === "styles/tokens.css");

const MOTION_OK = new Set(["transform", "opacity", "none"]);
const TIMING =
  /^(-?[\d.]+m?s|linear|ease(-in|-out|-in-out)?|step-(start|end)|steps\(.*\)|cubic-bezier\(.*\)|var\(.*\)|infinite|alternate|normal|forwards|backwards|both)$/;

/** The property names a transition value names, e.g. "transform 300ms linear, opacity 1s". */
function transitioned(value: string): string[] {
  return value.split(",").map((part) => {
    const word = part
      .trim()
      .split(/\s+/)
      .find((w) => !TIMING.test(w));
    return word ?? "all";
  });
}

const STATE_CLASSES = new Set([
  "frame",
  "state-fed",
  "state-throttled",
  "state-bottleneck",
  "state-paused",
  "state-idle",
]);

/** Every selector in the list names a state or frame class, as a whole class token. */
function isStateSelector(selectorList: string): boolean {
  return selectorList.split(",").every((sel) => {
    const classes = [...sel.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)].map((m) => m[1]!);
    return classes.some((c) => STATE_CLASSES.has(c));
  });
}

describe("the CSS source", () => {
  it("titles are unique", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const prefixes = [...source.matchAll(/^\s*it\("(\d+[a-z]?\.)/gm)].map((m) => m[1]!);
    const repeated = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
    expect(repeated).toEqual([]);
  });

  it("has the files the tests read", () => {
    expect(files.map((f) => relative(SRC, f)).sort()).toEqual(
      expect.arrayContaining([
        "styles/tokens.css",
        "styles/base.css",
        "ui/Row.module.css",
        "ui/Bar.module.css",
      ]),
    );
  });

  it("7a. only transform and opacity transition or animate (W-18)", () => {
    const bad: string[] = [];
    for (const d of all) {
      if (d.property === "transition" || d.property === "transition-property") {
        for (const p of transitioned(d.value))
          if (!MOTION_OK.has(p)) bad.push(`${d.file}: ${d.property}: ${d.value}`);
      }
      if (d.stack.some((s) => s.startsWith("@keyframes")) && !MOTION_OK.has(d.property)) {
        bad.push(`${d.file}: ${d.stack.join(" > ")} { ${d.property} }`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("7b. every animation and transition sits in prefers-reduced-motion: no-preference", () => {
    const outside = all
      .filter((d) => /^(animation|transition)(-|$)/.test(d.property))
      .filter(
        (d) => !d.stack.some((s) => /^@media.*prefers-reduced-motion:\s*no-preference/.test(s)),
      )
      .map((d) => `${d.file}: ${d.stack.join(" > ")} { ${d.property}: ${d.value} }`);
    expect(outside).toEqual([]);
  });

  it("7c. there is a pulse, on opacity, over --pulse-cycle, on the bottleneck's gutter (U-3e)", () => {
    const pulse = all.filter((d) => d.stack.some((s) => s === "@keyframes pulse"));
    expect(pulse.map((d) => d.property)).toEqual(["opacity", "opacity"]);
    expect(pulse.every((d) => d.file === "ui/Row.module.css")).toBe(true);
    const uses = all.filter(
      (d) => d.property === "animation" && d.value.includes("var(--pulse-cycle)"),
    );
    expect(uses.map((d) => `${d.file}: ${d.stack.at(-1)}`)).toEqual([
      "ui/Row.module.css: .gutter:global(.state-bottleneck)",
    ]);
  });

  it("7d. a hidden tab pauses animations on pseudo-elements too (W-9)", () => {
    const paused = all.filter((d) => d.property === "animation-play-state" && d.value === "paused");
    const selectors = paused.flatMap((d) =>
      d.stack
        .at(-1)!
        .split(",")
        .map((x) => x.trim()),
    );
    expect(selectors).toEqual(
      expect.arrayContaining([
        ":root.hidden-tab *",
        ":root.hidden-tab *::before",
        ":root.hidden-tab *::after",
      ]),
    );
  });

  it("8c. the state-class matcher takes whole class tokens", () => {
    expect(isStateSelector(".frame")).toBe(true);
    expect(isStateSelector(".frame::before")).toBe(true);
    expect(isStateSelector(".frame .label")).toBe(true);
    expect(isStateSelector(".state-fed")).toBe(true);
    expect(isStateSelector(".state-paused, .state-idle")).toBe(true);
    expect(isStateSelector(".frameworks")).toBe(false);
    expect(isStateSelector(".myframe")).toBe(false);
    expect(isStateSelector(".state-fedora")).toBe(false);
    expect(isStateSelector(".state-fed, .chip")).toBe(false);
  });

  it("8a. the state colours are used only by state and frame rules (W-17)", () => {
    const misuse = all
      .filter((d) => d.value.includes("var(--state-"))
      .filter((d) => !isStateSelector(d.stack.filter((s) => !s.startsWith("@")).at(-1) ?? ""))
      .map((d) => `${d.file}: ${d.stack.join(" > ")} { ${d.property}: ${d.value} }`);
    expect(misuse).toEqual([]);
    // And something does use them.
    expect(all.some((d) => d.value.includes("var(--state-bottleneck)"))).toBe(true);
  });

  it("8b. the terminal :root is U-1c, with V-2's paused and the shared sizes", () => {
    // Whitespace-normalised: Prettier wraps long values across lines.
    const norm = (v: string) => v.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");
    const root = Object.fromEntries(
      Object.entries(block(tokensCss, ":root")).map(([k, v]) => [k, norm(v)]),
    );
    expect(root).toMatchObject({
      "color-scheme": "dark",
      "--bg": "#050a06",
      "--s1": "#071009",
      "--s2": "#0b1208",
      "--s-hi": "#0b1a0e",
      "--line": "#1f6b30",
      "--line-soft": "#123d1c",
      "--rule": "dashed",
      "--t1": "#7dff9a",
      "--t-body": "#4ee06c",
      "--t2": "#3fb85a",
      "--t3": "#2a8c42",
      "--accent": "#4ee06c",
      "--on-accent": "#050a06",
      "--advice": "#ffb000",
      "--advice-dim": "#c98c00",
      "--advice-hi": "#ffd166",
      "--advice-line": "#5a4206",
      "--advice-fill": "#ffb000",
      "--on-advice-fill": "#050a06",
      "--link": "#7dff9a",
      "--link-hover": "#c8ffd4",
      "--rate-up": "#4ee06c",
      "--rate-down": "#ff6b5a",
      "--state-fed": "#4ee06c",
      "--state-throttled": "#d9c34a",
      "--state-bottleneck": "#ffb000",
      "--state-paused": "#2f9a4a",
      "--scrim": "rgba(0, 0, 0, 0.55)",
      "--radius": "0",
      "--radius-pill": "0",
      "--bar-seg": "1ch",
      "--bar-open": '"["',
      "--bar-wash": "0.25",
      "--bar-close": '"]"',
      "--bar-paint":
        "repeating-linear-gradient(90deg, currentColor 0 calc(var(--bar-seg) - 2px), transparent 0 var(--bar-seg))",
      "--glow-text": "0 0 5px rgba(78, 224, 108, 0.35)",
      "--glow-title": "0 0 8px rgba(125, 255, 154, 0.6)",
      "--glow-advice": "0 0 6px rgba(255, 176, 0, 0.45)",
      "--glow-banner": "0 0 8px rgba(255, 209, 102, 0.6)",
      "--glow-tap": "0 0 0 1px #4ee06c, 0 0 12px rgba(78, 224, 108, 0.45)",
      "--scanlines":
        "repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.28) 0 1px, transparent 1px 3px)",
      "--fw-name": "400",
      "--fs-body": "14px",
      "--fs-small": "12px",
      "--fs-label": "13px",
      "--fs-title": "34px",
      "--fs-bar": "20px",
      "--row-h": "44px",
      "--pulse-cycle": "2.6s",
    });
    expect(root["--font-display"]).toMatch(/^"VT323", .*monospace$/);
    expect(root["--font-ui"]).toMatch(/^"IBM Plex Mono", .*monospace$/);
    expect(root["--font-mono"]).toMatch(/^"IBM Plex Mono", .*monospace$/);

    // The breakpoints are useLayoutMode's (W-19): the sizes and the row height follow them.
    const at = (q: string) =>
      Object.fromEntries(
        tokensCss
          .filter((d) => d.stack.join(" > ") === `${q} > :root`)
          .map((d) => [d.property, d.value]),
      );
    expect(at("@media (max-width: 1000px)")).toEqual({ "--fs-title": "28px" });
    expect(at("@media (max-width: 599px)")).toEqual({
      "--fs-body": "13px",
      "--fs-small": "11px",
      "--fs-label": "12px",
      "--fs-title": "28px",
      "--fs-bar": "17px",
      "--row-h": "54px",
      "--glow-title": "0 0 6px rgba(78, 224, 108, 0.45)",
    });

    // U-1a: the default ignores the OS preference; the old light set is gone.
    expect(all.filter((d) => d.stack.some((s) => /prefers-color-scheme/.test(s)))).toEqual([]);
    expect(all.filter((d) => d.stack.includes(':root[data-theme="light"]'))).toEqual([]);

    const num = all.filter((d) => d.stack.at(-1) === ".num");
    expect(Object.fromEntries(num.map((d) => [d.property, d.value]))).toEqual({
      "font-family": "var(--font-mono)",
      "font-variant-numeric": "tabular-nums",
    });
  });

  it("8d. each of the six blocks defines every semantic token (U-1b)", () => {
    const missing: string[] = [];
    for (const t of THEMES) {
      const own = block(tokensCss, themePrelude(t.id));
      for (const name of ["color-scheme", ...SEMANTIC_TOKENS])
        if (!(name in own)) missing.push(`${t.id}: ${name}`);
      expect(own["color-scheme"], t.id).toBe(t.scheme);
    }
    expect(missing).toEqual([]);
    // No other theme block, and nothing under a theme block but its tokens.
    const preludes = new Set(tokensCss.map((d) => d.stack[0]!));
    const themed = [...preludes].filter((p) => p.includes("data-theme"));
    expect(themed.sort()).toEqual(
      THEMES.filter((t) => t.id !== "terminal")
        .map((t) => themePrelude(t.id))
        .sort(),
    );
    for (const p of themed)
      for (const k of Object.keys(block(tokensCss, p)))
        expect(k === "color-scheme" || SEMANTIC_TOKENS.includes(k), `${p} ${k}`).toBe(true);
  });

  it("8g. no CSS file names a retired token, and tokens.css defines none (V-1)", () => {
    const named = (name: string) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`);
    const sources = files.map((f) => [relative(SRC, f), readFileSync(f, "utf8")] as const);
    const uses = RETIRED.flatMap((name) =>
      sources.filter(([, text]) => named(name).test(text)).map(([file]) => `${file}: ${name}`),
    );
    expect(uses).toEqual([]);
    const defined = tokensCss.filter((d) => RETIRED.includes(d.property));
    expect(defined.map((d) => `${d.stack.join(" > ")} { ${d.property} }`)).toEqual([]);
    // The matcher takes whole names: --font-mono is not --mono, --fs-10 is not --fs-1.
    expect(named("--mono").test("var(--font-mono)")).toBe(false);
    expect(named("--fs-1").test("var(--fs-10)")).toBe(false);
    expect(named("--mono").test("var(--mono)")).toBe(true);
  });

  it("8e. every registry swatch equals its block's --bg, --t-body and --advice", () => {
    for (const t of THEMES) {
      const tokens = themeTokens(tokensCss, t.id);
      const css = (name: string) => resolve(tokens, tokens[name]!);
      expect(t.swatch, t.id).toEqual({
        bg: css("--bg"),
        body: css("--t-body"),
        advice: css("--advice"),
      });
    }
  });

  it("8f. each theme's faces are U-1c to U-1e, and each one is self-hosted (U-1g)", () => {
    const FACES: Record<string, [ui: string, mono: string, display: string]> = {
      terminal: ["IBM Plex Mono", "IBM Plex Mono", "VT323"],
      "clean-dark": ["Inter", "JetBrains Mono", "Inter"],
      "clean-oled": ["Inter", "JetBrains Mono", "Inter"],
      "clean-light": ["Inter", "JetBrains Mono", "Inter"],
      cosy: ["Nunito", "JetBrains Mono", "Fraunces"],
      industrial: ["IBM Plex Mono", "IBM Plex Mono", "Oswald"],
    };
    expect(Object.keys(FACES).sort()).toEqual(THEMES.map((t) => t.id).sort());
    /** Stacks end in system faces; only these may lack an @font-face. */
    const SYSTEM = new Set(["ui-monospace", "monospace", "system-ui", "sans-serif", "serif"]);
    const SYSTEM_FALLBACK = new Set(["Georgia", "Arial Narrow"]);
    const declared = new Set(
      all
        .filter((d) => d.file === "styles/fonts.css" && d.property === "font-family")
        .filter((d) => d.stack.length === 1 && d.stack[0] === "@font-face")
        .map((d) => d.value.replace(/^"|"$/g, "")),
    );
    expect(declared.size).toBe(7);
    for (const t of THEMES) {
      const own = block(tokensCss, themePrelude(t.id));
      const stacks = ["--font-ui", "--font-mono", "--font-display"].map((k) =>
        own[k]!.split(",").map((f) => f.trim()),
      );
      expect(
        stacks.map((s) => s[0]),
        t.id,
      ).toEqual(FACES[t.id]!.map((f) => `"${f}"`));
      for (const stack of stacks) {
        const [face, ...rest] = stack.map((f) => f.replace(/^"|"$/g, ""));
        expect(declared.has(face!), `${t.id}: ${face} has an @font-face`).toBe(true);
        expect(SYSTEM.has(rest.at(-1)!), `${t.id}: ${stack.join(", ")} ends generic`).toBe(true);
        for (const f of rest) expect(SYSTEM.has(f) || SYSTEM_FALLBACK.has(f), f).toBe(true);
      }
    }
  });

  it("10a. a row is a pinned height that clips: no min-height, max-height or height: auto (U-3a)", () => {
    // CSS modules scope the classes: only Row.module.css can reach a row or its cells.
    const row = all.filter((d) => d.file === "ui/Row.module.css");
    const rule = Object.fromEntries(
      row
        .filter((d) => d.stack.length === 1 && d.stack[0] === ".row")
        .map((d) => [d.property, d.value]),
    );
    expect(rule.height).toBe("var(--row-h)");
    expect(rule.overflow).toBe("hidden");
    const CELLS = ["row", "gutter", "name", "rate", "sat", "machines", "storage", "stock"];
    const reaches = (selector: string) =>
      [...selector.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)].some((m) => CELLS.includes(m[1]!));
    const bad = row
      .filter((d) => reaches(d.stack.filter((s) => !s.startsWith("@")).at(-1) ?? ""))
      .filter(
        (d) =>
          d.property === "min-height" ||
          d.property === "max-height" ||
          d.property === "min-block-size" ||
          d.property === "max-block-size" ||
          ((d.property === "height" || d.property === "block-size") && d.value.trim() === "auto"),
      )
      .map((d) => `${d.stack.join(" > ")} { ${d.property}: ${d.value} }`);
    expect(bad).toEqual([]);
    // Every rule that sets a row's own height sets it to the token.
    const heights = row.filter(
      (d) => d.property === "height" && /(^|[\s,])\.row\b(?![-\w])/.test(d.stack.at(-1) ?? ""),
    );
    expect(heights.map((d) => d.value)).toEqual(heights.map(() => "var(--row-h)"));
  });

  // Catches: a hint shown unconditionally (a touch screen would see keys it has no way to press),
  // or shown under some other query.
  it("11a. key hints show only on a fine pointer (U-7e, K-7)", () => {
    const FINE = "@media (hover: hover) and (pointer: fine)";
    const hints = all.filter(
      (d) =>
        d.property === "display" &&
        /\.key-hint\b/.test(d.stack.filter((s) => !s.startsWith("@")).at(-1) ?? ""),
    );
    const shown = hints.map((d) => `${d.stack.join(" > ")} { display: ${d.value} }`);
    expect(shown).toEqual([
      ".key-hint { display: none }",
      `${FINE} > .key-hint { display: inline }`,
    ]);
    for (const d of hints) {
      if (d.value === "none") expect(d.stack, shown.join("; ")).toEqual([".key-hint"]);
      else expect(d.stack, shown.join("; ")).toEqual([FINE, ".key-hint"]);
    }
  });

  // U-8d / K-16. Catches: a module min-height under 44 px, which beats the coarse rule's
  // element selector on specificity and leaves a touch target short.
  it("9a. a coarse pointer gets 44 px targets from one rule, and nothing undercuts it", () => {
    const coarse = all.filter(
      (d) =>
        d.file === "styles/base.css" &&
        d.stack.length === 2 &&
        d.stack[0] === "@media (pointer: coarse)" &&
        d.stack[1]!.split(",")
          .map((x) => x.trim())
          .includes("button"),
    );
    // A letter key's target can be a link (the drawer's [H] handbook): links are covered too.
    expect(coarse[0]!.stack[1]!.split(",").map((x) => x.trim())).toEqual(
      expect.arrayContaining(["button", ".btn", '[role="tab"]', "[data-key]", "a[href]"]),
    );
    expect(Object.fromEntries(coarse.map((d) => [d.property, d.value]))).toMatchObject({
      "min-height": "44px",
      "min-width": "44px",
    });
    const fine = (d: (typeof all)[number]) => d.stack.some((s) => /pointer:\s*fine/.test(s));
    const under = all.filter((d) => {
      if (d.property !== "min-height" && d.property !== "min-width") return false;
      // px, or rem/em at the 16 px root (2.5rem is 40 px).
      const m = /^(\d+(?:\.\d+)?)(px|rem|em)$/.exec(d.value);
      if (m === null || fine(d)) return false;
      return Number(m[1]) * (m[2] === "px" ? 1 : 16) < 44;
    });
    expect(
      under.map((d) => `${d.file}: ${d.stack.join(" > ")} { ${d.property}: ${d.value} }`),
    ).toEqual([]);
    // The segmented tabs are gone (U-5c).
    expect(all.filter((d) => d.stack.some((s) => s.includes(".segBtn")))).toEqual([]);
  });
});
