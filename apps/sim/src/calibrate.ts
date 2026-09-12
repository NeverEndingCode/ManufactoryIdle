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
import {
  checkRunawayGrowth,
  maxAttainableCap,
  type Bundle,
  type Derived,
  type MachineClass,
} from "@manufactory/content";
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
 * A copy of `bundle` with every authored `r_eff` moved by one scale.
 *
 * It scales `r_eff − 1`, not `r_eff`. Spec D3's invariant is `r_eff > 1 + ε`, so the
 * distance above the floor is the pacing quantity: 1.047 and 1.076 are not "within 3%
 * of each other", they are a factor of 1.6 apart in the thing that decides pace.
 * Scaling that distance keeps the ordering the author chose between classes, and can
 * never land on or below the floor for a positive scale.
 *
 * One scale for every class rather than fourteen independent knobs: there are ten tier
 * targets, so per-class freedom would be underdetermined and the answer arbitrary.
 *
 * It re-derives `costRatio` as well, and that is not a convenience. The engine runs on
 * `costRatio`; `rEff` is the intent behind it. Moving one without the other produces a
 * bundle that SIMULATES AS IF UNSCALED while reporting the new r_eff — a silent no-op
 * that looks like a measurement. It cost a wrong pre-filter result before this was
 * folded in. The two can now only move together.
 *
 * Math.pow is legal here for report.ts's reason: calibration is offline, and its output
 * is a committed number that never re-enters a state-affecting path (spec E.4).
 */
export function withREffScale(bundle: Bundle, scale: number): Bundle {
  return {
    ...bundle,
    machineClasses: bundle.machineClasses.map((cls: MachineClass) => {
      if (cls.rEff === undefined) return cls;
      const rEff = 1 + (cls.rEff - 1) * scale;
      const m = Math.pow(cls.ladder.step, 1 / cls.ladder.interval);
      return { ...cls, rEff, costRatio: rEff * m };
    }),
  };
}

/**
 * How badly a whole tier curve misses its targets — the score the `r_eff` scan
 * minimises, since no single tier's time can be bisected against (see `calibrate`).
 *
 * Relative, because a tier aiming at 2100 collections and landing 1 out is not the
 * same failure as a tier aiming at 2 and landing 1 out.
 *
 * An unreachable tier scores `UNREACHABLE_PENALTY` rather than infinity: infinity
 * would make every bad candidate equally bad, and the scan needs to prefer "two tiers
 * unreachable" over "five tiers unreachable" in order to climb out. The penalty sits
 * far above any relative miss a reachable tier can produce, so a reachable curve
 * always beats an unreachable one. A deadband never forgives it — not reaching a tier
 * is a different kind of answer from landing near it.
 *
 * `deadband` exists because the ranking pass fits amounts loosely. A tier fitted to a
 * 15% tolerance lands within 15% by construction, so across three tiers up to 0.45 of
 * pure fitting noise accumulates — larger than the differences between the scales
 * being ranked. Measured: scale 1 scored 0.5389 on a curve whose real miss was 0.33.
 * Scoring from the edge of the band instead of from the target leaves only the misses
 * the fitting could not close, which is the thing the scan is actually comparing.
 */
export const UNREACHABLE_PENALTY = 1e6;

export function curveMiss(
  tiers: { target: number; observed: number | null }[],
  deadband = 0,
): number {
  let total = 0;
  for (const tier of tiers) {
    if (tier.observed === null) {
      total += UNREACHABLE_PENALTY;
      continue;
    }
    const relative = Math.abs(tier.observed - tier.target) / tier.target;
    total += Math.max(0, relative - deadband);
  }
  return total;
}

/**
 * How close to the maximum attainable cap the ceiling configuration fills to. Just
 * under, because a requirement exactly at the cap is delivered only if the very last
 * unit arrives before anything else consumes it, and that is a knife edge rather than
 * a measurement.
 */
const CEILING_FILL = 0.98;

