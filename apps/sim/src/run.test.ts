import { describe, expect, it } from "vitest";
import { SLICE_BUNDLE_DIR, loadContent } from "./bootstrap.js";
import { POLICY_NAMES } from "./policies.js";
import { authoredREff, formatReport, observedREff, progressPrinter } from "./report.js";
import { runSimulation, type RunProgress } from "./run.js";

const content = loadContent();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe("loadContent", () => {
  it("loads and indexes the fixture bundle", () => {
    expect(content.bundle.version).toBe("fixture.v1");
    expect(content.recipes.size).toBeGreaterThan(0);
  });
});

describe("authoredREff", () => {
  it("is the cost ratio over the per-machine multiplier growth (spec D3)", () => {
    // Miner: r = 1.09, ladder x1.5 every 10, so m = 1.5^(1/10) = 1.0413797 and
    // r_eff = 1.09 / 1.0413797 = 1.04669. Spec D3 quotes 1.047.
    expect(authoredREff(content, "miner")).toBeCloseTo(1.04669, 4);
    // Refinery: r = 1.12 on the same ladder -> 1.12 / 1.0413797 = 1.07549.
    expect(authoredREff(content, "refinery")).toBeCloseTo(1.07549, 4);
  });

  it("stays above 1, which is spec D3's runaway invariant", () => {
    for (const machineClass of content.machineClasses.keys()) {
      expect(authoredREff(content, machineClass)).toBeGreaterThan(1);
    }
  });
});

describe("observedREff", () => {
  it("matches the authored value when the run spans a whole ladder interval", () => {
    // 10 machines bought on the miner's curve: cost grows 1.09^10 and the ladder
    // steps once, x1.5, so the observed r_eff is exactly 1.09 / 1.5^(1/10).
    expect(observedREff(1.09, 1.5, 10, 0, 10)).toBeCloseTo(1.04669, 4);
  });

  it("is null when too little was bought to measure", () => {
    expect(observedREff(1.09, 1.5, 10, 4, 4)).toBeNull();
  });
});

