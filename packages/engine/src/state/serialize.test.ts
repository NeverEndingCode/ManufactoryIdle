import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D } from "../numbers/decimal.js";
import { indexContent } from "../graph/index-content.js";
import { deserializeWorld, serializeWorld } from "./serialize.js";
import { initialWorld, type WorldState } from "./world.js";

const fixtureDir = fileURLToPath(new URL("../../../content/bundles/fixture", import.meta.url));
const content = indexContent(loadBundleDir(fixtureDir));

function populated(): WorldState {
  const w = initialWorld(content, 42, 1_700_000_000_000);
  return {
    ...w,
    tier: 2,
    stored: { ...w.stored, iron_plate: D("1.2345e678"), iron_ore: D(500) },
    bound: { ...w.bound, iron_plate: D("4.01e9") },
    tapStacks: 3,
    timers: [{ id: "tap", kind: "tapExpiry", fireAt: 1_700_000_030_000 }],
    lifetime: { ...w.lifetime, iron_plate: D("9.87e12") },
  };
}

describe("serializeWorld", () => {
  it("round-trips every field", () => {
    const w = populated();
    const back = deserializeWorld(serializeWorld(w));
    expect(back.schemaVersion).toBe(w.schemaVersion);
    expect(back.contentVersion).toBe(w.contentVersion);
    expect(back.tier).toBe(2);
    expect(back.seed).toEqual(w.seed);
    expect(back.installed).toEqual(w.installed);
    expect(back.assignment).toEqual(w.assignment);
    expect(back.activeRecipe).toEqual(w.activeRecipe);
    expect(back.priority).toEqual(w.priority);
    expect(back.timers).toEqual(w.timers);
    expect(back.tapStacks).toBe(3);
    expect(back.lastResolvedAt).toBe(w.lastResolvedAt);
  });

  it("round-trips magnitudes far past float64 exactly", () => {
    const back = deserializeWorld(serializeWorld(populated()));
    expect(back.stored.iron_plate!.toString()).toBe(D("1.2345e678").toString());
    expect(back.bound.iron_plate!.toString()).toBe(D("4.01e9").toString());
    expect(back.lifetime.iron_plate!.toString()).toBe(D("9.87e12").toString());
  });

  it("writes Decimals as canonical strings, never as JSON numbers", () => {
    const text = serializeWorld(populated());
    expect(text).toContain('"iron_plate":"1.2345e678"');
    expect(text).not.toContain("1.2345e+678");
  });

  it("is byte-stable across repeated calls", () => {
    const w = populated();
    expect(serializeWorld(w)).toBe(serializeWorld(w));
  });

  it("does not depend on key insertion order", () => {
    const w = populated();
    const shuffled: WorldState = { ...w, stored: { iron_ore: w.stored.iron_ore!, ...w.stored } };
    expect(serializeWorld(shuffled)).toBe(serializeWorld(w));
  });

  it("is idempotent under a second round trip", () => {
    const once = serializeWorld(populated());
    expect(serializeWorld(deserializeWorld(once))).toBe(once);
  });

  it("rejects a payload from a different schema version", () => {
    const text = serializeWorld(populated()).replace('"schemaVersion":1', '"schemaVersion":99');
    expect(() => deserializeWorld(text)).toThrow(/schema version/i);
  });
});