/**
 * A copy of `bundle` with every requirement up to `maxTier` set as large as a player
 * could ever hold (ruling R7 pays deliveries from liquid stock, so that is the most
 * that can ever be asked for).
 *
 * A tier's landing time in THIS configuration is the latest it can be made to land:
 * its own requirement is at the maximum, and every earlier tier is also at its
 * slowest, so the tier starts accumulating as late as it ever could.
 */
export function withAllMilestonesAtCap(bundle: Bundle, maxTier: number): Bundle {
  const items = new Map(bundle.items.map((item) => [item.id, item]));
  return {
    ...bundle,
    milestones: bundle.milestones.map((milestone) =>
      milestone.tier > maxTier
        ? milestone
        : {
            ...milestone,
            requires: milestone.requires.map((requirement) => {
              const item = items.get(requirement.item);
              if (item === undefined) return requirement;
              return {
                ...requirement,
                // At the tier BELOW this milestone: the player banks toward tier k
                // while still on tier k-1, and caps grow with progression (spec B.4 as
                // amended). Using this milestone's own tier would set a requirement
                // the player cannot hold until after they have already delivered it.
                amount: Math.max(
                  1,
                  Math.floor(
                    maxAttainableCap(bundle, item, Math.max(0, milestone.tier - 1)) *
                      CEILING_FILL,
                  ),
                ),
              };
            }),
          },
    ),
  };
}

export interface TierCeiling {
  tier: number;
  target: number;
  /** null when the tier did not land inside the budget — its ceiling is beyond it. */
  ceiling: number | null;
}

export interface CeilingOptions {
  bundle: Bundle;
  maxTier: number;
  policy: PolicyName;
  seed: number;
  /** Hard ceiling on the ceiling run itself. See CEILING_BUDGET_CAP. */
  maxCollections?: number;
}

/**
 * The furthest the ceiling run will ever simulate, whatever the targets say.
 *
 * Its natural budget is the deepest target, since past that every unlanded tier has
 * already proven its ceiling exceeds its own target. But that budget is authored data:
 * a `targetCollectionsToTier` with a typo in it -- 1e9 rather than 1e3 -- asks for two
 * and a half million years of simulated time, and the calibrator hangs instead of
 * complaining. 5,000 collections is about four and a half years of play at three
 * collections a day, past the end of any game this is pacing.
 *
 * Hitting the cap makes the filter PERMISSIVE, not wrong: a tier that has not landed is
 * reported as clearing its target, so an over-long run costs at worst a wasted scoring
 * pass. The asymmetry is deliberate -- a pre-filter that wrongly rejects loses the
 * answer, one that wrongly admits only loses time.
 */
export const CEILING_BUDGET_CAP = 5_000;

/**
 * The largest storage tier factor worth searching.
 *
 * `capPerTier` compounds: at 64 a tier-9 item holds 64^9 -- about 1e16 -- times its
 * authored cap. Past that the search is no longer proposing a game, and each probe is
 * expensive because a factor that big clears the early tiers and so simulates most of
 * the run before failing. Measured: three probes at scale 0.5 (2, 4, 8) took 4 s, 206 s
 * and 155 s and were all short, on a search that would otherwise have doubled 24 times.
 *
 * Hitting this bound means the scale cannot be rescued by storage at all, which is a
 * result worth reporting quickly rather than an answer worth grinding for.
 */
export const MAX_CAP_PER_TIER = 64;

/**
 * The latest each tier can be made to land, in ONE simulated run per bundle.
 *
 * This is the scan's pre-filter. A full amounts calibration per candidate scale costs
 * tens of runs and, measured, took thirteen minutes on a single tier; this costs one
 * run whose budget is the deepest target itself, because the moment the clock passes
 * that target every tier still unlanded already has a ceiling above its own target
 * (targets increase with tier). So it is cheap for exactly the reason it is useful.
 *
 * It is the same simulator, asked a cheaper question — "is this satisfiable at all",
 * the same question check 9 asks — and not a second estimator of how long anything
 * takes, which B.7 forbids.
 */
