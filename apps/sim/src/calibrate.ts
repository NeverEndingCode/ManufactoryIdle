// Spec B.7's calibration script: the simulator with a search wrapper.
//
// The property that makes it trustworthy is that there is exactly ONE implementation
// of "how long does this take". The search calls `runSimulation` -- the same function
// `sim run` calls, driving the same engine the game does -- so a calibrated number
// cannot disagree with a measured one. There is deliberately no faster estimator for
// the inner loop; that would reintroduce precisely the disagreement this design
// exists to prevent, and it is the kind of shortcut that looks like an optimisation.
// The one speed-up taken is replaying a solved prefix from a checkpoint, which is
// memoisation of this simulator rather than a second model of it (see RunCheckpoint).
//
// Solve order is not arbitrary, because the parameters are coupled:
//
//   1. `r` from the authored `r_eff` -- arithmetic, no simulation. Spec D3's
//      authoring inversion, so retuning the ladder moves pacing by zero.
//   2. Storage cap growth against `pacing.storageBindingCadence`. Before milestone
//      amounts, because a storage curve that binds too early makes a tier
//      unreachable at ANY amount, and bisection against an infeasible target does
//      not converge -- it just burns the iteration cap.
//   3. Milestone delivery amounts against `pacing.targetCollectionsToTier`, tier by
//      tier in order, each holding every earlier tier at its solved value.
//
// Step 2 is then re-measured after step 3 and reported rather than re-solved: the
// two do interact, and a number that has drifted should be visible rather than
// chased round a loop that may not terminate.
import { maxAttainableCap, type Bundle, type Derived, type MachineClass } from "@manufactory/content";
import { indexContent, type ContentBundle } from "@manufactory/engine";
import type { PolicyName } from "./policies.js";
import { runSimulation, type RunCheckpoint } from "./run.js";

export interface BisectOptions {
  target: number;
  /** Relative: |y - target| <= tolerance * target counts as a hit. */
  tolerance: number;
  /** Where to start looking. The search brackets outward from here. */
  seed?: number;
  maxExpansions?: number;
  maxIterations?: number;
  /**
   * Give up splitting once `(hi - lo) / hi` falls below this.
   *
   * The default is tight enough to be invisible for a continuous `f`. Callers whose
   * `f` costs a full simulation set it far looser -- past the point where two inputs
   * round to the same milestone amount, further splitting buys a different `x` and
   * an identical `y`, at one simulated run apiece.
   */
  minBracketRatio?: number;
}

export interface BisectResult {
  x: number;
  /** What `f(x)` actually measured. Never the target -- the claim must be checkable. */
  y: number;
  evaluations: number;
  converged: boolean;
}

/**
 * Bisection for a non-decreasing `f`, with the bracket found by expansion rather
 * than assumed. `f` may return Infinity, which is how "the run never got there"
 * arrives; it is ordered above every finite value and needs no special case.
 *
 * Convergence is on `f`, but termination is also on the bracket: the functions this
 * searches are staircases (milestone amounts are whole units), so the target
 * routinely falls between two reachable values and no `x` satisfies the tolerance.
 * Stopping on a collapsed bracket turns that from "spin to the iteration cap on
 * every tier" into "report the closest step and say it did not converge".
 */
export function bisectMonotone(f: (x: number) => number, options: BisectOptions): BisectResult {
  const { target, tolerance } = options;
  const maxExpansions = options.maxExpansions ?? 32;
  const maxIterations = options.maxIterations ?? 60;
  const minBracketRatio = options.minBracketRatio ?? 1e-12;
  // A box rather than a number: `refine` runs most of the evaluations, and a plain
  // counter passed by value would report only the ones spent finding the bracket.
  const counter = { n: 0 };

  const evaluate = (x: number): number => {
    counter.n += 1;
    return f(x);
  };

  const hit = (y: number): boolean => Number.isFinite(y) && Math.abs(y - target) <= tolerance * target;

  let x = options.seed ?? 1;
  const y = evaluate(x);
  if (hit(y)) return { x, y, evaluations: counter.n, converged: true };

  let lo: number;
  let hi: number;
  if (y < target) {
    lo = x;
    let loY = y;
    for (let i = 0; i < maxExpansions; i += 1) {
      hi = x * 4;
      const hiY = evaluate(hi);
      if (hit(hiY)) return { x: hi, y: hiY, evaluations: counter.n, converged: true };
      if (hiY > target) {
        return refine(evaluate, lo, hi, settings(target, tolerance, maxIterations, minBracketRatio), counter, x, loY);
      }
      lo = hi;
      loY = hiY;
      x = hi;
    }
    // Never bracketed: report the largest input tried and the measurement there.
    return { x, y: loY, evaluations: counter.n, converged: false };
  }

  hi = x;
  let hiY = y;
  for (let i = 0; i < maxExpansions; i += 1) {
    lo = x / 4;
    const loY = evaluate(lo);
    if (hit(loY)) return { x: lo, y: loY, evaluations: counter.n, converged: true };
    if (loY < target) {
      return refine(evaluate, lo, hi, settings(target, tolerance, maxIterations, minBracketRatio), counter, x, hiY);
    }
    hi = lo;
    hiY = loY;
    x = lo;
  }
  return { x, y: hiY, evaluations: counter.n, converged: false };
}

