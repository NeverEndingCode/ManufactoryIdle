// Spec 4.5, amended 2026-09-19: the solver returns the bottleneck as first-class
// output, never something the UI derives. Exactly one row per lane carries the
// treatment -- marking every row under 100% teaches players to ignore the marking.
// The reporter resolves the next milestone's unmet requirements first; only when the
// milestone is satisfied or nothing in it is blocked does it fall back to the recipe
// limiting the HIGHEST-PRIORITY limited target.
//
// machinesToClear is the count that would make some other recipe the binding
// constraint, which is what "6 more constructors clears it" means. The waterfall
// already recorded the runner-up ratio, so no second solve is needed.
//
// Every answer is then priced, and one that can never be paid for -- a cost above its
// item's liquid cap plus the bound stock already held -- becomes storage advice for
// that payer.
import { POWER_ITEM, type ItemId, type RecipeId } from "../content/types.js";
import { isLiveRecipe, type IndexedContent } from "../graph/index-content.js";
import { bestUnlockedMark, type CapacityTable } from "../economy/capacity.js";
import { liquid, liquidCap, type ItemStateTag } from "../economy/storage.js";
import { levelCostRange, machineCostRange } from "../economy/curves.js";
import { D, type Dec } from "../numbers/decimal.js";
import { installedAt, type WorldState } from "../state/world.js";
import type { EntryAllocation } from "./waterfall.js";
import type { PowerReport } from "./power.js";
import { FLOW_TOLERANCE, type ItemFlow } from "./fixpoint.js";

export type Bottleneck =
  | { kind: "recipe"; recipeId: RecipeId; limitingTarget: string; machinesToClear: number }
  | {
      kind: "power";
      limitingTarget: string;
      generatorRecipeId: RecipeId | null;
      machinesToClear: number;
    }
  // A cap is a constraint no machine can clear, and before this kind existed the
  // reporter fell through to the recipe it could name -- telling a player at cap,
  // with production at zero, to buy another machine. `upgrade` is null only when
  // both curves are maxed, which is the permanent wall validator check 9 exists to
  // make unreachable, or when no storage purchase for `itemId` can ever be paid for
  // (the payer chain dead-ends); saying so beats inventing a purchase that cannot be
  // made. `itemId` may be a payer rather than the limiting item: compare it with
  // `limitingTarget`.
  | { kind: "storage"; itemId: ItemId; limitingTarget: string; upgrade: StorageUpgrade | null }
  // Spec 2026-10-13 (reserves protect stock): a purchase priced in `itemId` fits its cap
  // but can never be paid while consumers take every unit made. Set aside `percent` of
  // its production so it can bank. Setting a reserve costs nothing.
  | { kind: "reserve"; itemId: ItemId; percent: number; limitingTarget: string }
  | null;

/** The share of production a reserve advice sets aside: measured on the slice, under the 50% maximum. */
export const RESERVE_ADVICE_PERCENT = 0.25;

/**
 * Spec 2026-10-14: a payer that would take longer than this many offline windows to
 * afford the advised purchase gets production advice instead. Measured on the slice:
 * 0.5 finishes tier 10 soonest with the shortest dead stretches (1 is slower, 0.25
 * buys 66 more machines for a later finish).
 */
export const SLOW_PAYER_HORIZON_COLLECTIONS = 0.5;

export type StorageUpgrade = "storage" | "quantum";

/**
 * `activeRecipe` is a Record<ItemId, RecipeId> keyed by an author-supplied content
 * id (see waterfall.ts's activeRecipeOf for the collision this guards against).
 * POWER_ITEM is a fixed engine constant ("__power__"), not author-supplied, but the
 * lookup goes through the same guarded accessor for consistency and because a
 * future content bundle authoring an item literally named "__power__" is not this
 * function's problem to reason about.
 */
function activeRecipeOf(
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
  itemId: ItemId,
): RecipeId | undefined {
  return Object.hasOwn(activeRecipe, itemId) ? activeRecipe[itemId] : undefined;
}

function machinesToClearRecipe(capacity: CapacityTable, entry: EntryAllocation): number {
  const recipeId = entry.limitedBy;
  if (recipeId === null) return 0;
  const goal = Math.min(entry.runnerUpRate, entry.requested);
  // An unbounded target with no runner-up has no natural "cleared" point, so quote
  // what a 10% lift would take rather than reporting nothing.
  const target = Number.isFinite(goal) ? goal : entry.allocated * 1.1;
  const shortfallUnits = Math.max(0, target - entry.allocated) * entry.limitingPerUnit;
  const perMachine = capacity.unitsPerMachine.get(recipeId) ?? 0;
  if (perMachine <= 0) return 1;
  return Math.max(1, Math.ceil(shortfallUnits / perMachine));
}