export function tierCeilings(options: CeilingOptions): TierCeiling[] {
  const targets = options.bundle.pacing.targetCollectionsToTier;
  const offlineCapMs = options.bundle.offlineCapHours * 60 * 60 * 1000;
  const deepest = Math.min(
    targets[options.maxTier - 1] ?? 0,
    options.maxCollections ?? CEILING_BUDGET_CAP,
  );
  const content = indexContent(
    withAllMilestonesAtCap(options.bundle, options.maxTier) as ContentBundle,
  );

  const out: TierCeiling[] = [];
  for (let tier = 1; tier <= options.maxTier; tier += 1) {
    out.push({ tier, target: targets[tier - 1] ?? 0, ceiling: null });
  }

  // Tier by tier, resuming from the previous tier's checkpoint, so that the run can be
  // abandoned the moment the answer is known. ONE tier topping out below its target
  // rejects the scale, and everything simulated after that is wasted: on the ten-tier
  // slice, scale 0.5 was rejected on tier 3 and then kept going to the deepest target,
  // spending 899 seconds to learn what the first three tiers had already settled.
  let checkpoint: RunCheckpoint | undefined;
  for (let tier = 1; tier <= options.maxTier; tier += 1) {
    const run = runSimulation({
      policy: options.policy,
      seed: options.seed,
      content,
      untilTier: tier,
      // Absolute, and stopping at the deepest target: past it, every unlanded tier has
      // already proven its ceiling exceeds its own target.
      maxSimMs: deepest * offlineCapMs,
      startFrom: checkpoint,
      captureCheckpoints: true,
    });

    const mark = run.tierTimes.find((t) => t.tier === tier);
    // Did not land inside the budget, so its ceiling is beyond it — which clears its
    // target, and leaves no checkpoint to carry deeper. Nothing further is knowable.
    if (mark === undefined) return out;

    out[tier - 1]!.ceiling = mark.collections;
    if (mark.collections < out[tier - 1]!.target) return out;

    checkpoint = run.checkpoints.find((c) => c.tier === tier);
    if (checkpoint === undefined) return out;
  }
  return out;
}

/**
 * Whether every tier could be stretched to its target.
 *
 * A tier that did not land inside the budget counts as clearing it: its ceiling is
 * beyond the budget, which is later than its target, not earlier. Reading "never" as
 * a failure would reject precisely the scales that stretch the game the most.
 */
export function clearsTargets(ceilings: readonly TierCeiling[], headroom = 1): boolean {
  return ceilings.every((c) => c.ceiling === null || c.ceiling >= c.target * headroom);
}

/**
 * A copy of `bundle` with the tier factor set on both cap curves (spec B.4 as amended).
 *
 * One number for storage and Quantum Storage together. They could differ, but the
 * pacing intent offers no target that separates them, and two knobs against one
 * constraint would make the answer arbitrary — the same reason `r_eff` is solved as one
 * scale across all fourteen machine classes rather than per class.
 */
export function withCapPerTier(bundle: Bundle, capPerTier: number): Bundle {
  return {
    ...bundle,
    storage: { ...bundle.storage, capPerTier },
    quantumStorage: { ...bundle.quantumStorage, capPerTier },
  };
}

export interface ClearingOptions {
  seed?: number;
  /** Never search below this. Defaults to 1: a cap factor under 1 shrinks caps. */
  floor?: number;
  /**
   * Never search above this. Without it a hopeless predicate is answered by doubling
   * until `maxExpansions` runs out, and here each doubling is a simulated run that gets
   * MORE expensive as the value rises.
   */
  ceiling?: number;
  maxExpansions?: number;
  maxIterations?: number;
  /**
   * Stop splitting once the bracket is this close, relative.
   *
   * Loose on purpose. Every probe here is a full ceiling measurement -- minutes at ten
   * tiers -- and the difference between a cap factor of 2.00 and 2.02 is invisible in a
   * game, so the extra splits buy nothing but an hour.
   */
  precision?: number;
  /** Called with each probe and its verdict, so an hour-long search is not silent. */
  onProbe?: (x: number, cleared: boolean, elapsedMs: number) => void;
}

export interface ClearingResult {
  value: number;
  cleared: boolean;
  evaluations: number;
}

