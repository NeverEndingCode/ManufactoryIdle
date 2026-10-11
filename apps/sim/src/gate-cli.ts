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
import { availableParallelism } from "node:os";
import { stderr, stdout } from "node:process";
import { Worker } from "node:worker_threads";
import { loadBundleDir } from "@manufactory/content";
import { indexContent, type ContentBundle } from "@manufactory/engine";
import { SLICE_BUNDLE_DIR } from "./bootstrap.js";
import { DEFAULT_THRESHOLDS, compareRuns, evaluateGate, type PolicyGate } from "./gate.js";
import type { GateJob } from "./gate-worker.js";
import type { RunReport } from "./report.js";

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
 * Measured 2026-09-16, seed 42, `slice.v1`; `bottleneck` re-measured 2026-10-10.
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
      { tier: 10, observed: 205.0120, why: CASUAL + " Re-measured 2026-10-10 after R32 was asked jointly (coupled EMPTY items)." },
    ],
  },
  {
    policy: "bottleneck",
    untilTier: 10,
    // Measured 2026-10-10 after payable advice: the reporter now prices its advice, so
    // the tier-7 stall (a 4,473 iron_plate storage level against a 4,000 cap) no longer
    // happens and the run goes on. `bottleneck` now FINISHES all 10
    // tiers (dead time 0.225 collections), so there is no `reachesTier`; every tier
    // still lands far earlier than target.
    knownRed: [
      {
        tier: 1,
        observed: 0.0748,
        why:
          "target 0.42, measured 0.075 (-82%): bottleneck clears the early tiers far " +
          "faster than target because it buys almost nothing beyond what the reporter " +
          "names. Fast is not on-target -- both directions count as red.",
      },
      {
        tier: 2,
        observed: 0.1706,
        why: "target 0.8, measured 0.171 (-79%): the same minimal-buying overshoot as tier 1.",
      },
      {
        tier: 3,
        observed: 0.4133,
        why: "target 1.2, measured 0.413 (-66%): the same overshoot, narrowing tier over tier.",
      },
      {
        tier: 4,
        observed: 0.5953,
        why: "target 1.9, measured 0.595 (-69%): the same overshoot.",
      },
      {
        tier: 5,
        observed: 0.6995,
        why: "target 2.9, measured 0.700 (-76%): the same overshoot.",
      },
      {
        tier: 6,
        observed: 0.9337,
        why:
          "target 4.4, measured 0.934 (-79%). Earlier than the 1.170 it was pinned at " +
          "before 2026-10-09, because a starved generator now names its fuel supplier " +
          "instead of another generator -- the policy no longer sinks purchases into " +
          "biomass burners it cannot fuel.",
      },
      {
        tier: 7,
        observed: 1.2871,
        why:
          "target 6.8, measured 1.287 (-81%). Unchanged by payable advice. This was " +
          "where bottleneck used to stop: the reporter advised a 4,473 iron_plate " +
          "Quantum Storage level while iron_plate could hold 4,000, and the policy " +
          "bought nothing. After payable advice the run passes tier 7; the advice it took there " +
          "was not captured (the probe started from a pre-payable checkpoint).",
      },
      {
        tier: 8,
        observed: 1.6678,
        why:
          "target 11, measured 1.668 (-85%): the same minimal-buying overshoot, now reached " +
          "because the run no longer stalls at tier 7. Re-measured 2026-10-10 after R32 was asked jointly (coupled EMPTY items).",
      },
      {
        tier: 9,
        observed: 3.0791,
        why:
          "target 16, measured 3.079 (-81%): the same overshoot, with the gap narrowing. " +
          "Re-measured 2026-10-10 after R32 was asked jointly (coupled EMPTY items).",
      },
      {
        tier: 10,
        observed: 5.5792,
        why:
          "target 25, measured 5.579 (-78%): bottleneck now finishes all 10 tiers, but " +
          "at under a quarter of the target time (500 purchases, dead time 0.225 " +
          "collections). `greedy` reaches tier 10 at 20.87 and `casual` at 205.01. " +
          "Re-measured 2026-10-10 after R32 was asked jointly (coupled EMPTY items).",
      },
    ],
  },
];

