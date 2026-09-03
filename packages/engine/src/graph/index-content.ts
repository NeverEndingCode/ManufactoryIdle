// Spec C.3's precompute, part one: turn an authored bundle into indexed structures
// the solver can walk in constant time.
//
// Authored rates are exact rational strings per minute (spec A.4 zone 1). They are
// parsed exactly here and converted to per-second float64 once, at this boundary,
// because that is the only place a rational is allowed to become a float.
import { parseRational, toApproximateNumber } from "@manufactory/rational";
import {
  POWER_ITEM,
  type ContentBundle,
  type ItemId,
  type LaneId,
  type MachineClassId,
  type MarkDef,
  type MilestoneDef,
  type RecipeDef,
  type RecipeId,
} from "../content/types.js";

export interface IndexedRecipe {
  def: RecipeDef;
  lane: LaneId;
  machineClass: MachineClassId;
  /** Items per second produced per machine-unit at clock 1, including byproducts. */
  outputPerSecond: Map<ItemId, number>;
  /** Items per second consumed per machine-unit at clock 1. */
  inputPerSecond: Map<ItemId, number>;
  /**
   * The output this recipe is *selected* for. First non-byproduct output; POWER_ITEM
   * for a generator. Spec 4.4 makes recipe selection per-item, so a recipe is live
   * only while it is the active recipe for its primary output.
   */
  primaryOutput: ItemId;
  /** Ruling R6: inside a non-trivial SCC, therefore never live in Phase 1. */
  inCycle: boolean;
}

export interface IndexedContent {
  bundle: ContentBundle;
  lanes: Map<LaneId, ContentBundle["lanes"][number]>;
  items: Map<ItemId, ContentBundle["items"][number]>;
  machineClasses: Map<MachineClassId, ContentBundle["machineClasses"][number]>;
  recipes: Map<RecipeId, IndexedRecipe>;
  /** Every item id in authored order, plus POWER_ITEM last. */
  itemIds: ItemId[];
  /** Items that occupy storage. `itemIds` minus POWER_ITEM. */
  stockItemIds: ItemId[];
  recipeIds: RecipeId[];
  producersOf: Map<ItemId, RecipeId[]>;
  consumersOf: Map<ItemId, RecipeId[]>;
  recipesByLaneClass: Map<string, RecipeId[]>;
  cyclicRecipes: Set<RecipeId>;
  /** Items ordered so every producer of an item precedes it. Acyclic recipes only. */
  topologicalItems: ItemId[];
  milestoneByTier: Map<number, MilestoneDef>;
  maxTier: number;
  defaultActiveRecipe: Record<ItemId, RecipeId>;
  offlineCapMs: number;
}

export function laneClassKey(lane: LaneId, machineClass: MachineClassId): string {
  return `${lane}::${machineClass}`;
}

export function getMark(
  content: IndexedContent,
  machineClass: MachineClassId,
  mark: number,
): MarkDef | undefined {
  return content.machineClasses.get(machineClass)?.marks.find((m) => m.mark === mark);
}

export function isLiveRecipe(
  content: IndexedContent,
  recipeId: RecipeId,
  tier: number,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
): boolean {
  const recipe = content.recipes.get(recipeId);
  if (!recipe) return false;
  if (recipe.inCycle) return false;
  if (recipe.def.unlockTier > tier) return false;
  return activeRecipe[recipe.primaryOutput] === recipeId;
}

