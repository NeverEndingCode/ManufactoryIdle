// U-1h / V-16: names are always set in --font-mono, and each theme decides the casing
// (ThemeDef.names): terminal shows the id (IRON_ORE, CONSTRUCTOR_MK1), the plain themes the
// content name (Iron Ore, Constructor Mk.1), Industrial that name uppercased (IRON ORE). Lanes
// are uppercased in terminal and Industrial. A screen reader always gets itemName, the content
// name, so it never reads IRON_ORE aloud.
import { useMemo } from "react";
import { getMark, type ItemId, type LaneId, type MachineClassId } from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { useTheme, type ThemeDef, type Voice } from "./theme.js";

/** What a screen reader gets: the content name, always. */
export function itemName(s: Snapshot, itemId: ItemId): string {
  return s.content.items.get(itemId)?.name ?? itemId;
}

/** IRON_ORE | Iron Ore | IRON ORE */
export function itemLabel(s: Snapshot, itemId: ItemId, theme: ThemeDef): string {
  switch (theme.names) {
    case "id":
      return itemId.toUpperCase();
    case "title":
      return itemName(s, itemId);
    case "upper":
      return itemName(s, itemId).toUpperCase();
  }
}

/** CONSTRUCTOR_MK1 | Constructor Mk.1 (the mark's name) | CONSTRUCTOR MK.1; with no mark, the
 *  class: CONSTRUCTOR | Constructor | CONSTRUCTOR. */
export function machineLabel(
  s: Snapshot,
  machineClass: MachineClassId,
  mark: number | null,
  theme: ThemeDef,
): string {
  if (theme.names === "id") {
    const id = machineClass.toUpperCase();
    return mark === null ? id : `${id}_MK${mark}`;
  }
  const className = s.content.machineClasses.get(machineClass)?.name ?? machineClass;
  const name =
    mark === null
      ? className
      : (getMark(s.content, machineClass, mark)?.name ?? `${className} Mk.${mark}`);
  return theme.names === "upper" ? name.toUpperCase() : name;
}

/** IRON in terminal and Industrial, Iron in the plain themes (V-16). */
export function laneLabel(s: Snapshot, laneId: LaneId, theme: ThemeDef): string {
  const name = s.content.lanes.get(laneId)?.name ?? laneId;
  return theme.names === "title" ? name : name.toUpperCase();
}

export interface Names {
  item(id: ItemId): string;
  machine(c: MachineClassId, m: number | null): string;
  lane(id: LaneId): string;
  voice: Voice;
  theme: ThemeDef;
}

/** The helpers bound to the applied theme. */
export function useNames(s: Snapshot): Names {
  const { applied } = useTheme();
  return useMemo(
    () => ({
      item: (id) => itemLabel(s, id, applied),
      machine: (c, m) => machineLabel(s, c, m, applied),
      lane: (id) => laneLabel(s, id, applied),
      voice: applied.voice,
      theme: applied,
    }),
    [s, applied],
  );
}
