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

/**
 * Spec B.6 check 7's stated failure mode: "a machine whose build cost needs an item
 * only that machine can make." A fixed-point bootstrap analysis, replacing the
 * tier-ordering approximation this check shipped with in Phase 0.
 *
 * Seeded from the world's authored starting machines, it alternates
 * "classes I can build" and "items I can produce" until neither grows. Because an
 * item only enters the set once some ALREADY-available class produces it, a
 * circularity cannot bootstrap itself into the answer — which is precisely what the
 * tier comparison could not see. The Phase 0 fixture was such a deadlock and
 * validated clean.
 *
 * The analysis subsumes the tier ordering it replaces: an item first produced above
 * the mark's tier is absent from that tier's producible set for exactly that reason.
 * The three messages below tell the three cases apart, because "unreachable" and
 * "not yet unlocked" call for different fixes.
 *
 * Both sets grow monotonically and are bounded by the bundle, so the loop terminates.
 */
function producibleAtTier(
  bundle: Bundle,
  tier: number,
  startingClasses: ReadonlySet<string>,
): Set<string> {
  const items = new Set<string>();
  const classes = new Set<string>(startingClasses);

  for (;;) {
    let changed = false;

    for (const recipe of bundle.recipes) {
      if (recipe.unlockTier > tier) continue;
      if (!classes.has(recipe.machineClass)) continue;
      if (!recipe.inputs.every((input) => items.has(input.item))) continue;
      for (const output of recipe.outputs) {
        if (!items.has(output.item)) {
          items.add(output.item);
          changed = true;
        }
      }
    }

    for (const cls of bundle.machineClasses) {
      if (classes.has(cls.id)) continue;
      const buildable = cls.marks.some(
        (mark) =>
          mark.unlockTier <= tier && mark.buildCost.every((cost) => items.has(cost.item)),
      );
      if (buildable) {
        classes.add(cls.id);
        changed = true;
      }
    }

    if (!changed) return items;
  }
}

export function checkBuildCostsSatisfiable(bundle: Bundle): ValidationIssue[] {
  const produced = earliestProduction(bundle);
  const startingClasses = new Set(bundle.start.machines.map((m) => m.machineClass));
  const producibleByTier = new Map<number, Set<string>>();
  const issues: ValidationIssue[] = [];

  for (const cls of bundle.machineClasses) {
    for (const mark of cls.marks) {
      let producible = producibleByTier.get(mark.unlockTier);
      if (producible === undefined) {
        producible = producibleAtTier(bundle, mark.unlockTier, startingClasses);
        producibleByTier.set(mark.unlockTier, producible);
      }

      for (const cost of mark.buildCost) {
        if (producible.has(cost.item)) continue;
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
        } else {
          issues.push(
            issue(
              7,
              `"${cls.id}" mk${mark.mark} costs "${cost.item}", which is unreachable at tier ${mark.unlockTier}: every recipe producing it needs a machine that cannot be built first. Grant a starting machine, or denominate the cost in something reachable`,
            ),
          );
        }
      }
    }
  }
  return issues;
}
