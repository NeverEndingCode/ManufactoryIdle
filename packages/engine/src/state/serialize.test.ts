import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { D, type Dec } from "../numbers/decimal.js";
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
    quantum: { ...w.quantum, iron_plate: D(42) },
    bound: { ...w.bound, iron_plate: D("4.01e9") },
    storageLevel: { ...w.storageLevel, iron_plate: 3 },
    qsLevel: { ...w.qsLevel, iron: 2 },
    reserve: { ...w.reserve, iron_plate: 7 },
    powerBank: D("123.5"),
    tapStacks: 3,
    timers: [{ id: "tap", kind: "tapExpiry", fireAt: 1_700_000_030_000 }],
    lifetime: { ...w.lifetime, iron_plate: D("9.87e12") },
  };
}

// Decimal instances round-trip to equal-valued but not necessarily
// reference-or-shape-identical objects, so field-by-field record equality is
// checked through their canonical string form rather than vitest's structural
// `toEqual`.
function decMap(record: Record<string, Dec>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.toString()]));
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
    expect(decMap(back.stored)).toEqual(decMap(w.stored));
    expect(decMap(back.quantum)).toEqual(decMap(w.quantum));
    expect(decMap(back.bound)).toEqual(decMap(w.bound));
    expect(decMap(back.lifetime)).toEqual(decMap(w.lifetime));
    expect(back.storageLevel).toEqual(w.storageLevel);
    expect(back.qsLevel).toEqual(w.qsLevel);
    expect(back.reserve).toEqual(w.reserve);
    expect(back.powerBank.toString()).toBe(w.powerBank.toString());
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

  it('round-trips an item id of "__proto__" as a real entry, not a corrupted prototype', () => {
    // The content schema places no restriction on ids, so "__proto__" is exactly as
    // legal an item id as "constructor" is a legal machine class id. Built here
    // rather than added to the shared fixture: pathological enough to belong in a
    // targeted test, not in content every other task loads. This exercises the
    // write side of the same hazard `ownOrUndefined` guards on the read side --
    // `record[key] = value` reassigns an object's prototype instead of creating an
    // own property when key is "__proto__", which every accumulator in
    // encodeDecimals/decodeDecimals/sortRecord/sortInstalled must avoid.
    const bundle = loadBundleDir(fixtureDir);
    const poisoned = indexContent({
      ...bundle,
      items: [
        ...bundle.items,
        {
          id: "__proto__",
          lane: "iron",
          tier: 0,
          name: "Proto Trap",
          fluid: false,
          terminal: false,
          baseStorageCap: 500,
          baseQuantumCap: 2000,
        },
      ],
    });
    const baseWorld = initialWorld(poisoned, 1, 0);
    // Written via Object.fromEntries, not `{ ...baseWorld.stored, __proto__: D("777") }`:
    // a literal (non-computed) "__proto__" key in an object literal sets the new
    // object's [[Prototype]] instead of creating a data property, which would make
    // this setup line itself reproduce the bug the test exists to catch.
    const stored: Record<string, Dec> = Object.fromEntries([
      ...Object.entries(baseWorld.stored),
      ["__proto__", D("777")],
    ]);
    const w: WorldState = { ...baseWorld, stored };

    const text = serializeWorld(w);
    const back = deserializeWorld(text);

    expect(Object.hasOwn(back.stored, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(back.stored)).toBe(Object.prototype);
    expect(back.stored["__proto__"]!.toString()).toBe(D("777").toString());
    // A poisoned prototype would corrupt every other lookup on the same object too.
    expect(back.stored.iron_ore!.toNumber()).toBe(0);
    expect(serializeWorld(back)).toBe(text);
  });
});