/**
 * The smallest input that satisfies a monotone predicate.
 *
 * `capPerTier` is a feasibility knob, not a fitted value: it has to be big enough that
 * every tier's ceiling clears its target, and past that point more is not better. Bigger
 * caps mean a player hoarding more of everything and milestones asking for more of it,
 * which is a real cost to how the game feels. So the search takes the SMALLEST value
 * that works rather than the first or the largest.
 *
 * Monotone in a way `r_eff` is not: raising a cap can only make a tier take longer to
 * fill, never less, so unlike the `r_eff` scan this genuinely can bisect.
 */
export function smallestClearing(
  clears: (x: number) => boolean,
  options: ClearingOptions = {},
): ClearingResult {
  const floor = options.floor ?? 1;
  const ceiling = options.ceiling ?? Number.POSITIVE_INFINITY;
  const maxExpansions = options.maxExpansions ?? 24;
  const maxIterations = options.maxIterations ?? 24;
  const precision = options.precision ?? 2e-2;
  const counter = { n: 0 };
  const test = (x: number): boolean => {
    counter.n += 1;
    const started = Date.now();
    const result = clears(x);
    options.onProbe?.(x, result, Date.now() - started);
    return result;
  };

  const seed = Math.max(floor, options.seed ?? 1);
  if (test(seed)) {
    // Already clears. Look below for something smaller, but never under the floor.
    let good = seed;
    let bad = floor;
    if (seed <= floor) return { value: floor, cleared: true, evaluations: counter.n };
    for (let i = 0; i < maxExpansions; i += 1) {
      const candidate = Math.max(floor, good / 2);
      if (candidate === good) break;
      if (test(candidate)) {
        good = candidate;
        if (good <= floor) return { value: floor, cleared: true, evaluations: counter.n };
      } else {
        bad = candidate;
        break;
      }
    }
    for (let i = 0; i < maxIterations && good - bad > good * precision; i += 1) {
      const mid = (good + bad) / 2;
      if (test(mid)) good = mid;
      else bad = mid;
    }
    return { value: good, cleared: true, evaluations: counter.n };
  }

  let bad = seed;
  for (let i = 0; i < maxExpansions; i += 1) {
    const candidate = bad * 2;
    if (candidate > ceiling) break;
    if (test(candidate)) {
      let good = candidate;
      for (let j = 0; j < maxIterations && good - bad > good * precision; j += 1) {
        const mid = (good + bad) / 2;
        if (test(mid)) good = mid;
        else bad = mid;
      }
      return { value: good, cleared: true, evaluations: counter.n };
    }
    bad = candidate;
  }
  return { value: bad, cleared: false, evaluations: counter.n };
}

/**
 * How far short of its targets a ceiling report falls, relatively and summed. Only
 * used to rank scales that all failed the pre-filter, so that "fit the closest" means
 * something rather than "fit whichever was tried first".
 */
export function ceilingShortfall(ceilings: readonly TierCeiling[]): number {
  let total = 0;
  for (const c of ceilings) {
    if (c.ceiling === null || c.target <= 0) continue;
    total += Math.max(0, (c.target - c.ceiling) / c.target);
  }
  return total;
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
  /** Set false to hold `r_eff` at whatever the bundle authored and solve amounts only. */
  solveREff?: boolean;
  /** Set false to hold the storage tier factor where the bundle authored it. */
  solveCapPerTier?: boolean;
  /**
   * Set false to take the coarse grid's winner and skip the refinement pass.
   *
   * The refinement probes fractions of the winner, and those fractions are where cost
   * is unpredictable: measured, a refinement at scale 1.6 spent over 800 seconds on a
   * single tier while scale 1.25 did the same tier in 4. For a quick look, or a test
   * that only needs the coarse ranking, that is a bad trade.
   */
  refine?: boolean;
  /**
   * How far above its target each tier's ceiling must reach for `capPerTier` to count
   * as sufficient. Above 1 so the amounts search has somewhere to land: a ceiling
   * exactly ON the target is only reachable by asking for every last unit a player can
   * hold, which is the knife edge the ceiling fill deliberately stays under.
   */
  capHeadroom?: number;
  /**
   * The coarse grid of `r_eff - 1` scales to rank. Geometric, because the useful range
   * spans more than an order of magnitude and the response is flat at the bottom of it.
   */
  rEffScales?: readonly number[];
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
  /** The scale applied to every class's `r_eff - 1`. 1 when nothing authored `r_eff`. */
  rEffScale: number;
  /** The solved storage tier factor (spec B.4 as amended). */
  capPerTier: number;
  /**
   * Every scale tried, with the curve score it produced and the capPerTier solved for
   * it. `capPerTier` is absent on a scale that was refused or that no cap could rescue.
   */
  rEffScan: { scale: number; miss: number; capPerTier?: number }[];
}