function levelOf(record: Readonly<Record<string, number>>, key: string): number {
  return Object.hasOwn(record, key) ? record[key]! : 0;
}

/**
 * The first item in `costs` -- in the map's order, which is the curve's or the mark's
 * authored order -- whose amount is more than that item can ever be held, or null if
 * every one fits. Its liquid cap plus its bound stock, not its stock: a build spends
 * bound, then quantum, then stored, and bound is uncapped but never refills, so waiting
 * fixes a shortfall of stock and only storage fixes a cap. (Ruling R7's liquid-only rule
 * covers milestone deliveries, not builds.) `>` and not `>=`: a player holding exactly
 * the cost can pay it.
 */
function overflowingPayer(
  content: IndexedContent,
  state: WorldState,
  costs: ReadonlyMap<ItemId, Dec>,
): ItemId | null {
  for (const [itemId, amount] of costs) {
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    if (amount.gt(liquidCap(content, state, itemId).plus(bound))) return itemId;
  }
  return null;
}

/** What one more level of `upgrade` for `itemId` costs. */
function upgradeCost(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
  upgrade: StorageUpgrade,
): Map<ItemId, Dec> {
  if (upgrade === "storage") {
    return levelCostRange(content.bundle.storage, levelOf(state.storageLevel, itemId), 1);
  }
  const lane = content.items.get(itemId)!.lane;
  return levelCostRange(content.bundle.quantumStorage, levelOf(state.qsLevel, lane), 1);
}

/**
 * Which container to buy when a cap is what binds. Cheaper next level wins; a curve
 * already at maxLevel is not a candidate. Only one level is ever recommended -- the
 * caller re-solves after buying, so an iterative honest answer beats quoting a
 * "levels to clear" count derived from the same 10%-lift heuristic that produced the
 * bad machine advice in the first place. Of the open curves, one whose next level fits
 * under its cost item's liquid cap plus bound stock is preferred over one that never can.
 */
function cheaperUpgrade(
  content: IndexedContent,
  state: WorldState,
  itemId: ItemId,
): StorageUpgrade | null {
  const item = content.items.get(itemId);
  if (!item) return null;

  const storageLevel = levelOf(state.storageLevel, itemId);
  const qsLevel = levelOf(state.qsLevel, item.lane);
  const storageOpen = storageLevel < content.bundle.storage.maxLevel;
  const qsOpen = qsLevel < content.bundle.quantumStorage.maxLevel;
  if (!storageOpen && !qsOpen) return null;
  if (!qsOpen) return "storage";
  if (!storageOpen) return "quantum";

  // Both open. Prefer one whose next level can ever be paid for -- measured on the
  // slice at tier 7, both of packaged_fuel's overflowed iron_plate's 4,000 cap, and on a
  // bundle that pays the two curves in different items the cheaper one can overflow
  // while the dearer fits. When neither fits, the cheaper is still named and the final
  // `payable` step redirects to the payer.
  const storageCost = levelCostRange(content.bundle.storage, storageLevel, 1);
  const qsCost = levelCostRange(content.bundle.quantumStorage, qsLevel, 1);
  const storageFits = overflowingPayer(content, state, storageCost) === null;
  const qsFits = overflowingPayer(content, state, qsCost) === null;
  if (storageFits !== qsFits) return storageFits ? "storage" : "quantum";

  // Each curve names a single cost item, and they need not be the same one, so compare
  // the amounts that are there.
  const total = (costs: Map<ItemId, Dec>): Dec =>
    [...costs.values()].reduce((sum, amount) => sum.plus(amount), D(0));
  return total(qsCost).lt(total(storageCost)) ? "quantum" : "storage";
}

const NO_ITEMS: ReadonlySet<ItemId> = new Set();

/** What the gridlock walk reads. Bundled because every helper below needs all five. */
interface WalkContext {
  content: IndexedContent;
  capacity: CapacityTable;
  state: WorldState;
  itemStates: ReadonlyMap<ItemId, ItemStateTag>;
  itemRates: ReadonlyMap<ItemId, ItemFlow>;
}

