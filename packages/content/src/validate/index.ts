// Spec B.6. Checks 8, 9, and 10 (r_eff > 1 + epsilon, storage cap versus largest
// build cost, generator capacity versus tier draw) need the economy and
// calibration machinery and land in Phase 2.
import { checkReferences, type ValidationIssue } from "../load.js";
import type { Bundle } from "../schema.js";
import {
  checkByproductOutlets,
  checkBuildCostsSatisfiable,
  checkConsumers,
  checkProducers,
} from "./graph.js";
import { checkCycles } from "./scc.js";

export function validateBundle(bundle: Bundle): ValidationIssue[] {
  return [
    ...checkReferences(bundle),
    ...checkProducers(bundle),
    ...checkConsumers(bundle),
    ...checkByproductOutlets(bundle),
    ...checkCycles(bundle),
    ...checkBuildCostsSatisfiable(bundle),
  ].sort((a, b) => a.check - b.check);
}

export { checkByproductOutlets, checkBuildCostsSatisfiable, checkConsumers, checkProducers };
export { buildRecipeDependencyGraph, checkCycles, findStronglyConnectedComponents } from "./scc.js";
