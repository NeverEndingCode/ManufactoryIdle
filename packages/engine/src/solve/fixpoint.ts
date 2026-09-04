// Spec C.2's three item states and spec C.3's fixed point.
//
// The two halves of the constraint set behave differently, and ruling R6 is why.
// Cyclic recipes are excluded, so the live recipe graph is a DAG:
//
//   FULL  (liquid at cap, production must not exceed consumption)
//         Discharged exactly inside one pass, by walking items in reverse
//         topological order -- consumers before producers -- and scaling each FULL
//         item's producers by consumption/production. Downstream-first is what makes
//         a single sweep enough: throttling i's producers lowers consumption of i's
//         inputs, which are still ahead in the walk, and a later upstream throttle
//         can only lower a downstream item's production further, which relaxes an
//         already-satisfied constraint. With cycles this would need damped
//         iteration.
//
//   EMPTY (no stock, consumption must not exceed production)
//         Enforced structurally by making the requirement walk traverse through the
//         item. Discovered by spec C.3's loop, which pins at least one item per
//         iteration and never unpins, so it terminates in <= |items| passes.
import type { ItemId, RecipeId } from "../content/types.js";
import { POWER_ITEM } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import type { ExpansionVectors } from "../graph/expand.js";
import type { PriorityEntry, WorldState } from "../state/world.js";
import { itemStateTag, liquid, type ItemStateTag } from "../economy/storage.js";
import { runWaterfall, type WaterfallResult } from "./waterfall.js";

/** Rates below this are treated as zero. Comfortably above float64 noise. */
export const FLOW_TOLERANCE = 1e-9;

export interface ItemFlow {
  production: number;
  consumption: number;
  net: number;
}

export function computeFlows(
  content: IndexedContent,
  capacityUnits: ReadonlyMap<RecipeId, number>,
  clocks: ReadonlyMap<RecipeId, number>,
): Map<ItemId, ItemFlow> {
  const flows = new Map<ItemId, ItemFlow>();
  const bump = (itemId: ItemId, produced: number, consumed: number): void => {
    const current = flows.get(itemId) ?? { production: 0, consumption: 0, net: 0 };
    current.production += produced;
    current.consumption += consumed;
    current.net = current.production - current.consumption;
    flows.set(itemId, current);
  };

  for (const itemId of content.itemIds) bump(itemId, 0, 0);

  for (const [recipeId, units] of capacityUnits) {
    const rate = units * (clocks.get(recipeId) ?? 0);
    if (rate === 0) continue;
    const recipe = content.recipes.get(recipeId);
    if (!recipe) continue;
    for (const [itemId, perSecond] of recipe.outputPerSecond) bump(itemId, rate * perSecond, 0);
    for (const [itemId, perSecond] of recipe.inputPerSecond) bump(itemId, 0, rate * perSecond);
  }
  return flows;
}

export interface SolvePassArgs {
  content: IndexedContent;
  vectors: ExpansionVectors;
  state: WorldState;
  capacityUnits: ReadonlyMap<RecipeId, number>;
  entries: readonly PriorityEntry[];
  pinnedEmpty: ReadonlySet<ItemId>;
  reserveFloor: number;
}

export interface SolvePassResult {
  clocks: Map<RecipeId, number>;
  waterfall: WaterfallResult;
  flows: Map<ItemId, ItemFlow>;
  itemStates: Map<ItemId, ItemStateTag>;
}

export function solvePass(args: SolvePassArgs): SolvePassResult {
  const { content, vectors, state, capacityUnits, entries, pinnedEmpty, reserveFloor } = args;

  const waterfall = runWaterfall({
    content,
    vectors,
    activeRecipe: state.activeRecipe,
    capacityUnits,
    entries,
    pinnedEmpty,
    reserveFloor,
  });

  const clocks = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacityUnits) {
    clocks.set(recipeId, units > 0 ? (waterfall.usedUnits.get(recipeId) ?? 0) / units : 0);
  }

  // Computed once, before the sweep: a FULL item stays FULL for the whole sweep --
  // the state does not change mid-solve, only the clocks do.
  const itemStates = new Map<ItemId, ItemStateTag>();
  for (const itemId of content.stockItemIds) {
    itemStates.set(itemId, itemStateTag(content, state, itemId));
  }

  // Spec 3.3's backpressure, discharged in one downstream-first sweep (ruling R6).
  for (let i = content.topologicalItems.length - 1; i >= 0; i -= 1) {
    const itemId = content.topologicalItems[i]!;
    if (itemId === POWER_ITEM) continue;
    if (itemStates.get(itemId) !== "FULL") continue;

    const flows = computeFlows(content, capacityUnits, clocks);
    const flow = flows.get(itemId);
    if (!flow) continue;
    if (flow.production <= flow.consumption + FLOW_TOLERANCE) continue;
    if (flow.production <= 0) continue;

    const factor = flow.consumption / flow.production;
    for (const recipeId of content.producersOf.get(itemId) ?? []) {
      const clock = clocks.get(recipeId);
      if (clock === undefined) continue;
      clocks.set(recipeId, clock * factor);
    }
  }

  return { clocks, waterfall, flows: computeFlows(content, capacityUnits, clocks), itemStates };
}

export interface SolveItemsResult {
  pass: SolvePassResult;
  passes: number;
  pinOrder: ItemId[];
  pinnedEmpty: Set<ItemId>;
}

/**
 * Spec C.3's loop. `seedPins` pre-pins every item with no stock -- not a guess, but
 * a fact about the state: no stock means consumption cannot exceed production, so
 * the pin only asserts something already true. It is conservative (it can add pins
 * the loop would not have found, never remove one) and it makes the priority order
 * decide which target gets scarce upstream capacity rather than leaving it to the
 * order production happens to be pulled in.
 */
export function solveItems(
  args: Omit<SolvePassArgs, "pinnedEmpty"> & { seedPins: boolean },
): SolveItemsResult {
  const { content, state, seedPins } = args;

  const pinnedEmpty = new Set<ItemId>();
  const pinOrder: ItemId[] = [];
  if (seedPins) {
    for (const itemId of content.stockItemIds) {
      if (liquid(state, itemId).lte(0)) {
        pinnedEmpty.add(itemId);
        pinOrder.push(itemId);
      }
    }
  }

  // Each iteration pins at least one item and pins are never removed, so this is a
  // hard bound rather than a hope (spec C.3).
  const limit = content.itemIds.length;
  let pass = solvePass({ ...args, pinnedEmpty });
  let passes = 1;

  while (passes < limit) {
    let worst: ItemId | null = null;
    let worstNet = -FLOW_TOLERANCE;
    for (const itemId of content.stockItemIds) {
      if (pinnedEmpty.has(itemId)) continue;
      if (!liquid(state, itemId).lte(0)) continue;
      const net = pass.flows.get(itemId)?.net ?? 0;
      if (net < worstNet) {
        worstNet = net;
        worst = itemId;
      }
    }
    if (worst === null) break;

    pinnedEmpty.add(worst);
    pinOrder.push(worst);
    pass = solvePass({ ...args, pinnedEmpty });
    passes += 1;
  }

  return { pass, passes, pinOrder, pinnedEmpty };
}
