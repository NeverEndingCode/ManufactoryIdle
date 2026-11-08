// U-9d: what a tier unlocks, and how the banner, the log and the announcement name it.
import { describe, expect, it } from "vitest";
import { ID_LIKE, freshState, loadSlice, snapshotOf } from "./test-fixtures.js";
import { tierUpSaid, unlockSummary, unlockedAt } from "./unlocks.js";

const slice = loadSlice();
const s = snapshotOf(slice, freshState(slice));
const { content } = slice;

describe("unlockedAt (U-9d)", () => {
  // Catches: items of a lower tier (already shown), items in a lane still locked at t, lanes or
  // marks of another tier, or the three lists out of content order.
  it("1. tier by tier: the items at t in unlocked lanes, then the lanes, then the marks", () => {
    for (let t = 0; t <= content.maxTier; t++) {
      const laneTier = (id: string) => content.lanes.get(id)!.unlockTier;
      const items = content.bundle.items
        .filter((i) => i.tier === t && laneTier(i.lane) <= t)
        .map((i) => i.id);
      const lanes = [...content.bundle.lanes]
        .sort((a, b) => a.order - b.order)
        .filter((l) => l.unlockTier === t)
        .map((l) => l.id);
      const marks = content.bundle.machineClasses.flatMap((c) =>
        c.marks
          .filter((m) => m.unlockTier === t)
          .map((m) => ({ machineClass: c.id, mark: m.mark })),
      );
      expect(unlockedAt(content, t), `tier ${t}`).toEqual({ items, lanes, marks });
    }
    // The slice's tier 3, spelled out once: a lane, and its new items before it.
    const t3 = unlockedAt(content, 3);
    expect(t3.items).toEqual(["rotor", "copper_sheet", "limestone", "concrete"]);
    expect(t3.lanes).toEqual(["coal"]);
    expect(t3.marks).toEqual([
      { machineClass: "miner", mark: 2 },
      { machineClass: "smelter", mark: 2 },
    ]);
  });

  // Catches: naming more than two, a wrong +N, ids in the plain voice, or text for an empty tier.
  it("2. the summary names two, then +N, in both voices; tierUpSaid uses content names", () => {
    const t3 = unlockedAt(content, 3);
    expect(unlockSummary(s, t3, "shell")).toBe("ROTOR, COPPER_SHEET +5");
    expect(unlockSummary(s, t3, "plain")).toBe("Rotor, Copper Sheet +5");
    expect(unlockSummary(s, { items: ["rotor"], lanes: [], marks: [] }, "shell")).toBe("ROTOR");
    // Lanes and marks are named when there are fewer than two items.
    const one = { items: ["rotor"], lanes: ["coal"], marks: [{ machineClass: "miner", mark: 2 }] };
    expect(unlockSummary(s, one, "shell")).toBe("ROTOR, COAL +1");
    expect(unlockSummary(s, one, "plain")).toBe("Rotor, Coal +1");
    expect(unlockSummary(s, { items: [], lanes: [], marks: [] }, "plain")).toBe("");

    expect(tierUpSaid(s, 3)).toBe("Tier 3 reached. Rotor, Copper Sheet and 5 more unlocked.");
    expect(tierUpSaid(s, 3)).not.toMatch(ID_LIKE);
    // Tier 8 in the slice: Smart Plating, Polymer Resin and the Manufacturer Mk.1, so 1 more.
    expect(tierUpSaid(s, 8)).toBe(
      "Tier 8 reached. Smart Plating, Polymer Resin and 1 more unlocked.",
    );
    const empty = Array.from({ length: 30 }, (_, i) => i).find((t) => {
      const u = unlockedAt(content, t);
      return u.items.length + u.lanes.length + u.marks.length === 0;
    })!;
    expect(tierUpSaid(s, empty)).toBe(`Tier ${empty} reached.`);
  });

  // Catches: "A, B unlocked" where a reader expects "and", or "and 0 more".
  it("3. tierUpSaid with exactly two: the slice's tier 9", () => {
    expect(unlockedAt(content, 9)).toEqual({
      items: ["heavy_modular_frame"],
      lanes: [],
      marks: [{ machineClass: "assembly_rig", mark: 1 }],
    });
    expect(unlockSummary(s, unlockedAt(content, 9), "shell")).toBe(
      "HEAVY_MODULAR_FRAME, ASSEMBLY_RIG_MK1",
    );
    expect(tierUpSaid(s, 9)).toBe(
      "Tier 9 reached. Heavy Modular Frame and Assembly Rig Mk.1 unlocked.",
    );
    expect(tierUpSaid(s, 1)).toBe(
      "Tier 1 reached. Screw, Reinforced Iron Plate and 1 more unlocked.",
    );
  });
});