interface AmountOptions extends CalibrateOptions {
  bundle: Bundle;
}

interface AmountResult {
  bundle: Bundle;
  tiers: TierCalibration[];
}

/**
 * The `r_eff` scan (spec D3 as amended in Phase 2, and B.7).
 *
 * It is a scan and not a bisection, and that is forced by measurement rather than
 * chosen for convenience. Raising `r_eff` makes machines dearer, so a player buys fewer
 * and banks more of the same currency instead — and while a tier's requirement is small
 * relative to production, that hoarding WINS. On the slice at a fixed 22,400
 * `iron_plate`, scaling `r_eff - 1` by 1 -> 2 -> 4 took tier 1 from 1.95 collections to
 * 1.65 to 1.42. Only once the requirement is large does slower production dominate: at
 * 1,000,000 the same scales run 3.94 -> 3.76 -> 9.39 -> 23.58 -> 53.71.
 *
 * A bisection assumes the monotonicity that measurement disproves, and would settle in
 * the flat corner and report success. So every candidate is scored on the WHOLE tier
 * curve, by `curveMiss`, with the amounts re-solved underneath it — a scale is only as
 * good as the game it produces once the requirements have been fitted to it.
 *
 * Coarse geometric pass first, then a finer one around the winner. The coarse pass runs
 * at a loose tolerance because it only has to rank candidates; the chosen scale is then
 * calibrated once more at full precision, and THAT is the result reported.
 */
const COARSE_SCALES = [0.5, 1, 2, 4, 8, 16, 32];

/**
 * Where to look once the coarse grid has a winner. The grid steps by 2x, so the answer
 * lies somewhere in the octave either side of it, and these four split that interval.
 *
 * A function taking the winner explicitly rather than four multiplications against a
 * mutable variable: the whole point is that every refinement is relative to the same
 * base, and a parameter makes that true by construction rather than by discipline.
 */
export const REFINEMENT_FACTORS = [0.6, 0.8, 1.25, 1.6] as const;

export function refinementScales(coarseWinner: number): number[] {
  return REFINEMENT_FACTORS.map((factor) => coarseWinner * factor);
}

