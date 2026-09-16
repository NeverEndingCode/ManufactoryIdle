import { fileURLToPath } from "node:url";
import { applyDerived, loadBundleDir, maxAttainableCap } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { SLICE_BUNDLE_DIR } from "./bootstrap.js";
import { indexContent } from "@manufactory/engine";
import {
  bisectMonotone,
  calibrate,
  curveMiss,
  refinementScales,
  smallestClearing,
  tierCeilings,
  clearsTargets,
  withAllMilestonesAtCap,
  withCapPerTier,
  REFINEMENT_FACTORS,
  UNREACHABLE_PENALTY,
  deriveCostRatios,
  withREffScale,
  withMilestoneAmounts,
} from "./calibrate.js";
import { runSimulation } from "./run.js";

// The calibrator's own view of content: authored numbers, never the derived.yaml a
// previous run emitted. These assertions are about what the search does to the seeds.
const raw = { applyDerived: false } as const;

/**
 * Give a test its own pacing targets.
 *
 * Tests that assert calibrator MECHANICS -- a ceiling falls short, a scale is
 * rejected, a search has work to do -- need a target the slice measurably cannot
 * reach. Borrowing `pacing.yaml`'s targets for that couples them to a tuning
 * decision: retuning the slice to what it can actually pace silently turned five of
 * these green-for-no-reason, because the content moved under an assertion about the
 * machinery. The targets below are the ones each test's measurements were taken
 * against, pinned here so they stay put.
 */
const withTargets = (bundle: typeof slice, targets: number[]): typeof slice => ({
  ...bundle,
  pacing: { ...bundle.pacing, targetCollectionsToTier: targets },
});

/**
 * Pin a test to the storage depth its measurements were taken against.
 *
 * Same hazard as `withTargets`, from the other direction. Tests that need a bundle
 * which measurably CANNOT clear a target -- the whole point of the capPerTier search --
 * were reading the slice's shipped ladder, so deepening it to 22/16 made the slice clear
 * unaided and `capPerTier` correctly stop rising. Four of them then asserted against a
 * premise the content had removed, and one spent 23 minutes doing the expensive fit it
 * exists to prove is skipped. 20/15 is the pre-fix depth those ceilings were measured at.
 */
const withLadder = (bundle: typeof slice, storage: number, quantum: number): typeof slice => ({
  ...bundle,
  storage: { ...bundle.storage, maxLevel: storage },
  quantumStorage: { ...bundle.quantumStorage, maxLevel: quantum },
});

/**
 * The storage curve every short-of-target measurement below was taken against: depth
 * 20/15 AND costGrowth 1.5.
 *
 * Both halves are load-bearing and each was learned by breaking the suite. Deepening the
 * ladder to 22/16 gave the slice enough shelf to clear targets it used to miss; raising
 * costGrowth to 1.8 slowed the late game enough to move the ceilings again. Either one
 * alone turns "this bundle measurably cannot clear" -- the premise the capPerTier and
 * ceiling-prefilter tests are built on -- quietly false.
 */
const shallow = (bundle: typeof slice): typeof slice => ({
  ...withLadder(bundle, 20, 15),
  storage: { ...bundle.storage, maxLevel: 20, costGrowth: 1.5 },
});
const slice = loadBundleDir(SLICE_BUNDLE_DIR, raw);
const fixture = loadBundleDir(
  fileURLToPath(new URL("../../../packages/content/bundles/fixture", import.meta.url)),
  raw,
);

