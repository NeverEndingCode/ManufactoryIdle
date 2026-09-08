// Bundle loading and reference resolution. Spec B.6 checks 1 and 2.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BundleSchema, type Bundle } from "./schema.js";

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

export function loadBundleDir(dir: string): Bundle {
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
  return BundleSchema.parse(merged);
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