interface RefineSettings {
  target: number;
  tolerance: number;
  maxIterations: number;
  minBracketRatio: number;
}

function settings(
  target: number,
  tolerance: number,
  maxIterations: number,
  minBracketRatio: number,
): RefineSettings {
  return { target, tolerance, maxIterations, minBracketRatio };
}

/** The bracketed half. `lo` measures below the target and `hi` above it. */
function refine(
  evaluate: (x: number) => number,
  lo: number,
  hi: number,
  { target, tolerance, maxIterations, minBracketRatio }: RefineSettings,
  counter: { n: number },
  fallbackX: number,
  fallbackY: number,
): BisectResult {
  let bestX = fallbackX;
  let bestY = fallbackY;
  let bestError = Number.POSITIVE_INFINITY;

  for (let i = 0; i < maxIterations; i += 1) {
    // The bracket has collapsed to the width of one step of a staircase, so no
    // further split can land anywhere new.
    if (hi - lo <= hi * minBracketRatio) break;
    const mid = (lo + hi) / 2;
    const y = evaluate(mid);
    const error = Number.isFinite(y) ? Math.abs(y - target) : Number.POSITIVE_INFINITY;
    if (error < bestError) {
      bestError = error;
      bestX = mid;
      bestY = y;
    }
    if (Number.isFinite(y) && error <= tolerance * target) {
      return { x: mid, y, evaluations: counter.n, converged: true };
    }
    if (y < target) lo = mid;
    else hi = mid;
  }
  return { x: bestX, y: bestY, evaluations: counter.n, converged: false };
}

/**
 * Spec D3: `r = r_eff * m`, where `m = step^(1/interval)` is the ladder's multiplier
 * growth per machine. This is the one place calibration needs no simulation at all.
 *
 * Math.pow is legal here for the same reason it is in report.ts: calibration is an
 * offline authoring step whose output is a committed number, so nothing it computes
 * re-enters a state-affecting path at runtime (spec E.4).
 */
export function deriveCostRatios(bundle: Bundle): { id: string; costRatio: number }[] {
  const out: { id: string; costRatio: number }[] = [];
  for (const cls of bundle.machineClasses) {
    if (cls.rEff === undefined) continue;
    const m = Math.pow(cls.ladder.step, 1 / cls.ladder.interval);
    out.push({ id: cls.id, costRatio: cls.rEff * m });
  }
  return out;
}

/**
 * A copy of `bundle` with one tier's delivery requirements scaled.
 *
 * Rounding happens HERE, not at emit time, so the simulator measures the number that
 * actually ships. Rounding afterwards would mean the committed bundle is one nobody
 * ever ran.
 */
export function withMilestoneAmounts(bundle: Bundle, tier: number, factor: number): Bundle {
  return {
    ...bundle,
    milestones: bundle.milestones.map((milestone) =>
      milestone.tier === tier
        ? {
            ...milestone,
            requires: milestone.requires.map((requirement) => ({
              ...requirement,
              amount: Math.max(1, Math.round(requirement.amount * factor)),
            })),
          }
        : milestone,
    ),
  };
}

