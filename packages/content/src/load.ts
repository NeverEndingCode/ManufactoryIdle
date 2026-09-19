// Bundle loading and reference resolution. Spec B.6 checks 1 and 2.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BundleSchema, type Bundle, type Derived, type StorageCurve } from "./schema.js";

export interface ValidationIssue {
  check: number;
  /**
   * `error` fails the build. `warning` reports and continues.
   *
   * Only check 6 (cycles) warns. Spec B.6 defines it as flagging cyclic recipes
   * "unselectable in v1", not as rejecting the bundle, and the engine already
   * enforces exactly that (ruling R6: every recipe in a non-trivial SCC is marked
   * cyclic and is never live). Spec B.5 then *requires* the vertical slice to
   * contain a genuine SCC — Recycled Plastic and Recycled Rubber — so that the
   * detection has something real to catch and so the decision to ship or forbid an
   * SCC solver can be made from evidence. An erroring check 6 would make that
   * content unauthorable.
   */
  severity: "error" | "warning";
  message: string;
}

// A bundle may be split across as many yaml files as the author likes. Top-level
// arrays concatenate; scalars take the last writer. Files load in sorted order so
// the result never depends on directory iteration order.
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      target[key] = [...existing, ...value];
    } else {
      target[key] = value;
    }
  }
}

export interface LoadOptions {
  /**
   * Overlay `derived.yaml` onto the authored numbers. Default true: the game, the
   * validator and the simulator must all run on the solved values.
   *
   * The calibrator passes false. It is the thing that *writes* derived.yaml, so if it
   * read its own last output it would search from there instead of from the authored
   * seeds — two runs over unchanged content would disagree, and each run's scale
   * factors would compound on the previous one's. Tests that assert on authored
   * intent pass false for the same reason.
   */
  applyDerived?: boolean;
}

export function loadBundleDir(dir: string, options: LoadOptions = {}): Bundle {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const merged: Record<string, unknown> = {};
  for (const file of files) {
    const parsed = parseYaml(readFileSync(join(dir, file), "utf8")) as unknown;
    if (parsed === null || parsed === undefined) continue; // empty file, legitimate
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `${file}: a bundle file's top level must be a mapping, but this parsed to ` +
          `${Array.isArray(parsed) ? "a list" : typeof parsed}. Check indentation.`,
      );
    }
    mergeInto(merged, parsed as Record<string, unknown>);
  }

  // Check 1: schema conformance. Throwing here is deliberate — nothing
  // downstream can run against a bundle that is not even shaped right.
  //
  // The derived overlay is applied here rather than left to callers so that there is
  // one notion of "the bundle" by default: the validator, the engine and the simulator
  // all see the calibrated numbers, and none of them can be looking at the authored
  // seeds by accident. The calibrator is the one caller that must opt out — see
  // LoadOptions.applyDerived.
  const bundle = BundleSchema.parse(merged);
  return options.applyDerived === false ? bundle : applyDerived(bundle);
}


/**
 * Lay the calibration script's solution over the authored numbers (spec B.1, B.7).
 *
 * Every entry is a patch rather than a replacement, so a run that solved only
 * milestone amounts cannot silently reset a storage curve it never looked at.
 *
 * A patch naming something the bundle does not have throws rather than being
 * ignored. That case means the content was re-authored since the calibration run, so
 * the numbers no longer describe this graph; carrying on would leave the bundle
 * half-calibrated with nothing anywhere to say so, which is exactly the failure mode
 * spec B.1 wants made structural.
 */