export interface GateCliOptions {
  contentDir?: string;
  seed: number;
  smoke: boolean;
  emitPins: boolean;
  maxDays: number;
}

const SMOKE_TIER = 4;

/** One run in its own worker thread; resolves with its report. */
function runInWorker(job: GateJob): Promise<RunReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./gate-worker.ts", import.meta.url), { workerData: job });
    worker.once("message", (report: RunReport) => resolve(report));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`${job.label}: worker exited with code ${code}`));
    });
  });
}

/**
 * Runs every job with at most `limit` in flight, and returns the results in JOB order
 * rather than completion order, so the table and the judging are what a serial gate
 * would have produced.
 */
async function runAll(
  jobs: readonly GateJob[],
  limit: number,
): Promise<{ reports: RunReport[]; seconds: number[] }> {
  const reports: RunReport[] = new Array(jobs.length);
  const seconds: number[] = new Array(jobs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const started = Date.now();
      reports[index] = await runInWorker(jobs[index]!);
      seconds[index] = (Date.now() - started) / 1000;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, lane));
  return { reports, seconds };
}

export async function runGate(options: GateCliOptions): Promise<number> {
  const dir = options.contentDir ?? SLICE_BUNDLE_DIR;
  const bundle = loadBundleDir(dir);
  const content = indexContent(bundle as ContentBundle);
  const targets = bundle.pacing.targetCollectionsToTier;
  const maxSimMs = options.maxDays * 24 * 60 * 60 * 1000;
  // A run that has gone longer than the dead-time threshold with nothing bought or
  // unlocked has already failed that check -- or, for a policy pinned by
  // `reachesTier`, has shown exactly what its pin asserts. Simulating the rest of the
  // budget teaches nothing and, measured 2026-10-09, would have cost `bottleneck`
  // ~250 hours. So the gate stops it there.
  const stopWhenDeadMs = DEFAULT_THRESHOLDS.maxDeadTimeCollections * content.offlineCapMs;

  // The smoke gate runs one policy, shallow, and holds it to its targets with no pins:
  // every tier it touches is green today, so a pin here would be a pin on nothing.
  const gates: readonly PolicyGate[] = options.smoke
    ? [{ policy: "greedy", untilTier: SMOKE_TIER, knownRed: [] }]
    : VERTICAL_SLICE_GATE;

  // Determinism (spec E.4) at the gate's own depth, not a shallower one: divergence is
  // a libm hazard and libm is reached at LARGE magnitudes, so checking only the shallow
  // end would be checking the regime that cannot fail. The rerun is its own job, in
  // its own thread, so the comparison is between two genuinely separate runs.
  const deepest = gates.reduce((a, g) => Math.max(a, g.untilTier), 0);
  const base = { contentDir: dir, seed: options.seed, maxSimMs, stopWhenDeadMs };
  const jobs: GateJob[] = [
    ...gates.map((gate) => ({ ...base, label: gate.policy, policy: gate.policy, untilTier: gate.untilTier })),
    { ...base, label: "greedy (determinism rerun)", policy: "greedy", untilTier: deepest },
  ];
  const { reports: all, seconds } = await runAll(jobs, availableParallelism());
  const reports = all.slice(0, gates.length);
  const second = all[gates.length]!;
  const timings = jobs.map((job, i) => `${job.label} ${seconds[i]!.toFixed(1)}s`);

  const first = reports.find((r) => r.policy === "greedy")!;
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
    const stop = report.stalled ? `stalled at tier ${report.reachedTier} -- pin with reachesTier: ${report.reachedTier}` : `reached tier ${report.reachedTier}`;
    lines.push(`// ${report.policy}: ${stop}, dead ${(report.maxDeadTimeMs / offlineCapMs).toFixed(4)} collections`);
    for (const mark of report.tierTimes) {
      lines.push(`{ tier: ${mark.tier}, observed: ${mark.collections.toFixed(4)}, why: "..." },`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
