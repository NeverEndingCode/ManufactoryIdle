import { describe, expect, it } from "vitest";
import { loadContent } from "./bootstrap.js";
import { POLICY_NAMES } from "./policies.js";
import { authoredREff, formatReport, observedREff } from "./report.js";
import { runSimulation } from "./run.js";

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