// A guard on the fixture rather than on any one assertion. The slice ships a
// derived.yaml, and every "the slice is measurably short here" claim below is about
// the authored numbers; if `raw` ever stopped working, those tests would quietly start
// measuring the last calibration's output against itself.
describe("the fixture the calibrator sees", () => {
  it("is the authored slice, not the calibrated one", () => {
    const calibrated = loadBundleDir(SLICE_BUNDLE_DIR);
    expect(calibrated.derived).toBeDefined();
    expect(slice.milestones.find((m) => m.tier === 1)!.requires[0]!.amount).not.toBe(
      calibrated.milestones.find((m) => m.tier === 1)!.requires[0]!.amount,
    );
  });
});

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
    const result = calibrate({ bundle: withTargets(slice, [2]), maxTier: 1, tolerance: 0.05, solveREff: false, solveCapPerTier: false });
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
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, solveREff: false, solveCapPerTier: false });
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
      solveREff: false, solveCapPerTier: false,
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
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, solveREff: false, solveCapPerTier: false });
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
      solveREff: false, solveCapPerTier: false,
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

  it("leaves r_eff where it was at scale 1", () => {
    expect(withREffScale(slice, 1).machineClasses.map((c) => c.rEff)).toEqual(
      slice.machineClasses.map((c) => c.rEff),
    );
  });

  // The engine runs on costRatio and rEff is the intent behind it, so a bundle where
  // they disagree simulates as if unscaled while reporting the new r_eff -- a silent
  // no-op that looks like a measurement, which is exactly how the first version of the
  // ceiling pre-filter produced a wrong answer.
  it("moves costRatio with r_eff so the two can never disagree", () => {
    for (const scale of [0.5, 1, 4]) {
      for (const cls of withREffScale(slice, scale).machineClasses) {
        if (cls.rEff === undefined) continue;
        const m = Math.pow(cls.ladder.step, 1 / cls.ladder.interval);
        expect(cls.costRatio).toBeCloseTo(cls.rEff * m, 12);
      }
    }
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

  // Computed once and read by four assertions. `calibrate` is a pure function of its
  // options and nothing here mutates the result, so re-running it per test bought
  // nothing but three more scans -- about seventy seconds of the suite.
  let shared: ReturnType<typeof calibrate> | undefined;
  const scan = (): ReturnType<typeof calibrate> => {
    shared ??= calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, solveCapPerTier: false, rEffScales: scales });
    return shared;
  };

  it("scores every scale it is given and reports the scan", () => {
    const result = scan();
    expect(result.rEffScan.map((s) => s.scale)).toEqual(
      expect.arrayContaining(scales),
    );
    for (const entry of result.rEffScan) expect(entry.miss).toBeGreaterThanOrEqual(0);
  }, 600_000);

  it("picks the scale with the smallest curve miss, not the first or the largest", () => {
    const result = scan();
    const best = result.rEffScan.reduce((a, b) => (b.miss < a.miss ? b : a));
    expect(result.rEffScale).toBe(best.scale);
  }, 600_000);

  // The cost ratios it emits have to be the ones implied by the r_eff it chose. If they
  // came from the authored r_eff instead, the committed bundle would run on a pacing
  // decision the calibration never made.
  it("emits cost ratios derived from the scale it chose", () => {
    const result = scan();
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
      solveREff: false, solveCapPerTier: false,
    });
    expect(result.rEffScale).toBe(1);
    expect(result.rEffScan).toEqual([]);
    const miner = result.derived.machineClasses!.find((c) => c.id === "miner")!;
    expect(miner.rEff).toBeCloseTo(slice.machineClasses.find((c) => c.id === "miner")!.rEff!, 9);
  }, 600_000);
});

describe("the scan and check 8", () => {
  // One scan, two assertions -- see the note in "the r_eff scan".
  let shared: { result: ReturnType<typeof calibrate>; lines: string[] } | undefined;
  const scan = (): { result: ReturnType<typeof calibrate>; lines: string[] } => {
    if (shared === undefined) {
      const lines: string[] = [];
      const result = calibrate({
        bundle: shallow(slice),
        maxTier: 1,
        tolerance: 0.05,
        solveCapPerTier: false,
        rEffScales: [0.001, 1],
        onProgress: (line) => lines.push(line),
      });
      shared = { result, lines };
    }
    return shared;
  };

  // r_eff below 1 + eps is spec D3's runaway: machine count grows linearly or faster
  // and production explodes. The scan is handed its grid, so nothing stops a caller
  // asking for a scale that lands there -- and a calibrator that emits content its own
  // validator rejects is worse than one that fails, because the numbers look solved.
  //
  // It reuses checkRunawayGrowth rather than re-deriving the floor, so the calibrator
  // and the validator cannot drift apart on what counts as runaway.
  //
  // It asserts that the refused scale is not the one CHOSEN, and deliberately not that
  // the winner is 1. The grid here has two entries, so the refinement pass runs and
  // searches the octave around the coarse winner; at tier 1's retuned target a scale of
  // 0.6 fits better than 1 and legitimately wins. Pinning the winner made this test fail
  // the moment `targetCollectionsToTier[0]` moved 0.5 -> 0.42 -- reporting a content
  // retune as a refusal bug. Refusal is what this test is for; which of the surviving
  // scales fits best is the r_eff scan's business and is asserted there.
  it("refuses a scale that drives r_eff below the runaway floor", () => {
    const { result, lines } = scan();
    const refused = result.rEffScan.find((entry) => entry.scale === 0.001);
    expect(refused, "the refused scale must still be reported in the scan").toBeDefined();
    expect(refused!.miss).toBe(Number.POSITIVE_INFINITY);
    expect(refused!.capPerTier).toBeUndefined();
    expect(result.rEffScale).not.toBe(0.001);
    expect(lines.some((l) => l.includes("runaway"))).toBe(true);
  }, 600_000);

  it("does not simulate a scale it has already refused", () => {
    const { lines } = scan();
    const refused = lines.find((l) => l.includes("runaway"))!;
    expect(refused).toMatch(/ 0s$/);
  }, 600_000);
});

