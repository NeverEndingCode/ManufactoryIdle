// Original spec section 4.2's demand-pull waterfall, processed in priority order
// with remaining[R] depleted as each target takes its share.
//
// The one thing the original algorithm does not have is spec C.2's notion of stock.
// An item with stock can supply a target faster than it is produced -- the stock
// drains at (demand - production) and hitting zero is a discrete event the event
// loop already looks for. So the requirement walk traverses THROUGH an item only
// when that item is pinned EMPTY, where consumption really is clamped to
// production. Everywhere else it stops. That cut is what makes the pin set
// meaningful, and it is why solve/fixpoint.ts exists.
//
// Capacity is measured in machine-units (one Mk1 machine at clock 1, no
// multipliers), so remaining[R] / vector[R] is an achievable item/second rate.
import type { ItemId, RecipeId } from "../content/types.js";
import type { IndexedContent } from "../graph/index-content.js";
import type { ExpansionVectors } from "../graph/expand.js";
import type { PriorityEntry, WorldState } from "../state/world.js";
import { unconstrainedRate, type CapacityTable } from "../economy/capacity.js";

/** Spec 4.2's suggested 2%. Keeps a low-priority target off a hard 0%. */
export const RESERVE_FLOOR = 0.02;

/** Ruling R8: a reserve can never eat more than half of an item's own production. */
const RESERVE_MAX_PERCENT = 0.5;

export interface EntryAllocation {
  entryId: string;
  itemId: ItemId;
  /** Infinity when the entry is unbounded. */
  requested: number;
  allocated: number;
  /** null when the entry got everything it asked for. */
  limitedBy: RecipeId | null;
  /** Machine-units of `limitedBy` per one item/second of `itemId`. */
  limitingPerUnit: number;
  /** What this entry could reach if `limitedBy` were cleared. Infinity if unbounded. */
  runnerUpRate: number;
}

export interface WaterfallResult {
  usedUnits: Map<RecipeId, number>;
  remainingUnits: Map<RecipeId, number>;
  entries: EntryAllocation[];
  /** recipe -> entryId -> machine-units. Drives spec 13.1's split bars. */
  allocations: Map<RecipeId, Map<string, number>>;
  /**
   * Ruling R32 (task 14b): entry ids excluded from ever drawing on their own
   * item's producing recipe this pass. Ruling R31's reconciliation pass
   * (solve/fixpoint.ts) must feed this back in as `forceDisqualified` on its
   * second `runWaterfall` call rather than let that call recompute its own --
   * the recomputation uses `reconciledCapacityUnits`, which is deliberately a
   * different (already-final, absolute) number than this call's nameplate
   * `capacityUnits` for a sweep-touched recipe, and that difference can shift
   * a ceiling comparison enough to disqualify a different set of entries.
   * Reusing this call's answer is what keeps a recipe untouched by the sweep
   * reproducing this pass's own split bit-for-bit, exactly like
   * `untaxedRecipes` already does for the reserve-floor tax.
   */
  disqualified: ReadonlySet<string>;
}

/**
 * `activeRecipe` is a Record<ItemId, RecipeId> keyed by an author-supplied content
 * id, and content ids are free to collide with a name already on Object.prototype
 * (this fixture bundle has a machine class named "constructor"). Plain
 * `activeRecipe[itemId]` on an object with no own such property resolves through
 * the prototype chain instead of returning undefined, so the `=== undefined` guard
 * below would never fire for a colliding key. Object.hasOwn distinguishes "own
 * property" from "no own property at all", mirroring ownOrUndefined in
 * state/world.ts and assignmentOf in economy/capacity.ts.
 */
function activeRecipeOf(
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
  itemId: ItemId,
): RecipeId | undefined {
  return Object.hasOwn(activeRecipe, itemId) ? activeRecipe[itemId] : undefined;
}

