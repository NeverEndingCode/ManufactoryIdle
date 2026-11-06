// @vitest-environment jsdom
// U-1h / V-16: one name helper, the theme decides the casing; a screen reader always gets the
// content name.
import { act, renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import { itemLabel, itemName, laneLabel, machineLabel, useNames } from "./names.js";
import { freshState, loadSlice, snapshotOf } from "./test-fixtures.js";
import { setTheme, themeDef } from "./theme.js";

let s: Snapshot;
beforeAll(() => {
  const slice = loadSlice();
  s = snapshotOf(slice, freshState(slice));
});

const terminal = themeDef("terminal");
const clean = themeDef("clean-dark");
const cosy = themeDef("cosy");
const industrial = themeDef("industrial");

describe("names (U-1h, V-16)", () => {
  it("1. an item: the id in terminal, the content name in the plain themes, upper in Industrial", () => {
    expect(itemLabel(s, "iron_ore", terminal)).toBe("IRON_ORE");
    expect(itemLabel(s, "iron_ore", clean)).toBe("Iron Ore");
    expect(itemLabel(s, "iron_ore", cosy)).toBe("Iron Ore");
    expect(itemLabel(s, "iron_ore", industrial)).toBe("IRON ORE");
  });

  it("2. a machine at a mark: class id and mark, the mark's content name, or that uppercased", () => {
    expect(machineLabel(s, "constructor", 1, terminal)).toBe("CONSTRUCTOR_MK1");
    expect(machineLabel(s, "constructor", 1, clean)).toBe("Constructor Mk.1");
    expect(machineLabel(s, "constructor", 1, industrial)).toBe("CONSTRUCTOR MK.1");
    expect(machineLabel(s, "constructor", 3, terminal)).toBe("CONSTRUCTOR_MK3");
  });

  // Catches: a mark the content doesn't have rendering "undefined" or the bare class name.
  // MarkDef.name is required, so getMark finding no mark is the one way to the fallback.
  it("2b. a mark the content lacks falls back to the class name and Mk.n", () => {
    expect(s.content.machineClasses.get("constructor")!.marks.some((m) => m.mark === 99)).toBe(
      false,
    );
    expect(machineLabel(s, "constructor", 99, clean)).toBe("Constructor Mk.99");
    expect(machineLabel(s, "constructor", 99, industrial)).toBe("CONSTRUCTOR MK.99");
    expect(machineLabel(s, "constructor", 99, terminal)).toBe("CONSTRUCTOR_MK99");
  });

  it("3. a machine class without a mark", () => {
    expect(machineLabel(s, "constructor", null, terminal)).toBe("CONSTRUCTOR");
    expect(machineLabel(s, "constructor", null, clean)).toBe("Constructor");
    expect(machineLabel(s, "constructor", null, industrial)).toBe("CONSTRUCTOR");
  });

  it("4. a lane: the uppercased name in terminal and Industrial, the name in the plain themes", () => {
    expect(laneLabel(s, "iron", terminal)).toBe("IRON");
    expect(laneLabel(s, "iron", industrial)).toBe("IRON");
    expect(laneLabel(s, "iron", clean)).toBe("Iron");
  });

  it("5. itemName is the content name, whatever the theme", () => {
    expect(itemName(s, "iron_ore")).toBe("Iron Ore");
    expect(itemName(s, "iron_plate")).toBe(s.content.items.get("iron_plate")!.name);
  });

  it("6. useNames is bound to the applied theme", () => {
    act(() => void setTheme("terminal"));
    const { result } = renderHook(() => useNames(s));
    expect(result.current.item("iron_ore")).toBe("IRON_ORE");
    expect(result.current.machine("constructor", 1)).toBe("CONSTRUCTOR_MK1");
    expect(result.current.lane("iron")).toBe("IRON");
    expect(result.current.voice).toBe("shell");
    act(() => void setTheme("clean-light"));
    expect(result.current.item("iron_ore")).toBe("Iron Ore");
    expect(result.current.machine("constructor", null)).toBe("Constructor");
    expect(result.current.voice).toBe("plain");
    expect(result.current.theme.id).toBe("clean-light");
    act(() => void setTheme("terminal"));
  });
});
