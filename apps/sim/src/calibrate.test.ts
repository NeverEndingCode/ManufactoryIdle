import { fileURLToPath } from "node:url";
import { applyDerived, loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { SLICE_BUNDLE_DIR } from "./bootstrap.js";
import { indexContent } from "@manufactory/engine";
import {
  bisectMonotone,
  calibrate,
  curveMiss,
  UNREACHABLE_PENALTY,
  deriveCostRatios,
  withREffScale,
  withMilestoneAmounts,
} from "./calibrate.js";
import { runSimulation } from "./run.js";

const slice = loadBundleDir(SLICE_BUNDLE_DIR);
const fixture = loadBundleDir(
  fileURLToPath(new URL("../../../packages/content/bundles/fixture", import.meta.url)),
);

describe("bisectMonotone", () => {
  it("finds the input that hits the target", () => {
    const result = bisectMonotone((x) => x * x, { target: 100, tolerance: 1e-6 });
    expect(result.converged).toBe(true);
    expect(result.x).toBeCloseTo(10, 4);
  });

  it("brackets upward when the seed is far below the target", () => {
    const result = bisectMonotone((x) => x, { target: 1e6, tolerance: 1e-6 });
    expect(result.converged).toBe(true);
    expect(result.x).toBeCloseTo(1e6, 0);
  });

  it("brackets downward when the seed is far above the target", () => {
    const result = bisectMonotone((x) => x, { target: 1e-4, tolerance: 1e-6 });
    expect(result.converged).toBe(true);
    expect(result.x).toBeCloseTo(1e-4, 8);
  });

  // A run that never reaches the tier reports Infinity. Bisection has to keep
  // working against that rather than propagating a NaN through every later step.
  it("handles an input whose measurement never finishes", () => {
    const result = bisectMonotone((x) => (x > 5 ? Number.POSITIVE_INFINITY : x), {
      target: 4,
      tolerance: 1e-6,
    });
    expect(result.converged).toBe(true);
    expect(result.x).toBeCloseTo(4, 4);
  });

  // Milestone amounts are integers, so the function it searches is a staircase and
  // the target usually falls between two steps. Stopping on a collapsed bracket is
  // what keeps that from spinning to the iteration cap on every single tier.
  it("stops when the bracket collapses on a step function", () => {
    const result = bisectMonotone((x) => Math.round(x), { target: 10.5, tolerance: 1e-9 });
    expect(result.converged).toBe(false);
    expect(result.evaluations).toBeLessThan(80);
    expect(Math.round(result.x)).toBeGreaterThanOrEqual(10);
    expect(Math.round(result.x)).toBeLessThanOrEqual(11);
  });

  // The count is what the caller sees as "how many simulated runs did this cost".
  // It lived in a plain number passed into the refinement half by value, so every
  // split the refinement made went uncounted and a twenty-run tier reported three.
  it("counts every evaluation, including the ones the refinement made", () => {
    let calls = 0;
    const result = bisectMonotone(
      (x) => {
        calls += 1;
        return Math.round(x);
      },
      { target: 10.5, tolerance: 1e-9 },
    );
    expect(result.evaluations).toBe(calls);
    expect(result.evaluations).toBeGreaterThan(5);
  });

  it("reports the measurement it actually settled on, not the target", () => {
    const result = bisectMonotone((x) => Math.round(x), { target: 10.5, tolerance: 1e-9 });
    expect(result.y).toBe(Math.round(result.x));
  });
});

describe("deriveCostRatios", () => {
  // Spec D3's authoring inversion: author the ladder and r_eff, derive r = r_eff * m
  // with m = step^(1/interval). Retuning the ladder then moves pacing by zero.
  it("derives r from the authored r_eff and ladder", () => {
    const bundle = {
      ...fixture,
      machineClasses: fixture.machineClasses.map((c) =>
        c.id === "miner" ? { ...c, rEff: 1.047 } : c,
      ),
    };
    const derived = deriveCostRatios(bundle);
    // m = 1.5^(1/10) = 1.0413797, so r = 1.047 * 1.0413797 = 1.0903245
    expect(derived.find((d) => d.id === "miner")!.costRatio).toBeCloseTo(1.0903245, 6);
  });

  it("leaves a class that authors r directly alone", () => {
    expect(deriveCostRatios(fixture)).toEqual([]);
  });
});

describe("withMilestoneAmounts", () => {
  it("scales every requirement of the named tier and no other", () => {
    const scaled = withMilestoneAmounts(slice, 1, 10);
    const before = slice.milestones.find((m) => m.tier === 1)!.requires[0]!.amount;
    const after = scaled.milestones.find((m) => m.tier === 1)!.requires[0]!.amount;
    expect(after).toBe(before * 10);
    expect(scaled.milestones.find((m) => m.tier === 2)).toEqual(
      slice.milestones.find((m) => m.tier === 2),
    );
  });

  // The simulator must run the number that ships, not a float the emitter later
  // rounds. Otherwise the committed bundle is a bundle nobody measured.
  it("rounds to whole units, because that is what gets written out", () => {
    const scaled = withMilestoneAmounts(slice, 1, 1.337);
    for (const requirement of scaled.milestones.find((m) => m.tier === 1)!.requires) {
      expect(Number.isInteger(requirement.amount)).toBe(true);
    }
  });

  it("never scales a requirement below one unit", () => {
    const scaled = withMilestoneAmounts(slice, 1, 1e-9);
    for (const requirement of scaled.milestones.find((m) => m.tier === 1)!.requires) {
      expect(requirement.amount).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves the input bundle untouched", () => {
    const before = slice.milestones.find((m) => m.tier === 1)!.requires[0]!.amount;
    withMilestoneAmounts(slice, 1, 99);
    expect(slice.milestones.find((m) => m.tier === 1)!.requires[0]!.amount).toBe(before);
  });
});

describe("calibrate", () => {
  // Tier 1 on the slice is authored at 200 iron_plate and lands in 0.02 collections
  // against a target of 2 -- a hundredfold miss. This is the whole job of the phase,
  // reduced to one tier so it runs in a test.
  it("moves an observed tier time onto its target", () => {
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, solveREff: false });
    const tier1 = result.tiers[0]!;
    expect(tier1.target).toBe(2);
    expect(tier1.observed).not.toBeNull();
    expect(Math.abs(tier1.observed! - 2)).toBeLessThanOrEqual(0.1);
    expect(tier1.converged).toBe(true);
  }, 300_000);

  // The point of emitting a `derived` block rather than rewriting the source is that
  // the committed bundle is the one that was measured. If loading the authored files
  // with the derived block on top produced anything else, every number in it would be
  // a claim about a bundle nobody ran.
  it("emits a derived block that reproduces the measurement it reports", () => {
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, solveREff: false });
    const reloaded = applyDerived({ ...slice, derived: result.derived });
    const run = runSimulation({
      policy: "greedy",
      seed: 42,
      content: indexContent(reloaded as never),
      untilTier: 1,
      maxSimMs: 60 * 24 * 60 * 60 * 1000,
    });
    expect(run.tierTimes.find((t) => t.tier === 1)!.collections).toBeCloseTo(
      result.tiers[0]!.observed!,
      9,
    );
  }, 300_000);

  // A single tier can take tens of minutes: every step of the search is a real run,
  // and an overshoot simulates to the overrun budget before it can report "never".
  // Reporting only once per tier made that indistinguishable from a hang.
  it("reports every search step, not just the tier it finished", () => {
    const lines: string[] = [];
    calibrate({
      bundle: slice,
      maxTier: 1,
      tolerance: 0.05,
      solveREff: false,
      onProgress: (l) => lines.push(l),
    });
    const steps = lines.filter((l) => l.includes("try"));
    expect(steps.length).toBeGreaterThan(1);
    // Each step says what it tried and what came back, so a stalled search is
    // distinguishable from a slow one.
    expect(steps[0]).toMatch(/try/);
    expect(steps.some((l) => /never|\d/.test(l))).toBe(true);
  }, 300_000);

  it("records the targets and the observations side by side", () => {
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, solveREff: false });
    expect(result.derived.run!.targetCollectionsToTier).toEqual(
      slice.pacing.targetCollectionsToTier,
    );
    expect(result.derived.run!.observedCollectionsToTier).toEqual([result.tiers[0]!.observed]);
    expect(result.derived.run!.policy).toBe("greedy");
  }, 300_000);
});