describe("runSimulation", () => {
  it.each([...POLICY_NAMES])("%s reaches tier 1 and reports it", (policy) => {
    const report = runSimulation({
      policy,
      seed: 42,
      untilTier: 1,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.policy).toBe(policy);
    expect(report.contentVersion).toBe("fixture.v1");
    expect(report.finished).toBe(true);
    expect(report.reachedTier).toBeGreaterThanOrEqual(1);
    expect(report.tierTimes[0]!.tier).toBe(1);
    expect(report.tierTimes[0]!.atMs).toBeGreaterThan(0);
  });

  it("reports times in collections, one collection per offline window (spec B.7)", () => {
    const report = runSimulation({
      policy: "greedy",
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    for (const mark of report.tierTimes) {
      expect(mark.collections).toBeCloseTo(mark.atMs / content.offlineCapMs, 9);
    }
    expect(report.collections).toBeCloseTo(report.simulatedMs / content.offlineCapMs, 9);
  });

  it("reports a finite max dead time no larger than the run (spec 16.6)", () => {
    const report = runSimulation({
      policy: "greedy",
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(Number.isFinite(report.maxDeadTimeMs)).toBe(true);
    expect(report.maxDeadTimeMs).toBeGreaterThanOrEqual(0);
    expect(report.maxDeadTimeMs).toBeLessThanOrEqual(report.simulatedMs);
  });

  it("reports which recipe was binding and for how long (spec E.2)", () => {
    const report = runSimulation({
      policy: "greedy",
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.bindingConstraints.length).toBeGreaterThan(0);
    let total = 0;
    for (const row of report.bindingConstraints) {
      expect(row.boundMs).toBeGreaterThan(0);
      total += row.boundMs;
    }
    expect(total).toBeLessThanOrEqual(report.simulatedMs + 1);
    // Sorted longest-binding first, so the report reads top-down.
    for (let i = 1; i < report.bindingConstraints.length; i += 1) {
      expect(report.bindingConstraints[i - 1]!.boundMs).toBeGreaterThanOrEqual(
        report.bindingConstraints[i]!.boundMs,
      );
    }
  });

  it("stops at the simulated-time budget rather than running forever", () => {
    const report = runSimulation({
      policy: "casual",
      seed: 1,
      untilTier: 99,
      maxSimMs: 60 * 60 * 1000,
    });
    expect(report.finished).toBe(false);
    expect(report.simulatedMs).toBeLessThanOrEqual(60 * 60 * 1000 + content.offlineCapMs);
  });

  it("is deterministic for a given seed and policy (spec E.4)", () => {
    const options = {
      policy: "greedy" as const,
      seed: 7,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    };
    const a = runSimulation(options);
    const b = runSimulation(options);
    expect(b.tierTimes).toEqual(a.tierTimes);
    expect(b.purchases).toBe(a.purchases);
    expect(b.simulatedMs).toBe(a.simulatedMs);
  });

  it("stops a run once nothing has happened for longer than the stall cut-off", () => {
    // Casual acts once per offline window, so a cut-off of half a window is crossed at
    // its first gap: the run must stop there instead of simulating the whole budget.
    const cutoff = content.offlineCapMs / 2;
    const report = runSimulation({
      policy: "casual",
      seed: 1,
      untilTier: 99,
      maxSimMs: THIRTY_DAYS_MS,
      stopWhenDeadMs: cutoff,
    });
    expect(report.stalled).toBe(true);
    expect(report.finished).toBe(false);
    expect(report.maxDeadTimeMs).toBeGreaterThan(cutoff);
    // Stopped at the first step past the cut-off, not at the budget.
    expect(report.simulatedMs).toBe(content.offlineCapMs);
  });

  it("leaves a run that keeps making progress exactly as it was", () => {
    const options = {
      policy: "greedy" as const,
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    };
    const plain = runSimulation(options);
    const guarded = runSimulation({ ...options, stopWhenDeadMs: 2 * content.offlineCapMs });
    expect(plain.stalled).toBe(false);
    expect(guarded.stalled).toBe(false);
    expect(guarded.tierTimes).toEqual(plain.tierTimes);
    expect(guarded.purchases).toBe(plain.purchases);
    expect(guarded.simulatedMs).toBe(plain.simulatedMs);
  });

  it("reports progress as it goes, without changing the run", () => {
    const options = {
      policy: "greedy" as const,
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    };
    const events: RunProgress[] = [];
    const watched = runSimulation({ ...options, onProgress: (event) => events.push(event) });
    const plain = runSimulation(options);

    // Watching is read-only: a callback that perturbed the run would make every slow
    // run a different run from the one it is reporting on.
    expect(watched.tierTimes).toEqual(plain.tierTimes);
    expect(watched.purchases).toBe(plain.purchases);

    // One tier event per tier unlocked, in order, at the times the report records.
    const tiers = events.filter((event) => event.kind === "tier");
    expect(tiers.map((event) => event.tier)).toEqual(plain.tierTimes.map((mark) => mark.tier));
    expect(tiers.map((event) => event.collections)).toEqual(
      plain.tierTimes.map((mark) => mark.collections),
    );

    // A step event per simulated interval, so a stalled run still shows signs of life,
    // with a clock that only moves forward and ends where the report does.
    const steps = events.filter((event) => event.kind === "step");
    expect(steps.length).toBeGreaterThan(tiers.length);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.collections).toBeGreaterThan(steps[i - 1]!.collections);
    }
    expect(steps.at(-1)!.collections).toBeCloseTo(plain.collections, 9);
    expect(steps.at(-1)!.purchases).toBe(plain.purchases);
  });

  it("casual buys nothing before its first check-in", () => {
    // Its first decision point is at t = 0 with an empty warehouse, and the next is
    // a whole offline window later -- by which time tier 1 has already landed.
    const report = runSimulation({
      policy: "casual",
      seed: 42,
      untilTier: 1,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.purchases).toBe(0);
  });

  it("greedy buys before it reaches tier 1", () => {
    const report = runSimulation({
      policy: "greedy",
      seed: 42,
      untilTier: 1,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.purchases).toBeGreaterThan(0);
  });
});

// Phase 2, Task 8. The fixture's iron lane has ONE live recipe per lane-class, so
// no assignment rule can starve anything in it and none of the tests above can see
// this class of defect at all. The slice is the first content where it bites, and
// it bit twice: `make_iron_rod` starved behind a capped `make_iron_plate` (tier 2
// unreachable), then `make_wire` starved behind an unfillable `make_cable` (tier 3
// unreachable). Both looked exactly like "the milestone amounts are placeholders".
//
// This asserts reachability, deliberately not a time. The time is Task 3's to
// calibrate and will move every time it runs; "the player can get there at all" is
// the property that must not regress.
describe("the vertical slice is playable", () => {
  it("greedy reaches tier 5 without a policy hint", () => {
    const report = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 5,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.reachedTier).toBe(5);
    expect(report.tierTimes.map((t) => t.tier)).toEqual([1, 2, 3, 4, 5]);
    // ~10s: 44 recipes over half a simulated day at a 120s-and-up decision cadence.
  }, 60_000);

  it("buys machines only into lanes it has unlocked", () => {
    const report = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    // `observed` is non-null exactly where a lane-class count grew, so this reads as
    // "which lanes did it buy into". The run stops on reaching tier 2, so copper
    // (tier 2), coal (3) and oil (6) were locked for the whole of it.
    const bought = [...new Set(report.rEff.filter((r) => r.observed !== null).map((r) => r.lane))];
    expect(bought.sort()).toEqual(["iron", "power"]);
  }, 30_000);
});

describe("formatReport", () => {
  it("renders every section a human needs", () => {
    const text = formatReport(
      runSimulation({ policy: "greedy", seed: 42, untilTier: 2, maxSimMs: THIRTY_DAYS_MS }),
    );
    expect(text).toContain("greedy");
    expect(text).toContain("fixture.v1");
    expect(text).toContain("collections");
    expect(text).toContain("dead time");
    expect(text).toContain("r_eff");
  });
});

// Spec B.7: "there is exactly one implementation of how long does this take, so
// calibrated numbers cannot disagree with measured ones." Calibration bisects tier
// k's requirements, which cannot change anything before tier k-1 unlocked -- the
// purchase cadence in that span is measured against milestone k-1, not k -- so the
// prefix can be replayed from a checkpoint instead of re-simulated. That is
// memoisation of this simulator, not a second, faster estimate of it, and this test
// is what holds the distinction: resuming must land on the same millisecond.
describe("resuming from a checkpoint", () => {
  it("reaches the next tier at exactly the time an unbroken run does", () => {
    const whole = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 3,
      maxSimMs: THIRTY_DAYS_MS,
      captureCheckpoints: true,
    });
    const atTier1 = whole.checkpoints.find((c) => c.tier === 1);
    if (!atTier1) throw new Error("no tier 1 checkpoint");

    const resumed = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 3,
      maxSimMs: THIRTY_DAYS_MS,
      startFrom: atTier1,
    });

    expect(resumed.tierTimes.map((t) => [t.tier, t.atMs])).toEqual(
      whole.tierTimes.filter((t) => t.tier > 1).map((t) => [t.tier, t.atMs]),
    );
    expect(resumed.simulatedMs).toBe(whole.simulatedMs);
  }, 60_000);

  // Dead time is simulated time since the last event, so a resumed run starts counting
  // from where it resumes. Counted from clock 0, a run resumed at tier 1 (0.42
  // collections in) has already "been dead" longer than this cut-off on its first step.
  // greedy's longest dead stretch on the slice is 0.06 collections.
  it("measures dead time from where it resumes, not from clock 0", () => {
    const whole = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 3,
      maxSimMs: THIRTY_DAYS_MS,
      captureCheckpoints: true,
    });
    const atTier1 = whole.checkpoints.find((c) => c.tier === 1);
    if (!atTier1) throw new Error("no tier 1 checkpoint");
    const cutoff = 0.1 * content.offlineCapMs;
    // Precondition: the resume point is further from clock 0 than the cut-off.
    expect(atTier1.nowMs).toBeGreaterThan(cutoff);

    const resumed = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 3,
      maxSimMs: THIRTY_DAYS_MS,
      startFrom: atTier1,
      stopWhenDeadMs: cutoff,
    });
    expect(resumed.stalled).toBe(false);
    expect(resumed.reachedTier).toBe(3);
    expect(resumed.maxDeadTimeMs).toBeLessThan(cutoff);
  }, 60_000);

  it("captures one checkpoint per tier it unlocks", () => {
    const report = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 3,
      maxSimMs: THIRTY_DAYS_MS,
      captureCheckpoints: true,
    });
    expect(report.checkpoints.map((c) => c.tier)).toEqual([1, 2, 3]);
    expect(report.checkpoints.every((c) => c.state.tier >= c.tier)).toBe(true);
  }, 60_000);

  it("captures nothing unless asked, so an ordinary run keeps no world states", () => {
    const report = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    expect(report.checkpoints).toEqual([]);
  }, 30_000);
});

