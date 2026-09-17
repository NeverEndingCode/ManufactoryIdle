// Spec E.5's CI pacing gates: the simulator's own report, turned into pass/fail.
//
// Everything here is a pure function over `RunReport`s. The runs are expensive and the
// judgement is not, so separating them means the rules can be tested in milliseconds
// instead of behind a ten-minute run -- which is what `gate.test.ts` does. `gate-cli.ts`
// is the only place that actually simulates.
//
// Spec E.5 asks for five things: `content:check`, three policies within tolerance of
// `pacing.targetCollectionsToTier`, dead time under a threshold, `r_eff > 1 + eps`, and
// replay determinism. `content:check` is already its own CI step and is not duplicated
// here. The other four are below.
//
// **Assert absolute tier times, never a policy ordering.** `greedy` can honestly finish
// after `casual`: it spends plate on miners that do not raise plate output. A gate that
// encoded "greedy must beat casual" would be asserting a thing the game does not
// promise.
import { RUNAWAY_EPSILON } from "@manufactory/content";
import type { RunReport } from "./report.js";
import type { PolicyName } from "./policies.js";

export interface GateThresholds {
  /** Relative band around a `pacing.targetCollectionsToTier` entry. */
  tierTolerance: number;
  /**
   * Relative band around a KNOWN-RED pin. Tighter than `tierTolerance`, because a pin
   * is a measurement of what the game does today rather than a design target, and the
   * only thing it is there to catch is drift.
   */
  driftTolerance: number;
  /**
   * Spec 16.6's pace-decay detector, in collections.
   *
   * TWO windows, not one, and the reason is `casual`: its check-in interval IS the
   * offline cap, so it acts exactly once per window and its dead time is exactly
   * 1.0000 collections by construction. That is the policy's own cadence, not pace
   * decay, and a threshold of 1 would sit precisely on it -- a gate decided by the
   * last bit of a float. At 2, the meaning is the one §16.6 actually names: a player
   * checked in twice and nothing had happened. Measured today: greedy 0.061, casual
   * 1.000, bottleneck 102.9 (which is a real failure, and is pinned as one).
   */
  maxDeadTimeCollections: number;
  /** Spec D3's runaway floor, shared with check 8 so the two cannot drift apart. */
  runawayEpsilon: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  tierTolerance: 0.05,
  driftTolerance: 0.02,
  maxDeadTimeCollections: 2,
  runawayEpsilon: RUNAWAY_EPSILON,
};

/**
 * A tier that cannot meet its target today, pinned to the number the game really
 * produces.
 *
 * A pin is NOT an exemption. The tier is still asserted -- against its measured value
 * rather than its target -- so drift is still caught, and `stale-pin` fires the moment
 * the tier starts hitting its target, which is what forces the entry to be deleted
 * rather than quietly outliving the problem. `why` is mandatory for the same reason.
 */
export interface KnownRedTier {
  tier: number;
  observed: number;
  why: string;
}

export interface PolicyGate {
  policy: PolicyName;
  untilTier: number;
  knownRed: KnownRedTier[];
  /**
   * Set when the policy cannot reach `untilTier` at all today. The gate then requires
   * it to reach EXACTLY this tier: getting further is a `stale-pin`, not a pass, so an
   * accidental improvement is reported rather than absorbed.
   */
  reachesTier?: number;
  /**
   * Dead time pinned to what this policy really produces, for a policy already known to
   * be broken. Same contract as `knownRed`: still asserted, drift still caught, and it
   * goes stale loudly once the policy comes back under the threshold.
   */
  deadTimePin?: { collections: number; why: string };
}

export interface GateInput {
  /** `pacing.targetCollectionsToTier`, index 0 being tier 1. */
  targets: readonly number[];
  gates: readonly PolicyGate[];
  reports: readonly RunReport[];
  thresholds: GateThresholds;
  /**
   * `content.offlineCapMs`. Passed rather than divided out of the report: dead time is
   * authored in collections and a run that recorded none would make that division 0/0.
   */
  offlineCapMs: number;
}

