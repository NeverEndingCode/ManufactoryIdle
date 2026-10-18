// The lane view's display derivations: pure, and computed once per snapshot (W-7);
// affordability lives in quote.ts (W-13). Rates and the boundary
// always come from the server's schedule; only the solution comes from the display solve.
import {
  bestUnlockedMark,
  D,
  DECIMAL_ZERO,
  format,
  isLiveRecipe,
  itemStateTag,
  liquidCap,
  POWER_ITEM,
  type Action,
  type Dec,
  type ItemId,
  type ItemStateTag,
  type LaneDef,
  type LaneId,
  type RecipeId,
  type Solution,
} from "@manufactory/engine";
import { isPlateaued, storageFraction } from "../sync/interpolate.js";
import type { Snapshot } from "../sync/snapshot.js";

export type BuyMachine = Extract<Action, { type: "BUY_MACHINE" }>;

/** The frame's one button (P-3, Q-5): the sim `bottleneck` policy's four actions. */
export type FrameAction =
  | BuyMachine
  | Extract<Action, { type: "BUY_STORAGE" | "BUY_QS" | "SET_RESERVE" }>;

/** "+0.333/s": a net rate, signed when positive. */
export function rateText(net: number): string {
  return `${net > 0 ? "+" : ""}${format(D(net), "hybrid")}/s`;
}

/** The label every bottleneck-buy batch carries; the button is busy while one is pending. */
export const BOTTLENECK_BUY_LABEL = "bottleneck buy";

/** A split bar shows when two or more entries each take more than this share. */
const SPLIT_MIN_SHARE = 0.01;