describe("the scan's refinement pass", () => {
  // `refinementScales` takes the winner as a parameter precisely so the drift cannot
  // happen: the four points are one base times four factors, by construction.
  it("splits the octave either side of the winner", () => {
    expect(refinementScales(4)).toEqual([2.4, 3.2, 5, 6.4]);
    expect(refinementScales(1)).toEqual([...REFINEMENT_FACTORS]);
  });

  it("keeps every refinement relative to one base", () => {
    const scales = refinementScales(7);
    for (const [i, scale] of scales.entries()) {
      expect(scale / REFINEMENT_FACTORS[i]!).toBeCloseTo(7, 9);
    }
  });

  // A weaker guard than the two above, and deliberately labelled as one: it only bites
  // if a refinement point actually wins, which depends on the bundle and the grid. It
  // is here because it exercises the wiring -- that `calibrate` really does run four
  // refinements off one base -- not because it can catch the drift on its own.
  it("runs four refinements off a single coarse winner (wiring only)", () => {
    const coarse = [1, 8];
    const result = calibrate({
      bundle: slice,
      maxTier: 1,
      tolerance: 0.05,
      solveCapPerTier: false,
      rEffScales: coarse,
    });
    const refinements = result.rEffScan.slice(coarse.length).map((s) => s.scale);
    expect(refinements).toHaveLength(4);
    // Every refinement must be one fixed base times its own factor.
    const bases = refinements.map((scale, i) => scale / [0.6, 0.8, 1.25, 1.6][i]!);
    for (const base of bases) expect(base).toBeCloseTo(bases[0]!, 9);
    // And that base is one of the coarse points -- the one that won.
    expect(coarse).toContain(Math.round(bases[0]! * 1000) / 1000);
  }, 900_000);
});

describe("withAllMilestonesAtCap", () => {
  // The ceiling configuration: every requirement as large as the player could ever
  // hold. A tier's landing time here is the latest it can be made to land, because a
  // requirement is monotone in time and every earlier tier is also at its slowest.
  it("fills each requirement to just under the item's maximum attainable cap", () => {
    const capped = withAllMilestonesAtCap(slice, 3);
    for (const milestone of capped.milestones.filter((m) => m.tier <= 3)) {
      for (const requirement of milestone.requires) {
        const item = slice.items.find((i) => i.id === requirement.item)!;
        const cap = maxAttainableCap(slice, item, Math.max(0, milestone.tier - 1));
        expect(requirement.amount).toBeLessThan(cap);
        expect(requirement.amount).toBeGreaterThan(cap * 0.9);
      }
    }
  });

  it("leaves tiers past the one being solved alone", () => {
    const capped = withAllMilestonesAtCap(slice, 2);
    expect(capped.milestones.filter((m) => m.tier > 2)).toEqual(
      slice.milestones.filter((m) => m.tier > 2),
    );
  });

  it("keeps every amount a whole number", () => {
    for (const milestone of withAllMilestonesAtCap(slice, 10).milestones) {
      for (const requirement of milestone.requires) {
        expect(Number.isInteger(requirement.amount)).toBe(true);
      }
    }
  });
});