export function applyDerived(bundle: Bundle): Bundle {
  const derived: Derived | undefined = bundle.derived;
  if (derived === undefined) return bundle;

  let next = bundle;

  if (derived.machineClasses !== undefined) {
    const byId = new Map(derived.machineClasses.map((c) => [c.id, c]));
    for (const id of byId.keys()) {
      if (!bundle.machineClasses.some((c) => c.id === id)) {
        throw new Error(
          `derived block sets costRatio for machine class "${id}", which this bundle ` +
            `does not define. The content was re-authored after calibration; re-run it.`,
        );
      }
    }
    next = {
      ...next,
      machineClasses: next.machineClasses.map((cls) => {
        const patch = byId.get(cls.id);
        if (patch === undefined) return cls;
        return {
          ...cls,
          costRatio: patch.costRatio,
          ...(patch.rEff === undefined ? {} : { rEff: patch.rEff }),
        };
      }),
    };
  }

  if (derived.milestones !== undefined) {
    const byTier = new Map(derived.milestones.map((m) => [m.tier, m]));
    for (const [tier, patch] of byTier) {
      const milestone = bundle.milestones.find((m) => m.tier === tier);
      if (!milestone) {
        throw new Error(
          `derived block sets requirements for tier ${tier}, which this bundle does ` +
            `not define. The content was re-authored after calibration; re-run it.`,
        );
      }
      for (const requirement of patch.requires) {
        if (!milestone.requires.some((r) => r.item === requirement.item)) {
          throw new Error(
            `derived block sets a tier ${tier} requirement for "${requirement.item}", ` +
              `which that milestone does not ask for. The content was re-authored ` +
              `after calibration; re-run it.`,
          );
        }
      }
    }
    next = {
      ...next,
      milestones: next.milestones.map((milestone) => {
        const patch = byTier.get(milestone.tier);
        if (patch === undefined) return milestone;
        const amounts = new Map(patch.requires.map((r) => [r.item, r.amount]));
        return {
          ...milestone,
          requires: milestone.requires.map((r) => ({
            ...r,
            amount: amounts.get(r.item) ?? r.amount,
          })),
        };
      }),
    };
  }

  const patchCurve = (curve: StorageCurve, patch: Partial<StorageCurve> | undefined): StorageCurve =>
    patch === undefined ? curve : { ...curve, ...patch };

  return {
    ...next,
    storage: patchCurve(next.storage, derived.storage),
    quantumStorage: patchCurve(next.quantumStorage, derived.quantumStorage),
  };
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

export function checkReferences(bundle: Bundle): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (message: string) => issues.push({ check: 2, severity: "error", message });

  const laneIds = new Set(bundle.lanes.map((l) => l.id));
  const itemIds = new Set(bundle.items.map((i) => i.id));
  const classIds = new Set(bundle.machineClasses.map((m) => m.id));

  for (const [kind, ids] of [
    ["lane", bundle.lanes.map((l) => l.id)],
    ["item", bundle.items.map((i) => i.id)],
    ["machine class", bundle.machineClasses.map((m) => m.id)],
    ["recipe", bundle.recipes.map((r) => r.id)],
  ] as const) {
    for (const id of duplicates(ids)) add(`duplicate ${kind} id "${id}"`);
  }

  for (const item of bundle.items) {
    if (!laneIds.has(item.lane)) add(`item "${item.id}" references missing lane "${item.lane}"`);
  }

  for (const cls of bundle.machineClasses) {
    for (const mark of cls.marks) {
      for (const cost of mark.buildCost) {
        if (!itemIds.has(cost.item)) {
          add(`build cost for "${cls.id}" mk${mark.mark} references missing item "${cost.item}"`);
        }
      }
    }
  }

  for (const recipe of bundle.recipes) {
    if (!laneIds.has(recipe.lane)) add(`recipe "${recipe.id}" references missing lane "${recipe.lane}"`);
    if (!classIds.has(recipe.machineClass)) {
      add(`recipe "${recipe.id}" references missing machine class "${recipe.machineClass}"`);
    }
    for (const part of [...recipe.inputs, ...recipe.outputs]) {
      if (!itemIds.has(part.item)) {
        add(`recipe "${recipe.id}" references missing item "${part.item}"`);
      }
    }
  }

  const recipeIds = new Set(bundle.recipes.map((r) => r.id));

  for (const [label, curve] of [
    ["storage", bundle.storage],
    ["quantumStorage", bundle.quantumStorage],
  ] as const) {
    if (curve.baseCostItem !== null && !itemIds.has(curve.baseCostItem)) {
      add(`${label} curve references missing item "${curve.baseCostItem}"`);
    }
  }

  for (const milestone of bundle.milestones) {
    for (const requirement of milestone.requires) {
      if (!itemIds.has(requirement.item)) {
        add(`milestone tier ${milestone.tier} requires missing item "${requirement.item}"`);
      }
    }
    for (const lane of Object.keys(milestone.laneMultipliers)) {
      if (!laneIds.has(lane)) {
        add(`milestone tier ${milestone.tier} multiplies missing lane "${lane}"`);
      }
    }
  }

  for (const machine of bundle.start.machines) {
    if (!laneIds.has(machine.lane)) add(`start machine references missing lane "${machine.lane}"`);
    const cls = bundle.machineClasses.find((c) => c.id === machine.machineClass);
    if (!cls) {
      add(`start machine references missing machine class "${machine.machineClass}"`);
    } else if (!cls.marks.some((m) => m.mark === machine.mark)) {
      add(`start machine "${machine.machineClass}" has no mk${machine.mark}`);
    }
  }
  for (const recipeId of Object.keys(bundle.start.assignments)) {
    if (!recipeIds.has(recipeId)) add(`start assignment references missing recipe "${recipeId}"`);
  }
  for (const itemId of bundle.start.priority) {
    if (!itemIds.has(itemId)) add(`start priority references missing item "${itemId}"`);
  }

  return issues;
}
