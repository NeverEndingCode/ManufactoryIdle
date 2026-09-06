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
//         Discovered by spec C.3's loop, which pins at least one item per iteration
//         and never unpins, so it terminates in <= |items| passes. Pinning alone
//         only changes what solve/waterfall.ts's requirement walk traverses through:
//         for most items that walk reaches the item's own active (primary-output)
//         recipe and so throttles consumers automatically as it composes the
//         requirement vector. A byproduct-only item (e.g. the fixture's
//         heavy_oil_residue) is never anyone's primary output, so the walk has
//         nothing to recurse into and returns empty -- the item is pinned but
//         nothing is constrained by it. Ruling R30 (task 10, fix round 1) closes
//         that gap with an explicit clamp below, structurally identical to the FULL
//         sweep but mirrored: forward topological order -- producers before
//         consumers -- scaling each EMPTY item's CONSUMERS by production/consumption
//         when consumption would outrun production. This is the runtime EMPTY
//         invariant from spec C.2 ("what everything in the engine rests on") and
//         spec 3.4 ("fluids are otherwise ordinary nodes in the solver"); it is
//         deliberately distinct from expand.ts's rawCost cutoff, which is a
//         cost-accounting convention (byproducts are free build-cost leaves) and is
//         untouched by this clamp.
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

  // Ruling R31: every recipe whose clock either sweep below actually multiplies
  // gets recorded here, so the reconciliation pass at the end of this function
  // knows which capacityUnits it hands to a second runWaterfall call are already
  // an absolute, final figure (must not be taxed again) versus which are still
  // the original nameplate ceiling (must be taxed exactly as this pass taxed it,
  // so the reconciliation reproduces this pass's own numbers on a recipe neither
  // sweep touched).
  const sweepTouched = new Set<RecipeId>();

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
      sweepTouched.add(recipeId);
    }
  }

  // Ruling R30: the EMPTY mirror of the sweep above. requirementVector's walk
  // already enforces this for an item with an active recipe of its own (throttling
  // falls out of composing the requirement vector), but a byproduct-only item is
  // never anyone's primary output, so that walk cannot reach it and the pin alone
  // enforces nothing. This clamp is the backstop: forward topological order --
  // producers before consumers -- so throttling itemId's CONSUMERS here only ever
  // further reduces production of items still ahead in the walk, the same
  // relaxation argument as the FULL sweep above, mirrored.
  for (let i = 0; i < content.topologicalItems.length; i += 1) {
    const itemId = content.topologicalItems[i]!;
    if (itemId === POWER_ITEM) continue;
    if (itemStates.get(itemId) !== "EMPTY") continue;

    const flows = computeFlows(content, capacityUnits, clocks);
    const flow = flows.get(itemId);
    if (!flow) continue;
    if (flow.consumption <= flow.production + FLOW_TOLERANCE) continue;
    if (flow.consumption <= 0) continue;

    const factor = flow.production / flow.consumption;
    for (const recipeId of content.consumersOf.get(itemId) ?? []) {
      const clock = clocks.get(recipeId);
      if (clock === undefined) continue;
      clocks.set(recipeId, clock * factor);
      sweepTouched.add(recipeId);
    }
  }

  // Ruling R31: `waterfall` above (and therefore its `entries`/`allocations`)
  // describes the solve BEFORE the two sweeps just ran -- the FULL sweep and the
  // EMPTY sweep both adjust `clocks` afterward without re-deriving it, so
  // `entries[].allocated` and `allocations` can be stale by whatever factor a
  // clamp applied (up to 12x in the byproduct case: `fuel`'s entry reports
  // residual_fuel's PRE-clamp throughput even though residual_fuel's actual clock
  // was just cut by the EMPTY sweep because heavy_oil_residue -- its only input,
  // and a byproduct nobody else produces -- ran out).
  //
  // Both sweeps only ever multiply a clock already in `sweepTouched` by a factor
  // in [0, 1] -- they never raise one -- so `capacityUnits[r] * clocks[r]` for a
  // touched recipe is an absolute, already-final figure: every entry that was
  // ever going to draw on it already had its chance, and re-running the
  // waterfall must not tax that number again (the reserve floor already did its
  // job during the first pass; a recipe can end up below its nameplate cross
  // capacity purely because phase B's leftover went unclaimed by a starved
  // entry blocked elsewhere -- taxing the resulting, already-reduced figure a
  // second time would shrink it further for no physical reason). A recipe
  // neither sweep touched is fed its ORIGINAL nameplate `capacityUnits[r]` and
  // taxed by the SAME `reserveFloor` exactly as this pass did, reproducing this
  // pass's own split bit-for-bit. `untaxedRecipes` (waterfall.ts) is what lets
  // one runWaterfall call treat the two kinds of recipe differently: exempt from
  // the reserve floor's phase-A tax if touched, taxed normally if not.
  //
  // Re-running the waterfall (rather than uniformly scaling every entry at a
  // touched recipe by the same factor) is also what correctly handles an entry
  // whose OWN requirement vector spans both a touched and an untouched recipe at
  // once -- exactly the byproduct case above, where the fuel entry's vector is
  // {refine_plastic (untouched), residual_fuel (touched)}. Re-running finds the
  // entry's true tightest ratio across both; a per-recipe scale would either
  // under-count refine_plastic (never actually the bottleneck) or leave
  // residual_fuel's share inconsistent with the entry's own reported rate.
  const reconciledCapacityUnits = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacityUnits) {
    reconciledCapacityUnits.set(
      recipeId,
      sweepTouched.has(recipeId) ? units * (clocks.get(recipeId) ?? 0) : units,
    );
  }
  const reconciledWaterfall = runWaterfall({
    content,
    vectors,
    activeRecipe: state.activeRecipe,
    capacityUnits: reconciledCapacityUnits,
    entries,
    pinnedEmpty,
    reserveFloor,
    untaxedRecipes: sweepTouched,
  });

  return {
    clocks,
    waterfall: reconciledWaterfall,
    flows: computeFlows(content, capacityUnits, clocks),
    itemStates,
  };
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