describe("the ceiling pre-filter", () => {
  // One run per scale instead of a whole amounts calibration. It answers only "could
  // this scale reach the target at all", which is the question that discards most
  // candidates -- and it is the same simulator asked a cheaper question, not a second
  // estimate of how long anything takes.
  it("reports a ceiling per tier", () => {
    const ceilings = tierCeilings({ bundle: slice, maxTier: 2, policy: "greedy", seed: 42 });
    expect(ceilings.map((c) => c.tier)).toEqual([1, 2]);
    for (const c of ceilings) expect(c.target).toBeGreaterThan(0);
  }, 300_000);

  // A tier whose ceiling is below its target cannot be solved by any requirement, so
  // the scale is rejected without ever fitting amounts to it.
  it("rejects a scale whose ceiling falls short and keeps one that clears it", () => {
    // Measured: at the authored r_eff, tier 3's ceiling is 7.72 against a target of
    // 11; at twice the authored distance above the floor it is 12.45.
    const demanding = shallow(withTargets(slice, [2, 5, 11]));
    const authored = tierCeilings({ bundle: demanding, maxTier: 3, policy: "greedy", seed: 42 });
    const doubled = tierCeilings({
      bundle: withREffScale(demanding, 2),
      maxTier: 3,
      policy: "greedy",
      seed: 42,
    });
    expect(clearsTargets(authored)).toBe(false);
    expect(clearsTargets(doubled)).toBe(true);
  }, 900_000);

  // A tier that never lands inside the budget has a ceiling beyond it, which is later
  // than its target, not earlier. Treating "never" as a failure would reject exactly
  // the scales that stretch the game most.
  it("counts a tier that did not land inside the budget as clearing its target", () => {
    expect(clearsTargets([{ tier: 1, target: 2, ceiling: null }])).toBe(true);
  });
});

describe("the scan's use of the pre-filter", () => {
  // Both of these scales fall short of tier 3 -- measured ceilings 7.72 at scale 1 and
  // 9.39 at 0.5, against a target of 11 -- so both are filtered out, and the fallback
  // then fits the closer of the two. That covers the rejection path AND the fallback
  // in one pass, and it is deliberately the CHEAP pair: scoring scale 2 at tier 3 is
  // the thirteen-minute case this pre-filter exists to avoid, and putting it in the
  // suite would be paying the very cost being optimised away.
  it("does not fit amounts to a scale whose ceiling cannot reach the target", () => {
    const lines: string[] = [];
    calibrate({
      bundle: shallow(withTargets(slice, [2, 5, 11])),
      maxTier: 3,
      tolerance: 0.05,
      solveCapPerTier: false,
      rEffScales: [1, 0.5],
      // This asserts which passes RAN, not how well they fitted, so the fallback's
      // amounts search is capped to a couple of steps. Fitting it properly is the
      // expensive half and proves nothing the other tests do not.
      maxIterationsPerTier: 2,
      refine: false,
      // Bracketing dominates the fallback fit, and only the overrun budget shortens it.
      // This asserts which passes ran, not how well they fitted.
      overrunBudget: 1,
      onProgress: (line) => lines.push(line),
    });
    // The joint solve reports this differently, and more usefully: a scale is rejected
    // when NO capPerTier clears, not merely when the ceiling at one cap is too low.
    for (const scale of ["1.000", "0.500"]) {
      expect(
        lines.some((l) => l.includes(`scale    ${scale}`) && l.includes("no capPerTier clears")),
      ).toBe(true);
    }
    // The giveaway that neither was fitted during the scan: the only tier lines in the
    // whole log come from the single fallback pass, not from two scoring passes.
    expect(lines.filter((l) => /^ {2}\[scale .*\] tier +1 /.test(l))).toHaveLength(1);
  }, 900_000);

  it("still solves when no scale clears, rather than emitting nothing", () => {
    const lines: string[] = [];
    // Targets nothing can reach, but inside the budget cap so the pre-filter can
    // observe the shortfall rather than running out of simulated time.
    const impossible: typeof slice = {
      ...slice,
      pacing: { ...slice.pacing, targetCollectionsToTier: [400, 400, 400] },
    };
    const result = calibrate({
      bundle: impossible,
      maxTier: 1,
      tolerance: 0.05,
      solveCapPerTier: false,
      rEffScales: [1, 2],
      maxIterationsPerTier: 2,
      overrunBudget: 1,
      refine: false,
      onProgress: (line) => lines.push(line),
    });
    expect(result.tiers).toHaveLength(1);
    expect(lines.some((l) => l.includes("no scale"))).toBe(true);
  }, 1_800_000);
});