/**
 * FULL and held there: the FULL sweep is scaling this item's producers to its drain
 * rate. FULL alone is not enough -- measured on the fixture, residue at cap with one
 * refinery feeding it and one residual-fuel plant drawing it nets -0.833/s and runs
 * both at clock 1. A draining tank throttles nothing. The tolerance is the solver's
 * own, so float noise on a held item reads as held rather than flickering.
 */
function heldAtCap(walk: WalkContext, itemId: ItemId): boolean {
  if (walk.itemStates.get(itemId) !== "FULL") return false;
  return (walk.itemRates.get(itemId)?.net ?? 0) >= -FLOW_TOLERANCE;
}

/**
 * The first output of `recipeId` -- byproducts included, in authored order -- that is
 * held at its cap, skipping anything already in `exclude`. `exclude` is how the
 * requirement item itself is never treated as a jam: it is always its own recipe's
 * output, it is always in the walk's `visited` set, and a FULL requirement is already
 * answered by storage for it. Skipping rather than stopping matters: residue is
 * `refine_plastic`'s SECOND output, after the plastic the player asked for.
 */
function heldOutputOf(
  walk: WalkContext,
  recipeId: RecipeId,
  exclude: ReadonlySet<ItemId>,
): ItemId | null {
  const recipe = walk.content.recipes.get(recipeId);
  if (!recipe) return null;
  for (const itemId of recipe.outputPerSecond.keys()) {
    if (itemId === POWER_ITEM || exclude.has(itemId)) continue;
    if (heldAtCap(walk, itemId)) return itemId;
  }
  return null;
}

/**
 * What would drain `itemId`, which is held at its cap. Consumers are taken in
 * `content.consumersOf` order, which is bundle order, so the answer is deterministic.
 * A consumer's own held outputs are checked BEFORE its capacity: an unbuilt consumer
 * whose output is already full would be held at clock 0 the moment it was built, so
 * naming it is the same buy-into-a-jam defect the walk exists to remove (a missing
 * residual_fuel plant with fuel at cap -- storage for fuel is the purchase that moves
 * anything). `machinesToClear` is 1 on every answer here: `machinesToClearRecipe`
 * closes a gap to a waterfall runner-up, and a drain has no runner-up; the caller
 * re-solves after buying, the argument the zero-capacity and storage branches already
 * make.
 *
 * `preferred` is the target's own recipe, tried first at the first hop only. The held
 * item can be an INPUT of the target's recipe (the named recipe is an upstream
 * producer whose output is held), and bundle order then puts a consumer off the
 * target's path first: on the vertical slice crude_oil's consumers are refine_plastic,
 * refine_rubber and refine_polymer_resin, so for a `rubber` requirement with crude
 * held, the first consumer drains via refine_plastic (and, plastic being FULL, walks
 * on into plastic's lane) when the answer is refine_rubber. Recursive hops pass null:
 * past the first hop the walk follows held outputs, not the target's recipe.
 */
function drainBlocker(
  walk: WalkContext,
  itemId: ItemId,
  limitingTarget: string,
  visited: Set<ItemId>,
  preferred: RecipeId | null,
): NonNullable<Bottleneck> {
  visited.add(itemId);
  const { content, state } = walk;
  const consumers = content.consumersOf.get(itemId) ?? [];
  const ordered =
    preferred !== null &&
    consumers.includes(preferred) &&
    isLiveRecipe(content, preferred, state.tier, state.activeRecipe)
      ? [preferred, ...consumers.filter((consumerId) => consumerId !== preferred)]
      : consumers;
  for (const consumerId of ordered) {
    if (!isLiveRecipe(content, consumerId, state.tier, state.activeRecipe)) continue;
    const fresh = heldOutputOf(walk, consumerId, visited);
    if (fresh !== null) return drainBlocker(walk, fresh, limitingTarget, visited, null);
    // Every full output of this consumer is already in the walk: it is a loop, not an
    // answer, and naming it would buy a machine the sweep holds at clock 0.
    if (heldOutputOf(walk, consumerId, NO_ITEMS) !== null) continue;
    // Nothing downstream is full. Either it has no machines or it runs but is too slow
    // for what it drains; one more is the right purchase for each.
    return { kind: "recipe", recipeId: consumerId, limitingTarget, machinesToClear: 1 };
  }
  // Nothing live consumes it -- the vertical slice's `fuel` at tier 6 -- or every
  // consumer leads back into the walk. Storage is the only purchase that moves it.
  return {
    kind: "storage",
    itemId,
    limitingTarget,
    upgrade: cheaperUpgrade(content, state, itemId),
  };
}