export interface Finding {
  policy: PolicyName;
  check: "reached-tier" | "tier-time" | "known-red-drift" | "stale-pin" | "dead-time" | "r-eff" | "determinism";
  detail: string;
}

function pct(value: number, of: number): string {
  return `${(((value - of) / of) * 100).toFixed(1)}%`;
}

export function evaluateGate(input: GateInput): Finding[] {
  const findings: Finding[] = [];
  const { thresholds: t } = input;

  for (const gate of input.gates) {
    const report = input.reports.find((r) => r.policy === gate.policy);
    if (report === undefined) {
      findings.push({ policy: gate.policy, check: "reached-tier", detail: "no run report" });
      continue;
    }

    const add = (check: Finding["check"], detail: string): void => {
      findings.push({ policy: gate.policy, check, detail });
    };

    // 1. Did it get there at all?
    if (gate.reachesTier !== undefined) {
      if (report.reachedTier > gate.reachesTier) {
        add(
          "stale-pin",
          `pinned as reaching only tier ${gate.reachesTier} but reached ${report.reachedTier}; ` +
            `the policy has improved -- re-measure and update or remove the pin`,
        );
      } else if (report.reachedTier < gate.reachesTier) {
        add("reached-tier", `reached tier ${report.reachedTier}, pinned at ${gate.reachesTier}`);
      }
    } else if (report.reachedTier < gate.untilTier) {
      add("reached-tier", `reached tier ${report.reachedTier} of ${gate.untilTier}`);
    }

    // 2. Tier times, against the target or against a pin.
    const pins = new Map(gate.knownRed.map((k) => [k.tier, k]));
    const highest = gate.reachesTier ?? gate.untilTier;
    for (const mark of report.tierTimes) {
      if (mark.tier > highest) continue;
      const target = input.targets[mark.tier - 1];
      if (target === undefined) continue;
      const pin = pins.get(mark.tier);
      if (pin === undefined) {
        if (Math.abs(mark.collections - target) > t.tierTolerance * target) {
          add(
            "tier-time",
            `tier ${mark.tier} at ${mark.collections.toFixed(4)} against target ${target} ` +
              `(${pct(mark.collections, target)}, tolerance ${(t.tierTolerance * 100).toFixed(0)}%)`,
          );
        }
        continue;
      }
      // A pinned tier that now hits its target has outlived its pin.
      if (Math.abs(mark.collections - target) <= t.tierTolerance * target) {
        add(
          "stale-pin",
          `tier ${mark.tier} is pinned at ${pin.observed} but now measures ` +
            `${mark.collections.toFixed(4)}, inside its target band -- delete the pin`,
        );
        continue;
      }
      if (Math.abs(mark.collections - pin.observed) > t.driftTolerance * pin.observed) {
        add(
          "known-red-drift",
          `tier ${mark.tier} at ${mark.collections.toFixed(4)} has drifted off its pin ` +
            `${pin.observed} (${pct(mark.collections, pin.observed)}, drift tolerance ` +
            `${(t.driftTolerance * 100).toFixed(0)}%). Pinned because: ${pin.why}`,
        );
      }
    }

    // 3. Dead time (spec 16.6).
    const deadCollections = report.maxDeadTimeMs / input.offlineCapMs;
    if (Number.isFinite(deadCollections)) {
      const pin = gate.deadTimePin;
      if (pin === undefined) {
        if (deadCollections > t.maxDeadTimeCollections) {
          add(
            "dead-time",
            `max dead time ${deadCollections.toFixed(3)} collections, over the ` +
              `${t.maxDeadTimeCollections} threshold`,
          );
        }
      } else if (deadCollections <= t.maxDeadTimeCollections) {
        add(
          "stale-pin",
          `dead time is pinned at ${pin.collections} collections but now measures ` +
            `${deadCollections.toFixed(3)}, under the ${t.maxDeadTimeCollections} ` +
            `threshold -- delete the pin`,
        );
      } else if (Math.abs(deadCollections - pin.collections) > t.driftTolerance * pin.collections) {
        add(
          "known-red-drift",
          `max dead time ${deadCollections.toFixed(3)} collections has drifted off its ` +
            `pin ${pin.collections} (${pct(deadCollections, pin.collections)}). ` +
            `Pinned because: ${pin.why}`,
        );
      }
    }

    // 4. Observed r_eff above the runaway floor (spec D3). A null observation is a
    //    class too little was bought of to measure, not a violation.
    for (const row of report.rEff) {
      if (row.observed === null) continue;
      if (row.observed <= 1 + t.runawayEpsilon) {
        add(
          "r-eff",
          `${row.lane}/${row.machineClass} observed r_eff ${row.observed.toFixed(6)} at or ` +
            `below the 1 + ${t.runawayEpsilon} runaway floor`,
        );
      }
    }
  }

  return findings;
}

