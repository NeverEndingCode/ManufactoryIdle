// Spec C.4's outer loop.
//
// Spec 6.1 writes powerRatio = min(1, capacity / demand) and spec C.4 adds damping
// to stop it oscillating. It oscillates because `demand` there is measured at the
// current ratio: 300 MW of draw against 200 MW gives 0.667, then demand falls to
// 200, then the update gives 1, then 0.667 again. Worse, the naive iteration's fixed
// point is sqrt(capacity/fullDemand), at which the grid still draws more than it can
// supply. Measuring against FULL-POWER demand gives ratio = capacity / fullDemand
// directly -- the correct equilibrium, and no damping required. Two passes when
// supply is ratio-independent, three when generators are fed through the graph,
// which is exactly the 2-3 spec C.4 predicts.
//
// powerRatio scales consuming recipes only. Generators are exempt, which is spec
// C.4's fix for the death spiral: generators burn fuel drawn from the graph, so
// throttling them in a brownout would cut capacity, deepen the brownout, and never
// recover -- hardest while offline, violating pillar 1.
import type { RecipeId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import type { CapacityTable } from "../economy/capacity.js";

export const POWER_PASSES = 8;
export const POWER_TOLERANCE = 1e-12;

export interface PowerReport {
  /** Megawatts actually drawn at the settled ratio. */
  demandMw: number;
  /** Megawatts the same factory would draw at ratio 1. */
  fullDemandMw: number;
  supplyMw: number;
  ratio: number;
  passes: number;
}

export function isGenerator(content: IndexedContent, recipeId: RecipeId): boolean {
  return (content.recipes.get(recipeId)?.def.powerOutput ?? 0) > 0;
}

/** A copy of the table with consuming recipes' capacity scaled by the grid ratio. */
export function scaleCapacityByRatio(
  content: IndexedContent,
  capacity: CapacityTable,
  ratio: number,
): CapacityTable {
  const unitsByRecipe = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacity.unitsByRecipe) {
    unitsByRecipe.set(recipeId, isGenerator(content, recipeId) ? units : units * ratio);
  }
  return { ...capacity, unitsByRecipe };
}

/** Undoes the scaling, so reported clocks are fractions of nameplate speed. */
export function absoluteClocks(
  content: IndexedContent,
  scaled: ReadonlyMap<RecipeId, number>,
  ratio: number,
): Map<RecipeId, number> {
  const out = new Map<RecipeId, number>();
  for (const [recipeId, clock] of scaled) {
    out.set(recipeId, isGenerator(content, recipeId) ? clock : clock * ratio);
  }
  return out;
}