/**
 * The trigger, called before any recipe-shaped advice. For each listed recipe in
 * order, if one of its outputs is held at cap, buying that recipe cannot help -- the
 * FULL sweep holds it at the drain rate -- so walk forward from that output instead.
 * Callers list the target item's OWN active recipe before the one they would name:
 * measured on the fixture gridlock, the waterfall's `limitedBy` for `plastic` is
 * `extract_oil`, running at clock 1, by the zero-ratio tie-break `resolveBlocker`
 * documents, and only `refine_plastic` -- the recipe actually making plastic -- shows
 * the jam.
 */
function jamBlocker(
  walk: WalkContext,
  recipeIds: readonly (RecipeId | null | undefined)[],
  limitingTarget: string,
  visited: Set<ItemId>,
  /** The target's own active recipe, or null when there is none; see drainBlocker. */
  preferred: RecipeId | null,
): Bottleneck {
  for (const recipeId of recipeIds) {
    if (recipeId === null || recipeId === undefined) continue;
    const held = heldOutputOf(walk, recipeId, visited);
    if (held !== null) return drainBlocker(walk, held, limitingTarget, visited, preferred);
  }
  return null;
}

/**
 * What is stopping `itemId`, or null if nothing is.
 *
 * `visited` is shared across one call's whole sweep rather than reset per
 * requirement: an item that returned null once returns null again, so sharing is
 * exact and saves re-walking an item two requirements have in common. The walk no
 * longer recurses into recipe inputs -- see the comment at the bottom of this
 * function for why. The gridlock walk (`drainBlocker`) shares the same set, and there
 * it IS load-bearing: it is what bounds the forward walk at one visit per item, and
 * what keeps the requirement item itself from ever being walked from.
 */
function resolveBlocker(
  walk: WalkContext,
  entries: readonly EntryAllocation[],
  itemId: ItemId,
  /**
   * The milestone requirement this walk started from. Every blocker reports it as
   * `limitingTarget`, NOT the item the walk happens to have reached: the advice has
   * to read "this is what is stopping the thing you need", not name an intermediate
   * the player never asked for. The blocker's own identity travels in `recipeId` or
   * `itemId`, so both halves are still recoverable.
   */
  targetId: ItemId,
  visited: Set<ItemId>,
): Bottleneck {
  if (visited.has(itemId)) return null;
  visited.add(itemId);
  const { content, capacity, state, itemStates } = walk;
  const limitingTarget = `item:${targetId}`;

  const recipeId = activeRecipeOf(state.activeRecipe, itemId);
  if (recipeId === undefined) return null;
  // A locked recipe is not advice. The player cannot buy a machine for a recipe that
  // has not unlocked, and `unitsByRecipe` only carries live recipes, so without this
  // guard every locked recipe downstream would read as a zero-capacity blocker.
  if (!isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) return null;

  // Zero machines is not "limited" -- nothing is constraining it, it has no capacity
  // at all, and its waterfall entry reports `limitedBy: null`. That is exactly why
  // the priority scan could never name it.
  if ((capacity.unitsByRecipe.get(recipeId) ?? 0) <= 0) {
    return jamBlocker(walk, [recipeId], limitingTarget, visited, recipeId) ?? {
      kind: "recipe",
      recipeId,
      limitingTarget,
      // One, deliberately, and not from `machinesToClearRecipe`. That function
      // answers "how many machines of `entry.limitedBy`", and for a zero-capacity
      // target `limitedBy` need not name this recipe at all: measured on the fixture
      // at tier 2, `plastic` comes back limited by `extract_oil` rather than
      // `refine_plastic`, because both oil recipes sit at ratio 0 with no machines
      // and the tie breaks on `content.recipeIds` order. Quoting its count would
      // attach a number to the wrong recipe. One machine is the honest minimum and
      // the caller re-solves after buying -- the same argument the storage branch
      // makes for only ever recommending one level.
      machinesToClear: 1,
    };
  }

  // A cap is a constraint no machine can clear. Ordered ahead of the limited branch
  // for the same reason the priority scan orders it that way: a FULL item's producer
  // is limited by backpressure, and naming the recipe would advise a purchase that
  // cannot help.
  if (itemStates.get(itemId) === "FULL") {
    return {
      kind: "storage",
      itemId,
      limitingTarget,
      upgrade: cheaperUpgrade(content, state, itemId),
    };
  }

  const entry = entries.find((candidate) => candidate.itemId === itemId);
  // Before trusting the waterfall's name for this blocker, check that neither the
  // recipe making the target nor the one about to be named is held by a full output.
  const jam = jamBlocker(walk, [recipeId, entry?.limitedBy], limitingTarget, visited, recipeId);
  if (jam !== null) return jam;
  if (entry !== undefined && entry.limitedBy !== null) {
    return {
      kind: "recipe",
      recipeId: entry.limitedBy,
      limitingTarget,
      machinesToClear: machinesToClearRecipe(capacity, entry),
    };
  }

  // Producing, uncapped, and getting everything it asked for: this requirement is
  // not blocked, it is merely not banked yet. This branch used to recurse into the
  // recipe's inputs in case one of THEM was stopped, but measurement found that
  // branch dead: running `bottleneck` on the vertical-slice content at tier 2 --
  // the tier the policy could never pass before this task, so the tier where this
  // walk does the most work -- for 5 simulated days hit a counter placed at the top
  // of that loop zero times. The waterfall's `limitedBy` already names the deepest
  // limiting recipe by the time this function runs, so there was nothing left for
  // the recursion to find. Deleted rather than shipped on faith; `visited` stays
  // because it still guards this function's entry point.
  return null;
}