describe("a requirement nobody could ever deliver", () => {
  // Ruling R7 pays deliveries from liquid stock, so a requirement above what storage
  // and Quantum Storage can hold at maximum level can never be met -- not slowly, not
  // ever. Learning that by simulating to the overrun budget and giving up cost minutes
  // per step, and bracketing overshoots deliberately, so it happens on most tiers.
  //
  // This is a feasibility test, not a second estimate of how long something takes:
  // it answers "is this satisfiable at all", which is exactly check 9's question and
  // is exact. B.7's one-implementation rule is about durations, and no duration is
  // being guessed here.
  it("is rejected without simulating it", () => {
    const seen: string[] = [];
    // A target no requirement could ever reach, so the search brackets upward past
    // what storage and Quantum Storage can hold and has to deal with the infeasible
    // half. Tier 1's real target of 2 converges long before it gets there.
    const unreachable: typeof slice = {
      ...slice,
      pacing: { ...slice.pacing, targetCollectionsToTier: [1e6, ...slice.pacing.targetCollectionsToTier.slice(1)] },
    };
    calibrate({
      bundle: unreachable,
      maxTier: 1,
      tolerance: 0.05,
      solveREff: false,
      onProgress: (line) => seen.push(line),
    });
    const overCap = seen.filter((l) => l.includes("above the maximum"));
    expect(overCap.length).toBeGreaterThan(0);
    // And it costs no measurable time, which is the entire point.
    for (const line of overCap) expect(line).toMatch(/ 0s /);
  }, 300_000);
});