describe("the ceiling run's own budget", () => {
  // Its natural budget is the deepest target, which is authored data. A typo there --
  // 1e9 instead of 1e3 -- would ask for two and a half million years of simulated time
  // and hang the calibrator instead of complaining.
  it("never simulates past the cap, whatever the targets ask for", () => {
    const absurd: typeof slice = {
      ...slice,
      pacing: { ...slice.pacing, targetCollectionsToTier: [1e9, 1e9, 1e9] },
    };
    const started = Date.now();
    const ceilings = tierCeilings({
      bundle: absurd,
      maxTier: 1,
      policy: "greedy",
      seed: 42,
      maxCollections: 3,
    });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(ceilings).toHaveLength(1);
  }, 120_000);

  // Permissive by construction: hitting the cap reports "did not land", which counts as
  // clearing. A pre-filter that wrongly rejects loses the answer; one that wrongly
  // admits only loses a scoring pass.
  it("reports a tier it ran out of budget for as clearing, not failing", () => {
    const absurd: typeof slice = {
      ...slice,
      pacing: { ...slice.pacing, targetCollectionsToTier: [1e9] },
    };
    const ceilings = tierCeilings({
      bundle: absurd,
      maxTier: 1,
      policy: "greedy",
      seed: 42,
      maxCollections: 0.001,
    });
    expect(ceilings[0]!.ceiling).toBeNull();
    expect(clearsTargets(ceilings)).toBe(true);
  }, 120_000);
});

describe("the ceiling run's early exit", () => {
  // A scale is rejected the moment ONE tier tops out below its target; everything
  // simulated after that is wasted. On the full ten-tier slice, scale 0.5 was rejected
  // on tier 3 but kept simulating to the deepest target: 899 seconds to learn something
  // the first three tiers had already settled.
  it("stops at the first tier that tops out below its target", () => {
    const started = Date.now();
    const ceilings = tierCeilings({
      bundle: shallow(withTargets(slice, [2, 5, 11, 24, 52, 110, 230, 480, 1000, 2100])),
      maxTier: 10,
      policy: "greedy",
      seed: 42,
    });
    expect(clearsTargets(ceilings)).toBe(false);
    const failed = ceilings.find((c) => c.ceiling !== null && c.ceiling < c.target)!;
    expect(failed.tier).toBeLessThanOrEqual(3);
    // Every tier past the failure is unevaluated, because it was not worth evaluating.
    for (const c of ceilings.filter((c) => c.tier > failed.tier)) {
      expect(c.ceiling).toBeNull();
    }
    // The whole point: it must not have walked the remaining seven tiers to find out.
    expect(Date.now() - started).toBeLessThan(120_000);
  }, 300_000);
});

