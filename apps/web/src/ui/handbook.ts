// The handbook's model (S-13, §13.4): one pure function over the recipe index and the
// engine's computeExpansion, for every item in the bundle. Nothing here is authored text
// about the graph: made from, traces back to and used in all come from the live recipes
// (the snapshot's display state, so the player's alternates count). A locked item, which the
// expansion can't reach at the player's tier, is traced at its own tier with the default
// recipes and says so; a byproduct-only item says what makes it instead.
import {
  bestUnlockedMark,
  computeExpansion,
  D,
  getMark,
  liquidCap,
  type IndexedContent,
  type IndexedRecipe,
  type ItemId,
  type NotationMode,
  type RecipeId,
  type WorldState,
} from "@manufactory/engine";
import { currentNotation, fmt } from "./notation.js";

export interface RecipeLine {
  recipeId: RecipeId;
  name: string;
  machine: string;
  inputs: { itemId: ItemId; name: string; perMin: string }[];
  outputs: { itemId: ItemId; name: string; perMin: string; byproduct: boolean }[];
  power: { kind: "draw"; mw: number; mark: string } | { kind: "output"; mw: number } | null;
  locked: boolean;
  unlockTier: number;
}

export interface HandbookEntry {
  itemId: ItemId;
  name: string;
  laneName: string;
  tier: number;
  locked: boolean;
  capText: string;
  madeFrom: RecipeLine | null;
  alternates: RecipeLine[];
  /** Recipes that make it only as a byproduct (heavy_oil_residue). */
  byproductOf: { recipeId: RecipeId; name: string }[];
  tracesBack: { itemId: ItemId; name: string; amountText: string }[];
  /** Names, raw first: ["Iron Ore", "Iron Ingot", "Iron Rod", "Screw"]. */
  chain: string[];
  /** Non-null when traced at the item's own tier with default recipes (a locked item). */
  tracedAt: { tier: number } | null;
  usedIn: { recipeId: RecipeId; name: string; outputItemId: ItemId; locked: boolean }[];
}

/** S-13: the chain stops after this many steps even without a repeat. */
const MAX_CHAIN_STEPS = 12;

const itemName = (content: IndexedContent, id: ItemId) => content.items.get(id)?.name ?? id;

function recipeLine(
  content: IndexedContent,
  state: WorldState,
  recipe: IndexedRecipe,
  as: NotationMode,
): RecipeLine {
  const def = recipe.def;
  let power: RecipeLine["power"] = null;
  if (def.powerOutput > 0) {
    power = { kind: "output", mw: def.powerOutput };
  } else {
    // The best mark the player has, or would have once the recipe unlocks.
    const tier = Math.max(state.tier, def.unlockTier);
    const n = bestUnlockedMark(content, recipe.machineClass, tier);
    const mark = n === null ? undefined : getMark(content, recipe.machineClass, n);
    if (mark !== undefined && mark.powerDraw > 0)
      power = { kind: "draw", mw: mark.powerDraw, mark: mark.name };
  }
  return {
    recipeId: def.id,
    name: def.name,
    machine: content.machineClasses.get(recipe.machineClass)?.name ?? recipe.machineClass,
    inputs: def.inputs.map((p) => ({
      itemId: p.item,
      name: itemName(content, p.item),
      perMin: fmt(D(p.rate), as),
    })),
    outputs: def.outputs.map((p) => ({
      itemId: p.item,
      name: itemName(content, p.item),
      perMin: fmt(D(p.rate), as),
      byproduct: p.byproduct,
    })),
    power,
    locked: def.unlockTier > state.tier,
    unlockTier: def.unlockTier,
  };
}

/**
 * S-13's chain rule, the one place it lives: from the item, step to the input of its active
 * recipe with the largest raw total (the sum of that input's rawCost), ties to authored input
 * order. Stop at an extraction recipe (no inputs), a repeat, or MAX_CHAIN_STEPS. Raw first.
 */
