// Spec A.4 zone 1, and spec C.3's precompute. This is the ONLY module in the engine
// permitted to touch @manufactory/rational.
//
// Ratios must be exact or allocation drifts across a deep graph: 20/60 and 30/60
// composed three deep in float64 leaves a residue that shows up as a phantom
// bottleneck. So the whole composition runs in BigInt rationals and converts to
// float64 exactly once, on the way out. Nothing here runs per solve — the result is
// memoized on (contentVersion, tier, activeRecipeSet), which changes only when the
// player selects a different recipe or unlocks a tier.
import {
  ZERO,
  add,
  divide,
  multiply,
  of,
  parseRational,
  toApproximateNumber,
  type Rational,
} from "@manufactory/rational";
import { POWER_ITEM, type ItemId, type RecipeId } from "../content/types.js";
import { isLiveRecipe, type IndexedContent } from "./index-content.js";

export interface ExpansionVectors {
  key: string;
  /** Machine-units of the active recipe needed per 1 item/s of the key item. */
  unitsPerItem: Map<ItemId, number>;
  /** Units of the inner item consumed per 1 unit of the outer item. */
  directInputs: Map<ItemId, Map<ItemId, number>>;
  /** Uncut full expansion: machine-units of every upstream recipe per 1 item/s. */
  perUnit: Map<ItemId, Map<RecipeId, number>>;
  /** Extraction-item trace per 1 unit. Spec F.1's Handbook "traces back to". */
  rawCost: Map<ItemId, Map<ItemId, number>>;
}

export function expansionKey(
  content: IndexedContent,
  tier: number,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
): string {
  const pairs = Object.keys(activeRecipe)
    .sort()
    .map((item) => `${item}=${activeRecipe[item]}`)
    .join(",");
  return `${content.bundle.version}|t${tier}|${pairs}`;
}

const CACHE_LIMIT = 16;
const cache = new Map<string, ExpansionVectors>();

/** Test hook. Never called by shipped code. */
export function clearExpansionCache(): void {
  cache.clear();
}

function exactRatePerSecond(rate: string): Rational {
  return divide(parseRational(rate), of(60n));
}

export function computeExpansion(
  content: IndexedContent,
  tier: number,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
): ExpansionVectors {
  const key = expansionKey(content, tier, activeRecipe);
  const hit = cache.get(key);
  if (hit) return hit;

  // Exact per-item intermediates, all Rational.
  const unitsExact = new Map<ItemId, Rational>();
  const directExact = new Map<ItemId, Map<ItemId, Rational>>();

  for (const itemId of content.itemIds) {
    const recipeId = activeRecipe[itemId];
    if (recipeId === undefined) continue;
    if (!isLiveRecipe(content, recipeId, tier, activeRecipe)) continue;
    const recipe = content.recipes.get(recipeId)!;

    // Output rate of the primary item, exactly. Power is a standing megawatt figure
    // rather than a per-minute flow, so it is not divided by 60.
    let outPerUnit: Rational;
    if (itemId === POWER_ITEM) {
      outPerUnit = of(BigInt(Math.round(recipe.def.powerOutput * 1_000_000)), 1_000_000n);
    } else {
      const part = recipe.def.outputs.find((o) => o.item === itemId);
      if (!part) continue;
      outPerUnit = exactRatePerSecond(part.rate);
    }
    if (outPerUnit.numerator === 0n) continue;

    const units = divide(of(1n), outPerUnit);
    unitsExact.set(itemId, units);

    const direct = new Map<ItemId, Rational>();
    for (const part of recipe.def.inputs) {
      const inPerUnit = exactRatePerSecond(part.rate);
      // Units of `part.item` per 1 unit of `itemId`.
      direct.set(part.item, add(direct.get(part.item) ?? ZERO, divide(inPerUnit, outPerUnit)));
    }
    directExact.set(itemId, direct);
  }

  // Compose the full vectors in topological order, so every input is already done by
  // the time its consumer is reached. Ruling R6 guarantees this order exists.
  const perUnitExact = new Map<ItemId, Map<RecipeId, Rational>>();
  const rawExact = new Map<ItemId, Map<ItemId, Rational>>();

  const mergeScaled = <K>(
    into: Map<K, Rational>,
    from: Map<K, Rational> | undefined,
    scale: Rational,
  ): void => {
    if (!from) return;
    for (const [k, v] of from) into.set(k, add(into.get(k) ?? ZERO, multiply(v, scale)));
  };

  for (const itemId of content.topologicalItems) {
    const units = unitsExact.get(itemId);
    if (units === undefined) continue;
    const recipeId = activeRecipe[itemId]!;
    const direct = directExact.get(itemId) ?? new Map<ItemId, Rational>();

    const vector = new Map<RecipeId, Rational>([[recipeId, units]]);
    const raw = new Map<ItemId, Rational>();
    let hasUpstream = false;

    for (const [inputId, perUnitOfInput] of direct) {
      if (unitsExact.has(inputId)) {
        hasUpstream = true;
        mergeScaled(vector, perUnitExact.get(inputId), perUnitOfInput);
        mergeScaled(raw, rawExact.get(inputId), perUnitOfInput);
      } else {
        // Not produced by any live recipe at this tier: treat it as a raw input.
        raw.set(inputId, add(raw.get(inputId) ?? ZERO, perUnitOfInput));
      }
    }
    // An extraction recipe has no inputs at all, so the item is its own raw cost.
    if (direct.size === 0 && !hasUpstream) raw.set(itemId, of(1n));

    perUnitExact.set(itemId, vector);
    rawExact.set(itemId, raw);
  }

  // The single float boundary (spec A.4). Nothing downstream ever sees a Rational.
  const toFloatMap = <K>(source: Map<K, Rational>): Map<K, number> => {
    const out = new Map<K, number>();
    for (const [k, v] of source) out.set(k, toApproximateNumber(v));
    return out;
  };

  const result: ExpansionVectors = {
    key,
    unitsPerItem: toFloatMap(unitsExact),
    directInputs: new Map([...directExact].map(([k, v]) => [k, toFloatMap(v)])),
    perUnit: new Map([...perUnitExact].map(([k, v]) => [k, toFloatMap(v)])),
    rawCost: new Map([...rawExact].map(([k, v]) => [k, toFloatMap(v)])),
  };

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, result);
  return result;
}