/** Spec E.4's magnitude rule: relative 1e-12, with an absolute fallback at zero. */
const MAGNITUDE_TOLERANCE = 1e-12;

function magnitudesDiffer(a: number, b: number): boolean {
  if (a === b) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? a !== b : Math.abs(a - b) / scale > MAGNITUDE_TOLERANCE;
}

/**
 * Spec E.4's replay determinism: the same inputs twice, exact equality for discrete
 * state and event ordering, relative 1e-12 for magnitudes.
 *
 * Discrete divergence is a bug; magnitude divergence in the last digits is physics --
 * `break_infinity.js` uses transcendentals internally at large magnitudes, so full
 * byte-equality is not achievable at the top of the range and asserting it would fail
 * for a reason that is not a defect.
 */
export function compareRuns(a: RunReport, b: RunReport): string[] {
  const out: string[] = [];
  const discrete = <T>(name: string, x: T, y: T): void => {
    if (x !== y) out.push(`${name}: ${String(x)} vs ${String(y)}`);
  };

  discrete("reachedTier", a.reachedTier, b.reachedTier);
  discrete("finished", a.finished, b.finished);
  discrete("purchases", a.purchases, b.purchases);
  discrete("contentVersion", a.contentVersion, b.contentVersion);
  discrete("seed", a.seed, b.seed);
  discrete("tierTimes.length", a.tierTimes.length, b.tierTimes.length);

  for (let i = 0; i < Math.min(a.tierTimes.length, b.tierTimes.length); i += 1) {
    const x = a.tierTimes[i]!;
    const y = b.tierTimes[i]!;
    discrete(`tierTimes[${i}].tier`, x.tier, y.tier);
    if (magnitudesDiffer(x.collections, y.collections)) {
      out.push(`tierTimes[${i}].collections: ${x.collections} vs ${y.collections}`);
    }
  }

  // Order is the assertion, not just membership: spec A.5 makes binding-constraint
  // ordering canonical, so a reordering is an event-ordering divergence.
  discrete("bindingConstraints.length", a.bindingConstraints.length, b.bindingConstraints.length);
  for (let i = 0; i < Math.min(a.bindingConstraints.length, b.bindingConstraints.length); i += 1) {
    discrete(`bindingConstraints[${i}].recipeId`, a.bindingConstraints[i]!.recipeId, b.bindingConstraints[i]!.recipeId);
  }

  discrete("rEff.length", a.rEff.length, b.rEff.length);
  for (let i = 0; i < Math.min(a.rEff.length, b.rEff.length); i += 1) {
    const x = a.rEff[i]!;
    const y = b.rEff[i]!;
    discrete(`rEff[${i}].machineClass`, x.machineClass, y.machineClass);
    if (x.observed === null || y.observed === null) {
      discrete(`rEff[${i}].observed`, x.observed, y.observed);
    } else if (magnitudesDiffer(x.observed, y.observed)) {
      out.push(`rEff[${i}].observed: ${x.observed} vs ${y.observed}`);
    }
  }

  return out;
}