/** Same hazard as activeRecipeOf, for `state.reserve`. */
function reservePercentOf(state: WorldState, itemId: ItemId): number {
  return Object.hasOwn(state.reserve, itemId) ? (state.reserve[itemId] ?? 0) : 0;
}

/**
 * Machine-units of each recipe needed per one item/second of `itemId`, cutting the
 * walk at every input that is not pinned EMPTY.
 *
 * `memo` must be created fresh per pass, because it is only valid for one pin set.
 */
export function requirementVector(
  content: IndexedContent,
  vectors: ExpansionVectors,
  activeRecipe: Readonly<Record<ItemId, RecipeId>>,
  itemId: ItemId,
  pinnedEmpty: ReadonlySet<ItemId>,
  memo: Map<ItemId, Map<RecipeId, number>>,
): Map<RecipeId, number> {
  const cached = memo.get(itemId);
  if (cached) return cached;

  const units = vectors.unitsPerItem.get(itemId);
  const recipeId = activeRecipeOf(activeRecipe, itemId);
  if (units === undefined || recipeId === undefined) {
    const empty = new Map<RecipeId, number>();
    memo.set(itemId, empty);
    return empty;
  }

  // Insert before recursing: ruling R6 excludes cycles, but a content bug must not
  // turn into an infinite recursion inside the engine.
  const vector = new Map<RecipeId, number>([[recipeId, units]]);
  memo.set(itemId, vector);

  for (const [inputId, perUnit] of vectors.directInputs.get(itemId) ?? []) {
    if (!pinnedEmpty.has(inputId)) continue;
    const sub = requirementVector(content, vectors, activeRecipe, inputId, pinnedEmpty, memo);
    for (const [subRecipe, subUnits] of sub) {
      vector.set(subRecipe, (vector.get(subRecipe) ?? 0) + subUnits * perUnit);
    }
  }
  return vector;
}

/**
 * Spec C.4 supplies the power entry's target rate from the grid demand, because
 * demand is only known once clocks are. Ruling R8 injects reserve entries, clamped
 * to at most 50% so a reserve can never starve the rest of the list.
 */
export function effectivePriority(
  content: IndexedContent,
  state: WorldState,
  capacity: CapacityTable,
  powerTargetRate: number,
): PriorityEntry[] {
  const live = state.priority
    .filter((entry) => !entry.paused)
    .map((entry) =>
      entry.kind === "power" ? { ...entry, targetRate: powerTargetRate } : entry,
    );

  const reserves: PriorityEntry[] = [];
  for (const itemId of content.stockItemIds) {
    const raw = reservePercentOf(state, itemId);
    const percent = Math.min(RESERVE_MAX_PERCENT, Math.max(0, raw));
    if (percent <= 0) continue;
    reserves.push({
      id: `reserve:${itemId}`,
      kind: "item",
      itemId,
      mode: "guaranteed",
      share: 1,
      targetRate: percent * unconstrainedRate(content, capacity, itemId),
      paused: false,
    });
  }
  if (reserves.length === 0) return live;

  const powerIndex = live.findIndex((entry) => entry.kind === "power");
  const at = powerIndex >= 0 ? powerIndex + 1 : 0;
  return [...live.slice(0, at), ...reserves, ...live.slice(at)];
}

export interface WaterfallArgs {
  content: IndexedContent;
  vectors: ExpansionVectors;
  activeRecipe: Readonly<Record<ItemId, RecipeId>>;
  capacityUnits: ReadonlyMap<RecipeId, number>;
  entries: readonly PriorityEntry[];
  pinnedEmpty: ReadonlySet<ItemId>;
  reserveFloor: number;
  /**
   * Ruling R31's reconciliation pass (solve/fixpoint.ts) supplies this: recipes
   * whose `capacityUnits` here is already an absolute, final machine-units figure
   * (post FULL/EMPTY sweep), not a nameplate ceiling the reserve floor should tax.
   * Taxing it again would silently shrink a recipe that was already correctly
   * clamped -- exactly the failure mode this set exists to prevent. Every other
   * caller omits it, so ordinary solves are untouched.
   */
  untaxedRecipes?: ReadonlySet<RecipeId>;
  /**
   * Ruling R32 (task 14b): when supplied, used as this call's disqualified set
   * verbatim instead of recomputing one. Ruling R31's reconciliation pass
   * (solve/fixpoint.ts) supplies its first call's `WaterfallResult.disqualified`
   * here on its second call, for the same reason it supplies `untaxedRecipes`:
   * the second call's `capacityUnits` are deliberately different (already-final)
   * numbers for a sweep-touched recipe, and recomputing from them can reach a
   * different answer than the first call did. Every other caller omits it, so
   * ordinary solves compute their own.
   */
  forceDisqualified?: ReadonlySet<string>;
}

