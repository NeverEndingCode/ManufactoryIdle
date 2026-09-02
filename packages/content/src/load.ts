// Bundle loading and reference resolution. Spec B.6 checks 1 and 2.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BundleSchema, type Bundle } from "./schema.js";

export interface ValidationIssue {
  check: number;
  severity: "error";
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

  return issues;
}