describe("smallestClearing", () => {
  // Feasibility, not a value: capPerTier only has to be big enough for every tier's
  // ceiling to clear its target, and the SMALLEST such value is the one to take --
  // bigger caps mean a player banking more of everything, which is a real cost to the
  // game's feel, not a free win.
  it("finds the smallest input that satisfies the predicate", () => {
    // Precision pinned rather than left to the default: the default is deliberately
    // loose because every probe in real use is a full ceiling measurement, and a test
    // that asserts tightly while relying on a loose default passes by luck.
    const result = smallestClearing((x) => x >= 10, { seed: 1, precision: 1e-4 });
    expect(result.value).toBeGreaterThanOrEqual(10);
    expect(result.value).toBeLessThan(10.01);
    expect(result.cleared).toBe(true);
  });

  it("spends fewer probes at the default precision than at a tight one", () => {
    const loose = smallestClearing((x) => x >= 10, { seed: 1 });
    const tight = smallestClearing((x) => x >= 10, { seed: 1, precision: 1e-6 });
    expect(loose.evaluations).toBeLessThan(tight.evaluations);
    // Still close enough that the difference is invisible in a game.
    expect(loose.value).toBeLessThan(10.5);
  });

  it("reports each probe and what it cost", () => {
    const seen: { x: number; cleared: boolean }[] = [];
    smallestClearing((x) => x >= 10, {
      seed: 1,
      onProbe: (x, cleared) => seen.push({ x, cleared }),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.some((p) => p.cleared)).toBe(true);
    expect(seen.some((p) => !p.cleared)).toBe(true);
  });

  it("returns the seed when the seed already clears", () => {
    const result = smallestClearing((x) => x >= 0.5, { seed: 1 });
    expect(result.value).toBeLessThanOrEqual(1);
    expect(result.cleared).toBe(true);
  });

  it("never goes below the floor, because a cap factor under 1 shrinks caps", () => {
    const result = smallestClearing((x) => x >= 0.001, { seed: 1, floor: 1 });
    expect(result.value).toBe(1);
  });

  it("reports failure rather than a wrong answer when nothing clears", () => {
    const result = smallestClearing(() => false, { seed: 1, maxExpansions: 4 });
    expect(result.cleared).toBe(false);
  });

  it("counts the evaluations it spent, which are simulated runs", () => {
    let calls = 0;
    const result = smallestClearing(
      (x) => {
        calls += 1;
        return x >= 10;
      },
      { seed: 1 },
    );
    expect(result.evaluations).toBe(calls);
  });
});

describe("solving the storage tier factor", () => {
  // Storage is solved FIRST because it decides what is reachable, and r_eff and the
  // amounts decide where inside the reachable range things land. A tier whose ceiling
  // is below its target has no solution at any r_eff and no solution at any amount.
  // Raised targets at maxTier 2 rather than the real ones at maxTier 4, which cost 442
  // seconds for the same assertion.
  //
  // 7 and not 12, and the difference is the whole point of the log fit: tier 2's ceiling
  // is ~6.7 at capPerTier 1, and the ceiling moves as `0.82 * ln(capFactor)`. A target of
  // 7 needs a cap factor near 2.2 -- capPerTier about 1.5. A target of 12 needs e^7.2,
  // about 1,340, and every probe on the way there simulates a game asking for
  // astronomical amounts. The first version of this test used 12 and did not finish in
  // nine minutes. Pick the demand from the response curve, not from taste.
  const demandingTargets: typeof slice = {
    ...shallow(slice),
    pacing: {
      ...slice.pacing,
      targetCollectionsToTier: [2, 7, ...slice.pacing.targetCollectionsToTier.slice(2)],
    },
  };

  // Exercised through the solve itself rather than through `calibrate`, and that is
  // about cost, measured: the search costs 23 seconds and 8 probes, while the amounts
  // fit `calibrate` runs underneath it costs about thirteen MINUTES a run at these
  // settings -- 10 simulated days of 120-second steps at `resolve`'s 108 ms a call.
  // The claim here is about the storage search; that `calibrate` wires its answer
  // through is a different claim, and "emits the solved factor into the derived block"
  // covers it.
  it("raises capPerTier until every tier's ceiling clears its target", () => {
    const clears = (value: number): boolean =>
      clearsTargets(
        tierCeilings({
          bundle: withCapPerTier(demandingTargets, value),
          maxTier: 2,
          policy: "greedy",
          seed: 42,
        }),
        1.05,
      );

    // The authored caps are measurably short of the raised target, so the search has
    // real work to do and an answer of 1 would mean it had not run.
    expect(clears(1)).toBe(false);

    const solved = smallestClearing(clears, { seed: 2, floor: 1 });
    expect(solved.cleared).toBe(true);
    expect(solved.value).toBeGreaterThan(1);
    expect(clears(solved.value)).toBe(true);
  }, 300_000);

  // The authored slice does NOT clear tier 3 at capPerTier 1 -- measured ceiling 8.93
  // against a target of 11 -- so the solve has real work to do and a result of 1 would
  // mean the search had not run.
  it("does not leave it at 1, which the slice is measurably short at", () => {
    expect(
      clearsTargets(
        tierCeilings({
          bundle: withCapPerTier(withTargets(slice, [2, 5, 11, 24]), 1),
          maxTier: 4,
          policy: "greedy",
          seed: 42,
        }),
      ),
    ).toBe(false);
  }, 300_000);

  // Asserts that the solved factor reaches the derived block, not how well anything
  // fitted, so the amounts search is capped. Before the standalone-storage fix this test
  // was fast for the wrong reason -- solveCapPerTier did nothing when solveREff was off,
  // so there was no search to pay for.
  it("emits the solved factor into the derived block", () => {
    const result = calibrate({
      bundle: slice,
      // One tier. The claim is that the solved factor reaches the derived block, which
      // a second tier does not make truer -- it only adds an amounts search whose
      // BRACKETING is the expensive part (each expansion is a full run, and capping the
      // refinement iterations does not touch it). Measured: 137s at two tiers.
      maxTier: 1,
      tolerance: 0.05,
      solveREff: false,
      maxIterationsPerTier: 2,
      refine: false,
    });
    expect(result.derived.storage!.capPerTier).toBe(result.capPerTier);
    expect(result.derived.quantumStorage!.capPerTier).toBe(result.capPerTier);
  }, 1_800_000);

  it("holds it where the bundle put it when asked not to solve", () => {
    const result = calibrate({
      bundle: slice,
      maxTier: 1,
      tolerance: 0.05,
      solveREff: false,
      solveCapPerTier: false,
    });
    expect(result.capPerTier).toBe(slice.storage.capPerTier);
  }, 300_000);
});

describe("solving r_eff and capPerTier jointly", () => {
  // The two levers MULTIPLY: capPerTier raises what a tier can ask for, r_eff slows how
  // fast it is made. Solved in sequence, capPerTier was fitted at the bundle's authored
  // r_eff -- its worst case -- and so was charged for the whole gap on its own. Measured
  // on the slice: r_eff scale 4 alone cleared tiers 1-5 and missed tier 6 by 0.9%, while
  // capPerTier alone at the authored scale needed 3.64 just to reach tier 3's target.
  //
  // So each candidate scale now gets its OWN capPerTier: the smallest that clears at
  // that scale. capPerTier bisects because it is monotone -- a bigger cap can only make
  // a tier take longer to fill -- while the scale is scanned because it is not.
  const grid = [1, 2];

  let shared: ReturnType<typeof calibrate> | undefined;
  const joint = (): ReturnType<typeof calibrate> => {
    // No refinement: its probes are fractions of the winner, and 1.6x of it is the
    // scale measured at 800+ seconds for a single tier. The plumbing under test is in
    // the coarse pass.
    shared ??= calibrate({
      bundle: slice,
      maxTier: 2,
      tolerance: 0.05,
      rEffScales: grid,
      refine: false,
    });
    return shared;
  };

  it("records a capPerTier alongside every scale it scored", () => {
    const scored = joint().rEffScan.filter((e) => Number.isFinite(e.miss));
    expect(scored.length).toBeGreaterThan(0);
    for (const entry of scored) {
      expect(entry.capPerTier).toBeDefined();
      expect(entry.capPerTier!).toBeGreaterThanOrEqual(1);
    }
  }, 1_800_000);

  it("reports the capPerTier belonging to the scale it chose", () => {
    const result = joint();
    const chosen = result.rEffScan.find((e) => e.scale === result.rEffScale);
    expect(chosen).toBeDefined();
    expect(result.capPerTier).toBe(chosen!.capPerTier);
  }, 1_800_000);

  it("emits that same pair into the derived block", () => {
    const result = joint();
    expect(result.derived.storage!.capPerTier).toBe(result.capPerTier);
    expect(result.derived.quantumStorage!.capPerTier).toBe(result.capPerTier);
  }, 1_800_000);

  // The tests above run at maxTier 2, where both tiers clear unaided and the solve
  // correctly returns capPerTier 1 -- so they check the plumbing and nothing else. This
  // one raises tier 2's target above its ceiling (measured ~6.7 at cap 1) so a real cap
  // is required, which is the condition the joint solve exists for. Synthesising the
  // condition is far cheaper than reaching it honestly at tier 4.
  // 7, not 12. Tier 2's ceiling is ~6.7 at capPerTier 1 and the ceiling moves as
  // `0.82 * ln(capFactor)`, so 7 asks for a cap factor near 2.2 while 12 asks for e^7.2
  // -- about 1,340 -- and every probe on the way there simulates a game demanding
  // astronomical amounts. This describe kept 12 after the other one was corrected.
  const demanding: typeof slice = {
    ...shallow(slice),
    pacing: { ...slice.pacing, targetCollectionsToTier: [2, 7, ...slice.pacing.targetCollectionsToTier.slice(2)] },
  };

  // These were skipped while `resolve` cost 108 ms a call: both need a configuration
  // where a real capPerTier is required, and fifteen minutes produced no result. With
  // the cancellation crumb snapped at source (FLOW_CANCELLATION_TOLERANCE) resolve runs
  // at 1.37 ms a call and they are affordable again, which is what they were kept for.
  it("solves a capPerTier above 1 when the targets demand it", () => {
    const result = calibrate({
      bundle: demanding,
      maxTier: 2,
      tolerance: 0.05,
      rEffScales: [1],
      maxIterationsPerTier: 2,
    });
    expect(result.capPerTier).toBeGreaterThan(1);
  }, 1_800_000);

  // The claim the joint solve is FOR: a scale that stretches the game further needs
  // less help from storage. If both scales came back with the same cap, pairing them
  // would be machinery for nothing.
  it("asks less of storage at a scale that stretches the game further", () => {
    const result = calibrate({
      bundle: demanding,
      maxTier: 2,
      tolerance: 0.05,
      // [1, 2] rather than [1, 4]: scale 4 is where `resolve` becomes pathologically
      // slow (measured 108 ms a call, 99% of the wall clock), and the claim under test
      // does not need the extreme.
      rEffScales: [1, 2],
      maxIterationsPerTier: 2,
    });
    const caps = new Map(
      result.rEffScan
        .filter((e) => e.capPerTier !== undefined)
        .map((e) => [e.scale, e.capPerTier!]),
    );
    expect(caps.get(1)).toBeDefined();
    expect(caps.get(2)).toBeDefined();
    expect(caps.get(2)!).toBeLessThan(caps.get(1)!);
  }, 1_800_000);

  it("holds capPerTier at the authored value when asked not to solve it", () => {
    const result = calibrate({
      bundle: slice,
      maxTier: 1,
      tolerance: 0.05,
      solveCapPerTier: false,
      rEffScales: [1],
      refine: false,
    });
    expect(result.capPerTier).toBe(slice.storage.capPerTier);
  }, 900_000);
});

describe("a tier already unlocked at the resume point", () => {
  // One `resolve` can unlock several tiers at once, and `runSimulation` pushes a
  // checkpoint per tier that all share the same state -- so "tier k's checkpoint" can
  // already have `state.tier` past k. Resuming from it to time tier k+1, the loop
  // condition `state.tier < untilTier` is false immediately, nothing is recorded, and
  // the tier reads as unreachable whatever its requirement is.
  //
  // Measured on the slice: every one of tier 10's 34 search steps returned "never" in
  // 0s -- including the first, whose 4,000 smart plating was already covered by
  // 1,570,313 in stock -- while the run itself reported `reachedTier` 10 with 54
  // collections of budget unspent. A direct replay reaches tier 10 at 12.99 collections.
  //
  // Its true landing time is the checkpoint's: the two tiers unlocked at the same
  // instant.
  const twoAtOnce: typeof fixture = {
    ...fixture,
    milestones: fixture.milestones.map((m) =>
      m.tier === 3 ? { ...m, requires: m.requires.map((r) => ({ ...r, amount: 1 })) } : m,
    ),
  };

  it("reports the tier as reached, not as never", () => {
    const result = calibrate({
      bundle: twoAtOnce,
      maxTier: 3,
      tolerance: 0.05,
      solveREff: false,
      solveCapPerTier: false,
      maxIterationsPerTier: 2,
      overrunBudget: 1,
      refine: false,
    });
    const tier3 = result.tiers.find((t) => t.tier === 3);
    expect(tier3).toBeDefined();
    expect(tier3!.observed).not.toBeNull();
  }, 300_000);

  it("does not spend its whole iteration budget re-running identical amounts", () => {
    const lines: string[] = [];
    calibrate({
      bundle: twoAtOnce,
      maxTier: 3,
      tolerance: 0.05,
      solveREff: false,
      solveCapPerTier: false,
      overrunBudget: 1,
      refine: false,
      onProgress: (line) => lines.push(line),
    });
    // Every requirement bottoms out at 1, so once the search reaches the floor further
    // halving changes nothing and each extra step is a simulated run of the same input.
    const steps = lines.filter((l) => /tier +3 try/.test(l));
    const atFloor = steps.filter((l) => /iron_plate 1\b/.test(l));
    expect(atFloor.length).toBeLessThanOrEqual(2);
  }, 300_000);
});