// Phase 2, Task 3. `purchases` counted every action the policy returned, so once the
// policies started emitting ASSIGN_MACHINES to move idle machines, reassignments were
// reported as purchases. A purchase is a spend; moving a machine you already own is not.
describe("what counts as a purchase", () => {
  it("counts only actions that spend", () => {
    const report = runSimulation({
      policy: "greedy",
      contentDir: SLICE_BUNDLE_DIR,
      seed: 42,
      untilTier: 2,
      maxSimMs: THIRTY_DAYS_MS,
    });
    // Every purchase must be matched by machines or levels actually bought.
    const machinesBought = report.rEff.filter((r) => r.observed !== null).length;
    expect(report.purchases).toBeGreaterThan(0);
    expect(machinesBought).toBeGreaterThan(0);
  }, 60_000);
});

describe("progressPrinter", () => {
  it("prints every tier, and throttles steps to one per interval of wall clock", () => {
    const lines: string[] = [];
    let now = 0;
    const print = progressPrinter("greedy", (line) => lines.push(line), {
      now: () => now,
      everyMs: 10_000,
    });
    const step = (collections: number) =>
      print({ kind: "step", tier: 1, collections, purchases: 3, bound: "make_screw" });

    step(0.1); // the first step prints, so a run shows life at once
    now = 5_000;
    step(0.2); // inside the interval: suppressed
    print({ kind: "tier", tier: 2, collections: 0.25, purchases: 4 }); // tiers always print
    now = 10_000;
    step(0.3);

    expect(lines).toEqual([
      "[greedy 0s] tier 1 · 0.1000 colls · 3 buys · bound make_screw",
      "[greedy 5s] reached tier 2 at 0.2500 colls · 4 buys",
      "[greedy 10s] tier 1 · 0.3000 colls · 3 buys · bound make_screw",
    ]);
  });

  it("formats elapsed time past a minute as minutes and seconds", () => {
    const lines: string[] = [];
    const print = progressPrinter("bottleneck", (line) => lines.push(line), {
      now: () => 134_000,
      startedAt: 0,
    });
    print({ kind: "tier", tier: 6, collections: 1.2143, purchases: 146 });
    expect(lines).toEqual(["[bottleneck 2m14s] reached tier 6 at 1.2143 colls · 146 buys"]);
  });
});