/** The cost of one machine of `recipeId`'s class at the best unlocked mark, or null. */
function machinePrice(
  content: IndexedContent,
  state: WorldState,
  recipeId: RecipeId,
): Map<ItemId, Dec> | null {
  const recipe = content.recipes.get(recipeId);
  if (!recipe) return null;
  const mark = bestUnlockedMark(content, recipe.machineClass, state.tier);
  if (mark === null) return null;
  const owned = installedAt(state, recipe.lane, recipe.machineClass, mark);
  return machineCostRange(content, recipe.machineClass, mark, owned, 1);
}

/**
 * The purchase an answer implies, priced the way the `bottleneck` policy prices it:
 * one level for storage advice, ONE machine for recipe and generator advice (the
 * policy falls back to one when it cannot afford more, so one is what must be
 * possible). Null when the answer implies no purchase.
 */
function priceOf(walk: WalkContext, answer: NonNullable<Bottleneck>): Map<ItemId, Dec> | null {
  const { content, state } = walk;
  switch (answer.kind) {
    case "storage":
      return answer.upgrade === null ? null : upgradeCost(content, state, answer.itemId, answer.upgrade);
    case "recipe":
      return machinePrice(content, state, answer.recipeId);
    case "power":
      return answer.generatorRecipeId === null ? null : machinePrice(content, state, answer.generatorRecipeId);
    case "reserve":
      return null;
  }
}

/**
 * Spec 2026-10-13: an item a purchase is priced in whose stock (plus bound) is short of
 * the price. Its consumers take every unit made, so the purchase can never be paid until
 * something banks it. With no reserve yet, it is named when its net rate is not positive.
 * With a reserve already set, it is named again only while its net rate is positive: the
 * reserve is working, so it is kept until the price is met. A reserved item still not
 * growing is skipped -- the reserve is not helping, and naming it again would loop.
 * An item nothing produces is never named: a reserve cannot bank what no machine makes.
 * An item missing from `itemRates` reads as net 0 and unmade; `solve` lists every item.
 */
function drainedPayer(walk: WalkContext, costs: ReadonlyMap<ItemId, Dec>): ItemId | null {
  const { state, itemRates } = walk;
  for (const [itemId, amount] of costs) {
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    if (liquid(state, itemId).plus(bound).gte(amount)) continue;
    const reserved = (Object.hasOwn(state.reserve, itemId) ? state.reserve[itemId]! : 0) > 0;
    const growing = (itemRates.get(itemId)?.net ?? 0) > FLOW_TOLERANCE;
    // A reserve banks a share of production, so with none set the item must be made.
    const made = (itemRates.get(itemId)?.production ?? 0) > FLOW_TOLERANCE;
    if (reserved ? growing : !growing && made) return itemId;
  }
  return null;
}

/**
 * Spec 2026-10-15: an item the purchase is priced in that is short of the price and not
 * made at all, because its live active recipe has a FULL output (byproducts included)
 * -- returns that output, the first in recipe order not yet visited; else null. It sits
 * between drainedPayer (which names only a made item) and slowPayer (which names only a
 * growing one): a payer whose own recipe is backed up is neither. The `visited` filter
 * is what bounds the caller's loop (see the test that removes it).
 */