export interface CalibrateOptions {
  bundle: Bundle;
  policy?: PolicyName;
  seed?: number;
  /** Solve tiers 1..maxTier. Defaults to every milestone the bundle defines. */
  maxTier?: number;
  /** Relative. A tier lands when |observed - target| <= tolerance * target. */
  tolerance?: number;
  /**
   * How many times the target's own span a tier may overrun before the run is cut
   * off and reported as "never got there". This is what bounds the cost of the
   * search: bracketing multiplies the requirement by four at a time, and without a
   * ceiling one overshoot would simulate for years of game time to tell us
   * something a fraction of it already has.
   */
  overrunBudget?: number;
  maxIterationsPerTier?: number;
  onProgress?: (line: string) => void;
}

export interface TierCalibration {
  tier: number;
  target: number;
  /** From the confirming run over the emitted numbers, not from the search. */
  observed: number | null;
  factor: number;
  converged: boolean;
  evaluations: number;
}

export interface CalibrationResult {
  /** The authored bundle with every solved number applied. */
  bundle: Bundle;
  /** The same solution as a `derived` block, ready to write next to the source. */
  derived: Derived;
  tiers: TierCalibration[];
}

function withCostRatios(bundle: Bundle, ratios: { id: string; costRatio: number }[]): Bundle {
  if (ratios.length === 0) return bundle;
  const byId = new Map(ratios.map((r) => [r.id, r.costRatio]));
  return {
    ...bundle,
    machineClasses: bundle.machineClasses.map((cls: MachineClass) => {
      const costRatio = byId.get(cls.id);
      return costRatio === undefined ? cls : { ...cls, costRatio };
    }),
  };
}

/**
 * Solve the delivery requirements so the observed curve matches
 * `pacing.targetCollectionsToTier` (spec B.7).
 *
 * Tier by tier in order, because tier k's requirements cannot affect anything before
 * tier k-1 unlocked. That is what lets each tier's search resume from the previous
 * tier's checkpoint instead of replaying the whole game, and it is also why the
 * search is well posed at all: one scalar per tier against one target per tier.
 * Solving every tier at once would be a dozen knobs against ten numbers, and the
 * answer would be arbitrary rather than derived.
 */