/** Authored rates are per minute; the engine works per second everywhere. */
function ratePerSecond(rate: string): number {
  const exact = parseRational(rate);
  return toApproximateNumber(exact) / 60;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Tarjan's SCC, iteratively. Nodes are recipes; R depends on S when R consumes an
 * item S produces. Iterative rather than recursive because a blown call stack in the
 * engine is a far worse failure mode than a slightly longer function.
 */
function findCyclicRecipes(recipes: IndexedRecipe[]): Set<RecipeId> {
  const producersOf = new Map<ItemId, RecipeId[]>();
  for (const recipe of recipes) {
    for (const item of recipe.outputPerSecond.keys()) push(producersOf, item, recipe.def.id);
  }
  const edges = new Map<RecipeId, RecipeId[]>();
  for (const recipe of recipes) {
    const deps = new Set<RecipeId>();
    for (const item of recipe.inputPerSecond.keys()) {
      for (const producer of producersOf.get(item) ?? []) deps.add(producer);
    }
    edges.set(recipe.def.id, [...deps]);
  }

  const index = new Map<RecipeId, number>();
  const low = new Map<RecipeId, number>();
  const onStack = new Set<RecipeId>();
  const stack: RecipeId[] = [];
  const cyclic = new Set<RecipeId>();
  let counter = 0;

  for (const root of recipes.map((r) => r.def.id)) {
    if (index.has(root)) continue;
    const frames: { node: RecipeId; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const children = edges.get(frame.node) ?? [];
      if (frame.next < children.length) {
        const child = children[frame.next]!;
        frame.next += 1;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          frames.push({ node: child, next: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));

      if (low.get(frame.node) === index.get(frame.node)) {
        const component: RecipeId[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        const selfLoop =
          component.length === 1 && (edges.get(component[0]!) ?? []).includes(component[0]!);
        if (component.length > 1 || selfLoop) for (const id of component) cyclic.add(id);
      }
    }
  }
  return cyclic;
}

/**
 * Kahn's algorithm over the item graph, restricted to acyclic recipes. Ties are
 * broken by authored order so the result is stable across runs (spec A.5's canonical
 * ordering rule).
 */
function topologicalItems(itemIds: ItemId[], recipes: IndexedRecipe[]): ItemId[] {
  const rank = new Map<ItemId, number>(itemIds.map((id, i) => [id, i]));
  const dependsOn = new Map<ItemId, Set<ItemId>>(itemIds.map((id) => [id, new Set<ItemId>()]));
  const dependents = new Map<ItemId, Set<ItemId>>(itemIds.map((id) => [id, new Set<ItemId>()]));

  for (const recipe of recipes) {
    if (recipe.inCycle) continue;
    for (const out of recipe.outputPerSecond.keys()) {
      for (const input of recipe.inputPerSecond.keys()) {
        if (input === out) continue;
        dependsOn.get(out)!.add(input);
        dependents.get(input)!.add(out);
      }
    }
  }

  const ready = itemIds.filter((id) => dependsOn.get(id)!.size === 0);
  ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
  const order: ItemId[] = [];
  const remaining = new Map<ItemId, number>(itemIds.map((id) => [id, dependsOn.get(id)!.size]));

  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    const freed: ItemId[] = [];
    for (const dependent of dependents.get(next)!) {
      const left = remaining.get(dependent)! - 1;
      remaining.set(dependent, left);
      if (left === 0) freed.push(dependent);
    }
    freed.sort((a, b) => rank.get(a)! - rank.get(b)!);
    for (const id of freed) ready.push(id);
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
  }

  // Anything left is in a cycle the recipe-level SCC pass did not exclude; append it
  // in authored order so the array always covers every item.
  for (const id of itemIds) if (!order.includes(id)) order.push(id);
  return order;
}

export function indexContent(bundle: ContentBundle): IndexedContent {
  const lanes = new Map(bundle.lanes.map((l) => [l.id, l]));
  const items = new Map(bundle.items.map((i) => [i.id, i]));
  const machineClasses = new Map(bundle.machineClasses.map((m) => [m.id, m]));

  const indexedRecipes: IndexedRecipe[] = bundle.recipes.map((def) => {
    if (!lanes.has(def.lane)) throw new Error(`recipe "${def.id}": unknown lane "${def.lane}"`);
    if (!machineClasses.has(def.machineClass)) {
      throw new Error(`recipe "${def.id}": unknown machine class "${def.machineClass}"`);
    }

    const outputPerSecond = new Map<ItemId, number>();
    for (const part of def.outputs) {
      if (!items.has(part.item)) throw new Error(`recipe "${def.id}": unknown item "${part.item}"`);
      outputPerSecond.set(part.item, ratePerSecond(part.rate));
    }
    // Megawatts are a standing output, not a per-minute flow, so powerOutput is used
    // as authored rather than divided by 60.
    if (def.powerOutput > 0) outputPerSecond.set(POWER_ITEM, def.powerOutput);

    const inputPerSecond = new Map<ItemId, number>();
    for (const part of def.inputs) {
      if (!items.has(part.item)) throw new Error(`recipe "${def.id}": unknown item "${part.item}"`);
      inputPerSecond.set(part.item, ratePerSecond(part.rate));
    }

    const primary = def.outputs.find((o) => !o.byproduct)?.item;
    const primaryOutput = primary ?? (def.powerOutput > 0 ? POWER_ITEM : undefined);
    if (primaryOutput === undefined) {
      throw new Error(`recipe "${def.id}": has neither a non-byproduct output nor power output`);
    }

    return {
      def,
      lane: def.lane,
      machineClass: def.machineClass,
      outputPerSecond,
      inputPerSecond,
      primaryOutput,
      inCycle: false,
    };
  });

  const cyclicRecipes = findCyclicRecipes(indexedRecipes);
  for (const recipe of indexedRecipes) recipe.inCycle = cyclicRecipes.has(recipe.def.id);

  const recipes = new Map(indexedRecipes.map((r) => [r.def.id, r]));
  const itemIds = [...bundle.items.map((i) => i.id), POWER_ITEM];
  const stockItemIds = bundle.items.map((i) => i.id);

  const producersOf = new Map<ItemId, RecipeId[]>();
  const consumersOf = new Map<ItemId, RecipeId[]>();
  const recipesByLaneClass = new Map<string, RecipeId[]>();
  for (const recipe of indexedRecipes) {
    for (const item of recipe.outputPerSecond.keys()) push(producersOf, item, recipe.def.id);
    for (const item of recipe.inputPerSecond.keys()) push(consumersOf, item, recipe.def.id);
    push(recipesByLaneClass, laneClassKey(recipe.lane, recipe.machineClass), recipe.def.id);
  }

  // Spec 4.4: one active recipe per output item. The default is the first authored
  // non-alternate recipe for that item, falling back to the first of any kind.
  const defaultActiveRecipe: Record<ItemId, RecipeId> = {};
  for (const item of itemIds) {
    const candidates = indexedRecipes.filter((r) => r.primaryOutput === item && !r.inCycle);
    const chosen = candidates.find((r) => !r.def.isAlternate) ?? candidates[0];
    if (chosen) defaultActiveRecipe[item] = chosen.def.id;
  }

  const milestoneByTier = new Map(bundle.milestones.map((m) => [m.tier, m]));
  const maxTier = bundle.milestones.reduce((acc, m) => Math.max(acc, m.tier), 0);

  return {
    bundle,
    lanes,
    items,
    machineClasses,
    recipes,
    itemIds,
    stockItemIds,
    recipeIds: indexedRecipes.map((r) => r.def.id),
    producersOf,
    consumersOf,
    recipesByLaneClass,
    cyclicRecipes,
    topologicalItems: topologicalItems(itemIds, indexedRecipes),
    milestoneByTier,
    maxTier,
    defaultActiveRecipe,
    offlineCapMs: bundle.offlineCapHours * 60 * 60 * 1000,
  };
}