function blockedPayerOutput(walk: WalkContext, costs: ReadonlyMap<ItemId, Dec>, visited: ReadonlySet<ItemId>): ItemId | null {
  const { content, state, itemRates, itemStates } = walk;
  for (const [itemId, amount] of costs) {
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    if (liquid(state, itemId).plus(bound).gte(amount)) continue;
    if ((itemRates.get(itemId)?.production ?? 0) > FLOW_TOLERANCE) continue;
    const recipeId = activeRecipeOf(state.activeRecipe, itemId);
    if (recipeId === undefined || !isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) continue;
    for (const output of content.recipes.get(recipeId)!.def.outputs) {
      if (itemStates.get(output.item) === "FULL" && !visited.has(output.item)) return output.item;
    }
  }
  return null;
}

/**
 * Spec 2026-10-14: the cost item that would take longest to afford at its current net
 * rate, if that is longer than SLOW_PAYER_HORIZON_COLLECTIONS offline windows; else
 * null. Only short, growing items count -- a short item that is not growing is
 * drainedPayer's case, and one that already covers its share is not waiting on anything.
 */
function slowPayer(walk: WalkContext, costs: ReadonlyMap<ItemId, Dec>): ItemId | null {
  const { content, state, itemRates } = walk;
  let slowest: ItemId | null = null;
  let worstMs = SLOW_PAYER_HORIZON_COLLECTIONS * content.offlineCapMs;
  for (const [itemId, amount] of costs) {
    const bound = Object.hasOwn(state.bound, itemId) ? state.bound[itemId]! : D(0);
    const shortfall = amount.minus(liquid(state, itemId).plus(bound)).toNumber();
    if (!(shortfall > 0)) continue;
    const net = itemRates.get(itemId)?.net ?? 0;
    if (!(net > FLOW_TOLERANCE)) continue;
    const ms = (shortfall / net) * 1000;
    if (ms > worstMs) {
      worstMs = ms;
      slowest = itemId;
    }
  }
  return slowest;
}

/** True when any input of the recipe is EMPTY. */
function hasEmptyInput(walk: WalkContext, recipeId: RecipeId): boolean {
  return walk.content.recipes.get(recipeId)!.def.inputs.some((input) => walk.itemStates.get(input.item) === "EMPTY");
}

/**
 * The recipe one step toward what starves `recipeId`: the active recipe of its first
 * EMPTY input (recipe order) that is live and not in `visited`, which gains that input.
 * Null when there is none.
 */
function starvedStep(walk: WalkContext, recipeId: RecipeId, visited: Set<ItemId>): RecipeId | null {
  const { content, state } = walk;
  for (const input of content.recipes.get(recipeId)!.def.inputs) {
    if (walk.itemStates.get(input.item) !== "EMPTY" || visited.has(input.item)) continue;
    const next = activeRecipeOf(state.activeRecipe, input.item);
    if (next === undefined || !isLiveRecipe(content, next, state.tier, state.activeRecipe)) continue;
    visited.add(input.item);
    return next;
  }
  return null;
}

/**
 * The final step every answer passes through (spec §4.5, amended 2026-10-10). A
 * purchase that costs more of some item than that item can be held can never be made,
 * so the advice becomes storage for that payer -- priced the same way, so a payer whose
 * own upgrade overflows steps back again. Measured cause: `bottleneck` stalled at tier 7
 * of the vertical slice told to buy a 4,473 iron_plate Quantum Storage level while
 * iron_plate could hold 4,000; one iron_plate storage level, 90, was the way out.
 * Spec 2026-10-14: a payer too slow to afford the price within half an offline window
 * becomes one more machine for its active recipe -- walked on to the recipe limiting it
 * while that recipe has an EMPTY input -- priced through this same loop.
 * Spec 2026-10-15: a payer short and not made at all because its own recipe has a FULL
 * output becomes storage for that output, priced through this same loop.
 * `visited` bounds the steps at one per payer; reaching one twice, or a payer with both
 * curves maxed, ends at `upgrade: null` -- the honest wall, which check 12 makes
 * unreachable at the deepest tier but not before it.
 */
