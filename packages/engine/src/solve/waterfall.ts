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

export function runWaterfall(args: WaterfallArgs): WaterfallResult {
  const { content, vectors, activeRecipe, capacityUnits, entries, pinnedEmpty, reserveFloor } =
    args;

  const live = entries.filter((entry) => !entry.paused);
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

  const usedUnits = new Map<RecipeId, number>();
  const allocations = new Map<RecipeId, Map<string, number>>();
  const results = new Map<string, EntryAllocation>();
  for (const recipeId of capacityUnits.keys()) usedUnits.set(recipeId, 0);

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
    const shareGroup = live.filter((entry) => entry.mode === "share");
    const shareHandled = new Set<string>();

    for (const entry of live) {
      if (only !== null && !only.has(entry.id)) continue;

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
          for (const [recipeId, perUnit] of vectorOf.get(member.id)!) {
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
          const memberVector = vectorOf.get(member.id)!;
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

      const vector = vectorOf.get(entry.id)!;
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
    const contested = (touchCount.get(recipeId) ?? 0) >= 2;
    phaseA.set(recipeId, contested ? units * (1 - reserveFloor) : units);
  }
  runPass(phaseA, null);

  // Phase B: whatever is still unused, offered in priority order to the entries that
  // got exactly nothing. This is what keeps a low-priority target off a hard 0%.
  const starved = new Set<string>();
  for (const entry of live) {
    const result = results.get(entry.id);
    if (result && result.allocated <= 0 && vectorOf.get(entry.id)!.size > 0) starved.add(entry.id);
  }
  if (starved.size > 0) {
    const phaseB = new Map<RecipeId, number>();
    for (const [recipeId, units] of capacityUnits) {
      phaseB.set(recipeId, units - (usedUnits.get(recipeId) ?? 0));
    }
    runPass(phaseB, starved);
  }

  const remainingUnits = new Map<RecipeId, number>();
  for (const [recipeId, units] of capacityUnits) {
    remainingUnits.set(recipeId, units - (usedUnits.get(recipeId) ?? 0));
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
        const result = results.get(member.id);
        if (result) orderedEntries.push(result);
      }
      continue;
    }
    const result = results.get(entry.id);
    if (result) orderedEntries.push(result);
  }

  return {
    usedUnits,
    remainingUnits,
    entries: orderedEntries,
    allocations,
  };
}
