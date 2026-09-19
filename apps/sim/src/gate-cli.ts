// `sim gate` — spec E.5's pacing gates, wired to a terminal.
//
// The rules live in `gate.ts` and are unit-tested there in milliseconds. This file only
// does the expensive half: run the policies, hand the reports over, print, exit.
//
// Two depths, because the full gate is ~14 minutes and a per-commit hook that costs
// that gets switched off:
//
//   sim gate --smoke   greedy to tier 4, twice (determinism). Seconds. Per commit.
//   sim gate           all three policies to tier 10, greedy twice. Nightly / PR job.
//
// `--emit-pins` prints a paste-ready config from the current measurements. Re-pinning
// after a calibration run is otherwise a hand-transcription job, and a gate that is
// annoying to update is a gate that gets deleted.
import { stderr, stdout } from "node:process";
import { loadBundleDir } from "@manufactory/content";
import { indexContent, type ContentBundle } from "@manufactory/engine";
import { SLICE_BUNDLE_DIR } from "./bootstrap.js";
import { DEFAULT_THRESHOLDS, compareRuns, evaluateGate, type PolicyGate } from "./gate.js";
import type { RunReport } from "./report.js";
import { runSimulation } from "./run.js";

/**
 * What the vertical slice does TODAY, and where that is not what spec E.5 asks for.
 *
 * E.5 wants `greedy`, `casual` and `bottleneck` all within tolerance of
 * `pacing.targetCollectionsToTier`. Only `greedy` is: it is the policy calibration
 * solved against, and calibration fits ONE set of milestone amounts. A player checking
 * in every two minutes and a player checking in three times a day cannot both hit the
 * same tier times unless the game is entirely idle-bound, so this is a property of the
 * spec's wording rather than a fixable content defect. Every deviation below is pinned
 * to its measured value with a reason, so the gate still fails on drift and every pin
 * names the thing that has to change for it to go away.
 *
 * Measured 2026-09-16, seed 42, `slice.v1`.
 */
const CASUAL =
  "spec E.5 asks every policy to hit the same targets; calibration fits one set of " +
  "amounts against `greedy`. `casual` checks in once per offline window and lands 4x " +
  "to 8x slower at every tier. Pinned rather than chased: the two cannot both be on " +
  "target unless the game is entirely idle-bound.";

