// S-14 / W-18 / §13.6, over the CSS source itself: motion lives only inside
// `@media (prefers-reduced-motion: no-preference)`, and only transform and opacity move.
// A small brace-depth scanner, no CSS parser dependency.
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
  where: string;
  property: string;
  value: string;
  /** Every enclosing block's prelude, outermost first. */
  blocks: string[];
}

function scan(where: string, text: string): Decl[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Decl[] = [];
  const blocks: string[] = [];
  let buf = "";
  const decl = () => {
    const d = buf.trim();
    buf = "";
    if (d === "") return;
    const colon = d.indexOf(":");
    if (colon === -1) throw new Error(`${where}: cannot read "${d}"`);
    out.push({
      where,
      property: d.slice(0, colon).trim().toLowerCase(),
      value: d.slice(colon + 1).trim(),
      blocks: [...blocks],
    });
  };
  for (const ch of src) {
    if (ch === "{") {
      blocks.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      decl();
      if (blocks.pop() === undefined) throw new Error(`${where}: unbalanced "}"`);
    } else if (ch === ";") {
      decl();
    } else {
      buf += ch;
    }
  }
  if (blocks.length !== 0) throw new Error(`${where}: unbalanced "{"`);
  return out;
}

const files = cssFiles(SRC);
const decls = files.flatMap((f) => scan(relative(SRC, f), readFileSync(f, "utf8")));
const show = (d: Decl) => `${d.where}: ${d.blocks.join(" > ")} { ${d.property}: ${d.value} }`;

const MOVES = new Set(["transform", "opacity"]);
const NO_PREFERENCE = /^@media\b.*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/;
const TIMING =
  /^(-?[\d.]+m?s|linear|ease(-in|-out|-in-out)?|step-(start|end)|steps\(.*\)|cubic-bezier\(.*\)|var\(.*\)|infinite|alternate(-reverse)?|reverse|normal|forwards|backwards|both)$/;

/** The properties a transition names: "transform 300ms linear, opacity 1s" → both. */
function transitioned(value: string): string[] {
  return value.split(",").map(
    (part) =>
      part
        .trim()
        .split(/\s+/)
        .find((w) => !TIMING.test(w)) ?? "all",
  );
}

describe("motion in the CSS (S-14)", () => {
  it("1a. the scanner reads nesting, and the test sees the motion files", () => {
    const d = scan(
      "x",
      "@media (prefers-reduced-motion: no-preference) { .a { animation: b 1s } }",
    );
    expect(d).toEqual([
      {
        where: "x",
        property: "animation",
        value: "b 1s",
        blocks: ["@media (prefers-reduced-motion: no-preference)", ".a"],
      },
    ]);
    const names = files.map((f) => relative(SRC, f));
    expect(names).toEqual(
      expect.arrayContaining([
        "ui/ItemRow.module.css",
        "ui/LaneView.module.css",
        "ui/BottleneckFrame.module.css",
      ]),
    );
    // The motion this phase adds is here to be checked.
    expect(decls.some((x) => x.blocks.includes("@keyframes sweep"))).toBe(true);
    expect(decls.some((x) => x.blocks.includes("@keyframes conveyor"))).toBe(true);
  });

  it("1b. every animation and transition declaration is inside prefers-reduced-motion: no-preference", () => {
    const outside = decls
      .filter((d) => /^(animation|transition)(-|$)/.test(d.property))
      .filter((d) => !d.blocks.some((b) => NO_PREFERENCE.test(b)))
      .map(show);
    expect(outside).toEqual([]);
  });

  it("1c. every @keyframes body names only transform and opacity", () => {
    const bad = decls
      .filter((d) => d.blocks.some((b) => b.startsWith("@keyframes")))
      .filter((d) => !MOVES.has(d.property))
      .map(show);
    expect(bad).toEqual([]);
  });

  it("1d. no transition lists anything but transform and opacity", () => {
    const bad = decls
      .filter((d) => d.property === "transition" || d.property === "transition-property")
      .filter((d) => transitioned(d.value).some((p) => !MOVES.has(p) && p !== "none"))
      .map(show);
    expect(bad).toEqual([]);
  });
});
