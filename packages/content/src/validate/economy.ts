// Spec B.6 checks 8, 9 and 10 — the three that need economy numbers rather than
// graph shape, deferred out of Phase 0 for exactly that reason.
//
// These run in the validator, not the engine, so spec A.5's determinism rules do not
// bind them: `Math.pow` on a fractional exponent is fine here and would not be inside
// `packages/engine`.
import type { ValidationIssue } from "../load.js";
import type { Bundle, Item } from "../schema.js";

function issue(check: number, message: string): ValidationIssue {
  return { check, severity: "error", message };
}

/**
 * Spec D3's runaway invariant, statically. `r_eff = r / m`, where `r` is the cost
 * ratio per machine and `m = step^(1/interval)` is production growth per machine.
 * Above 1 the machine count grows like log(t) — the genre norm. At exactly 1 the
 * knife edge: linear machines, exponential production. Below 1, D3's "game over in
 * an afternoon".
 *
 * `EPSILON` is what keeps the knife edge itself out. It is deliberately loose: a bundle
 * sitting within 0.1% of the edge is not a bundle anyone tuned on purpose.
 *
 * What this does NOT model, stated plainly so it is not mistaken for more than it is:
 * the softcaps. Spec D3 applies them per multiplier category and again on the product
 * precisely so no stack of multipliers can push `r_eff` under 1, and the worst case for
 * this ratio is BELOW every softcap threshold — a softcap can only bend `m` down, which
 * raises `r_eff`. So checking the uncapped per-machine ratio is checking the worst case,
 * and the maxed-multiplier half of B.6's wording is the simulator's job (E.5's dynamic
 * gate with the whole stack maxed), not this one's.
 */
export const RUNAWAY_EPSILON = 1e-3;

export function checkRunawayGrowth(bundle: Bundle): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const cls of bundle.machineClasses) {
    const { step, interval } = cls.ladder;
    // Guarded so a degenerate ladder reports as a bundle error rather than NaN.
    if (!(interval > 0) || !(step > 0)) {
      issues.push(issue(8, `"${cls.id}" has a degenerate ladder (step ${step}, interval ${interval})`));
      continue;
    }

    const m = Math.pow(step, 1 / interval);
    const rEff = cls.costRatio / m;
    if (rEff <= 1 + RUNAWAY_EPSILON) {
      issues.push(
        issue(
          8,
          `"${cls.id}" has r_eff ${rEff.toFixed(4)} (cost ratio ${cls.costRatio} against ladder growth ${m.toFixed(4)}), at or below the 1 + ${RUNAWAY_EPSILON} runaway floor`,
        ),
      );
    }
  }
  return issues;
}

/**
 * The largest stock of one item a player could ever hold, with both curves bought to
 * `maxLevel`. Spec B.4: storage is per item, Quantum Storage is per lane, and the two
 * add.
 */
function maxAttainableCap(bundle: Bundle, item: Item): number {
  const storage = item.baseStorageCap * Math.pow(bundle.storage.capGrowth, bundle.storage.maxLevel);
  const quantum =
    item.baseQuantumCap *
    Math.pow(bundle.quantumStorage.capGrowth, bundle.quantumStorage.maxLevel);
  return storage + quantum;
}

/**
 * Spec B.6 check 9 — "a permanent hard wall: you could never bank enough to buy the
 * thing" — plus an extension beyond B.6's wording.
 *
 * B.6 scopes this to build costs. A milestone delivery requirement is the same failure
 * on the axis the check does not look at, so both are checked here.
 *
 * The comparison is against the MAXIMUM ATTAINABLE cap, not the base cap, and the
 * distinction carries the whole meaning of the check. A requirement above the base cap
 * leaves a player temporarily capped, which is recoverable by buying levels; only a
 * requirement above the maximum is a wall. The Phase 1 fixture stall — 2000 iron_plate
 * against a 1500 BASE cap — is the recoverable kind, and this check is correct to stay
 * silent on it. What made that stall bite was the bottleneck report having no way to
 * say "buy storage", which is fixed separately (task 0). Do not widen this check to
 * cover it: flagging every requirement above a base cap would fail bundles that are
 * merely paced, and would not have caught the real defect anyway.
 */
export function checkStorageReachesCosts(bundle: Bundle): ValidationIssue[] {
  const items = new Map(bundle.items.map((item) => [item.id, item]));
  const issues: ValidationIssue[] = [];

  const check = (itemId: string, amount: number, what: string): void => {
    const item = items.get(itemId);
    // A dangling id is check 2's to report, not this one's.
    if (item === undefined) return;
    const cap = maxAttainableCap(bundle, item);
    if (amount > cap) {
      issues.push(
        issue(
          9,
          `${what} needs ${amount} "${itemId}", above the ${cap.toFixed(0)} that storage and Quantum Storage can hold at maximum level`,
        ),
      );
    }
  };

  for (const cls of bundle.machineClasses) {
    for (const mark of cls.marks) {
      for (const cost of mark.buildCost) {
        check(cost.item, cost.amount, `"${cls.id}" mk${mark.mark}`);
      }
    }
  }

  for (const milestone of bundle.milestones) {
    for (const requirement of milestone.requires) {
      check(requirement.item, requirement.amount, `milestone "${milestone.name}" (tier ${milestone.tier})`);
    }
  }

  return issues;
}

/**
 * Spec B.6 check 10 — "a tier that browns out on arrival".
 *
 * Generation is expandable and draw is not bounded by anything the validator can see,
 * so the checkable question is narrower than "supply >= demand": at every tier where NO
 * generator recipe has unlocked yet, the only supply is the HUB allowance
 * (`baseGridCapacityMw`, spec 3.2), and it must cover at least one machine of every
 * class-mark unlocked so far. One of each is the floor — a player who cannot run a
 * single one of each unlocked machine has arrived at a tier that cannot function.
 *
 * Once any generator recipe is unlocked the tier is the player's problem to solve by
 * building generators, and the check stops: capacity is expandable from there.
 */
export function checkGeneratorCapacity(bundle: Bundle): ValidationIssue[] {
  const tiers = new Set<number>();
  for (const cls of bundle.machineClasses) for (const mark of cls.marks) tiers.add(mark.unlockTier);

  const issues: ValidationIssue[] = [];

  for (const tier of [...tiers].sort((a, b) => a - b)) {
    const generatorUnlocked = bundle.recipes.some(
      (recipe) => recipe.unlockTier <= tier && recipe.powerOutput > 0,
    );
    if (generatorUnlocked) continue;

    let draw = 0;
    const contributors: string[] = [];
    for (const cls of bundle.machineClasses) {
      // The cheapest mark a player could be running at this tier is the earliest
      // unlocked one; later marks are an upgrade, not an addition.
      const available = cls.marks.filter((mark) => mark.unlockTier <= tier);
      if (available.length === 0) continue;
      const first = available.reduce((a, b) => (b.unlockTier < a.unlockTier ? b : a));
      draw += first.powerDraw;
      contributors.push(`${cls.id} mk${first.mark}`);
    }

    if (draw > bundle.baseGridCapacityMw) {
      issues.push(
        issue(
          10,
          `tier ${tier} draws ${draw} MW for one each of ${contributors.join(", ")} against a ${bundle.baseGridCapacityMw} MW HUB allowance, with no generator unlocked yet`,
        ),
      );
    }
  }

  return issues;
}
