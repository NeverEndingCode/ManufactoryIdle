import { describe, expect, it } from "vitest";
import { RUNAWAY_EPSILON, loadBundleDir } from "@manufactory/content";
import { SLICE_BUNDLE_DIR } from "./bootstrap.js";
import { VERTICAL_SLICE_GATE } from "./gate-cli.js";
import type { RunReport } from "./report.js";
import {
  DEFAULT_THRESHOLDS,
  compareRuns,
  evaluateGate,
  type PolicyGate,
} from "./gate.js";

const TARGETS = [0.42, 0.8, 1.2];

/** A report that passes every check, so each test can break exactly one thing. */
function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    policy: "greedy",
    contentVersion: "slice.v1",
    seed: 42,
    reachedTier: 3,
    finished: true,
    simulatedMs: 1.2 * 8 * 3600_000,
    collections: 1.2,
    tierTimes: [
      { tier: 1, atMs: 0.42 * 8 * 3600_000, collections: 0.42 },
      { tier: 2, atMs: 0.8 * 8 * 3600_000, collections: 0.8 },
      { tier: 3, atMs: 1.2 * 8 * 3600_000, collections: 1.2 },
    ],
    maxDeadTimeMs: 0.5 * 8 * 3600_000,
    purchases: 100,
    bindingConstraints: [{ recipeId: "make_iron_plate", boundMs: 1000 }],
    rEff: [{ lane: "iron", machineClass: "miner", authored: 1.0467, observed: 1.0233 }],
    checkpoints: [],
    ...overrides,
  };
}

const onTarget: PolicyGate = { policy: "greedy", untilTier: 3, knownRed: [] };

const run = (gates: PolicyGate[], reports: RunReport[]) =>
  evaluateGate({ targets: TARGETS, gates, reports, thresholds: DEFAULT_THRESHOLDS, offlineCapMs: 8 * 3600_000 });

describe("evaluateGate", () => {
  it("passes a run that hits every target", () => {
    expect(run([onTarget], [report()])).toEqual([]);
  });

  it("fails a tier outside the tolerance band", () => {
    // 0.9 against a 0.8 target is +12.5%, well past 5%.
    const drifted = report({
      tierTimes: [
        { tier: 1, atMs: 0, collections: 0.42 },
        { tier: 2, atMs: 0, collections: 0.9 },
        { tier: 3, atMs: 0, collections: 1.2 },
      ],
    });
    const findings = run([onTarget], [drifted]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.check).toBe("tier-time");
    expect(findings[0]!.detail).toContain("tier 2");
  });

  // Just inside, not exactly on it: `0.8 * 1.05` is 0.8400000000000001 in float and
  // genuinely outside `0.8 + 0.8 * 0.05`, so "exactly at the edge" is not a
  // well-defined input to assert. The rule deliberately mirrors the calibrator's own
  // `|y - target| <= tolerance * target`, so a tier the calibrator called converged is
  // never failed here.
  it("accepts a tier just inside the band", () => {
    const edge = report({
      tierTimes: [
        { tier: 1, atMs: 0, collections: 0.42 },
        { tier: 2, atMs: 0, collections: 0.8 * 1.049 },
        { tier: 3, atMs: 0, collections: 1.2 },
      ],
    });
    expect(run([onTarget], [edge])).toEqual([]);
  });

  it("fails when the policy never reached the tier it was asked for", () => {
    const short = report({ reachedTier: 2, finished: false, tierTimes: report().tierTimes.slice(0, 2) });
    const findings = run([onTarget], [short]);
    expect(findings.some((f) => f.check === "reached-tier")).toBe(true);
  });

  it("fails on dead time over the threshold", () => {
    const stale = report({ maxDeadTimeMs: 2.5 * 8 * 3600_000 });
    const findings = run([onTarget], [stale]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.check).toBe("dead-time");
  });

  // `casual` acts once per offline window, so its dead time is exactly one collection
  // by construction. The threshold has to clear that or the gate is decided by a float.
  it("accepts the one-collection dead time a once-per-window policy always has", () => {
    expect(run([onTarget], [report({ maxDeadTimeMs: 8 * 3600_000 })])).toEqual([]);
  });

  it("pins dead time for a policy already known to be dead, and catches drift on it", () => {
    const gate: PolicyGate = {
      policy: "bottleneck",
      untilTier: 3,
      knownRed: [],
      reachesTier: 1,
      deadTimePin: { collections: 100, why: "stalls with no assembler; see the handoff" },
    };
    const stalled = (deadCollections: number): RunReport =>
      report({
        policy: "bottleneck",
        reachedTier: 1,
        finished: false,
        tierTimes: [{ tier: 1, atMs: 0, collections: 0.42 }],
        maxDeadTimeMs: deadCollections * 8 * 3600_000,
      });
    expect(run([gate], [stalled(100)])).toEqual([]);
    expect(run([gate], [stalled(140)]).some((f) => f.check === "known-red-drift")).toBe(true);
    // Back under the threshold: the policy is fixed and the pin must go.
    expect(run([gate], [stalled(0.5)]).some((f) => f.check === "stale-pin")).toBe(true);
  });

  it("fails an observed r_eff at or below the runaway floor", () => {
    const runaway = report({
      rEff: [{ lane: "iron", machineClass: "miner", authored: 1.0467, observed: 1 + RUNAWAY_EPSILON }],
    });
    const findings = run([onTarget], [runaway]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.check).toBe("r-eff");
  });

  it("ignores an r_eff that could not be measured", () => {
    const unmeasured = report({
      rEff: [{ lane: "iron", machineClass: "miner", authored: 1.0467, observed: null }],
    });
    expect(run([onTarget], [unmeasured])).toEqual([]);
  });
});