describe("withREffScale", () => {
  // Spec D3: the invariant is r_eff > 1 + eps, so the DISTANCE above 1 is the pacing
  // quantity. Scaling r_eff itself would move every class by a different amount in the
  // units that matter and would reorder them; scaling (r_eff - 1) preserves the
  // ordering the author chose.
  it("scales the distance above the runaway floor, not r_eff itself", () => {
    const scaled = withREffScale(slice, 2);
    const miner = scaled.machineClasses.find((c) => c.id === "miner")!;
    expect(miner.rEff).toBeCloseTo(1 + (1.046688 - 1) * 2, 9);
  });

  it("keeps the relative ordering of classes", () => {
    const before = slice.machineClasses.map((c) => c.rEff!);
    const after = withREffScale(slice, 3).machineClasses.map((c) => c.rEff!);
    const rank = (xs: number[]): number[] =>
      xs.map((x) => xs.filter((y) => y < x).length);
    expect(rank(after)).toEqual(rank(before));
  });

  it("is the identity at scale 1", () => {
    expect(withREffScale(slice, 1).machineClasses.map((c) => c.rEff)).toEqual(
      slice.machineClasses.map((c) => c.rEff),
    );
  });

  it("never lands on or below the runaway floor", () => {
    for (const cls of withREffScale(slice, 1e-9).machineClasses) {
      expect(cls.rEff!).toBeGreaterThan(1);
    }
  });

  it("leaves a class that authors no r_eff alone", () => {
    const noREff = {
      ...slice,
      machineClasses: slice.machineClasses.map(({ rEff: _drop, ...rest }) => rest),
    };
    expect(withREffScale(noREff, 5)).toEqual(noREff);
  });
});

describe("curveMiss", () => {
  // The score the r_eff scan minimises. Relative, because a tier targeting 2100
  // collections missing by 1 is not the same failure as a tier targeting 2 missing by 1.
  it("is zero when every tier lands on its target", () => {
    expect(curveMiss([{ target: 2, observed: 2 }, { target: 5, observed: 5 }])).toBe(0);
  });

  it("sums the relative misses", () => {
    expect(curveMiss([{ target: 2, observed: 3 }, { target: 10, observed: 9 }])).toBeCloseTo(
      0.5 + 0.1,
      9,
    );
  });

  // A tier that cannot be reached at all is not "very late" -- it is a different kind
  // of answer, and the scan must never prefer it to a tier that is merely off.
  it("scores an unreachable tier worse than any reachable one", () => {
    const unreachable = curveMiss([{ target: 2, observed: null }]);
    expect(unreachable).toBeGreaterThan(curveMiss([{ target: 2, observed: 1e6 }]));
  });

  // The coarse ranking pass fits amounts to a loose tolerance, so each tier lands
  // within about 15% rather than on the number. Across three tiers that is up to 0.45
  // of accumulated fitting noise -- larger than the differences between the scales
  // being ranked, which is how scale 1 scored 0.5389 when its real curve miss was
  // 0.33. A deadband makes "landed within the tolerance it was fitted to" score zero,
  // so only genuine misses survive into the comparison.
  it("ignores misses inside the deadband it was fitted to", () => {
    const tiers = [{ target: 10, observed: 11 }, { target: 100, observed: 105 }];
    expect(curveMiss(tiers, 0.15)).toBe(0);
    expect(curveMiss(tiers)).toBeCloseTo(0.1 + 0.05, 9);
  });

  it("measures a genuine miss from the edge of the deadband, not from the target", () => {
    expect(curveMiss([{ target: 10, observed: 15 }], 0.15)).toBeCloseTo(0.5 - 0.15, 9);
  });

  it("still scores an unreachable tier at full penalty inside a deadband", () => {
    expect(curveMiss([{ target: 10, observed: null }], 0.9)).toBe(UNREACHABLE_PENALTY);
  });

  it("counts a tier that was never attempted as unreachable", () => {
    expect(curveMiss([])).toBe(0);
    expect(curveMiss([{ target: 2, observed: null }])).toBeGreaterThan(0);
  });
});

