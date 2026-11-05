// The power readouts (Q-12, U-6): the grid from the display solve, and the tap's stacks, kick
// and remaining time, optimistic until the flush's response lands (W-12). The footer, the
// floating TAP and the power panel all read dockModel; the panel adds the per-generator and
// per-lane numbers below (V-21).
import {
  bestUnlockedMark,
  D,
  getMark,
  installedMachines,
  isLiveRecipe,
  laneClassKey,
  POWER_ITEM,
  TAP_TIMER_ID,
  tapMultiplier,
  type ItemId,
  type LaneId,
  type MachineClassId,
  type RecipeId,
} from "@manufactory/engine";
import { localTimeOf, type Snapshot } from "../sync/snapshot.js";
import { TAP_LABEL } from "../sync/constants.js";
import type { Batch } from "../sync/outbox.js";
import type { StoreView } from "../sync/store.js";
import { isPowerTarget, type BuyMachine } from "./derive.js";
import { fmt } from "./notation.js";

export interface DockModel {
  demandMw: number;
  supplyMw: number;
  fullDemandMw: number;
  ratio: number;
  /** The bottleneck is power: kind "power", or a recipe limiting the power entry (Q-5). */
  limited: boolean;
  stacks: number;
  maxStacks: number;
  /** The tap multiplier at the shown stacks, e.g. 1.25. */
  kick: number;
  remainingMs: number;
  injectionMw: number;
}

export function dockModel(
  s: Snapshot,
  taps: StoreView["taps"],
  clientNow: number,
  /** The store view's outbox: its TAP batches are flushed taps the snapshot hasn't counted yet. */
  pending: readonly Batch[] = [],
): DockModel {
  const { demandMw, fullDemandMw, supplyMw, ratio } = s.display.solution.power;
  const b = s.display.solution.bottleneck;
  const limited =
    b !== null &&
    (b.kind === "power" || (b.kind === "recipe" && isPowerTarget(s, b.limitingTarget)));

  const tap = s.content.bundle.tap;
  const state = s.display.state;
  // The later of the server's shared expiry and 30 s from the last local tap.
  const timer = state.timers.find((t) => t.id === TAP_TIMER_ID);
  const serverEnd = timer === undefined ? -Infinity : localTimeOf(s, timer.fireAt);
  const localEnd =
    taps.lastTapAt === null ? -Infinity : taps.lastTapAt + tap.durationSeconds * 1000;
  const end = Math.max(serverEnd, localEnd);
  const remainingMs = Number.isFinite(end) ? Math.max(0, end - clientNow) : 0;
  // Past the SERVER's expiry its stacks are gone, before the next snapshot says so; a local
  // tap since then extends the readout's time, not the expired stacks.
  const base = serverEnd > clientNow ? state.tapStacks : 0;
  let inFlight = 0;
  for (const b of pending) {
    if (b.label !== TAP_LABEL) continue;
    for (const a of b.actions) if (a.type === "TAP") inFlight += a.count;
  }
  const stacks = Math.min(tap.maxStacks, base + taps.pending + inFlight);
  return {
    demandMw,
    supplyMw,
    fullDemandMw,
    ratio,
    limited,
    stacks,
    maxStacks: tap.maxStacks,
    kick: tapMultiplier(s.content, { ...state, tapStacks: stacks }),
    remainingMs,
    injectionMw: stacks > 0 ? tap.powerInjectionMw : 0,
  };
}

// U-6b / V-21: the power panel's numbers, from the display solve. Pure, per snapshot.

/** One generator class's row in the panel's GENERATORS section. */
export interface GeneratorRow {
  machineClass: MachineClassId;
  /** The class's live power recipe, else its first. */
  recipeId: RecipeId;
  lane: LaneId;
  /** Installed in the lane, every mark. */
  owned: number;
  /** The best unlocked mark; null while the class (or its recipe) is locked. */
  mark: number | null;
  unlockTier: number;
  /** Σ inputPerSecond × unitsByRecipe × clock, per input, in recipe order. */
  eats: { itemId: ItemId; perSecond: number }[];
  /** powerOutput × unitsByRecipe / machinesByRecipe (multipliers in); with none assigned, what
   * one best-mark machine adds at clock 1. */
  mwEach: number;
  /** powerOutput × unitsByRecipe × clock. */
  mwNow: number;
  /** +1: the best unlocked mark, count 1, naming the recipe while it's live; null when locked. */
  buy: BuyMachine | null;
}

/** The +1's batch label, one per class: its button is busy while one is out (W-13). */
export const generatorLabel = (machineClass: MachineClassId) => `power:${machineClass}:buy`;