export function calibrate(options: CalibrateOptions): CalibrationResult {
  const report = options.onProgress ?? ((): void => {});
  const tolerance = options.tolerance ?? 0.05;
  const targets = options.bundle.pacing.targetCollectionsToTier;

  const authorsREff = options.bundle.machineClasses.some((c) => c.rEff !== undefined);
  const scan: { scale: number; miss: number; capPerTier?: number }[] = [];

  /**
   * Why a scale cannot be used at all, or null if it can.
   *
   * Spec D3's invariant is `r_eff > 1 + ε`: below it, machine count grows linearly or
   * faster and production explodes. The grid is a caller's parameter, so nothing else
   * stops a scale landing there — and a calibrator that emits content its own validator
   * rejects is worse than one that fails outright, because the numbers look solved.
   *
   * It asks `checkRunawayGrowth`, the same function `content:check` runs, rather than
   * re-deriving the floor here. Two implementations of "what counts as runaway" would
   * eventually disagree, and the one that mattered would be whichever ran last.
   */
  const refuse = (bundleAtScale: Bundle): string | null => {
    const issues = checkRunawayGrowth(bundleAtScale);
    return issues.length === 0
      ? null
      : `runaway: ${issues.length} class(es) at or below the floor — ${issues[0]!.message}`;
  };

  const score = (
    scale: number,
    bundleAtScale: Bundle,
    coarse: boolean,
  ): { miss: number; result?: AmountResult; refused?: string } => {
    const coarseTolerance = Math.max(tolerance, 0.15);
    const refused = refuse(bundleAtScale);
    if (refused !== null) return { miss: Number.POSITIVE_INFINITY, refused };
    const result = calibrateAmounts({
      ...options,
      bundle: bundleAtScale,
      tolerance: coarse ? coarseTolerance : tolerance,
      maxIterationsPerTier: coarse ? 6 : options.maxIterationsPerTier,
      // A tighter leash while ranking. The scan gets dearer as the scale rises -- a
      // slower game means every run simulates for longer -- and the coarse pass only
      // has to order candidates, so it does not need to watch an overshoot play out to
      // six times its target.
      overrunBudget: coarse ? 3 : options.overrunBudget,
      // The scan makes tens of inner passes, so their per-step lines would bury it --
      // but total silence inside a point that can run for minutes is the same defect
      // the per-step reporting fixed one level down. Tier lines only, prefixed.
      // `calibrateAmounts` indents its per-step lines and not its per-tier ones, which
      // is what makes them separable here.
      onProgress: coarse
        ? (line: string): void => {
            if (!line.startsWith("  ")) report(`  [scale ${scale.toFixed(3)}] ${line}`);
          }
        : options.onProgress,
    });
    return { miss: curveMiss(result.tiers, coarse ? coarseTolerance : 0), result };
  };

  const solvable = options.bundle.milestones
    .map((m) => m.tier)
    .filter((tier) => tier <= targets.length)
    .sort((a, b) => a - b);
  const deepestTier = Math.min(
    options.maxTier ?? (solvable[solvable.length - 1] ?? 0),
    solvable[solvable.length - 1] ?? 0,
  );

  // r_eff and capPerTier are solved TOGETHER, because they multiply: capPerTier raises
  // what a tier can ask for, r_eff slows how fast it is made. Solved in sequence --
  // capPerTier first, at the bundle's authored r_eff -- capPerTier is fitted at its own
  // worst case and charged for the whole gap alone. Measured on the slice: r_eff scale 4
  // by itself cleared tiers 1 to 5 and missed tier 6 by 0.9%, while capPerTier by itself
  // at the authored scale needed 3.64 just to reach tier 3's target.
  //
  // So every candidate scale gets its own capPerTier: the smallest that clears at THAT
  // scale. capPerTier bisects because it is monotone -- a bigger cap can only make a
  // tier take longer to fill, never less -- while the scale is scanned because it is
  // measurably not (see the note on the scan).
  //
  // The headroom is small on purpose. The ceiling responds to the cap factor
  // logarithmically -- measured `ceiling = 8.87 + 0.82 * ln(capFactor)` on tier 3 -- so
  // a 25% margin costs 28x the cap factor: reaching tier 3's target of 11 needs
  // capPerTier 3.64, reaching 11 x 1.25 needs 19.29, which puts tier-9 caps at 3e11
  // times base. In a log regime headroom is exponentially expensive and has to be thin.
  const headroom = options.capHeadroom ?? 1.05;
  const authoredCap = options.bundle.storage.capPerTier;
  const holdCap = options.solveCapPerTier === false;

  const capByScale = new Map<number, number>();
  const shortfalls = new Map<number, number>();
  // Warm start. Scales are tried in ascending order and a faster game needs a bigger
  // cap, so the previous answer is a good guess for the next and the bisection starts
  // near its target instead of bracketing from scratch every time.
  let warmSeed = Math.max(authoredCap, 2);

  const ceilingsAt = (bundleAtScale: Bundle, cap: number): TierCeiling[] =>
    tierCeilings({
      bundle: withCapPerTier(bundleAtScale, cap),
      maxTier: deepestTier,
      policy: options.policy ?? "greedy",
      seed: options.seed ?? 42,
    });

  /** Which tier a ceiling report falls short at, for the probe log. */
  const firstShort = (ceilings: readonly TierCeiling[]): string => {
    const short = ceilings.find((c) => c.ceiling !== null && c.ceiling < c.target * headroom);
    return short === undefined
      ? "no tier short"
      : `tier ${short.tier} tops out at ${short.ceiling!.toFixed(2)} of ${short.target}`;
  };

  /** The smallest capPerTier clearing every target at this scale, or null if none does. */
  const requiredCap = (scale: number, bundleAtScale: Bundle): number | null => {
    if (holdCap) {
      const ceilings = ceilingsAt(bundleAtScale, authoredCap);
      if (clearsTargets(ceilings, headroom)) return authoredCap;
      shortfalls.set(scale, ceilingShortfall(ceilings));
      return null;
    }
    // Reported per probe, because "short" alone says nothing about WHERE the game
    // stops, and each probe here costs a simulated run of most of the game.
    let lastShort = "";
    const solved = smallestClearing(
      (value) => {
        const ceilings = ceilingsAt(bundleAtScale, value);
        const ok = clearsTargets(ceilings, headroom);
        if (!ok) lastShort = firstShort(ceilings);
        return ok;
      },
      {
        seed: warmSeed,
        floor: 1,
        ceiling: MAX_CAP_PER_TIER,
        onProbe: (value, cleared, elapsedMs) =>
          report(
            `  [scale ${scale.toFixed(3)}] capPerTier ${value.toFixed(4).padStart(9)}  ` +
              `${cleared ? "clears" : `short: ${lastShort}`}  ${(elapsedMs / 1000).toFixed(0)}s`,
          ),
      },
    );
    if (!solved.cleared) {
      shortfalls.set(scale, ceilingShortfall(ceilingsAt(bundleAtScale, solved.value)));
      report(
        `  [scale ${scale.toFixed(3)}] no capPerTier up to ${MAX_CAP_PER_TIER} clears; ` +
          `${lastShort}`,
      );
      return null;
    }
    warmSeed = solved.value;
    return solved.value;
  };

  let bestScale = 1;
  let bestCap = authoredCap;
  if (authorsREff && options.solveREff !== false) {
    let best = Number.POSITIVE_INFINITY;
    const consider = (scale: number, force = false): void => {
      report(`r_eff scale ${scale.toFixed(3).padStart(8)}  ...`);
      const started = Date.now();
      const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(0)}s`;

      const scaled = withREffScale(options.bundle, scale);
      const refused = refuse(scaled);
      if (refused !== null) {
        scan.push({ scale, miss: Number.POSITIVE_INFINITY });
        report(`r_eff scale ${scale.toFixed(3).padStart(8)}  refused, ${refused}  ${elapsed()}`);
        return;
      }

      // The pre-filter and the storage solve are now the same step: a scale is usable
      // exactly when SOME capPerTier makes every tier clear, and the smallest such value
      // is the one to use with it.
      const cap = force ? (capByScale.get(scale) ?? warmSeed) : requiredCap(scale, scaled);
      if (cap === null) {
        scan.push({ scale, miss: Number.POSITIVE_INFINITY });
        report(
          `r_eff scale ${scale.toFixed(3).padStart(8)}  no capPerTier clears every ` +
            `target  ${elapsed()}`,
        );
        return;
      }
      capByScale.set(scale, cap);

      const { miss } = score(scale, withCapPerTier(scaled, cap), true);
      scan.push({ scale, miss, capPerTier: cap });
      report(
        `r_eff scale ${scale.toFixed(3).padStart(8)}  capPerTier ${cap.toFixed(4)}  ` +
          `curve miss ${miss.toFixed(4)}  ${elapsed()}`,
      );
      if (miss < best) {
        best = miss;
        bestScale = scale;
        bestCap = cap;
      }
    };
    for (const scale of options.rEffScales ?? COARSE_SCALES) consider(scale);
    // Read ONCE. `consider` writes to `bestScale`, so computing each refinement point
    // from it inside the loop meant that as soon as one refinement won, the next was
    // measured relative to that instead of to the coarse winner -- a grid that walks,
    // whose shape depends on the order it happened to be evaluated in.
    if (Number.isFinite(best) && options.refine !== false) {
      const coarseWinner = bestScale;
      for (const scale of refinementScales(coarseWinner)) consider(scale);
    } else if (Number.isFinite(best)) {
      report(`refinement skipped; keeping the coarse winner ${bestScale.toFixed(3)}`);
    } else if (!Number.isFinite(best)) {
      // Nothing cleared at any capPerTier. Rather than emit no solution, fit the scale
      // that came closest and let its tiers report themselves as off target -- numbers
      // honest about what they could not do beat a silent failure.
      let closest = bestScale;
      let least = Number.POSITIVE_INFINITY;
      for (const [scale, shortfall] of shortfalls) {
        if (shortfall < least) {
          least = shortfall;
          closest = scale;
        }
      }
      bestScale = closest;
      bestCap = capByScale.get(closest) ?? warmSeed;
      report(
        `no scale reached every target at any capPerTier; fitting the closest, ` +
          `${closest.toFixed(3)} (short by ${least.toFixed(3)} of a target, summed)`,
      );
      capByScale.set(closest, bestCap);
      consider(closest, true);
      bestCap = capByScale.get(closest) ?? bestCap;
    }
  } else if (!holdCap && deepestTier > 0) {
    // No scale scan -- either nothing authored `r_eff` or the caller asked to hold it --
    // so storage is solved on its own, at the bundle as authored. Nesting this inside
    // the scan made `solveCapPerTier` silently do nothing whenever `solveREff` was off,
    // which is a combination the CLI exposes as `--no-solve-reff`.
    report(`r_eff held; solving capPerTier alone`);
    const cap = requiredCap(1, options.bundle);
    if (cap !== null) bestCap = cap;
    report(
      cap === null
        ? `capPerTier: no value clears every target`
        : `capPerTier ${cap.toFixed(4)}`,
    );
    report(`r_eff scale chosen: ${bestScale.toFixed(3)}`);
  }

  const capPerTier = bestCap;
  const base = withCapPerTier(options.bundle, capPerTier);
  const scaled = withREffScale(base, bestScale);
  const costRatios = deriveCostRatios(scaled);
  for (const ratio of costRatios) {
    report(`r_eff -> r   ${ratio.id.padEnd(18)} ${ratio.costRatio.toFixed(6)}`);
  }

  const chosen = score(bestScale, scaled, false);
  if (chosen.result === undefined) {
    throw new Error(
      `every r_eff scale tried was refused (${chosen.refused ?? "unknown"}). ` +
        `Widen --max-tier's grid upward, or raise the authored r_eff.`,
    );
  }
  const final = chosen.result;
  const rEffById = new Map(scaled.machineClasses.map((c) => [c.id, c.rEff]));

  const derived: Derived = {
    run: {
      calibratedAt: new Date().toISOString(),
      policy: options.policy ?? "greedy",
      seed: options.seed ?? 42,
      targetCollectionsToTier: targets,
      observedCollectionsToTier: final.tiers.map((t) => t.observed),
    },
    ...(costRatios.length > 0
      ? {
          machineClasses: costRatios.map((r) => ({
            ...r,
            ...(rEffById.get(r.id) === undefined ? {} : { rEff: rEffById.get(r.id)! }),
          })),
        }
      : {}),
    storage: { capPerTier },
    quantumStorage: { capPerTier },
    milestones: final.tiers.map((t) => ({
      tier: t.tier,
      requires: final.bundle.milestones.find((m) => m.tier === t.tier)!.requires.map((r) => ({
        item: r.item,
        amount: r.amount,
      })),
    })),
  };

  return {
    bundle: final.bundle,
    derived,
    tiers: final.tiers,
    rEffScale: bestScale,
    capPerTier,
    rEffScan: scan,
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
function calibrateAmounts(options: AmountOptions): AmountResult {
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

  let working = options.bundle;

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
        const cap = maxAttainableCap(options.bundle, item, Math.max(0, tier - 1));
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

  return { bundle: working, tiers };
}
