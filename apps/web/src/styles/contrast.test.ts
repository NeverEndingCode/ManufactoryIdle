// U-1f / V-4: WCAG AA in every theme, measured from tokens.css. The matrix covers every text
// token on every surface, so only the barred pairs need a usage check over the CSS modules.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEMES } from "../ui/theme.js";
import { declarations, resolve, themeTokens, type Decl } from "./css-walk.js";

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

const files = cssFiles(SRC).map((f) => relative(SRC, f));
const read = (f: string) => declarations(f, readFileSync(join(SRC, f), "utf8"));
const tokensCss = read("styles/tokens.css");

const TEXT = [
  "t1",
  "t-body",
  "t2",
  "t3",
  "advice",
  "advice-dim",
  "advice-hi",
  "rate-up",
  "rate-down",
  "state-fed",
  "state-throttled",
  "state-bottleneck",
  "state-paused",
  "link",
] as const;
const SURFACES = ["bg", "s1", "s2", "s-hi"] as const;
/** [text, fill]: text set on a filled control. */
const FILLS = [
  ["on-accent", "accent"],
  ["on-advice-fill", "advice-fill"],
] as const;
/** [fill, surface]: meters, bars, the focus ring, the inset bar (WCAG 1.4.11, 3:1). */
const NON_TEXT = [
  ["t2", "bg"],
  ["t-body", "bg"],
  ["state-bottleneck", "bg"],
  ["accent", "bg"],
  ["accent", "s2"],
] as const;

/** U-3d: the fills a Bar paints (tone normal, body, bottleneck); each must read against its own
 *  track as well as against the surface. */
const BAR_FILLS = ["t2", "t-body", "state-bottleneck"] as const;

/** The pairs allowed to fail the matrix, policed in the CSS instead (U-1f). */
const BARRED = ["terminal t3/s-hi", "terminal t3/s2"];

/** Classes that paint a barred surface (--s-hi or --s2); --t3 text under them is barred. */
const ON_SURFACE: Record<string, string> = {
  selected: "s-hi",
  on: "s-hi",
  active: "s-hi",
  card: "s2",
  sheet: "s2",
  nextBuy: "s2",
  // Task 3: the notice lines (base.css); the lane and bottom tabs' "on" is listed above.
  notice: "s2",
  // Task 7: the priority list's reset confirmation and the account forms' error box.
  confirm: "s2",
  formError: "s2",
};
const ON_SURFACE_ATTRS = [/\[aria-selected="?true"?\]/, /\[aria-current/];

function rgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) throw new Error(`not an opaque hex colour: ${color}`);
  const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** fg at alpha over an opaque bg, as a hex colour (source-over, in sRGB as browsers do). */
