// Structural graph checks. Spec B.6 checks 3, 4, 5, and 7. Each of these
// catches content that produces a permanently stuck save rather than merely
// bad balance, which is why they fail the build rather than warn.
import type { ValidationIssue } from "../load.js";
import type { Bundle } from "../schema.js";

function issue(check: number, message: string): ValidationIssue {
  return { check, severity: "error", message };
}

// Lowest unlockTier at which each item can be produced at all.
function earliestProduction(bundle: Bundle): Map<string, number> {
  const earliest = new Map<string, number>();
  for (const recipe of bundle.recipes) {
    for (const output of recipe.outputs) {
      const current = earliest.get(output.item);
      if (current === undefined || recipe.unlockTier < current) {
        earliest.set(output.item, recipe.unlockTier);
      }
    }
  }
  return earliest;
}

export function checkProducers(bundle: Bundle): ValidationIssue[] {
  const produced = earliestProduction(bundle);
  return bundle.items
    .filter((item) => !produced.has(item.id))
    .map((item) => issue(3, `item "${item.id}" has no recipe that produces it`));
}

export function checkConsumers(bundle: Bundle): ValidationIssue[] {
  const consumed = new Set<string>();
  for (const recipe of bundle.recipes) {
    for (const input of recipe.inputs) consumed.add(input.item);
  }
  // Build costs are a legitimate sink: spec section 3.2 pays for machines out
  // of stored items, so an item used only to build things is not a dead end.
  for (const cls of bundle.machineClasses) {
    for (const mark of cls.marks) {
      for (const cost of mark.buildCost) consumed.add(cost.item);
    }
  }

  return bundle.items
    .filter((item) => !item.terminal && !consumed.has(item.id))
    .map((item) =>
      issue(
        4,
        `item "${item.id}" is never consumed, never a build cost, and not marked terminal`,
      ),
    );
}

export function checkByproductOutlets(bundle: Bundle): ValidationIssue[] {
  // Earliest tier at which each item is consumed by something.
  const earliestConsumption = new Map<string, number>();
  for (const recipe of bundle.recipes) {
    for (const input of recipe.inputs) {
      const current = earliestConsumption.get(input.item);
      if (current === undefined || recipe.unlockTier < current) {
        earliestConsumption.set(input.item, recipe.unlockTier);
      }
    }
  }

  const issues: ValidationIssue[] = [];
  for (const recipe of bundle.recipes) {
    for (const output of recipe.outputs) {
      if (!output.byproduct) continue;
      const consumedAt = earliestConsumption.get(output.item);
      if (consumedAt === undefined) {
        issues.push(
          issue(
            5,
            `byproduct "${output.item}" from recipe "${recipe.id}" has no consumer recipe anywhere`,
          ),
        );
      } else if (consumedAt > recipe.unlockTier) {
        issues.push(
          issue(
            5,
            `byproduct "${output.item}" appears at tier ${recipe.unlockTier} (recipe "${recipe.id}") but its earliest consumer unlocks at tier ${consumedAt}`,
          ),
        );
      }
    }
  }
  return issues;
}

// What this does and does not model (spec B.6 check 7), same style of note
// as checks 8/9/10 below: this only checks tier ordering — that a machine's
// build-cost item is produced by *some* recipe at or before the mark's own
// unlock tier. It does NOT check the spec's stated failure mode, "a machine
// whose build cost needs an item only that machine can make" — i.e. a
// genuine circularity where the sole producer of the cost item is gated
// behind owning one of the very machines being bought. `iron_plate`'s only
// producer runs on a `constructor`, so a constructor mk1 costing iron_plate
// would pass this check (constructor unlocks at tier 0, iron_plate is first
// produced at tier 0) while being unbuildable in practice. Real reachability
// analysis — start from zero, or from the world's authored starting
// machines, and prove every build cost is reachable without begging the
// question — is deferred to Phase 2.
export function checkBuildCostsSatisfiable(bundle: Bundle): ValidationIssue[] {
  const produced = earliestProduction(bundle);
  const issues: ValidationIssue[] = [];

  for (const cls of bundle.machineClasses) {
    for (const mark of cls.marks) {
      for (const cost of mark.buildCost) {
        const producedAt = produced.get(cost.item);
        if (producedAt === undefined) {
          issues.push(
            issue(7, `"${cls.id}" mk${mark.mark} costs "${cost.item}", which nothing produces`),
          );
        } else if (producedAt > mark.unlockTier) {
          issues.push(
            issue(
              7,
              `"${cls.id}" mk${mark.mark} unlocks at tier ${mark.unlockTier} but costs "${cost.item}", first produced at tier ${producedAt}`,
            ),
          );
        }
      }
    }
  }
  return issues;
}