export function calibrate(options: CalibrateOptions): CalibrationResult {
  const policy = options.policy ?? "greedy";
  const seed = options.seed ?? 42;
  const tolerance = options.tolerance ?? 0.05;
  const overrunBudget = options.overrunBudget ?? 6;
  const maxIterations = options.maxIterationsPerTier ?? 12;
  const report = options.onProgress ?? ((): void => {});

  const targets = options.bundle.pacing.targetCollectionsToTier;
  const solvable = options.bundle.milestones
    .map((m) => m.tier)
    .filter((tier) => tier <= targets.length)
    .sort((a, b) => a - b);
  const maxTier = options.maxTier ?? (solvable[solvable.length - 1] ?? 0);

  const costRatios = deriveCostRatios(options.bundle);
  let working = withCostRatios(options.bundle, costRatios);
  for (const ratio of costRatios) {
    report(`r_eff -> r   ${ratio.id.padEnd(18)} ${ratio.costRatio.toFixed(6)}`);
  }

  const offlineCapMs = options.bundle.offlineCapHours * 60 * 60 * 1000;
  const tiers: TierCalibration[] = [];
  let checkpoint: RunCheckpoint | undefined;
  let previousTarget = 0;

  for (const tier of solvable) {
    if (tier > maxTier) break;
    const target = targets[tier - 1]!;
    // Absolute, because a resumed run starts with the clock already advanced.
    const deadlineMs =
      (checkpoint?.nowMs ?? 0) + (target - previousTarget) * overrunBudget * offlineCapMs;

    const items = new Map(options.bundle.items.map((item) => [item.id, item]));

    /**
     * A requirement above the most a player can ever hold liquid can never be
     * delivered -- ruling R7 pays deliveries out of liquid stock -- so the answer is
     * "never" with certainty and without running anything.
     *
     * This is a feasibility test, not a second estimate of how long something takes.
     * It answers check 9's question, which is exact; B.7's one-implementation rule is
     * about durations, and no duration is being guessed. It matters because the search
     * brackets by overshooting, so most tiers try at least one infeasible candidate,
     * and finding out by simulation costs the whole overrun budget every time.
     */
    const unsatisfiable = (candidate: Bundle): string | null => {
      for (const requirement of candidate.milestones.find((m) => m.tier === tier)!.requires) {
        const item = items.get(requirement.item);
        if (item === undefined) continue;
        const cap = maxAttainableCap(options.bundle, item);
        if (requirement.amount > cap) {
          return `${requirement.item} ${requirement.amount} is above the maximum ${cap.toFixed(0)} a player can hold`;
        }
      }
      return null;
    };

    const runAt = (factor: number): { collections: number | null; checkpoint?: RunCheckpoint } => {
      const candidate = withMilestoneAmounts(working, tier, factor);
      const run = runSimulation({
        policy,
        seed,
        content: indexContent(candidate as ContentBundle),
        untilTier: tier,
        maxSimMs: deadlineMs,
        startFrom: checkpoint,
        captureCheckpoints: true,
      });
      const mark = run.tierTimes.find((t) => t.tier === tier);
      return {
        collections: mark?.collections ?? null,
        checkpoint: run.checkpoints.find((c) => c.tier === tier),
      };
    };

    let step = 0;
    const search = bisectMonotone(
      (factor) => {
        step += 1;
        const started = Date.now();
        const candidate = withMilestoneAmounts(working, tier, factor);
        const amounts = candidate.milestones
          .find((m) => m.tier === tier)!
          .requires.map((r) => `${r.item} ${r.amount}`)
          .join(", ");

        const impossible = unsatisfiable(candidate);
        if (impossible !== null) {
          report(
            `  tier ${String(tier).padStart(2)} try ${String(step).padStart(2)}  ` +
              `${"never".padStart(8)} of ${target.toFixed(2)}  0s  ${impossible}`,
          );
          return Number.POSITIVE_INFINITY;
        }

        const { collections } = runAt(factor);
        // Per step, not per tier. One tier can take tens of minutes -- every step is
        // a real run, and an overshoot simulates all the way to the overrun budget
        // before it can report "never" -- so a per-tier line made a slow search
        // indistinguishable from a hung one.
        report(
          `  tier ${String(tier).padStart(2)} try ${String(step).padStart(2)}  ` +
            `${(collections === null ? "never" : collections.toFixed(2)).padStart(8)} of ` +
            `${target.toFixed(2)}  ${((Date.now() - started) / 1000).toFixed(0)}s  ${amounts}`,
        );
        return collections ?? Number.POSITIVE_INFINITY;
      },
      {
        target,
        tolerance,
        seed: 1,
        maxIterations,
        // Past this the two candidate factors round to the same whole-unit
        // requirement, so another split costs a simulated run and buys nothing.
        minBracketRatio: 1e-4,
      },
    );

    // Re-run at the settled factor and report THAT number. The search's memory of
    // its best evaluation would say the same thing, but this measures the content
    // that is actually about to be written out -- which is the claim being made.
    working = withMilestoneAmounts(working, tier, search.x);
    const confirmed = runAt(1);
    checkpoint = confirmed.checkpoint;
    previousTarget = target;

    const amounts = working.milestones
      .find((m) => m.tier === tier)!
      .requires.map((r) => `${r.item} ${r.amount}`)
      .join(", ");
    report(
      `tier ${String(tier).padStart(2)}  target ${target.toFixed(2).padStart(8)}  ` +
        `observed ${(confirmed.collections ?? Number.NaN).toFixed(2).padStart(8)}  ` +
        `${search.evaluations + 1} runs  ${search.converged ? "ok " : "OFF"}  ${amounts}`,
    );

    tiers.push({
      tier,
      target,
      observed: confirmed.collections,
      factor: search.x,
      converged: search.converged,
      evaluations: search.evaluations + 1,
    });

    // Nothing after an unreachable tier is measurable, so stop rather than emit
    // numbers for tiers whose search never had a bracket.
    if (confirmed.collections === null || checkpoint === undefined) {
      report(`tier ${tier} was never reached; stopping here`);
      break;
    }
  }

  const derived: Derived = {
    run: {
      calibratedAt: new Date().toISOString(),
      policy,
      seed,
      targetCollectionsToTier: targets,
      observedCollectionsToTier: tiers.map((t) => t.observed),
    },
    ...(costRatios.length > 0 ? { machineClasses: costRatios } : {}),
    milestones: tiers.map((t) => ({
      tier: t.tier,
      requires: working.milestones.find((m) => m.tier === t.tier)!.requires.map((r) => ({
        item: r.item,
        amount: r.amount,
      })),
    })),
  };

  return { bundle: working, derived, tiers };
}