interface Constraint {
  recipeId: RecipeId;
  ratio: number;
  perUnit: number;
}

/** Walks a vector in authored recipe order so ties break canonically (spec A.5). */
function constraints(
  content: IndexedContent,
  vector: ReadonlyMap<RecipeId, number>,
  remaining: ReadonlyMap<RecipeId, number>,
): Constraint[] {
  const out: Constraint[] = [];
  for (const recipeId of content.recipeIds) {
    const perUnit = vector.get(recipeId);
    if (perUnit === undefined || perUnit <= 0) continue;
    out.push({ recipeId, ratio: (remaining.get(recipeId) ?? 0) / perUnit, perUnit });
  }
  return out;
}

function bestTwo(list: readonly Constraint[]): { best: Constraint | null; runnerUp: number } {
  let best: Constraint | null = null;
  let runnerUp = Number.POSITIVE_INFINITY;
  for (const candidate of list) {
    if (best === null || candidate.ratio < best.ratio) {
      if (best !== null) runnerUp = Math.min(runnerUp, best.ratio);
      best = candidate;
    } else {
      runnerUp = Math.min(runnerUp, candidate.ratio);
    }
  }
  return { best, runnerUp };
}

interface PassResult {
  usedUnits: Map<RecipeId, number>;
  allocations: Map<RecipeId, Map<string, number>>;
  results: Map<string, EntryAllocation>;
}

/**
 * `itemId`'s production minus consumption, given a completed pass's clocks.
 * Mirrors solve/fixpoint.ts's `computeFlows` exactly, but scoped to one item
 * via `producersOf`/`consumersOf` rather than built as a full
 * Map<ItemId, ItemFlow> over every recipe -- `computeFlows` cannot be
 * imported here without a circular import (fixpoint.ts already imports
 * `runWaterfall` from this module), and ruling R32 (task 14b) below only
 * ever needs one item's net at a time.
 */
function netForItem(
  content: IndexedContent,
  itemId: ItemId,
  capacityUnits: ReadonlyMap<RecipeId, number>,
  clocks: ReadonlyMap<RecipeId, number>,
): number {
  let production = 0;
  let consumption = 0;
  for (const recipeId of content.producersOf.get(itemId) ?? []) {
    const units = capacityUnits.get(recipeId);
    if (units === undefined) continue;
    const rate = units * (clocks.get(recipeId) ?? 0);
    if (rate === 0) continue;
    const recipe = content.recipes.get(recipeId);
    if (!recipe) continue;
    production += rate * (recipe.outputPerSecond.get(itemId) ?? 0);
  }
  for (const recipeId of content.consumersOf.get(itemId) ?? []) {
    const units = capacityUnits.get(recipeId);
    if (units === undefined) continue;
    const rate = units * (clocks.get(recipeId) ?? 0);
    if (rate === 0) continue;
    const recipe = content.recipes.get(recipeId);
    if (!recipe) continue;
    consumption += rate * (recipe.inputPerSecond.get(itemId) ?? 0);
  }
  return production - consumption;
}