export interface RowModel {
  itemId: ItemId;
  name: string;
  /** From snapshot.schedule. */
  netPerSecond: number;
  /** P-1. */
  satisfaction: number;
  tag: ItemStateTag;
  /** True when the item's priority entry is paused. */
  paused: boolean;
  /** Neither produced nor consumed: the meter takes the neutral tone, not amber at 0%. */
  idle: boolean;
  capText: string;
  /** null when zero: no QS chip. */
  quantum: Dec | null;
  /** null when zero: no BOUND chip. */
  bound: Dec | null;
  /** Two or more entries above 1% of the primary producer's allocations, else null. */
  split: { entryId: string; label: string; share: number }[] | null;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function nonZero(v: Dec | undefined): Dec | null {
  return v === undefined || v.eq(DECIMAL_ZERO) ? null : v;
}

/** P-1: min(1, production / consumption); with no consumption, 1 if anything is made. */
export function satisfaction(solution: Solution, itemId: ItemId): number {
  const flow = solution.itemRates.get(itemId);
  if (!flow) return 0;
  if (flow.consumption > 0) return Math.min(1, flow.production / flow.consumption);
  return flow.production > 0 ? 1 : 0;
}

function isIdle(solution: Solution, itemId: ItemId): boolean {
  const flow = solution.itemRates.get(itemId);
  return !flow || (flow.production <= 0 && flow.consumption <= 0);
}

/** Lanes by order, up to the world's tier. */
export function unlockedLanes(s: Snapshot): LaneDef[] {
  return s.content.bundle.lanes
    .filter((l) => l.unlockTier <= s.state.tier)
    .sort((a, b) => a.order - b.order);
}

/** A priority entry's display name: its item's, or "power". */
function entryLabel(s: Snapshot, entryId: string): string {
  const entry = s.state.priority.find((e) => e.id === entryId);
  if (!entry) return entryId;
  if (entry.kind === "power") return "power";
  const item = entry.itemId === null ? undefined : s.content.items.get(entry.itemId);
  return item?.name ?? entry.itemId ?? entryId;
}

function primaryProducer(s: Snapshot, itemId: ItemId): RecipeId | undefined {
  return own(s.display.state.activeRecipe, itemId) ?? own(s.content.defaultActiveRecipe, itemId);
}

function splitOf(s: Snapshot, itemId: ItemId): RowModel["split"] {
  const recipeId = primaryProducer(s, itemId);
  const alloc = recipeId === undefined ? undefined : s.display.solution.allocations.get(recipeId);
  if (!alloc) return null;
  let total = 0;
  for (const units of alloc.values()) total += Math.max(0, units);
  if (total <= 0) return null;
  const parts = [...alloc]
    .map(([entryId, units]) => ({ entryId, label: entryLabel(s, entryId), share: units / total }))
    .filter((p) => p.share > SPLIT_MIN_SHARE);
  return parts.length >= 2 ? parts : null;
}

export function laneRows(s: Snapshot, laneId: LaneId): RowModel[] {
  const { content, state } = s;
  const solution = s.display.solution;
  return content.bundle.items
    .filter((item) => item.lane === laneId && item.tier <= state.tier)
    .map((item) => ({
      itemId: item.id,
      name: item.name,
      netPerSecond: s.schedule.items[item.id]?.netPerSecond ?? 0,
      satisfaction: satisfaction(solution, item.id),
      tag: itemStateTag(content, s.display.state, item.id),
      paused: state.priority.some((e) => e.itemId === item.id && e.paused),
      idle: isIdle(solution, item.id),
      capText: format(liquidCap(content, state, item.id), "hybrid"),
      quantum: nonZero(own(state.quantum, item.id)),
      bound: nonZero(own(state.bound, item.id)),
      split: splitOf(s, item.id),
    }));
}

export interface BottleneckModel {
  /** null when no row can carry the frame (a power bottleneck with no generator, or an item
   * outside the unlocked lanes and tier): the advice is a notice, and no tab is marked. */
  laneId: LaneId | null;
  itemId: ItemId | null;
  text: string;
  /** P-3, Q-5. */
  action: FrameAction | null;
}

function itemName(s: Snapshot, itemId: ItemId): string {
  return s.content.items.get(itemId)?.name ?? itemId;
}

function targetName(s: Snapshot, limitingTarget: string): string {
  return entryLabel(s, limitingTarget).toLowerCase();
}

export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** "1 more Constructor clears it", "10 more Constructors clear it". */
function clears(n: number): string {
  return n === 1 ? "clears it" : "clear it";
}

/** The power entry, or the engine's "power" target. */
export function isPowerTarget(s: Snapshot, limitingTarget: string): boolean {
  if (limitingTarget === "power") return true;
  return s.state.priority.some((e) => e.id === limitingTarget && e.kind === "power");
}

/** The class's display name, for "Buy N <class name>". */
export function className(s: Snapshot, machineClass: string, count: number): string {
  return plural(count, s.content.machineClasses.get(machineClass)?.name ?? machineClass);
}

/** P-3: the sim's bottleneck purchase, without its fallback to smaller counts. */
function machineBuy(s: Snapshot, recipeId: RecipeId, machinesToClear: number): BuyMachine | null {
  const recipe = s.content.recipes.get(recipeId);
  if (!recipe) return null;
  const mark = bestUnlockedMark(s.content, recipe.machineClass, s.state.tier);
  if (mark === null) return null;
  return {
    type: "BUY_MACHINE",
    lane: recipe.lane,
    machineClass: recipe.machineClass,
    mark,
    count: Math.max(1, machinesToClear),
    ...(isLiveRecipe(s.content, recipeId, s.state.tier, s.state.activeRecipe) ? { recipeId } : {}),
  };
}

function recipeRow(
  s: Snapshot,
  recipeId: RecipeId,
  limitingTarget: string,
  machinesToClear: number,
): BottleneckModel | null {
  const recipe = s.content.recipes.get(recipeId);
  if (!recipe) return null;
  const n = Math.max(1, machinesToClear);
  const more = `${n} more ${className(s, recipe.machineClass, n)} ${clears(n)}.`;
  const generator = recipe.primaryOutput === POWER_ITEM;
  const limiter = generator ? recipe.def.name : itemName(s, recipe.primaryOutput);
  const text = isPowerTarget(s, limitingTarget)
    ? `Power is limited by ${limiter.toLowerCase()}. ${more}`
    : `Limiting ${targetName(s, limitingTarget)}. ${more}`;
  // A generator's primary output is the power pseudo-item, which has no row: frame its
  // scarcest stock input (Q-5).
  const itemId = generator ? scarcestInput(s, [...recipe.inputPerSecond.keys()]) : recipe.primaryOutput;
  return {
    laneId: itemId === null ? null : (s.content.items.get(itemId)?.lane ?? null),
    itemId,
    text,
    action: machineBuy(s, recipeId, machinesToClear),
  };
}

/** Q-5: among the inputs that render as rows, the lowest P-1 satisfaction; ties to the lower
 * storage fraction at atMs, then authored order. With none shown, the first input. */
function scarcestInput(s: Snapshot, inputs: readonly ItemId[]): ItemId | null {
  const shown = inputs.filter((id) => isShownItem(s, id));
  if (shown.length === 0) return inputs[0] ?? null;
  const solution = s.display.solution;
  const atMs = s.schedule.atMs;
  let best = shown[0]!;
  for (const id of shown.slice(1)) {
    const a = satisfaction(solution, id);
    const b = satisfaction(solution, best);
    if (a < b || (a === b && storageFraction(s, id, atMs) < storageFraction(s, best, atMs))) {
      best = id;
    }
  }
  return best;
}

function isShownItem(s: Snapshot, itemId: ItemId): boolean {
  const item = s.content.items.get(itemId);
  const lane = item === undefined ? undefined : s.content.lanes.get(item.lane);
  return (
    item !== undefined &&
    lane !== undefined &&
    item.tier <= s.state.tier &&
    lane.unlockTier <= s.state.tier
  );
}

/** The frame needs a rendered row: an item in an unlocked lane, at or under the tier. */
function shownAsRow(s: Snapshot, m: BottleneckModel): BottleneckModel {
  if (m.itemId === null) return m;
  return isShownItem(s, m.itemId) ? m : { ...m, laneId: null, itemId: null, action: null };
}

/** P-2: the one framed row in the whole factory, from the display solve's bottleneck. */
export function bottleneckRow(s: Snapshot): BottleneckModel | null {
  const m = bottleneckModel(s);
  return m === null ? null : shownAsRow(s, m);
}

function bottleneckModel(s: Snapshot): BottleneckModel | null {
  const b = s.display.solution.bottleneck;
  if (b === null) return null;
  switch (b.kind) {
    case "recipe":
      return recipeRow(s, b.recipeId, b.limitingTarget, b.machinesToClear);
    case "power":
      if (b.generatorRecipeId === null)
        return {
          laneId: null,
          itemId: null,
          text: `Power is short, limiting ${targetName(s, b.limitingTarget)}. Build a generator.`,
          action: null,
        };
      return recipeRow(s, b.generatorRecipeId, b.limitingTarget, b.machinesToClear);
    case "storage": {
      const what = b.upgrade === "quantum" ? "Quantum Storage" : "storage";
      const text =
        b.upgrade === null
          ? `${itemName(s, b.itemId)} is at its cap, limiting ${targetName(s, b.limitingTarget)}.`
          : `${itemName(s, b.itemId)} is at its cap, limiting ${targetName(s, b.limitingTarget)}. More ${what} clears it.`;
      const lane = s.content.items.get(b.itemId)?.lane ?? null;
      return {
        laneId: lane,
        itemId: b.itemId,
        text,
        action:
          b.upgrade === "storage"
            ? { type: "BUY_STORAGE", itemId: b.itemId, levels: 1 }
            : b.upgrade === "quantum" && lane !== null
              ? { type: "BUY_QS", lane, levels: 1 }
              : null,
      };
    }
    case "reserve":
      return {
        laneId: s.content.items.get(b.itemId)?.lane ?? null,
        itemId: b.itemId,
        text: `${itemName(s, b.itemId)} never banks, limiting ${targetName(s, b.limitingTarget)}. Reserve ${Math.round(b.percent * 100)}% of it to clear it.`,
        action:
          (own(s.state.reserve, b.itemId) ?? 0) === b.percent
            ? null
            : { type: "SET_RESERVE", itemId: b.itemId, percent: b.percent },
      };
  }
}

/** P-4's notice text, as the store words it; shown whenever the snapshot is plateaued. */
export function plateauText(s: Snapshot): string | null {
  if (!isPlateaued(s)) return null;
  const hours = s.content.offlineCapMs / 3_600_000;
  return `Production paused ${hours} h after your last action. Do anything to resume.`;
}

/** The meter's state class: fed at 98%, throttled below, paused for a paused entry, and idle
 * (the paused grey, never amber at 0%) for an item nothing makes or uses. */
export function stateClass(
  row: Pick<RowModel, "satisfaction" | "paused" | "idle">,
): "fed" | "throttled" | "paused" | "idle" {
  if (row.paused) return "paused";
  if (row.idle) return "idle";
  return row.satisfaction >= 0.98 ? "fed" : "throttled";
}
