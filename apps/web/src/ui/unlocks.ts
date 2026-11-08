// U-9d: what a tier unlocks, pure. The banner, the factory log's tier-up line and the tier-up
// announcement (U-8a) all name it from here, so they agree.
import type { IndexedContent, ItemId, LaneId, MachineClassId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { itemLabel, laneLabel, machineLabel } from "./names.js";
import { themeDef, type ThemeDef, type Voice } from "./theme.js";

export interface Unlocks {
  items: ItemId[];
  lanes: LaneId[];
  marks: { machineClass: MachineClassId; mark: number }[];
}

/** The items whose tier is `tier` in lanes unlocked by then, then the lanes whose unlockTier is
 *  `tier`, then the machine marks whose unlockTier is `tier`; each in content order. */
export function unlockedAt(content: IndexedContent, tier: number): Unlocks {
  const laneTier = (id: LaneId) => content.lanes.get(id)?.unlockTier ?? Infinity;
  return {
    items: content.bundle.items
      .filter((i) => i.tier === tier && laneTier(i.lane) <= tier)
      .map((i) => i.id),
    lanes: [...content.bundle.lanes]
      .sort((a, b) => a.order - b.order)
      .filter((l) => l.unlockTier === tier)
      .map((l) => l.id),
    marks: content.bundle.machineClasses.flatMap((c) =>
      c.marks
        .filter((m) => m.unlockTier === tier)
        .map((m) => ({ machineClass: c.id, mark: m.mark })),
    ),
  };
}

/** The voice's names: the terminal's ids for the shell, the content names for plain (U-1h). */
export function voiceTheme(voice: Voice): ThemeDef {
  return themeDef(voice === "shell" ? "terminal" : "clean-dark");
}

function names(s: Snapshot, u: Unlocks, theme: ThemeDef): string[] {
  return [
    ...u.items.map((id) => itemLabel(s, id, theme)),
    ...u.lanes.map((id) => laneLabel(s, id, theme)),
    ...u.marks.map((m) => machineLabel(s, m.machineClass, m.mark, theme)),
  ];
}

/** "ROTOR, STATOR +3" / "Rotor, Stator +3": the first two named (items, then lanes, then marks),
 *  then +N; "" if none. */
export function unlockSummary(s: Snapshot, u: Unlocks, voice: Voice): string {
  const all = names(s, u, voiceTheme(voice));
  const rest = all.length - 2;
  return all.slice(0, 2).join(", ") + (rest > 0 ? ` +${rest}` : "");
}

/** U-8a: "Tier 3 reached. Rotor unlocked." / "Tier 3 reached. Rotor and Stator unlocked." /
 *  "Tier 3 reached. Rotor, Stator and 3 more unlocked." / "Tier 3 reached." */
export function tierUpSaid(s: Snapshot, tier: number): string {
  const all = names(s, unlockedAt(s.content, tier), voiceTheme("plain"));
  const reached = `Tier ${tier} reached.`;
  if (all.length === 0) return reached;
  const rest = all.length - 2;
  const list =
    all.length === 1
      ? all[0]!
      : all.length === 2
        ? `${all[0]} and ${all[1]}`
        : `${all[0]}, ${all[1]} and ${rest} more`;
  return `${reached} ${list} unlocked.`;
}
