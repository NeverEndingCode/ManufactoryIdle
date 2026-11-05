// U-1g / V-5: the self-hosted faces draw the glyphs UI-1 puts in them. A woff2 reader decodes
// each file's cmap (header, table directory, one Brotli stream; cmap is never transformed), and
// a face counts a glyph only where a fonts.css rule both maps it and lists it in unicode-range,
// which is what the browser does. Node-only, so it lives here and not in the app (W-4).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const STYLES = fileURLToPath(new URL(".", import.meta.url));
const FONTS = join(STYLES, "fonts");
const fontsCss = readFileSync(join(STYLES, "fonts.css"), "utf8");

// ---- the woff2 reader -------------------------------------------------------------------

/** WOFF2's known-table tags, by flag index 0..62 (63 means an explicit tag follows). */
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf",
  "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT",
  "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT",
  "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar",
  "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd",
  "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
]; // prettier-ignore

/** The decompressed tables of a (non-collection) woff2, by tag. */
function woff2Tables(buf: Buffer): Map<string, Buffer> {
  if (buf.toString("latin1", 0, 4) !== "wOF2") throw new Error("not a woff2 file");
  if (buf.toString("latin1", 4, 8) === "ttcf") throw new Error("font collections unsupported");
  const numTables = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  let p = 48; // the header
  const base128 = (): number => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[p++]!;
      if (i === 0 && b === 0x80) throw new Error("UIntBase128 with a leading zero");
      v = v * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new Error("UIntBase128 longer than 5 bytes");
  };
  const dir: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++]!;
    let tag: string;
    if ((flags & 0x3f) === 0x3f) {
      tag = buf.toString("latin1", p, p + 4);
      p += 4;
    } else {
      tag = KNOWN_TAGS[flags & 0x3f]!;
    }
    const version = flags >> 6;
    const origLength = base128();
    // glyf and loca are transformed at version 0; every other table at a non-zero version.
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    dir.push({ tag, length: transformed ? base128() : origLength });
  }
  const data = brotliDecompressSync(buf.subarray(p, p + compressed));
  const out = new Map<string, Buffer>();
  let o = 0;
  for (const t of dir) {
    out.set(t.tag, data.subarray(o, o + t.length));
    o += t.length;
  }
  if (o !== data.length) throw new Error(`table lengths ${o} != stream ${data.length}`);
  return out;
}

/** Every code point a cmap maps to a glyph other than .notdef (formats 4 and 12). */
function cmapCodePoints(cmap: Buffer): Set<number> {
  const cps = new Set<number>();
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const off = cmap.readUInt32BE(4 + i * 8 + 4);
    const format = cmap.readUInt16BE(off);
    if (format === 4) {
      const segs = cmap.readUInt16BE(off + 6) / 2;
      const ends = off + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const ranges = deltas + segs * 2;
      for (let k = 0; k < segs; k++) {
        const end = cmap.readUInt16BE(ends + k * 2);
        const start = cmap.readUInt16BE(starts + k * 2);
        const delta = cmap.readUInt16BE(deltas + k * 2);
        const rangeOffset = cmap.readUInt16BE(ranges + k * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (rangeOffset === 0) g = (c + delta) & 0xffff;
          else {
            g = cmap.readUInt16BE(ranges + k * 2 + rangeOffset + (c - start) * 2);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g !== 0) cps.add(c);
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(off + 12);
      for (let k = 0; k < groups; k++) {
        const b = off + 16 + k * 12;
        const start = cmap.readUInt32BE(b);
        const end = cmap.readUInt32BE(b + 4);
        const glyph = cmap.readUInt32BE(b + 8);
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) cps.add(c);
      }
    }
  }
  return cps;
}

const cmapCache = new Map<string, Set<number>>();
function codePoints(file: string): Set<number> {
  let cps = cmapCache.get(file);
  if (!cps) {
    const cmap = woff2Tables(readFileSync(join(STYLES, file))).get("cmap");
    if (!cmap) throw new Error(`${file}: no cmap`);
    cps = cmapCodePoints(cmap);
    cmapCache.set(file, cps);
  }
  return cps;
}