/** One row per class among producersOf(POWER_ITEM), in content order. */
export function generatorRows(s: Snapshot): GeneratorRow[] {
  const { content } = s;
  const { tier, activeRecipe } = s.state;
  const { capacity, clocks } = s.display.solution;
  const byClass = new Map<MachineClassId, RecipeId[]>();
  for (const recipeId of content.producersOf.get(POWER_ITEM) ?? []) {
    const recipe = content.recipes.get(recipeId);
    if (recipe === undefined) continue;
    byClass.set(recipe.machineClass, [...(byClass.get(recipe.machineClass) ?? []), recipeId]);
  }
  return [...byClass].map(([machineClass, recipeIds]) => {
    const live = recipeIds.find((id) => isLiveRecipe(content, id, tier, activeRecipe));
    const recipeId = live ?? recipeIds[0]!;
    const recipe = content.recipes.get(recipeId)!;
    const lane = recipe.lane;
    const cls = content.machineClasses.get(machineClass);
    const firstMark = Math.min(...(cls?.marks.map((m) => m.unlockTier) ?? [0]));
    const unlockTier = Math.max(recipe.def.unlockTier, firstMark);
    const best = bestUnlockedMark(content, machineClass, tier);
    const mark = live === undefined ? null : best;

    let mwNow = 0;
    const eats = new Map<ItemId, number>();
    for (const id of recipeIds) {
      const r = content.recipes.get(id)!;
      const units = capacity.unitsByRecipe.get(id) ?? 0;
      const clock = clocks.get(id) ?? 0;
      mwNow += (r.outputPerSecond.get(POWER_ITEM) ?? 0) * units * clock;
      for (const [itemId, rate] of r.inputPerSecond)
        eats.set(itemId, (eats.get(itemId) ?? 0) + rate * units * clock);
    }
    const out = recipe.outputPerSecond.get(POWER_ITEM) ?? 0;
    const units = capacity.unitsByRecipe.get(recipeId) ?? 0;
    const machines = capacity.machinesByRecipe.get(recipeId) ?? 0;
    const markDef = best === null ? undefined : cls?.marks.find((m) => m.mark === best);
    const mwEach =
      machines > 0
        ? (out * units) / machines
        : out * (capacity.unitsPerMachine.get(recipeId) ?? markDef?.rateMultiplier ?? 1);
    return {
      machineClass,
      recipeId,
      lane,
      owned: installedMachines(s.state, lane, machineClass),
      mark,
      unlockTier,
      eats: [...eats].map(([itemId, perSecond]) => ({ itemId, perSecond })),
      mwEach,
      mwNow,
      buy:
        mark === null
          ? null
          : { type: "BUY_MACHINE", lane, machineClass, mark, count: 1, recipeId },
    };
  });
}

/** BIGGEST USERS: Σ machinesByRecipe × drawPerMachine × solution.clocks per recipe.lane, skipping
 * generators. The display clocks are absolute (scaled by the grid ratio for consumers), so the
 * groups add up to demandMw; the solve's pass clocks would give fullDemandMw (V-21). Descending,
 * drawn MW only. */
export function powerByLane(s: Snapshot): { laneId: LaneId; mw: number }[] {
  const { content } = s;
  const { capacity, clocks } = s.display.solution;
  const byLane = new Map<LaneId, number>();
  for (const [recipeId, machines] of capacity.machinesByRecipe) {
    if (machines <= 0) continue;
    const recipe = content.recipes.get(recipeId);
    if (recipe === undefined || recipe.def.powerOutput > 0) continue;
    const each = capacity.drawPerMachine.get(laneClassKey(recipe.lane, recipe.machineClass)) ?? 0;
    const mw = machines * each * (clocks.get(recipeId) ?? 0);
    byLane.set(recipe.lane, (byLane.get(recipe.lane) ?? 0) + mw);
  }
  return [...byLane]
    .filter(([, mw]) => mw > 0)
    .map(([laneId, mw]) => ({ laneId, mw }))
    .sort((a, b) => b.mw - a.mw);
}

/** "next machine needs up to N MW": the largest content powerDraw of the best unlocked mark over
 * the live non-generator lane-classes in unlocked lanes, what one more draws at clock 1. Not
 * drawPerMachine, a pool mean that's 0 for an empty pool (V-21). */
export function nextMachineDrawMw(s: Snapshot): number {
  const { content } = s;
  const tier = s.state.tier;
  let most = 0;
  for (const recipeId of s.display.solution.capacity.machinesByRecipe.keys()) {
    const recipe = content.recipes.get(recipeId);
    if (recipe === undefined || recipe.def.powerOutput > 0) continue;
    if ((content.lanes.get(recipe.lane)?.unlockTier ?? Infinity) > tier) continue;
    const mark = bestUnlockedMark(content, recipe.machineClass, tier);
    if (mark === null) continue;
    const draw = getMark(content, recipe.machineClass, mark)?.powerDraw ?? 0;
    most = Math.max(most, draw);
  }
  return most;
}

/** Whole MW, and the notation past 10,000 (the footer, the header, the panel). */
export function mwText(n: number): string {
  return Math.abs(n) >= 10_000 ? fmt(D(n)) : String(Math.round(n));
}

/** U-6c's accessible name: per snapshot and per tap, never at 4 Hz (V-22), so the caller memoises
 * it; "Tap, hold to keep the kick" with no stacks. */
export function tapName(m: DockModel): string {
  if (m.stacks <= 0) return "Tap, hold to keep the kick";
  const secs = Math.ceil(m.remainingMs / 1000);
  return (
    `Tap, hold to keep tapping. Kick times ${m.kick.toFixed(2)}, ` +
    `${m.stacks} of ${m.maxStacks} stacks, ${secs} ${secs === 1 ? "second" : "seconds"} left`
  );
}
