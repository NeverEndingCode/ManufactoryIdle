// solve(state, content) -> { clocks, allocations, itemRates, bottleneck, power }
//
// Spec C.3's cost model: ~44 recipes x ~10 priority targets is ~440 operations per
// waterfall pass, x a few item-state passes, x 2-3 power passes. Microseconds. An
// 8-hour resolve with 20 events is 20 of those.
import type { ItemId, RecipeId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import { computeExpansion } from "../graph/expand.js";
import { computeCapacity, powerDemandMw, powerSupplyMw } from "../economy/capacity.js";
import type { CapacityTable } from "../economy/capacity.js";
import type { ItemStateTag } from "../economy/storage.js";
import type { WorldState } from "../state/world.js";
import { effectivePriority, RESERVE_FLOOR, type EntryAllocation } from "./waterfall.js";
import { solveItems, type ItemFlow } from "./fixpoint.js";
import {
  POWER_PASSES,
  POWER_TOLERANCE,
  absoluteClocks,
  scaleCapacityByRatio,
  type PowerReport,
} from "./power.js";
import { computeBottleneck, type Bottleneck } from "./bottleneck.js";

export interface Solution {
  /** Fraction of nameplate speed, per recipe. Absolute, not ratio-relative. */
  clocks: Map<RecipeId, number>;
  itemRates: Map<ItemId, ItemFlow>;
  itemStates: Map<ItemId, ItemStateTag>;
  /** recipe -> entryId -> machine-units. Spec 13.1's split bars. */
  allocations: Map<RecipeId, Map<string, number>>;
  entries: EntryAllocation[];
  bottleneck: Bottleneck;
  power: PowerReport;
  capacity: CapacityTable;
  passes: number;
  pinOrder: ItemId[];
  pinnedEmpty: Set<ItemId>;
}

export interface SolveOptions {
  seedPins?: boolean;
  reserveFloor?: number;
}

export function solve(
  state: WorldState,
  content: IndexedContent,
  options: SolveOptions = {},
): Solution {
  const seedPins = options.seedPins ?? true;
  const reserveFloor = options.reserveFloor ?? RESERVE_FLOOR;

  const capacity = computeCapacity(content, state);
  const vectors = computeExpansion(content, state.tier, state.activeRecipe);
  // Spec section 7: the tap injects power into the grid while a stack is live.
  const tapInjectionMw = state.tapStacks > 0 ? content.bundle.tap.powerInjectionMw : 0;

  let ratio = 1;
  let demandTargetMw = 0;
  let passes = 0;

  let items = solveItems({
    content,
    vectors,
    state,
    capacityUnits: scaleCapacityByRatio(content, capacity, ratio).unitsByRecipe,
    entries: effectivePriority(content, state, capacity, demandTargetMw),
    reserveFloor,
    seedPins,
  });
  let fullDemandMw = 0;
  let supplyMw = 0;

  for (;;) {
    passes += 1;
    const absolute = absoluteClocks(content, items.pass.clocks, ratio);

    // Demand measured at the scaled clocks is what the factory WOULD draw at ratio 1
    // with this allocation pattern. That is the quantity the equilibrium is against.
    fullDemandMw = powerDemandMw(content, capacity, state, items.pass.clocks);
    supplyMw = powerSupplyMw(content, capacity, absolute) + tapInjectionMw;

    const nextRatio = fullDemandMw <= 0 ? 1 : Math.min(1, supplyMw / fullDemandMw);
    const settled =
      passes >= 2 &&
      Math.abs(nextRatio - ratio) < POWER_TOLERANCE &&
      Math.abs(fullDemandMw - demandTargetMw) <= POWER_TOLERANCE * (1 + Math.abs(fullDemandMw));
    // Break without touching `ratio`: `items` was solved at the current ratio, so
    // reporting a different one would make the clocks and the grid disagree. When
    // `settled` fires the two are within POWER_TOLERANCE anyway.
    if (settled || passes >= POWER_PASSES) break;

    ratio = nextRatio;
    demandTargetMw = fullDemandMw;
    items = solveItems({
      content,
      vectors,
      state,
      capacityUnits: scaleCapacityByRatio(content, capacity, ratio).unitsByRecipe,
      entries: effectivePriority(content, state, capacity, demandTargetMw),
      reserveFloor,
      seedPins,
    });
  }

  const clocks = absoluteClocks(content, items.pass.clocks, ratio);
  const power: PowerReport = {
    demandMw: fullDemandMw * ratio,
    fullDemandMw,
    supplyMw,
    ratio,
    passes,
  };

  return {
    clocks,
    itemRates: items.pass.flows,
    itemStates: items.pass.itemStates,
    allocations: items.pass.waterfall.allocations,
    entries: items.pass.waterfall.entries,
    bottleneck: computeBottleneck(
      content,
      capacity,
      items.pass.waterfall.entries,
      power,
      state.tier,
      state.activeRecipe,
    ),
    power,
    capacity,
    passes: items.passes,
    pinOrder: items.pinOrder,
    pinnedEmpty: items.pinnedEmpty,
  };
}
