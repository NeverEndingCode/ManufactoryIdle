// W-17 and W-18 over the CSS source: what may animate, where motion may live, and where the
// four state colours may be used. Every src/**/*.css file, read as text.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

interface Decl {
  file: string;
  property: string;
  value: string;
  /** Block preludes, outermost first: "@media (...)", "@keyframes x", "0%,100%", ".a .b". */
  stack: string[];
}

/** A small CSS walker: comments stripped, blocks nested, declarations with their context. */
function declarations(file: string, text: string): Decl[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Decl[] = [];
  const stack: string[] = [];
  let buf = "";
  const flush = () => {
    const d = buf.trim();
    buf = "";
    if (!d) return;
    const colon = d.indexOf(":");
    if (colon === -1) throw new Error(`${file}: cannot parse "${d}"`);
    out.push({
      file,
      property: d.slice(0, colon).trim().toLowerCase(),
      value: d.slice(colon + 1).trim(),
      stack: [...stack],
    });
  };
  for (const ch of src) {
    if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      flush();
      stack.pop();
    } else if (ch === ";") {
      flush();
    } else {
      buf += ch;
    }
  }
  if (stack.length !== 0) throw new Error(`${file}: unbalanced braces`);
  return out;
}

const files = cssFiles(SRC);
const all = files.flatMap((f) => declarations(relative(SRC, f), readFileSync(f, "utf8")));

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

describe("the CSS source", () => {
  it("has the files the tests read", () => {
    expect(files.map((f) => relative(SRC, f)).sort()).toEqual(
      expect.arrayContaining(["styles/tokens.css", "styles/base.css", "ui/ItemRow.module.css"]),
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

  it("7c. there is a pulse, on opacity, over --pulse-cycle", () => {
    const pulse = all.filter((d) => d.stack.some((s) => s === "@keyframes pulse"));
    expect(pulse.map((d) => d.property)).toEqual(["opacity", "opacity"]);
    expect(
      all.some((d) => d.property === "animation" && d.value.includes("var(--pulse-cycle)")),
    ).toBe(true);
  });

  it("8a. the state colours are used only by state and frame rules (W-17)", () => {
    const misuse = all
      .filter((d) => d.value.includes("var(--state-"))
      .filter((d) => {
        const selector = d.stack.filter((s) => !s.startsWith("@")).at(-1) ?? "";
        return !selector.includes(".state-") && !selector.includes(".frame");
      })
      .map((d) => `${d.file}: ${d.stack.join(" > ")} { ${d.property}: ${d.value} }`);
    expect(misuse).toEqual([]);
    // And something does use them.
    expect(all.some((d) => d.value.includes("var(--state-bottleneck)"))).toBe(true);
  });

  it("8b. tokens.css defines the W-17 tokens, dark by default", () => {
    const root = all.filter(
      (d) => d.file === "styles/tokens.css" && d.stack.length === 1 && d.stack[0] === ":root",
    );
    const defined = Object.fromEntries(root.map((d) => [d.property, d.value]));
    expect(defined).toMatchObject({
      "--bg": "#14181d",
      "--s1": "#1a1f26",
      "--s2": "#212832",
      "--s3": "#2a323d",
      "--line": "#2c343f",
      "--line2": "#3a444f",
      "--t1": "#e4e9ef",
      "--t2": "#98a3b0",
      "--t3": "#69737f",
      "--accent": "#f59042",
      "--state-fed": "#57b96a",
      "--state-throttled": "#dda12e",
      "--state-bottleneck": "#e0594a",
      "--state-paused": "#69737f",
      "--fs-1": "15px",
      "--fs-2": "13px",
      "--fs-3": "12px",
      "--fw-regular": "400",
      "--fw-strong": "600",
      "--hairline": "0.5px",
      "--pulse-cycle": "2.6s",
    });
    expect(defined["--mono"]).toMatch(/monospace/);

    // A light set, by preference and by attribute.
    const lightPref = all.filter(
      (d) =>
        d.file === "styles/tokens.css" &&
        d.stack.some((s) => /prefers-color-scheme:\s*light/.test(s)) &&
        d.property === "--bg",
    );
    const lightAttr = all.filter(
      (d) =>
        d.file === "styles/tokens.css" &&
        d.stack.includes(':root[data-theme="light"]') &&
        d.property === "--bg",
    );
    expect(lightPref).toHaveLength(1);
    expect(lightAttr).toHaveLength(1);

    const num = all.filter((d) => d.stack.at(-1) === ".num");
    expect(Object.fromEntries(num.map((d) => [d.property, d.value]))).toEqual({
      "font-family": "var(--mono)",
      "font-variant-numeric": "tabular-nums",
    });
  });
});