function over(fg: string, bg: string, alpha: number): string {
  const f = rgb(fg);
  const b = rgb(bg);
  return `#${[0, 1, 2]
    .map((i) => Math.round(f[i]! * alpha + b[i]! * (1 - alpha)))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The track's wash: the opacity of the --bar-paint layer over --bar-track, in a theme. */
function trackWash(id: string): number {
  const decl = read("ui/Bar.module.css").find(
    (d) => d.stack.at(-1) === ".track::before" && d.property === "opacity",
  );
  if (decl === undefined) return 0;
  const tokens = themeTokens(tokensCss, id);
  return Number(resolve(tokens, decl.value));
}

/** Each bar fill against its track, composited: --bar-track (or the surface, when transparent)
 *  under the fill's own colour at the wash's opacity. */
function fillOnTrackFailures(): string[] {
  const bad: string[] = [];
  for (const t of THEMES) {
    const c = colours(t.id);
    const wash = trackWash(t.id);
    expect(Number.isFinite(wash), t.id).toBe(true);
    const track = c("bar-track");
    for (const fill of BAR_FILLS)
      for (const surface of SURFACES) {
        const base = track === "transparent" ? c(surface) : track;
        const r = ratio(c(fill), over(c(fill), base, wash));
        if (r < 3) bad.push(`${t.id} ${fill}/track on ${surface} ${r.toFixed(2)}`);
      }
  }
  return bad;
}

function colours(id: string) {
  const tokens = themeTokens(tokensCss, id);
  return (name: string) => {
    const v = tokens[`--${name}`];
    if (v === undefined) throw new Error(`${id}: --${name} undefined`);
    return resolve(tokens, v);
  };
}

/** Every matrix pair below 4.5:1, as "theme text/surface (ratio)". */
function matrixFailures(): { key: string; r: number }[] {
  const out: { key: string; r: number }[] = [];
  for (const t of THEMES) {
    const c = colours(t.id);
    for (const fg of TEXT)
      for (const bg of SURFACES) {
        const r = ratio(c(fg), c(bg));
        if (r < 4.5) out.push({ key: `${t.id} ${fg}/${bg}`, r });
      }
  }
  return out;
}

const STRIP = (v: string) => v.replace(/\s+/g, "");

/** V-4's usage rules over one file's declarations: what may not sit on a barred surface. */
function usageViolations(decls: readonly Decl[]): string[] {
  const bad: string[] = [];
  const rules = new Map<string, Decl[]>();
  for (const d of decls) {
    const key = `${d.file}\u0000${d.stack.join(" > ")}`;
    rules.set(key, [...(rules.get(key) ?? []), d]);
  }
  for (const rule of rules.values()) {
    const where = `${rule[0]!.file}: ${rule[0]!.stack.join(" > ")}`;
    const selector = rule[0]!.stack.filter((s) => !s.startsWith("@")).at(-1) ?? "";
    const color = rule.filter((d) => d.property === "color").map((d) => STRIP(d.value));
    if (color.includes("var(--accent)")) bad.push(`${where}: color: var(--accent) (V-2)`);
    if (!color.includes("var(--t3)")) continue;
    const backgrounds = rule
      .filter((d) => d.property === "background" || d.property === "background-color")
      .map((d) => STRIP(d.value));
    if (backgrounds.some((v) => /var\(--(s-hi|s2)\)/.test(v)))
      bad.push(`${where}: --t3 on its own barred background`);
    const classes = [...selector.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)].map((m) => m[1]!);
    if (classes.some((c) => c in ON_SURFACE) || ON_SURFACE_ATTRS.some((re) => re.test(selector)))
      bad.push(`${where}: --t3 under a barred surface`);
  }
  return bad;
}

describe("contrast (U-1f, V-4)", { timeout: 60_000 }, () => {
  it("1. every text token on every surface reaches 4.5:1, bar the declared pairs", () => {
    const failing = matrixFailures();
    expect(
      failing.filter((f) => !BARRED.includes(f.key)).map((f) => `${f.key} ${f.r.toFixed(2)}`),
    ).toEqual([]);
  });

  it("1b. BARRED lists exactly the pairs that fail, and they're real", () => {
    expect(
      matrixFailures()
        .map((f) => f.key)
        .sort(),
    ).toEqual([...BARRED].sort());
    // The self-check: the spec's measured 4.22 (U-1f), so the parse and the formula agree.
    const c = colours("terminal");
    expect(Math.abs(ratio(c("t3"), c("s-hi")) - 4.22)).toBeLessThanOrEqual(0.01);
    expect(ratio(c("t3"), c("s2"))).toBeCloseTo(4.46, 1);
  });

  it("2. the text on each fill reaches 4.5:1", () => {
    const bad: string[] = [];
    for (const t of THEMES) {
      const c = colours(t.id);
      for (const [fg, bg] of FILLS) {
        const r = ratio(c(fg), c(bg));
        if (r < 4.5) bad.push(`${t.id} ${fg}/${bg} ${r.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("3. the non-text fills reach 3:1 (WCAG 1.4.11)", () => {
    const bad: string[] = [];
    for (const t of THEMES) {
      const c = colours(t.id);
      for (const [fg, bg] of NON_TEXT) {
        const r = ratio(c(fg), c(bg));
        if (r < 3) bad.push(`${t.id} ${fg}/${bg} ${r.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("3b. each bar fill reaches 3:1 against its own composited track (U-3d, WCAG 1.4.11)", () => {
    // The self-check: a full wash leaves nothing to tell apart.
    expect(ratio("#3fb85a", over("#3fb85a", "#000000", 1))).toBe(1);
    expect(over("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(fillOnTrackFailures()).toEqual([]);
  });

  it("4. the usage checker catches each barred pattern", () => {
    const check = (css: string) => usageViolations(declarations("x.css", css));
    expect(check(".a { color: var(--t3); background: var(--s2) }")).toHaveLength(1);
    expect(check(".a { color: var(--t3); background-color: var(--s-hi) }")).toHaveLength(1);
    expect(check(".row.selected .x { color: var(--t3) }")).toHaveLength(1);
    expect(check('.tab[aria-selected="true"] { color: var(--t3) }')).toHaveLength(1);
    expect(check(".card .label { color: var(--t3) }")).toHaveLength(1);
    expect(check(".a { color: var(--accent) }")).toHaveLength(1);
    expect(check("@media (min-width: 1px) { .on { color: var(--t3) } }")).toHaveLength(1);
    // Allowed: --t3 on the page or the panel, --t2 on the card, --accent as a fill.
    expect(check(".a { color: var(--t3); background: var(--s1) }")).toEqual([]);
    expect(check(".card { color: var(--t2) }")).toEqual([]);
    expect(check(".selectedness { color: var(--t3) }")).toEqual([]);
    expect(check(".a { background: var(--accent); border-color: var(--accent) }")).toEqual([]);
  });

  it("5. no CSS file uses a barred pair", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "styles/tokens.css",
        "styles/base.css",
        "ui/Shell.module.css",
        "ui/Row.module.css",
        "ui/Bar.module.css",
        "ui/Power.module.css",
        "ui/Drawer.module.css",
        "ui/Handbook.module.css",
        "ui/PriorityList.module.css",
        "ui/Settings.module.css",
      ]),
    );
    expect(files.flatMap((f) => usageViolations(read(f)))).toEqual([]);
  });
});
