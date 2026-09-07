// Random but *legal* world states for the spec E.6 property suite.
//
// Test support only: nothing outside a test imports this, and the engine's
// import-boundary lint rule exempts src/testing/** for that reason.
//
// The generator builds states the way the game would reach them rather than by
// filling fields at random. `bound` in particular is only ever created through
// depositRefund, because spec D4's invariant -- bound > 0 implies quantum is at cap
// -- is a property of how bound comes into existence, and a generator that violated
// it would make that property untestable.
import fc from "fast-check";
import { D } from "../numbers/decimal.js";
import type { ItemId, LaneId, MachineClassId } from "../content/types.js";
import { getMark, isLiveRecipe, type IndexedContent } from "../graph/index-content.js";
import { depositProduction, depositRefund, liquidCap } from "../economy/storage.js";
import { initialWorld, withInstalled, type WorldState } from "../state/world.js";

export interface WorldSketch {
  tier: number;
  /** Machines to install per lane-class slot, cycled if shorter than the slot list. */
  machines: number[];
  /** Fraction of each item's combined cap to pre-fill, cycled likewise. */
  fills: number[];
  storageLevels: number[];
  qsLevels: number[];
  reserves: number[];
  tapStacks: number;
  /** Extra iron_plate refunded in, which is the only way bound stock appears. */
  refund: number;
  /** Rotation applied to the priority list. */
  rotate: number;
}

export function arbWorldSketch(): fc.Arbitrary<WorldSketch> {
  const cycle = <T>(item: fc.Arbitrary<T>) => fc.array(item, { minLength: 8, maxLength: 8 });
  // Mostly small counts (so a lane-class is frequently starved relative to its
  // neighbours) with an occasional large jump (so it is frequently a glut
  // instead) -- a uniform range collapses too often into "everyone has roughly
  // enough", which is exactly the balanced-fixture failure mode task 9's own
  // suite had. The skew is what produces a genuine multi-item pin cascade: one
  // lane-class starved relative to its consumer, and a SEPARATE lane-class (or a
  // second link of the same chain) starved independently in the same state.
  const machineCount = fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 3 }) },
    { weight: 1, arbitrary: fc.integer({ min: 4, max: 24 }) },
  );
  return fc.record({
    tier: fc.integer({ min: 0, max: 3 }),
    machines: cycle(machineCount),
    // Weighted toward 0 so multiple items are simultaneously EMPTY-eligible in
    // the same state -- a cascade needs at least two, and a generator where
    // EMPTY is merely "common" rather than "usual" rarely lands two at once.
    fills: cycle(fc.constantFrom(0, 0, 0, 0, 0.5, 1)),
    storageLevels: cycle(fc.integer({ min: 0, max: 3 })),
    qsLevels: cycle(fc.integer({ min: 0, max: 2 })),
    reserves: cycle(fc.constantFrom(0, 0, 0, 0.1, 0.25)),
    tapStacks: fc.integer({ min: 0, max: 10 }),
    refund: fc.constantFrom(0, 0, 0, 5_000, 250_000),
    rotate: fc.integer({ min: 0, max: 5 }),
  });
}

function at<T>(list: readonly T[], index: number): T {
  return list[index % list.length]!;
}

export function buildWorld(
  content: IndexedContent,
  sketch: WorldSketch,
  nowMs: number,
): WorldState {
  let world = initialWorld(content, 1, nowMs);
  world = { ...world, tier: sketch.tier, tapStacks: sketch.tapStacks, installed: {}, assignment: {} };

  // Machines, per lane-class, only where mk1 has actually unlocked at this tier.
  const slots = [...content.recipesByLaneClass.keys()].sort();
  slots.forEach((key, index) => {
    const [lane, machineClass] = key.split("::") as [LaneId, MachineClassId];
    const markOne = getMark(content, machineClass, 1);
    if (!markOne || markOne.unlockTier > sketch.tier) return;

    const count = at(sketch.machines, index);
    if (count <= 0) return;
    world = withInstalled(world, lane, machineClass, 1, count);

    const recipeIds = (content.recipesByLaneClass.get(key) ?? []).filter((recipeId) =>
      isLiveRecipe(content, recipeId, world.tier, world.activeRecipe),
    );
    if (recipeIds.length === 0) return;

    // A recipe id is an author-supplied content id (spec A.2's prototype-key
    // hazard): `assignment[recipeId] = ...` bracket-assigns into a spread copy,
    // which for recipeId === "__proto__" would reassign the object's prototype
    // instead of creating an own property. Accumulate in a Map (immune to the
    // hazard by construction) and merge back in via Object.fromEntries, which
    // builds every property through CreateDataPropertyOrThrow.
    const assignmentCounts = new Map<string, number>(Object.entries(world.assignment));
    for (let i = 0; i < count; i += 1) {
      const recipeId = recipeIds[i % recipeIds.length]!;
      assignmentCounts.set(recipeId, (assignmentCounts.get(recipeId) ?? 0) + 1);
    }
    world = { ...world, assignment: Object.fromEntries(assignmentCounts) };
  });

  // Levels first, so the caps the fills are measured against are the final ones.
  // Same hazard as above, same fix: merge via Object.fromEntries rather than
  // bracket-assigning into a spread copy keyed by a content id.
  const storageLevel: Record<ItemId, number> = {
    ...world.storageLevel,
    ...Object.fromEntries(
      content.stockItemIds.map((itemId, index): [ItemId, number] => [
        itemId,
        at(sketch.storageLevels, index),
      ]),
    ),
  };
  const qsLevel: Record<LaneId, number> = {
    ...world.qsLevel,
    ...Object.fromEntries(
      [...content.lanes.keys()].map((lane, index): [LaneId, number] => [
        lane,
        at(sketch.qsLevels, index),
      ]),
    ),
  };
  world = { ...world, storageLevel, qsLevel };

  // Fills go in through the real deposit path, so storage tops up before quantum.
  content.stockItemIds.forEach((itemId, index) => {
    const fraction = at(sketch.fills, index);
    if (fraction <= 0) return;
    const amount = liquidCap(content, world, itemId).times(fraction);
    world = depositProduction(content, world, itemId, amount).state;
  });

  const reserve: Record<ItemId, number> = {
    ...world.reserve,
    ...Object.fromEntries(
      content.stockItemIds.map((itemId, index): [ItemId, number] => [
        itemId,
        at(sketch.reserves, index),
      ]),
    ),
  };
  world = { ...world, reserve };

  // The only legal source of bound stock (spec D4).
  if (sketch.refund > 0) {
    world = depositRefund(content, world, "iron_plate", D(sketch.refund));
  }

  const rotate = sketch.rotate % world.priority.length;
  world = {
    ...world,
    priority: [...world.priority.slice(rotate), ...world.priority.slice(0, rotate)],
  };
  return world;
}