export function chainOf(
  content: IndexedContent,
  active: Readonly<Record<ItemId, RecipeId>>,
  rawCost: ReadonlyMap<ItemId, ReadonlyMap<ItemId, number>>,
  itemId: ItemId,
): ItemId[] {
  const rawTotal = (id: ItemId) => {
    let sum = 0;
    for (const v of rawCost.get(id)?.values() ?? []) sum += v;
    return sum;
  };
  const chain = [itemId];
  let at = itemId;
  for (let step = 0; step < MAX_CHAIN_STEPS; step++) {
    const rid = active[at];
    const recipe = rid === undefined ? undefined : content.recipes.get(rid);
    if (recipe === undefined || recipe.def.inputs.length === 0) break;
    let best: ItemId | null = null;
    let bestTotal = -Infinity;
    for (const part of recipe.def.inputs) {
      const total = rawTotal(part.item);
      if (total > bestTotal) {
        best = part.item;
        bestTotal = total;
      }
    }
    if (best === null || chain.includes(best)) break;
    chain.push(best);
    at = best;
  }
  return chain.reverse();
}

export function handbookEntry(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
  as: NotationMode = currentNotation(),
): HandbookEntry | null {
  const item = content.items.get(itemId);
  if (item === undefined) return null;
  const locked = item.tier > state.tier;
  // A locked item can't be live at the player's tier (S-13, measured): trace it at its own
  // tier with the bundle's default recipes, and label it.
  const traceTier = locked ? Math.max(state.tier, item.tier) : state.tier;
  const active = locked ? content.defaultActiveRecipe : state.activeRecipe;
  const vectors = computeExpansion(content, traceTier, active);
  const raw = vectors.rawCost.get(itemId);

  const producers = (content.producersOf.get(itemId) ?? []).map((id) => content.recipes.get(id)!);
  const own = producers.filter((r) => r.primaryOutput === itemId);
  const activeId = active[itemId];
  const made = own.find((r) => r.def.id === activeId) ?? null;

  return {
    itemId,
    name: item.name,
    laneName: content.lanes.get(item.lane)?.name ?? item.lane,
    tier: item.tier,
    locked,
    capText: fmt(liquidCap(content, state, itemId), as),
    madeFrom: made === null ? null : recipeLine(content, state, made, as),
    alternates: own.filter((r) => r !== made).map((r) => recipeLine(content, state, r, as)),
    byproductOf: producers
      .filter((r) => r.primaryOutput !== itemId)
      .map((r) => ({ recipeId: r.def.id, name: r.def.name })),
    tracesBack: [...(raw ?? new Map<ItemId, number>())].map(([id, amount]) => ({
      itemId: id,
      name: itemName(content, id),
      amountText: fmt(D(amount), as),
    })),
    chain:
      made === null
        ? [item.name]
        : chainOf(content, active, vectors.rawCost, itemId).map((id) => itemName(content, id)),
    tracedAt: locked ? { tier: traceTier } : null,
    usedIn: (content.consumersOf.get(itemId) ?? []).map((id) => {
      const r = content.recipes.get(id)!;
      return {
        recipeId: id,
        name: r.def.name,
        outputItemId: r.primaryOutput,
        locked: r.def.unlockTier > state.tier,
      };
    }),
  };
}

/** S-13: a case-insensitive substring match on name and id, every bundle item, in lane order
 * (authored order within a lane). */
export function searchItems(
  content: IndexedContent,
  state: WorldState,
  query: string,
): { itemId: ItemId; name: string; laneName: string; locked: boolean }[] {
  const q = query.trim().toLowerCase();
  const laneOrder = (lane: string) => content.lanes.get(lane)?.order ?? Infinity;
  return content.bundle.items
    .filter((i) => q === "" || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
    .map((i, at) => ({ i, at }))
    .sort((a, b) => laneOrder(a.i.lane) - laneOrder(b.i.lane) || a.at - b.at)
    .map(({ i }) => ({
      itemId: i.id,
      name: i.name,
      laneName: content.lanes.get(i.lane)?.name ?? i.lane,
      locked: i.tier > state.tier,
    }));
}
