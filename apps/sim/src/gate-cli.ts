// `sim gate` — spec E.5's pacing gates, wired to a terminal.
//
// The rules live in `gate.ts` and are unit-tested there in milliseconds. This file only
// does the expensive half: run the policies, hand the reports over, print, exit.
//
// Two depths, because the full gate takes minutes (2m15s locally as of 2026-10-14; it
// has been as slow as 135) and a per-commit hook that costs that gets switched off:
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
import { runPool, type Started } from "./pool.js";
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
 * Measured 2026-09-16, seed 42, `slice.v1`; `bottleneck` re-measured 2026-10-10;
 * all three policies re-measured 2026-10-13 (tier 10 capstone) and again 2026-10-16.
 */
const CASUAL =
  "spec E.5 asks every policy to hit the same targets; calibration fits one set of " +
  "amounts against `greedy`. `casual` checks in once per offline window and lands " +
  "roughly 4x to 8x slower at every tier. Pinned rather than chased: the two cannot both be on " +
  "target unless the game is entirely idle-bound.";

/** The sentence that records when a pinned figure was last measured, and why it moved. */
const remeasured = (date: string, cause: string): string => `Re-measured ${date} after ${cause}.`;

export const VERTICAL_SLICE_GATE: readonly PolicyGate[] = [
  {
    policy: "greedy",
    untilTier: 10,
    // Tier 10 is the assembly-rig capstone (2026-10-13) and lands at 24.16 against a
    // target of 25 (-3.3%), inside tolerance, so the gate holds it to target.
    knownRed: [
      {
        tier: 1,
        observed: 0.3735,
        why:
          "target 0.42, measured 0.3735 (-11.1%): tier 1's time steps 0.37 / 0.59 / 0.80 as the " +
          "iron_plate amount crosses storage-cap boundaries (about 2,800 and 3,200), so no amount " +
          "reaches 0.42 within 5%; the calibrator reports tier 1 as unable to be brought within 5%. " +
          "It sat on target before only because greedy bought storage for items nothing live produces. " +
          remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
    ],
  },
  {
    policy: "casual",
    untilTier: 10,
    knownRed: [
      { tier: 1, observed: 2.0046, why: CASUAL + " " + remeasured("2026-10-13", "tier 10 became the assembly-rig capstone: one more stock item adds one 2-minute storage purchase to greedy-style tier-0 sweeps, crossing an offline-window boundary") + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated") },
      { tier: 2, observed: 3.1389, why: CASUAL + " " + remeasured("2026-10-13", "tier 10 became the assembly-rig capstone") + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated") },
      { tier: 3, observed: 5.0069, why: CASUAL + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated") },
      { tier: 4, observed: 8.0579, why: CASUAL + " " + remeasured("2026-10-13", "tier 10 became the assembly-rig capstone") + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated") },
      { tier: 5, observed: 18.0034, why: CASUAL },
      { tier: 6, observed: 26.0021, why: CASUAL + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated") },
      { tier: 7, observed: 41.0167, why: CASUAL + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated") },
      { tier: 8, observed: 62.0021, why: CASUAL },
      { tier: 9, observed: 89.0013, why: CASUAL + " " + remeasured("2026-10-13", "tier 10 became the assembly-rig capstone") + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated") },
      {
        tier: 10,
        observed: 97.1651,
        why:
          CASUAL +
          " " +
          remeasured(
            "2026-10-13",
            "tier 10 became the assembly-rig capstone (was 205.0120 on the old smart_plating requirement)",
          ) +
          " " +
          remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
    ],
  },
  {
    policy: "bottleneck",
    untilTier: 10,
    // Fixed 2026-10-14 (spec 2026-10-14-slow-payer-advice): `bottleneck` used to STALL at
    // tier 9, waiting about 22.6 hours for encased_industrial_beam to afford the 12th assembly
    // rig, past the dead-time cut-off. The reporter now advises one more machine for a payer
    // too slow to afford the purchase soon, so the run keeps building and finishes tier 10.
    // The redirect walks on past a recipe starved of an input to the recipe that limits it
    // (final review, same day), which moved tiers 7 to 10. Re-measured 2026-10-15: it now buys
    // for the advised recipe and the reporter advises storage for a blocked payer, so tier 10
    // lands at 10.5551 and its dead time is 0.6089 collections. Re-measured again the same day
    // after the reporter advised the cause for a payer not being made: tier 10 at 10.5329, dead
    // time 0.6379 collections. Re-measured 2026-10-16 after reserves were sized against full-power
    // production and kept while working (spec 2026-10-16-reserves-that-last): tier 10 at 10.0576,
    // dead time 0.7753 collections.
    knownRed: [
      {
        tier: 1,
        observed: 0.0716,
        why:
          "target 0.42, measured 0.072 (-83%): bottleneck clears the early tiers far " +
          "faster than target because it buys almost nothing beyond what the reporter " +
          "names. Fast is not on-target -- both directions count as red. " +
          remeasured("2026-10-13", "bottleneck began following reserve advice")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 2,
        observed: 0.1901,
        why:
          "target 0.8, measured 0.190 (-76%): the same minimal-buying overshoot as tier 1. " +
          remeasured("2026-10-13", "bottleneck began following reserve advice")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 3,
        observed: 0.3325,
        why:
          "target 1.2, measured 0.333 (-72%): the same overshoot, narrowing tier over tier. " +
          remeasured("2026-10-13", "bottleneck began following reserve advice") +
          " " + remeasured("2026-10-15", "bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 4,
        observed: 0.4396,
        why:
          "target 1.9, measured 0.440 (-77%): the same overshoot. " +
          remeasured("2026-10-13", "bottleneck began following reserve advice") +
          " " + remeasured("2026-10-15", "bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer") +
          " " + remeasured("2026-10-16", "reserves were sized against production and kept while working")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 5,
        observed: 0.5659,
        why:
          "target 2.9, measured 0.566 (-80%): the same overshoot. " +
          remeasured("2026-10-13", "bottleneck began following reserve advice") +
          " " + remeasured("2026-10-15", "bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer") +
          " " + remeasured("2026-10-16", "reserves were sized against production and kept while working")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 6,
        observed: 0.7914,
        why:
          "target 4.4, measured 0.791 (-82%). Earlier than the 1.170 it was pinned at " +
          "before 2026-10-09, because a starved generator now names its fuel supplier " +
          "instead of another generator -- the policy no longer sinks purchases into " +
          "biomass burners it cannot fuel. " +
          remeasured("2026-10-13", "bottleneck began following reserve advice") +
          " " + remeasured("2026-10-15", "bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer") +
          " " + remeasured("2026-10-16", "reserves were sized against production and kept while working")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 7,
        observed: 1.1113,
        why:
          "target 6.8, measured 1.111 (-84%). This was " +
          "where bottleneck used to stop: the reporter advised a 4,473 iron_plate " +
          "Quantum Storage level while iron_plate could hold 4,000, and the policy " +
          "bought nothing. After payable advice the run passes tier 7. " +
          remeasured("2026-10-14", "the reporter advised production for slow payers") +
          " " + remeasured("2026-10-15", "bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer") +
          " " + remeasured("2026-10-16", "reserves were sized against production and kept while working")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 8,
        observed: 1.4360,
        why:
          "target 11, measured 1.436 (-87%): the same minimal-buying overshoot. " +
          remeasured("2026-10-14", "the reporter advised production for slow payers") +
          " " + remeasured("2026-10-15", "bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer") +
          " " + remeasured("2026-10-16", "reserves were sized against production and kept while working")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 9,
        observed: 2.2982,
        why:
          "target 16, measured 2.298 (-86%): the same overshoot. " +
          remeasured("2026-10-14", "the reporter advised production for slow payers") +
          " " + remeasured("2026-10-15", "bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer") +
          " " + remeasured("2026-10-16", "reserves were sized against production and kept while working")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
      },
      {
        tier: 10,
        observed: 9.6322,
        why:
          "target 25, measured 9.632 (-61%): the overshoot is at its narrowest. " +
          "bottleneck now finishes tier 10 because of slow-payer advice: it used to stall at " +
          "tier 9 waiting about 22.6 hours for encased_industrial_beam to afford the 12th " +
          "assembly rig, and now builds more beam production instead. " +
          remeasured("2026-10-14", "the reporter advised production for slow payers") +
          " " + remeasured("2026-10-15", "bottleneck bought for the advised recipe and the reporter advised storage for a blocked payer") +
          " " + remeasured("2026-10-15", "the reporter advised the cause for a payer not being made") +
          " " + remeasured("2026-10-16", "reserves were sized against production and kept while working")
          + " " + remeasured("2026-10-16", "greedy and casual stopped buying storage for items nothing live produces, and the slice was recalibrated"),
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
function runInWorker(job: GateJob): Started<RunReport> {
  const worker = new Worker(new URL("./gate-worker.ts", import.meta.url), { workerData: job });
  const result = new Promise<RunReport>((resolve, reject) => {
    worker.once("message", (report: RunReport) => resolve(report));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`${job.label}: worker exited with code ${code}`));
    });
  });
  return { result, stop: () => void worker.terminate() };
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
  const { results: all, seconds } = await runPool(jobs, availableParallelism(), runInWorker);
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