export function runWaterfall(args: WaterfallArgs): WaterfallResult {
  const {
    content,
    vectors,
    activeRecipe,
    capacityUnits,
    entries,
    pinnedEmpty,
    reserveFloor,
    untaxedRecipes,
    forceDisqualified,
  } = args;

  const live = entries.filter((entry) => !entry.paused);

  // The requirement vectors for the REAL pin set, used for the candidate
  // pre-filter below (touchCount) and as this call's default when `runPasses`
  // is not probing an alternate pin set.
  const memo = new Map<ItemId, Map<RecipeId, number>>();
  const vectorOf = new Map<string, Map<RecipeId, number>>();
  for (const entry of live) {
    vectorOf.set(
      entry.id,
      entry.itemId === null
        ? new Map<RecipeId, number>()
        : requirementVector(content, vectors, activeRecipe, entry.itemId, pinnedEmpty, memo),
    );
  }

  // A recipe is contested when two or more entries pull through it. Only contested
  // capacity is taxed by the reserve floor (spec 4.2).
  const touchCount = new Map<RecipeId, number>();
  for (const vector of vectorOf.values()) {
    for (const recipeId of vector.keys()) {
      touchCount.set(recipeId, (touchCount.get(recipeId) ?? 0) + 1);
    }
  }

  // One full phase-A/phase-B run against `pinnedEmptyForPass`, with every
  // entry named in `excluded` skipped entirely (never committed, never
  // touching `remaining`) and seeded to allocated 0 so it still appears in the
  // final `entries` output. `pinnedEmptyForPass` need not be the real
  // `pinnedEmpty`: ruling R32 (task 14b) below calls this with one item
  // removed, to answer "what would this item's producing recipe's clock be if
  // that item were not pinned EMPTY" without actually mutating any state --
  // recomputing the requirement vectors fresh each call is what makes that
  // question answerable at all, since a vector's shape (which recipes it even
  // touches) depends on which inputs are pinned, not just their magnitudes.
  const runPasses = (pinnedEmptyForPass: ReadonlySet<ItemId>, excluded: ReadonlySet<string>): PassResult => {
    const passVectorOf =
      pinnedEmptyForPass === pinnedEmpty
        ? vectorOf
        : (() => {
            const freshMemo = new Map<ItemId, Map<RecipeId, number>>();
            const built = new Map<string, Map<RecipeId, number>>();
            for (const entry of live) {
              built.set(
                entry.id,
                entry.itemId === null
                  ? new Map<RecipeId, number>()
                  : requirementVector(
                      content,
                      vectors,
                      activeRecipe,
                      entry.itemId,
                      pinnedEmptyForPass,
                      freshMemo,
                    ),
              );
            }
            return built;
          })();

    // A recipe touched only by an excluded entry and one real claimant is not
    // "contested" from this pass's point of view: recomputed with the excluded
    // entries' vectors removed, so the corrective pass does not also withhold
    // a 2% slice that nobody excluded could ever have claimed anyway.
    const localTouchCount = new Map<RecipeId, number>();
    for (const entry of live) {
      if (excluded.has(entry.id)) continue;
      for (const recipeId of passVectorOf.get(entry.id)!.keys()) {
        localTouchCount.set(recipeId, (localTouchCount.get(recipeId) ?? 0) + 1);
      }
    }

    const usedUnits = new Map<RecipeId, number>();
    const allocations = new Map<RecipeId, Map<string, number>>();
    const results = new Map<string, EntryAllocation>();
    for (const recipeId of capacityUnits.keys()) usedUnits.set(recipeId, 0);

    for (const entry of live) {
      if (!excluded.has(entry.id)) continue;
      results.set(entry.id, {
        entryId: entry.id,
        itemId: entry.itemId ?? "",
        requested: entry.targetRate ?? Number.POSITIVE_INFINITY,
        allocated: 0,
        limitedBy: null,
        limitingPerUnit: 0,
        runnerUpRate: Number.POSITIVE_INFINITY,
      });
    }

    const commit = (entryId: string, vector: ReadonlyMap<RecipeId, number>, rate: number): void => {
      if (rate <= 0) return;
      for (const [recipeId, perUnit] of vector) {
        const units = rate * perUnit;
        usedUnits.set(recipeId, (usedUnits.get(recipeId) ?? 0) + units);
        const perEntry = allocations.get(recipeId) ?? new Map<string, number>();
        perEntry.set(entryId, (perEntry.get(entryId) ?? 0) + units);
        allocations.set(recipeId, perEntry);
      }
    };

    const runPass = (pool: ReadonlyMap<RecipeId, number>, only: ReadonlySet<string> | null): void => {
      const remaining = new Map(pool);
      const shareGroup = live.filter((entry) => entry.mode === "share" && !excluded.has(entry.id));
      const shareHandled = new Set<string>();

      for (const entry of live) {
        if (only !== null && !only.has(entry.id)) continue;
        if (excluded.has(entry.id)) continue;

        if (entry.mode === "share") {
          if (shareHandled.size > 0) continue;
          // `only` (phase B) can restrict this filter to a subset of the group's ids,
          // which reads as if a share group could be split -- it can't, safely. Every
          // member of a group is scaled by the SAME `scale` below, so within one pass a
          // member either gets weight*scale > 0 or gets exactly 0, and it can only get
          // 0 for two reasons: the whole group's scale is 0 (every member ends up in
          // `only` together, so `members` still names the whole group), or that one
          // member's own `share <= 0` (weight 0, so its absence from `only` changes
          // nothing). A "group of one" therefore only ever arises from the share<=0
          // case, which the totalShare<=0 check just below turns into a no-op -- it
          // never silently drops a sibling that still deserved a slice.
          const members = shareGroup.filter((m) => only === null || only.has(m.id));
          if (members.length === 0) continue;

          let totalShare = 0;
          for (const member of members) totalShare += Math.max(0, member.share);
          if (totalShare <= 0) continue;

          // The group's combined draw at its authored weights, then one scalar.
          const groupVector = new Map<RecipeId, number>();
          const weightOf = new Map<string, number>();
          for (const member of members) {
            const weight = Math.max(0, member.share) / totalShare;
            weightOf.set(member.id, weight);
            for (const [recipeId, perUnit] of passVectorOf.get(member.id)!) {
              groupVector.set(recipeId, (groupVector.get(recipeId) ?? 0) + weight * perUnit);
            }
          }

          const { best, runnerUp } = bestTwo(constraints(content, groupVector, remaining));
          let scale = best === null ? Number.POSITIVE_INFINITY : best.ratio;
          for (const member of members) {
            if (member.targetRate === null) continue;
            const weight = weightOf.get(member.id)!;
            if (weight > 0) scale = Math.min(scale, member.targetRate / weight);
          }
          // Mirrors the guaranteed branch's `Math.max(0, Math.min(requested, ceiling))`
          // floor below -- nothing currently drives scale negative, but the asymmetry
          // is a trap for a future edit (e.g. an unvalidated negative targetRate).
          scale = Math.max(0, scale);
          if (!Number.isFinite(scale)) scale = 0;

          for (const [recipeId, perUnit] of groupVector) {
            remaining.set(recipeId, (remaining.get(recipeId) ?? 0) - scale * perUnit);
          }
          for (const member of members) {
            const weight = weightOf.get(member.id)!;
            const memberVector = passVectorOf.get(member.id)!;
            // A member with no live recipe (e.g. tier-gated) contributed nothing to
            // groupVector and cannot actually produce, so it must not share in the
            // group's scale -- mirroring the guaranteed branch's `ceiling = 0` on an
            // empty constraint list. Without this, `weight * scale` fabricates an
            // `allocated` figure for an item the waterfall never actually reserved any
            // capacity for: commit() no-ops on the empty vector, so usedUnits stays
            // correct, but the per-entry `allocated` this function returns does not.
            const hasRecipe = memberVector.size > 0;
            const rate = hasRecipe ? weight * scale : 0;
            commit(member.id, memberVector, rate);
            const previous = results.get(member.id);
            results.set(member.id, {
              entryId: member.id,
              itemId: member.itemId ?? "",
              requested: member.targetRate ?? Number.POSITIVE_INFINITY,
              allocated: (previous?.allocated ?? 0) + rate,
              limitedBy: hasRecipe ? (best?.recipeId ?? null) : null,
              limitingPerUnit:
                hasRecipe && best !== null ? (memberVector.get(best.recipeId) ?? 0) : 0,
              runnerUpRate: runnerUp,
            });
            shareHandled.add(member.id);
          }
          continue;
        }

        const vector = passVectorOf.get(entry.id)!;
        const requested = entry.targetRate ?? Number.POSITIVE_INFINITY;
        const { best, runnerUp } = bestTwo(constraints(content, vector, remaining));
        const ceiling = best === null ? 0 : best.ratio;
        const allocated = Math.max(0, Math.min(requested, ceiling));

        for (const [recipeId, perUnit] of vector) {
          remaining.set(recipeId, (remaining.get(recipeId) ?? 0) - allocated * perUnit);
        }
        commit(entry.id, vector, allocated);

        const limited = best !== null && allocated < requested - 1e-12;
        const previous = results.get(entry.id);
        results.set(entry.id, {
          entryId: entry.id,
          itemId: entry.itemId ?? "",
          requested,
          allocated: (previous?.allocated ?? 0) + allocated,
          limitedBy: limited ? best.recipeId : null,
          limitingPerUnit: limited ? best.perUnit : 0,
          runnerUpRate: runnerUp,
        });
      }
    };

    // Phase A: contested recipes are taxed by the reserve floor.
    const phaseA = new Map<RecipeId, number>();
    for (const [recipeId, units] of capacityUnits) {
      const contested = (localTouchCount.get(recipeId) ?? 0) >= 2 && !untaxedRecipes?.has(recipeId);
      phaseA.set(recipeId, contested ? units * (1 - reserveFloor) : units);
    }
    runPass(phaseA, null);

    // Phase B: whatever is still unused, offered in priority order to the entries
    // that got exactly nothing. This is what keeps a low-priority target off a
    // hard 0%.
    const starved = new Set<string>();
    for (const entry of live) {
      if (excluded.has(entry.id)) continue;
      const result = results.get(entry.id);
      if (result && result.allocated <= 0 && passVectorOf.get(entry.id)!.size > 0) starved.add(entry.id);
    }
    if (starved.size > 0) {
      const phaseB = new Map<RecipeId, number>();
      for (const [recipeId, units] of capacityUnits) {
        phaseB.set(recipeId, units - (usedUnits.get(recipeId) ?? 0));
      }
      runPass(phaseB, starved);
    }

    return { usedUnits, allocations, results };
  };

  // Ruling R32 (task 14b): an entry is disqualified from ever drawing on its OWN
  // item's producing recipe when that item (X) is pinned EMPTY, has a live
  // downstream consumer, and -- were X not pinned EMPTY at all -- X's own
  // recipe would run at a net that is actually negative (consumption would
  // exceed production).
  //
  // Any nonzero allocation to the owning entry in that situation manufactures a
  // net > 0 for an item that is pinned EMPTY -- production credited to the
  // entry's own bank, not consumed by anything -- while spec C.2's EMPTY
  // invariant only ever promises consumption <= production, never that a
  // leftover is sustainable. The instant that manufactured surplus lifts liquid
  // off zero, the item stops being pinned EMPTY, so every OTHER entry's
  // requirement walk that was only routing through X BECAUSE X was pinned
  // EMPTY no longer does: each switches from "bandwidth-limited by upstream" to
  // "unconstrained, draw from stock" in the very next solve, which drains the
  // manufactured surplus back to exactly zero and re-pins. resolve()'s
  // nextDiscontinuity chases that forever at ever-smaller timesteps (task 14's
  // escalated finding, root-caused in task 14b): a genuine sliding-mode
  // equilibrium the two-pass waterfall cannot represent as a fixed point,
  // because it keeps trying to hand the item's own entry a share the
  // equilibrium cannot actually sustain -- whether that share comes from an
  // uncontested slice of phase A (the owner outranks its walkers) or from
  // phase B's reserve-floor top-up (the owner is outranked). Both are the same
  // instability; only priority order decides which phase manufactures it,
  // which is why priority order cannot be what this check keys on.
  //
  // "Were X not pinned EMPTY at all" is answered literally, by re-running the
  // whole phase-A/phase-B machinery with X removed from the pin set (via
  // `runPasses`'s `pinnedEmptyForPass` above) and reading off X's OWN net from
  // the resulting clocks -- not by comparing one walker's isolated ceiling
  // against a full, untaxed `capacityUnits` pool. That isolated-ceiling
  // comparison was tried and found wanting: it ignores that OTHER entries
  // (including X's own siblings, e.g. a player-configured `reserve:` entry
  // alongside X's ordinary priority-list entry, and other walkers entirely
  // unrelated to X) also compete for the very same recipes, so a walker's
  // true, currently-attainable rate can be well below what an isolated
  // capacity check reports, understating how much unpinning X would actually
  // let that walker's demand jump. Re-running the real mechanism is what
  // makes every one of those interactions fall out correctly for free.
  //
  // Scoped to `mode === "guaranteed"`: no share-mode entry in the fixture or
  // generator exercises this shape, and folding disqualification into the
  // share group's weighted scale would complicate its renormalization for no
  // covered case.
  let disqualified: ReadonlySet<string>;
  if (forceDisqualified) {
    disqualified = forceDisqualified;
  } else {
    const computed = new Set<string>();
    for (const entry of live) {
      if (entry.mode !== "guaranteed" || entry.itemId === null) continue;
      if (!pinnedEmpty.has(entry.itemId)) continue;
      if ((content.consumersOf.get(entry.itemId) ?? []).length === 0) continue;
      const ownRecipe = activeRecipeOf(activeRecipe, entry.itemId);
      if (ownRecipe === undefined) continue;
      if ((touchCount.get(ownRecipe) ?? 0) < 2) continue;

      const pinnedWithoutX = new Set(pinnedEmpty);
      pinnedWithoutX.delete(entry.itemId);
      const alt = runPasses(pinnedWithoutX, new Set());
      const altClocks = new Map<RecipeId, number>();
      for (const [recipeId, units] of capacityUnits) {
        altClocks.set(recipeId, units > 0 ? (alt.usedUnits.get(recipeId) ?? 0) / units : 0);
      }
      if (netForItem(content, entry.itemId, capacityUnits, altClocks) < -1e-9) {
        computed.add(entry.id);
      }
    }
    disqualified = computed;
  }

  const final = runPasses(pinnedEmpty, disqualified);

  const remainingUnits = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacityUnits) {
    remainingUnits.set(recipeId, units - (final.usedUnits.get(recipeId) ?? 0));
  }

  // The final ordering matches priority order, except that a share group is a
  // single block sitting at the position of its first member -- the group is
  // processed as one unit, so it reads as one unit too.
  const allShareMembers = live.filter((entry) => entry.mode === "share");
  const orderedEntries: EntryAllocation[] = [];
  let shareBlockEmitted = false;
  for (const entry of live) {
    if (entry.mode === "share") {
      if (shareBlockEmitted) continue;
      shareBlockEmitted = true;
      for (const member of allShareMembers) {
        const result = final.results.get(member.id);
        if (result) orderedEntries.push(result);
      }
      continue;
    }
    const result = final.results.get(entry.id);
    if (result) orderedEntries.push(result);
  }

  return {
    usedUnits: final.usedUnits,
    remainingUnits,
    entries: orderedEntries,
    allocations: final.allocations,
    disqualified,
  };
}
