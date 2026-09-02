// Spec B.6's eleven checks, and where each one actually lives:
//
//   1  JSON Schema conformance                         `load.ts` (`loadBundleDir` / `BundleSchema.parse`) — THROWS, not returned as an issue
//   2  Reference resolution (dangling ids, dupes)       `load.ts` (`checkReferences`)
//   3  Every item has a producer                        `graph.ts` (`checkProducers`)
//   4  Every item has a consumer/sink/build-cost use     `graph.ts` (`checkConsumers`)
//   5  Every byproduct has a same-tier consumer          `graph.ts` (`checkByproductOutlets`)
//   6  SCC / cycle detection                             `scc.ts` (`checkCycles`)
//   7  Build costs satisfiable at unlock tier             `graph.ts` (`checkBuildCostsSatisfiable`) — tier-ordering only, see the comment on that function for what it does NOT model
//   8  `r_eff > 1 + ε` with every multiplier maxed        Phase 2 (needs the economy/calibration machinery)
//   9  Storage + QS cap >= largest build cost at tier     Phase 2 (needs the economy/calibration machinery)
//  10  Generator capacity >= draw at tier                 Phase 2 (needs the economy/calibration machinery)
//  11  Checksum + version stamp                           `checksum.ts` (`bundleChecksum`) — a SEPARATE function, not part of `validateBundle` below; the CLI (`cli.ts`) calls it directly after validation passes
//
// Check 1 throws (a bundle that doesn't even parse has nothing else worth
// checking against it); checks 2–7 below all return `ValidationIssue[]` and
// are collected and sorted by `validateBundle`; checks 8–10 do not exist yet
// (Phase 2); check 11 is deliberately its own function outside this list,
// since a checksum isn't a pass/fail issue.
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