describe("the r_eff scan", () => {
  // A two-point grid keeps this to two inner calibrations. The full COARSE_SCALES grid
  // plus its refinement is eleven, which is a ten-minute job and belongs at the CLI.
  const scales = [1, 8];

  it("scores every scale it is given and reports the scan", () => {
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, rEffScales: scales });
    expect(result.rEffScan.map((s) => s.scale)).toEqual(
      expect.arrayContaining(scales),
    );
    for (const entry of result.rEffScan) expect(entry.miss).toBeGreaterThanOrEqual(0);
  }, 600_000);

  it("picks the scale with the smallest curve miss, not the first or the largest", () => {
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, rEffScales: scales });
    const best = result.rEffScan.reduce((a, b) => (b.miss < a.miss ? b : a));
    expect(result.rEffScale).toBe(best.scale);
  }, 600_000);

  // The cost ratios it emits have to be the ones implied by the r_eff it chose. If they
  // came from the authored r_eff instead, the committed bundle would run on a pacing
  // decision the calibration never made.
  it("emits cost ratios derived from the scale it chose", () => {
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, rEffScales: scales });
    const miner = result.derived.machineClasses!.find((c) => c.id === "miner")!;
    const authored = slice.machineClasses.find((c) => c.id === "miner")!;
    const m = Math.pow(authored.ladder.step, 1 / authored.ladder.interval);
    expect(miner.rEff).toBeCloseTo(1 + (authored.rEff! - 1) * result.rEffScale, 9);
    expect(miner.costRatio).toBeCloseTo(miner.rEff! * m, 9);
  }, 600_000);

  it("holds r_eff where the bundle put it when asked not to solve it", () => {
    const result = calibrate({
      bundle: slice,
      maxTier: 1,
      tolerance: 0.05,
      solveREff: false,
    });
    expect(result.rEffScale).toBe(1);
    expect(result.rEffScan).toEqual([]);
    const miner = result.derived.machineClasses!.find((c) => c.id === "miner")!;
    expect(miner.rEff).toBeCloseTo(slice.machineClasses.find((c) => c.id === "miner")!.rEff!, 9);
  }, 600_000);
});

describe("the scan and check 8", () => {
  // r_eff below 1 + eps is spec D3's runaway: machine count grows linearly or faster
  // and production explodes. The scan is handed its grid, so nothing stops a caller
  // asking for a scale that lands there -- and a calibrator that emits content its own
  // validator rejects is worse than one that fails, because the numbers look solved.
  //
  // It reuses checkRunawayGrowth rather than re-deriving the floor, so the calibrator
  // and the validator cannot drift apart on what counts as runaway.
  it("refuses a scale that drives r_eff below the runaway floor", () => {
    const lines: string[] = [];
    const result = calibrate({
      bundle: slice,
      maxTier: 1,
      tolerance: 0.05,
      rEffScales: [0.001, 1],
      onProgress: (line) => lines.push(line),
    });
    expect(result.rEffScale).toBe(1);
    expect(lines.some((l) => l.includes("runaway"))).toBe(true);
  }, 600_000);

  it("does not simulate a scale it has already refused", () => {
    const lines: string[] = [];
    calibrate({
      bundle: slice,
      maxTier: 1,
      tolerance: 0.05,
      rEffScales: [0.001, 1],
      onProgress: (line) => lines.push(line),
    });
    const refused = lines.find((l) => l.includes("runaway"))!;
    expect(refused).toMatch(/ 0s$/);
  }, 600_000);
});
