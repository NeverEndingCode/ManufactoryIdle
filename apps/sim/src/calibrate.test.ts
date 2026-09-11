import { fileURLToPath } from "node:url";
import { applyDerived, loadBundleDir } from "@manufactory/content";
import { describe, expect, it } from "vitest";
import { SLICE_BUNDLE_DIR } from "./bootstrap.js";
import { indexContent } from "@manufactory/engine";
import { bisectMonotone, calibrate, deriveCostRatios, withMilestoneAmounts } from "./calibrate.js";
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
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05 });
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
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05 });
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
    calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05, onProgress: (l) => lines.push(l) });
    const steps = lines.filter((l) => l.includes("try"));
    expect(steps.length).toBeGreaterThan(1);
    // Each step says what it tried and what came back, so a stalled search is
    // distinguishable from a slow one.
    expect(steps[0]).toMatch(/try/);
    expect(steps.some((l) => /never|\d/.test(l))).toBe(true);
  }, 300_000);

  it("records the targets and the observations side by side", () => {
    const result = calibrate({ bundle: slice, maxTier: 1, tolerance: 0.05 });
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
      onProgress: (line) => seen.push(line),
    });
    const overCap = seen.filter((l) => l.includes("above the maximum"));
    expect(overCap.length).toBeGreaterThan(0);
    // And it costs no measurable time, which is the entire point.
    for (const line of overCap) expect(line).toMatch(/ 0s /);
  }, 300_000);
});
