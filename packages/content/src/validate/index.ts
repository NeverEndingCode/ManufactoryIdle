// Spec B.6's eleven checks, and where each one actually lives:
//
//   1  JSON Schema conformance                         `load.ts` (`loadBundleDir` / `BundleSchema.parse`) — THROWS, not returned as an issue
//   2  Reference resolution (dangling ids, dupes)       `load.ts` (`checkReferences`)
//   3  Every item has a producer                        `graph.ts` (`checkProducers`)
//   4  Every item has a consumer/sink/build-cost use     `graph.ts` (`checkConsumers`)
//   5  Every byproduct has a same-tier consumer          `graph.ts` (`checkByproductOutlets`)
//   6  SCC / cycle detection                             `scc.ts` (`checkCycles`)
//   7  Build costs satisfiable at unlock tier             `graph.ts` (`checkBuildCostsSatisfiable`) — a fixed-point bootstrap analysis, seeded from the authored starting machines
//   8  `r_eff > 1 + ε` with every multiplier maxed        `economy.ts` (`checkRunawayGrowth`) — the static half; the maxed-stack half is E.5's simulator gate
//   9  Storage + QS cap >= largest build cost at tier     `economy.ts` (`checkStorageReachesCosts`) — also covers milestone requirements, beyond B.6's wording
//  10  Generator capacity >= draw at tier                 `economy.ts` (`checkGeneratorCapacity`)
//  11  Checksum + version stamp                           `checksum.ts` (`bundleChecksum`) — a SEPARATE function, not part of `validateBundle` below; the CLI (`cli.ts`) calls it directly after validation passes
//
// Check 1 throws (a bundle that doesn't even parse has nothing else worth
// checking against it); checks 2–10 below all return `ValidationIssue[]` and
// are collected and sorted by `validateBundle`; check 11 is deliberately its
// own function outside this list, since a checksum isn't a pass/fail issue.
import { checkReferences, type ValidationIssue } from "../load.js";
import type { Bundle } from "../schema.js";
import {
  checkByproductOutlets,
  checkBuildCostsSatisfiable,
  checkConsumers,
  checkProducers,
} from "./graph.js";
import {
  checkGeneratorCapacity,
  checkRunawayGrowth,
  checkStorageReachesCosts,
} from "./economy.js";
import { checkCycles } from "./scc.js";

export function validateBundle(bundle: Bundle): ValidationIssue[] {
  return [
    ...checkReferences(bundle),
    ...checkProducers(bundle),
    ...checkConsumers(bundle),
    ...checkByproductOutlets(bundle),
    ...checkCycles(bundle),
    ...checkBuildCostsSatisfiable(bundle),
    ...checkRunawayGrowth(bundle),
    ...checkStorageReachesCosts(bundle),
    ...checkGeneratorCapacity(bundle),
  ].sort((a, b) => a.check - b.check);
}

export { checkByproductOutlets, checkBuildCostsSatisfiable, checkConsumers, checkProducers };
export {
  checkGeneratorCapacity,
  checkRunawayGrowth,
  checkStorageReachesCosts,
  RUNAWAY_EPSILON,
} from "./economy.js";
export { buildRecipeDependencyGraph, checkCycles, findStronglyConnectedComponents } from "./scc.js";
