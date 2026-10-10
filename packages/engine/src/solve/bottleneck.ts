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
import { POWER_ITEM, type ItemId, type RecipeId } from "../content/types.js";
import { isLiveRecipe, type IndexedContent } from "../graph/index-content.js";
import type { CapacityTable } from "../economy/capacity.js";
import { liquid, type ItemStateTag } from "../economy/storage.js";
import { levelCostRange } from "../economy/curves.js";
import { D, type Dec } from "../numbers/decimal.js";
import type { WorldState } from "../state/world.js";
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
  // make unreachable; saying so beats inventing a purchase that cannot be made.
  | { kind: "storage"; itemId: ItemId; limitingTarget: string; upgrade: StorageUpgrade | null }
  | null;

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
 * Which container to buy when a cap is what binds. Cheaper next level wins; a curve
 * already at maxLevel is not a candidate. Only one level is ever recommended -- the
 * caller re-solves after buying, so an iterative honest answer beats quoting a
 * "levels to clear" count derived from the same 10%-lift heuristic that produced the
 * bad machine advice in the first place.
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

  // Both open: compare what one more level costs. Each curve names a single cost
  // item, and they need not be the same one, so compare the amounts that are there.
  const storageCost = levelCostRange(content.bundle.storage, storageLevel, 1);
  const qsCost = levelCostRange(content.bundle.quantumStorage, qsLevel, 1);
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
 */
function drainBlocker(
  walk: WalkContext,
  itemId: ItemId,
  limitingTarget: string,
  visited: Set<ItemId>,
): NonNullable<Bottleneck> {
  visited.add(itemId);
  const { content, state } = walk;
  for (const consumerId of content.consumersOf.get(itemId) ?? []) {
    if (!isLiveRecipe(content, consumerId, state.tier, state.activeRecipe)) continue;
    const fresh = heldOutputOf(walk, consumerId, visited);
    if (fresh !== null) return drainBlocker(walk, fresh, limitingTarget, visited);
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
): Bottleneck {
  for (const recipeId of recipeIds) {
    if (recipeId === null || recipeId === undefined) continue;
    const held = heldOutputOf(walk, recipeId, visited);
    if (held !== null) return drainBlocker(walk, held, limitingTarget, visited);
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
    return jamBlocker(walk, [recipeId], limitingTarget, visited) ?? {
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
  const jam = jamBlocker(walk, [recipeId, entry?.limitedBy], limitingTarget, visited);
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

export function computeBottleneck(
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
      powerEntry?.limitedBy != null &&
      powerEntry.limitedBy !== live
    ) {
      const starvedBy = powerEntry.limitedBy;
      // The supplier can itself be held by a full output; naming it would then buy
      // into a jam. No shipped fuel maker has a byproduct yet, so this is defence for
      // content, pinned by a hand-built test rather than a measured stall.
      const jam = jamBlocker(walk, [starvedBy], powerEntry.entryId, new Set<ItemId>());
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
  );
  if (jam !== null) return jam;

  return {
    kind: "recipe",
    recipeId: firstLimited.limitedBy,
    limitingTarget: firstLimited.entryId,
    machinesToClear: machinesToClearRecipe(capacity, firstLimited),
  };
}