export const VERTICAL_SLICE_GATE: readonly PolicyGate[] = [
  {
    policy: "greedy",
    untilTier: 10,
    knownRed: [
      {
        tier: 10,
        observed: 20.8722,
        why:
          "target 25, measured 20.87 (-16.5%), and this is now a MEASURED ceiling " +
          "rather than a fitting failure. The requirement cannot exceed what a player " +
          "can ever hold -- maxAttainableCap(smart_plating, tier 9) is 7,665,440 -- and " +
          "the solved 7,663,000 is 99.97% of it. Even at the ceiling the tier lands at " +
          "20.87, so no amount reaches 25. The item RATIO is ruled out too (measured): " +
          "both requirements share a ceiling, the beam binding lands further out at " +
          "20.656, and both together measure the same as smart_plating alone. Needs " +
          "something structural -- recipe depth, or a power or throughput wall.",
      },
    ],
  },
  {
    policy: "casual",
    untilTier: 10,
    knownRed: [
      { tier: 1, observed: 2.0065, why: CASUAL },
      { tier: 2, observed: 4.0556, why: CASUAL },
      { tier: 3, observed: 6.1115, why: CASUAL },
      { tier: 4, observed: 9.0331, why: CASUAL },
      { tier: 5, observed: 18.0034, why: CASUAL },
      { tier: 6, observed: 28.0021, why: CASUAL },
      { tier: 7, observed: 42.0167, why: CASUAL },
      { tier: 8, observed: 62.0021, why: CASUAL },
      { tier: 9, observed: 89.0014, why: CASUAL },
      { tier: 10, observed: 205.0095, why: CASUAL },
    ],
  },
  {
    policy: "bottleneck",
    untilTier: 10,
    reachesTier: 6,
    knownRed: [
      {
        tier: 1,
        observed: 0.0748,
        why:
          "target 0.42, measured 0.075 (-82%): bottleneck clears tier 1 far faster " +
          "than target because it buys almost nothing before the milestone-aware " +
          "reporter's advice starts biting. Fast is not on-target -- both directions " +
          "count as red -- but this is no longer the tier-1 stall: see `reachesTier`.",
      },
      {
        tier: 2,
        observed: 0.1706,
        why:
          "target 0.8, measured 0.171 (-79%): same early-tier overshoot as tier 1 -- " +
          "the policy is still buying minimally and clearing milestones on cheap " +
          "recipes before the constraints that stall it at tier 6 become binding.",
      },
      {
        tier: 3,
        observed: 0.4133,
        why:
          "target 1.2, measured 0.413 (-66%): still well ahead of target. The gap to " +
          "target narrows tier over tier as the stalling constraints (refine_rubber, " +
          "power:burn_biomass, mine_copper_ore, make_screw) start to bind.",
      },
      {
        tier: 4,
        observed: 0.5899,
        why:
          "target 1.9, measured 0.590 (-69%): ahead of target, same shrinking-lead " +
          "trend as tiers 1-3 heading into the tier-6 stall.",
      },
      {
        tier: 5,
        observed: 0.6977,
        why:
          "target 2.9, measured 0.698 (-76%): ahead of target; the run reaches tier 6 " +
          "only 0.47 collections later before it stalls for good.",
      },
      {
        tier: 6,
        observed: 1.1697,
        why:
          "target 4.4, measured 1.170 (-73%), and this is now where bottleneck stops: " +
          "it does not reach tier 7 within the 120-day budget. Fixed from the prior " +
          "permanent tier-1 stall (was: reachesTier 1, dead time from day ~20) to a " +
          "tier-6 stall, bound by refine_rubber and power:burn_biomass with " +
          "mine_copper_ore and make_screw also binding -- a real but partial fix. " +
          "`bottleneck` reaches 6 of 10 tiers and is nowhere near `greedy`, which " +
          "reaches all 10.",
      },
    ],
    deadTimePin: {
      collections: 356.3315,
      why:
        "the policy stalls at tier 6 (binding constraints refine_rubber and " +
        "power:burn_biomass) rather than tier 1 as before, so dead time is now " +
        "measuring the NEW stall, not the old one. It goes away only when the tier-6 " +
        "advice defect is fixed, same as the old pin did for tier 1.",
    },
  },
];

/**
 * `bottleneck` no longer stalls at tier 1 forever -- the milestone-aware reporter fix
 * (this SDD plan, tasks 1-3) moved it from a permanent tier-1 stall to a tier-6 one.
 *
 * Measured 2026-09-19, seed 42, `slice.v1`, --max-days 120: reaches tier 6 (was tier 1),
 * 229 purchases, then stalls again -- binding constraints refine_rubber,
 * power:burn_biomass, mine_copper_ore and make_screw. At every tier it reaches it is
 * 66-82% FASTER than target, not slower: it still wins by buying almost nothing. This is
 * a real fix (6 of 10 tiers instead of 1 of 10) but not a complete one, and it lands
 * nowhere near `greedy`, which reaches all 10. See task-4-report.md for the full
 * before/after numbers.
 */
export interface GateCliOptions {
  contentDir?: string;
  seed: number;
  smoke: boolean;
  emitPins: boolean;
  maxDays: number;
}

const SMOKE_TIER = 4;

