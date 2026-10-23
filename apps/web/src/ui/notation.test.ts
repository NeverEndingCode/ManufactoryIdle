// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, renderHook } from "@testing-library/react";
import { D, format } from "@manufactory/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTATION_KEY, fmt, setNotation, storedNotation, useNotation } from "./notation.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setNotation("hybrid");
  localStorage.clear();
});

describe("notation (S-11)", () => {
  it("fmt follows useNotation's setter, and every subscriber re-renders", () => {
    const v = D(1_234_567);
    const { result } = renderHook(() => useNotation());
    expect(result.current[0]).toBe("hybrid");
    expect(fmt(v)).toBe(format(v, "hybrid"));
    act(() => result.current[1]("sci"));
    expect(result.current[0]).toBe("sci");
    expect(fmt(v)).toBe(format(v, "sci"));
    expect(fmt(v)).not.toBe(format(v, "hybrid"));
  });

  it("persists as mi.notation, and reads it back", () => {
    const { result } = renderHook(() => useNotation());
    act(() => result.current[1]("names"));
    expect(localStorage.getItem(NOTATION_KEY)).toBe("names");
    expect(NOTATION_KEY).toBe("mi.notation");
    expect(storedNotation()).toBe("names");
    localStorage.setItem(NOTATION_KEY, "bogus");
    expect(storedNotation()).toBe("hybrid");
  });

  it("a throwing localStorage falls back to hybrid, and the setter still works", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(storedNotation()).toBe("hybrid");
    const { result } = renderHook(() => useNotation());
    act(() => result.current[1]("eng"));
    expect(result.current[0]).toBe("eng");
  });
});

// The source scan: every number on screen goes through fmt, so the setting reaches it.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const LITERAL = /format\([^)]*,\s*"(sci|eng|names|short|doubled|hybrid)"\)/;
// Stricter: the engine's format is called nowhere but notation.ts (catches nested calls such
// as format(D(x), "hybrid"), which LITERAL's [^)]* stops short of).
const ANY_CALL = /(?<![\w.])format\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("the source scan", () => {
  it('no format(…, "<mode>") outside notation.ts', () => {
    const files = sources(SRC).filter((f) => relative(SRC, f) !== join("ui", "notation.ts"));
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return LITERAL.test(text) || ANY_CALL.test(text);
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
