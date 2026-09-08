// Spec E.2's batch mode. One binary, two modes, both driving the identical engine
// the real game uses -- there is no second implementation to keep in sync (spec
// 16.3), and spec A.2's reducers are what make that structural rather than a
// discipline.
import {
  apply,
  installedAt,
  resolve,
  solve,
  type IndexedContent,
  type LaneId,
  type MachineClassId,
  type WorldState,
} from "@manufactory/engine";
import { loadContent, newWorld } from "./bootstrap.js";
import { getPolicy, type PolicyName } from "./policies.js";
import { authoredREff, observedREff, type REffRow, type RunReport, type TierMark } from "./report.js";

export interface RunOptions {
  policy: PolicyName;
  contentDir?: string;
  seed: number;
  /** Stop once this tier is reached. */
  untilTier: number;
  /** Stop after this much simulated time regardless. */
  maxSimMs: number;
}

interface ClassSlot {
  lane: LaneId;
  machineClass: MachineClassId;
  startCount: number;
}

function classSlots(content: IndexedContent, state: WorldState): ClassSlot[] {
  const slots: ClassSlot[] = [];
  const seen = new Set<string>();
  for (const key of content.recipesByLaneClass.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const [lane, machineClass] = key.split("::") as [LaneId, MachineClassId];
    let startCount = 0;
    const cls = content.machineClasses.get(machineClass);
    for (const mark of cls?.marks ?? []) {
      startCount += installedAt(state, lane, machineClass, mark.mark) * mark.rateMultiplier;
    }
    slots.push({ lane, machineClass, startCount });
  }
  return slots;
}

export function runSimulation(options: RunOptions): RunReport {
  const content = loadContent(options.contentDir);
  const policy = getPolicy(options.policy);

  let state = newWorld(content, options.seed);
  const slots = classSlots(content, state);

  let nowMs = 0;
  let purchases = 0;
  let lastEventMs = 0;
  let maxDeadTimeMs = 0;
  const tierTimes: TierMark[] = [];
  const boundMsByRecipe = new Map<string, number>();

  const markEvent = (atMs: number): void => {
    maxDeadTimeMs = Math.max(maxDeadTimeMs, atMs - lastEventMs);
    lastEventMs = atMs;
  };

  while (nowMs < options.maxSimMs && state.tier < options.untilTier) {
    const solution = solve(state, content);
    const ctx = { content, state, solution, nowMs };

    for (const action of policy.decide(ctx)) {
      const result = apply(state, content, action, state.seed);
      if (result.rejected) continue;
      state = result.state;
      purchases += 1;
      markEvent(nowMs);
    }

    // Re-solve after the purchases so the binding-constraint accounting describes
    // the interval that is about to be simulated, not the one before it.
    const settled = solve(state, content);
    const stepMs = Math.min(
      Math.max(1_000, policy.intervalMs({ ...ctx, state, solution: settled })),
      options.maxSimMs - nowMs,
    );
    if (stepMs <= 0) break;

    if (settled.bottleneck !== null) {
      const bottleneck = settled.bottleneck;
      // Storage-bound time is reported under the item rather than a recipe: time
      // spent at cap is not time a machine purchase would have shortened.
      const id =
        bottleneck.kind === "recipe"
          ? bottleneck.recipeId
          : bottleneck.kind === "storage"
            ? `storage:${bottleneck.itemId}`
            : `power:${bottleneck.generatorRecipeId ?? "none"}`;
      boundMsByRecipe.set(id, (boundMsByRecipe.get(id) ?? 0) + stepMs);
    }

    const advanced = resolve(state, content, stepMs);
    state = advanced.state;
    nowMs += stepMs;

    for (const tier of advanced.summary.tiersUnlocked) {
      const event = advanced.events.find((e) => e.kind === "milestone" && e.tier === tier);
      const atMs = event?.atMs ?? nowMs;
      tierTimes.push({ tier, atMs, collections: atMs / content.offlineCapMs });
      markEvent(atMs);
    }
  }
  markEvent(nowMs);

  const rEff: REffRow[] = slots.map((slot) => {
    const cls = content.machineClasses.get(slot.machineClass)!;
    let endCount = 0;
    for (const mark of cls.marks) {
      endCount += installedAt(state, slot.lane, slot.machineClass, mark.mark) * mark.rateMultiplier;
    }
    return {
      lane: slot.lane,
      machineClass: slot.machineClass,
      authored: authoredREff(content, slot.machineClass),
      observed: observedREff(
        cls.costRatio,
        cls.ladder.step,
        cls.ladder.interval,
        slot.startCount,
        endCount,
      ),
    };
  });

  const bindingConstraints = [...boundMsByRecipe.entries()]
    .map(([recipeId, boundMs]) => ({ recipeId, boundMs }))
    // Longest first, ties broken by id so the report is stable (spec A.5).
    .sort((a, b) => (b.boundMs === a.boundMs ? (a.recipeId < b.recipeId ? -1 : 1) : b.boundMs - a.boundMs));

  return {
    policy: options.policy,
    contentVersion: content.bundle.version,
    seed: options.seed,
    reachedTier: state.tier,
    finished: state.tier >= options.untilTier,
    simulatedMs: nowMs,
    collections: nowMs / content.offlineCapMs,
    tierTimes,
    maxDeadTimeMs,
    purchases,
    bindingConstraints,
    rEff,
  };
}