describe("known-red tiers", () => {
  // A pinned tier is NOT excused. It is asserted against the number the game really
  // produces, so the gate still catches drift -- and the entry has to be deleted by
  // hand once the tier is fixed, which is what stops a red tier going quiet.
  const pinned: PolicyGate = {
    policy: "greedy",
    untilTier: 3,
    knownRed: [{ tier: 3, observed: 2.5, why: "unreachable target; see the handoff" }],
  };
  const atPin = report({
    tierTimes: [
      { tier: 1, atMs: 0, collections: 0.42 },
      { tier: 2, atMs: 0, collections: 0.8 },
      { tier: 3, atMs: 0, collections: 2.5 },
    ],
  });

  it("passes a pinned tier sitting where it was pinned, though it misses its target", () => {
    expect(run([pinned], [atPin])).toEqual([]);
    // ... and the same run fails when that tier is NOT pinned.
    expect(run([onTarget], [atPin]).some((f) => f.check === "tier-time")).toBe(true);
  });

  it("still fails a pinned tier that drifts off its pin", () => {
    const drifted = report({
      tierTimes: [
        { tier: 1, atMs: 0, collections: 0.42 },
        { tier: 2, atMs: 0, collections: 0.8 },
        { tier: 3, atMs: 0, collections: 3.2 },
      ],
    });
    const findings = run([pinned], [drifted]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.check).toBe("known-red-drift");
  });

  it("fails a pin that has become stale because the tier now hits its target", () => {
    // Pinned at 2.5 but measuring 1.2, which IS the target: the pin is obsolete and
    // saying so is the only thing that gets it deleted.
    const fixed = report();
    const findings = run([pinned], [fixed]);
    expect(findings.some((f) => f.check === "stale-pin")).toBe(true);
  });

  it("lets a policy declare it cannot reach the tier at all, and fails if it suddenly can", () => {
    const stalls: PolicyGate = { policy: "bottleneck", untilTier: 3, knownRed: [], reachesTier: 1 };
    const stalled = report({ policy: "bottleneck", reachedTier: 1, finished: false, tierTimes: [report().tierTimes[0]!] });
    expect(run([stalls], [stalled])).toEqual([]);
    const better = report({ policy: "bottleneck", reachedTier: 2, finished: false, tierTimes: report().tierTimes.slice(0, 2) });
    expect(run([stalls], [better]).some((f) => f.check === "stale-pin")).toBe(true);
  });
});

describe("compareRuns", () => {
  // Spec E.4: exact equality for discrete state, 1e-12 relative for magnitudes.
  it("accepts two identical runs", () => {
    expect(compareRuns(report(), report())).toEqual([]);
  });

  it("rejects a discrete difference", () => {
    expect(compareRuns(report(), report({ purchases: 101 }))).not.toEqual([]);
    expect(compareRuns(report(), report({ reachedTier: 2 }))).not.toEqual([]);
  });

  it("tolerates a magnitude difference inside 1e-12 relative", () => {
    const nudged = report({
      tierTimes: [
        { tier: 1, atMs: 0, collections: 0.42 * (1 + 1e-13) },
        { tier: 2, atMs: 0, collections: 0.8 },
        { tier: 3, atMs: 0, collections: 1.2 },
      ],
    });
    expect(compareRuns(report(), nudged)).toEqual([]);
  });

  it("rejects a magnitude difference outside it", () => {
    const nudged = report({
      tierTimes: [
        { tier: 1, atMs: 0, collections: 0.42 * (1 + 1e-9) },
        { tier: 2, atMs: 0, collections: 0.8 },
        { tier: 3, atMs: 0, collections: 1.2 },
      ],
    });
    expect(compareRuns(report(), nudged)).not.toEqual([]);
  });

  it("rejects a binding-constraint ordering change, which is event ordering", () => {
    const reordered = report({
      bindingConstraints: [{ recipeId: "smelt_iron_ingot", boundMs: 1000 }],
    });
    expect(compareRuns(report(), reordered)).not.toEqual([]);
  });
});

describe("the shipped vertical-slice gate config", () => {
  const bundle = loadBundleDir(SLICE_BUNDLE_DIR);
  const targets = bundle.pacing.targetCollectionsToTier;

  // A pin on a tier that already hits its target is a pin on nothing: it would fire
  // `stale-pin` on the very first run. Catching that here costs no simulation, where
  // catching it in CI costs fifteen minutes.
  it("pins only tiers that genuinely miss their target", () => {
    const unjustified: string[] = [];
    for (const gate of VERTICAL_SLICE_GATE) {
      for (const pin of gate.knownRed) {
        const target = targets[pin.tier - 1];
        if (target === undefined) continue;
        if (Math.abs(pin.observed - target) <= DEFAULT_THRESHOLDS.tierTolerance * target) {
          unjustified.push(`${gate.policy} tier ${pin.tier}: pinned ${pin.observed} is inside the band around ${target}`);
        }
      }
    }
    expect(unjustified).toEqual([]);
  });

  it("gives every pin a reason", () => {
    for (const gate of VERTICAL_SLICE_GATE) {
      for (const pin of gate.knownRed) expect(pin.why.length).toBeGreaterThan(20);
      if (gate.deadTimePin) expect(gate.deadTimePin.why.length).toBeGreaterThan(20);
    }
  });

  it("covers all three of spec E.5's policies", () => {
    expect(VERTICAL_SLICE_GATE.map((g) => g.policy).sort()).toEqual([
      "bottleneck",
      "casual",
      "greedy",
    ]);
  });
});
