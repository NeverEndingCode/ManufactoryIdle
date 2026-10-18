// The lane view's display derivations: pure, and computed once per snapshot, except
// affordability, which the 4 Hz text tick re-reads (W-7, W-13). Rates and the boundary
// always come from the server's schedule; only the solution comes from the display solve.
import {
  bestUnlockedMark,
  DECIMAL_ZERO,
  format,
  isLiveRecipe,
  itemStateTag,
  liquidCap,
  machineCostRange,
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
import { isPlateaued, shownStock } from "../sync/interpolate.js";
import { plateauAtMs, type Snapshot } from "../sync/snapshot.js";

export type BuyMachine = Extract<Action, { type: "BUY_MACHINE" }>;

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
  /** P-3. */
  buy: BuyMachine | null;
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
function isPowerTarget(s: Snapshot, limitingTarget: string): boolean {
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
  // A generator's primary output is the power pseudo-item, which has no row: frame its fuel.
  const itemId =
    generator
      ? (recipe.inputPerSecond.keys().next().value ?? null)
      : recipe.primaryOutput;
  return {
    laneId: itemId === null ? null : (s.content.items.get(itemId)?.lane ?? null),
    itemId,
    text,
    buy: machineBuy(s, recipeId, machinesToClear),
  };
}

/** The frame needs a rendered row: an item in an unlocked lane, at or under the tier. */
function shownAsRow(s: Snapshot, m: BottleneckModel): BottleneckModel {
  if (m.itemId === null) return m;
  const item = s.content.items.get(m.itemId);
  const lane = item === undefined ? undefined : s.content.lanes.get(item.lane);
  const visible =
    item !== undefined &&
    lane !== undefined &&
    item.tier <= s.state.tier &&
    lane.unlockTier <= s.state.tier;
  return visible ? m : { ...m, laneId: null, itemId: null, buy: null };
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
          buy: null,
        };
      return recipeRow(s, b.generatorRecipeId, b.limitingTarget, b.machinesToClear);
    case "storage": {
      const what = b.upgrade === "quantum" ? "Quantum Storage" : "storage";
      const text =
        b.upgrade === null
          ? `${itemName(s, b.itemId)} is at its cap, limiting ${targetName(s, b.limitingTarget)}.`
          : `${itemName(s, b.itemId)} is at its cap, limiting ${targetName(s, b.limitingTarget)}. More ${what} clears it.`;
      return {
        laneId: s.content.items.get(b.itemId)?.lane ?? null,
        itemId: b.itemId,
        text,
        buy: null,
      };
    }
    case "reserve":
      return {
        laneId: s.content.items.get(b.itemId)?.lane ?? null,
        itemId: b.itemId,
        text: `${itemName(s, b.itemId)} never banks, limiting ${targetName(s, b.limitingTarget)}. Reserve ${Math.round(b.percent * 100)}% of it to clear it.`,
        buy: null,
      };
  }
}

export type Affordability =
  | { affordable: true }
  /** inMs null: not reachable on current rates. */
  | { affordable: false; inMs: number | null };

/** From interpolated liquid plus bound, against the purchase's cost (W-13, P-3). */
export function affordability(s: Snapshot, action: BuyMachine, serverMs: number): Affordability {
  const owned = s.state.installed[action.lane]?.[action.machineClass]?.[action.mark - 1] ?? 0;
  const costs = machineCostRange(s.content, action.machineClass, action.mark, owned, action.count);
  let inMs: number | null = 0;
  let short = false;
  for (const [itemId, need] of costs) {
    const bound = own(s.state.bound, itemId) ?? DECIMAL_ZERO;
    const have = shownStock(s, itemId, serverMs).plus(bound);
    if (have.gte(need)) continue;
    short = true;
    if (inMs === null) continue;
    const net = s.schedule.items[itemId]?.netPerSecond ?? 0;
    // The line stops at the cap, and at the plateau: past either the wait never ends.
    if (net <= 0 || need.minus(bound).gt(liquidCap(s.content, s.state, itemId))) {
      inMs = null;
      continue;
    }
    inMs = Math.max(inMs, (need.minus(have).toNumber() / net) * 1000);
  }
  if (!short) return { affordable: true };
  if (inMs !== null && serverMs + inMs > plateauAtMs(s)) inMs = null;
  return { affordable: false, inMs };
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