function payable(walk: WalkContext, answer: Bottleneck): Bottleneck {
  if (answer === null) return null;
  const { content, state } = walk;
  const visited = new Set<ItemId>();
  let current: NonNullable<Bottleneck> = answer;
  for (;;) {
    const costs = priceOf(walk, current);
    if (costs === null) return current;
    const payer = overflowingPayer(content, state, costs);
    if (payer === null) {
      // The price fits the cap. Spec 2026-10-13: it may still never be payable, if a
      // consumer drains the item it is priced in.
      const drained = drainedPayer(walk, costs);
      if (drained !== null) {
        return { kind: "reserve", itemId: drained, percent: RESERVE_ADVICE_PERCENT, limitingTarget: answer.limitingTarget };
      }
      // Spec 2026-10-15: a payer not made at all because its own recipe has a FULL output
      // waits on room for that output. Advise storage for it, priced through this loop.
      const blocked = blockedPayerOutput(walk, costs, visited);
      if (blocked !== null) {
        // Adding it to `visited` is what bounds this loop: blockedPayerOutput skips visited
        // outputs, so when the advised storage is itself paid in an item the same output
        // blocks, the next pass finds nothing new and falls through instead of cycling.
        visited.add(blocked);
        current = { kind: "storage", itemId: blocked, limitingTarget: answer.limitingTarget, upgrade: cheaperUpgrade(content, state, blocked) };
        continue;
      }
      // Spec 2026-10-14: payable, but a payer is too slow to get there soon. Advise one
      // more machine for it, and price that through this same loop. One redirect per
      // payer (`visited`), and none when its recipe is not live.
      const slow = slowPayer(walk, costs);
      if (slow === null || visited.has(slow)) return current;
      const recipeId = activeRecipeOf(state.activeRecipe, slow);
      if (recipeId === undefined || !isLiveRecipe(content, recipeId, state.tier, state.activeRecipe)) return current;
      visited.add(slow);
      // A recipe starved of an input makes nothing however many machines it has, so walk
      // to what limits it: the first EMPTY input (recipe order) with a live active
      // recipe not yet visited. Bounded by `visited`. If the deepest recipe still has an
      // EMPTY input it cannot walk to, no machine for it helps: keep the advice as it was.
      let target = recipeId;
      for (let next: RecipeId | null = starvedStep(walk, target, visited); next !== null; next = starvedStep(walk, target, visited)) {
        target = next;
      }
      if (hasEmptyInput(walk, target)) return current;
      current = { kind: "recipe", recipeId: target, limitingTarget: answer.limitingTarget, machinesToClear: 1 };
      continue;
    }
    if (visited.has(payer)) {
      return { kind: "storage", itemId: payer, limitingTarget: answer.limitingTarget, upgrade: null };
    }
    visited.add(payer);
    current = {
      kind: "storage",
      itemId: payer,
      limitingTarget: answer.limitingTarget,
      upgrade: cheaperUpgrade(content, state, payer),
    };
  }
}