// ---- fonts.css ----------------------------------------------------------------------------

interface Face {
  family: string;
  weight: [number, number];
  url: string;
  ranges: [number, number][];
  display: string | undefined;
}

function faces(css: string): Face[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...src.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const props = Object.fromEntries(
      m[1]!
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
    );
    const w = (props["font-weight"] ?? "400").split(/\s+/).map(Number);
    const url = /url\("([^"]+)"\)\s*format\("woff2"\)/.exec(props.src ?? "");
    if (!url) throw new Error(`@font-face without a woff2 url(): ${m[0]}`);
    return {
      family: (props["font-family"] ?? "").replace(/^["']|["']$/g, ""),
      weight: [w[0]!, w[1] ?? w[0]!],
      url: url[1]!,
      ranges: (props["unicode-range"] ?? "U+0-10FFFF").split(",").map((r) => {
        const [a, b] = r.trim().replace(/^U\+/i, "").split("-");
        return [parseInt(a!, 16), parseInt(b ?? a!, 16)];
      }),
      display: props["font-display"],
    };
  });
}

const FACES = faces(fontsCss);

/** What the browser can draw in this family at this weight from fonts.css. */
function covers(family: string, weight: number, ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return FACES.some(
    (f) =>
      f.family === family &&
      f.weight[0] <= weight &&
      weight <= f.weight[1] &&
      f.ranges.some(([a, b]) => a <= c && c <= b) &&
      codePoints(f.url).has(c),
  );
}

/** V-5: the glyphs UI-1 draws in the mono faces. ■□ stand in for ▮▯ (neither face has them). */
const MONO_GLYPHS = [..."→●■□▴≡·▁▂▃▄▅▆▇█"];

describe("the self-hosted fonts (U-1g, V-5)", () => {
  it("1. the reader finds A in every latin file", () => {
    const latin = FACES.filter((f) => f.url.includes("-latin-"));
    expect(latin.length).toBeGreaterThanOrEqual(15);
    for (const f of latin) expect(codePoints(f.url).has(0x41), f.url).toBe(true);
  });

  it("2. VT323 draws the bar brackets", () => {
    expect(covers("VT323", 400, "[")).toBe(true);
    expect(covers("VT323", 400, "]")).toBe(true);
  });

  it.each([
    ["IBM Plex Mono", 400],
    ["IBM Plex Mono", 500],
    ["IBM Plex Mono", 600],
    ["JetBrains Mono", 400],
    ["JetBrains Mono", 500],
  ])("3. %s %i draws every mono glyph", (family, weight) => {
    expect(MONO_GLYPHS.filter((g) => !covers(family, weight, g))).toEqual([]);
  });

  it("4. every face swaps, and every url() is a file on disk", () => {
    expect(FACES.length).toBeGreaterThan(0);
    for (const f of FACES) {
      expect(f.display, f.url).toBe("swap");
      expect(f.url, f.url).toMatch(/^\.\/fonts\/[a-z0-9-]+\.woff2$/);
      expect(existsSync(join(STYLES, f.url)), f.url).toBe(true);
    }
  });

  it("5. every family has its OFL.txt, and every file on disk is declared", () => {
    const slugs = new Set(FACES.map((f) => f.family.toLowerCase().replace(/\s+/g, "-")));
    expect(slugs.size).toBe(7);
    for (const slug of slugs) {
      const ofl = join(FONTS, slug, "OFL.txt");
      expect(existsSync(ofl), ofl).toBe(true);
      expect(readFileSync(ofl, "utf8")).toContain("SIL Open Font License, Version 1.1");
    }
    const declared = new Set(FACES.map((f) => f.url.replace("./fonts/", "")));
    const onDisk = readdirSync(FONTS).filter((n) => n.endsWith(".woff2"));
    expect(onDisk.sort()).toEqual([...declared].sort());
  });

  it("6. no font request leaves the origin (W-2)", () => {
    // The provenance comment names the upstreams; the rules may not.
    const rules = fontsCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/googleapis|gstatic|https?:\/\/|\/\//);
  });
});