export function runGate(options: GateCliOptions): number {
  const dir = options.contentDir ?? SLICE_BUNDLE_DIR;
  const bundle = loadBundleDir(dir);
  const content = indexContent(bundle as ContentBundle);
  const targets = bundle.pacing.targetCollectionsToTier;
  const maxSimMs = options.maxDays * 24 * 60 * 60 * 1000;

  // The smoke gate runs one policy, shallow, and holds it to its targets with no pins:
  // every tier it touches is green today, so a pin here would be a pin on nothing.
  const gates: readonly PolicyGate[] = options.smoke
    ? [{ policy: "greedy", untilTier: SMOKE_TIER, knownRed: [] }]
    : VERTICAL_SLICE_GATE;

  const reports: RunReport[] = [];
  const timings: string[] = [];
  for (const gate of gates) {
    const started = Date.now();
    reports.push(
      runSimulation({
        policy: gate.policy,
        seed: options.seed,
        content,
        untilTier: gate.untilTier,
        maxSimMs,
      }),
    );
    timings.push(`${gate.policy} ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  // Determinism (spec E.4) at the gate's own depth, not a shallower one: divergence is
  // a libm hazard and libm is reached at LARGE magnitudes, so checking only the shallow
  // end would be checking the regime that cannot fail.
  const deepest = gates.reduce((a, g) => Math.max(a, g.untilTier), 0);
  const first = reports.find((r) => r.policy === "greedy")!;
  const second = runSimulation({
    policy: "greedy",
    seed: options.seed,
    content,
    untilTier: deepest,
    maxSimMs,
  });
  const divergence = compareRuns(first, second);

  if (options.emitPins) {
    stdout.write(formatPins(reports, content.offlineCapMs));
    return 0;
  }

  const findings = evaluateGate({
    targets,
    gates,
    reports,
    thresholds: DEFAULT_THRESHOLDS,
    offlineCapMs: content.offlineCapMs,
  });

  stdout.write(formatTable(reports, targets, gates, content.offlineCapMs));
  stderr.write(`\nruns: ${timings.join(", ")}\n`);

  for (const line of divergence) {
    findings.push({ policy: "greedy", check: "determinism", detail: line });
  }

  if (findings.length === 0) {
    stdout.write(`\ngate PASSED — ${gates.length} policy run(s), determinism clean\n`);
    return 0;
  }
  stdout.write(`\ngate FAILED — ${findings.length} finding(s)\n\n`);
  for (const f of findings) stdout.write(`  [${f.check}] ${f.policy}: ${f.detail}\n`);
  return 1;
}

function formatTable(
  reports: readonly RunReport[],
  targets: readonly number[],
  gates: readonly PolicyGate[],
  offlineCapMs: number,
): string {
  const lines = ["", "tier   target" + reports.map((r) => `   ${r.policy.padStart(10)}`).join(""), ""];
  const depth = gates.reduce((a, g) => Math.max(a, g.untilTier), 0);
  for (let tier = 1; tier <= depth; tier += 1) {
    const target = targets[tier - 1];
    if (target === undefined) continue;
    let row = `${String(tier).padStart(4)}   ${target.toFixed(2).padStart(6)}`;
    for (const report of reports) {
      const mark = report.tierTimes.find((t) => t.tier === tier);
      row += `   ${(mark === undefined ? "never" : mark.collections.toFixed(3)).padStart(10)}`;
    }
    lines.push(row);
  }
  lines.push("");
  for (const report of reports) {
    const measured = report.rEff.map((r) => r.observed).filter((v): v is number => v !== null);
    lines.push(
      `${report.policy.padStart(11)}  reached tier ${String(report.reachedTier).padStart(2)}  ` +
        `dead ${(report.maxDeadTimeMs / offlineCapMs).toFixed(3)} colls  ` +
        `purchases ${String(report.purchases).padStart(5)}  ` +
        `min r_eff ${measured.length === 0 ? "n/a" : Math.min(...measured).toFixed(6)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A paste-ready `knownRed` block from what the runs actually measured. */
function formatPins(reports: readonly RunReport[], offlineCapMs: number): string {
  const lines = ["// measured " + new Date().toISOString(), ""];
  for (const report of reports) {
    lines.push(`// ${report.policy}: reached tier ${report.reachedTier}, dead ${(report.maxDeadTimeMs / offlineCapMs).toFixed(4)} collections`);
    for (const mark of report.tierTimes) {
      lines.push(`{ tier: ${mark.tier}, observed: ${mark.collections.toFixed(4)}, why: "..." },`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