function adviseBottleneck(
  content: IndexedContent,
  capacity: CapacityTable,
  entries: readonly EntryAllocation[],
  power: PowerReport,
  state: WorldState,
  itemStates: ReadonlyMap<ItemId, ItemStateTag>,
  itemRates: ReadonlyMap<ItemId, ItemFlow>,
): Bottleneck {
  const tier = state.tier;
  const activeRecipe = state.activeRecipe;
  const firstLimited = entries.find((entry) => entry.limitedBy !== null) ?? null;
  const walk: WalkContext = { content, capacity, state, itemStates, itemRates };

  // Spec 4.5: when the grid is what binds, the bottleneck surfaces on the power bar
  // with a generator purchase instead of a recipe.
  if (power.ratio < 1 - 1e-9) {
    const generatorId = activeRecipeOf(activeRecipe, POWER_ITEM);
    const live =
      generatorId !== undefined && isLiveRecipe(content, generatorId, tier, activeRecipe)
        ? generatorId
        : null;

    // A generator that is installed but starved is not short of generators. Measured
    // on the vertical slice: `bottleneck` stalled at tier 6 owning 77 biomass burners
    // and zero collectors, every burner at clock 0, because this branch always named
    // the generator -- while the power entry's waterfall row already said
    // `limitedBy: collect_biomass`. Only when the generator has capacity: with none,
    // the generator IS what is missing, and naming its fuel chain would be naming the
    // wrong half of the purchase.
    const powerEntry = entries.find((entry) => entry.itemId === POWER_ITEM);
    if (
      live !== null &&
      (capacity.unitsByRecipe.get(live) ?? 0) > 0 &&
      powerEntry !== undefined &&
      powerEntry.limitedBy !== null &&
      powerEntry.limitedBy !== live
    ) {
      const starvedBy = powerEntry.limitedBy;
      // The supplier can itself be held by a full output; naming it would then buy
      // into a jam. No shipped fuel maker has a byproduct yet, so this is defence for
      // content, pinned by a hand-built test rather than a measured stall.
      // The empty visited set is right here: power has no item to revisit. Nor is there
      // a target recipe to prefer (null), so the drain falls back to consumersOf order.
      const jam = jamBlocker(walk, [starvedBy], powerEntry.entryId, new Set<ItemId>(), null);
      if (jam !== null) return jam;
      return {
        kind: "recipe",
        recipeId: starvedBy,
        limitingTarget: powerEntry.entryId,
        // Zero capacity reads as one machine, for resolveBlocker's reason: the
        // shortfall arithmetic answers for `limitedBy`'s own capacity, and with none
        // the honest minimum is one and a re-solve after buying.
        machinesToClear:
          (capacity.unitsByRecipe.get(starvedBy) ?? 0) > 0
            ? machinesToClearRecipe(capacity, powerEntry)
            : 1,
      };
    }

    let machines = 0;
    if (live !== null) {
      const perUnitMw = content.recipes.get(live)!.outputPerSecond.get(POWER_ITEM) ?? 0;
      const perMachineMw = (capacity.unitsPerMachine.get(live) ?? 0) * perUnitMw;
      const deficit = Math.max(0, power.fullDemandMw - power.supplyMw);
      machines = perMachineMw > 0 ? Math.max(1, Math.ceil(deficit / perMachineMw)) : 0;
    }
    return {
      kind: "power",
      limitingTarget: firstLimited?.entryId ?? (entries[0]?.entryId ?? ""),
      generatorRecipeId: live,
      machinesToClear: machines,
    };
  }

  // Spec §4.5 as amended 2026-09-19: what blocks the next milestone outranks what
  // limits the top priority item. Falls through when the milestone is satisfied,
  // when nothing in it is blocked, or at the last tier.
  const nextMilestone = content.milestoneByTier.get(tier + 1);
  if (nextMilestone !== undefined) {
    // Shared across requirements on purpose, with one known edge: a requirement whose
    // walk returned null early stays in `visited`, so a later requirement's gridlock
    // walk skips it even if it is a held byproduct. Unreachable on shipped content, and
    // a fresh set per requirement would re-walk every item two requirements share.
    const visited = new Set<ItemId>();
    for (const requirement of nextMilestone.requires) {
      // Ruling R7 pays deliveries from liquid stock, so liquid is the right measure.
      if (liquid(state, requirement.item).gte(requirement.amount)) continue;
      const blocker = resolveBlocker(walk, entries, requirement.item, requirement.item, visited);
      if (blocker !== null) return blocker;
    }
  }

  if (firstLimited === null || firstLimited.limitedBy === null) return null;

  // A FULL item is throttled by backpressure, not by capacity: its producing recipe
  // is limited because there is nowhere to put the output. Adding machines cannot
  // move it, so the cap must be named before the recipe branch gets the chance.
  if (itemStates.get(firstLimited.itemId) === "FULL") {
    return {
      kind: "storage",
      itemId: firstLimited.itemId,
      limitingTarget: firstLimited.entryId,
      upgrade: cheaperUpgrade(content, state, firstLimited.itemId),
    };
  }

  // The same gridlock check the milestone branch makes, with the scanned item standing
  // in for the requirement: in `visited` from the start, so it is never walked from.
  const jam = jamBlocker(
    walk,
    [activeRecipeOf(activeRecipe, firstLimited.itemId), firstLimited.limitedBy],
    firstLimited.entryId,
    new Set<ItemId>([firstLimited.itemId]),
    activeRecipeOf(activeRecipe, firstLimited.itemId) ?? null,
  );
  if (jam !== null) return jam;

  return {
    kind: "recipe",
    recipeId: firstLimited.limitedBy,
    limitingTarget: firstLimited.entryId,
    machinesToClear: machinesToClearRecipe(capacity, firstLimited),
  };
}

export function computeBottleneck(
  content: IndexedContent,
  capacity: CapacityTable,
  entries: readonly EntryAllocation[],
  power: PowerReport,
  state: WorldState,
  itemStates: ReadonlyMap<ItemId, ItemStateTag>,
  itemRates: ReadonlyMap<ItemId, ItemFlow>,
): Bottleneck {
  const answer = adviseBottleneck(content, capacity, entries, power, state, itemStates, itemRates);
  return payable({ content, capacity, state, itemStates, itemRates }, answer);
}
