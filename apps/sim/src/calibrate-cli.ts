// `sim calibrate` — spec B.7's search wrapper, wired to a terminal.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stderr, stdout } from "node:process";
import { loadBundleDir, serialiseDerived } from "@manufactory/content";
import { FIXTURE_BUNDLE_DIR } from "./bootstrap.js";
import { calibrate, type CalibrationResult, type TierCalibration } from "./calibrate.js";
import type { PolicyName } from "./policies.js";

export interface CalibrationCliOptions {
  contentDir?: string;
  policy: PolicyName;
  seed: number;
  maxTier?: number;
  tolerance: number;
  write: boolean;
  solveREff: boolean;
  scales?: number[] | undefined;
  refine?: boolean | undefined;
}

function formatScan(result: CalibrationResult): string {
  if (result.rEffScan.length === 0) return "r_eff held at the authored value";
  const lines = ["", "r_eff scale   curve miss", ""];
  // Ascending by scale rather than by score, so the shape of the response is readable
  // and a flat region is visible as one. The response is not monotone (spec D3), which
  // is the reason this is a scan, and the reason the whole of it is printed.
  for (const entry of [...result.rEffScan].sort((a, b) => a.scale - b.scale)) {
    const chosen = entry.scale === result.rEffScale ? "  <- chosen" : "";
    lines.push(
      `${entry.scale.toFixed(3).padStart(11)}   ${entry.miss.toFixed(4).padStart(10)}${chosen}`,
    );
  }
  return lines.join("\n");
}

function formatTable(tiers: TierCalibration[], tolerance: number): string {
  const lines = ["", "tier     target   observed      miss   runs", ""];
  for (const tier of tiers) {
    const observed = tier.observed;
    const miss = observed === null ? null : (observed - tier.target) / tier.target;
    lines.push(
      `${String(tier.tier).padStart(4)}   ${tier.target.toFixed(2).padStart(8)}   ` +
        `${(observed === null ? "never" : observed.toFixed(2)).padStart(8)}   ` +
        `${(miss === null ? "—" : `${(miss * 100).toFixed(1)}%`).padStart(7)}   ` +
        `${String(tier.evaluations).padStart(4)}${tier.converged ? "" : "   OFF TARGET"}`,
    );
  }
  const off = tiers.filter((t) => !t.converged);
  lines.push("");
  lines.push(
    off.length === 0
      ? `every tier within ${(tolerance * 100).toFixed(0)}% of its target`
      : `${off.length} tier(s) could not be brought within ${(tolerance * 100).toFixed(0)}%: ` +
        `${off.map((t) => t.tier).join(", ")}`,
  );
  return lines.join("\n");
}

export function runCalibration(options: CalibrationCliOptions): number {
  const dir = options.contentDir ?? FIXTURE_BUNDLE_DIR;
  // Authored seeds, not the last run's output: calibration has to be idempotent, so
  // it must not search outward from a solution it already wrote (see LoadOptions).
  const bundle = loadBundleDir(dir, { applyDerived: false });

  const result = calibrate({
    bundle,
    policy: options.policy,
    seed: options.seed,
    maxTier: options.maxTier,
    tolerance: options.tolerance,
    solveREff: options.solveREff,
    rEffScales: options.scales,
    refine: options.refine,
    // Progress goes to stderr so that stdout stays the result, and a run that takes
    // an hour is not a silent one.
    onProgress: (line) => stderr.write(`${line}\n`),
  });

  stdout.write(`${formatScan(result)}\n`);
  stdout.write(`${formatTable(result.tiers, options.tolerance)}\n`);

  if (options.write) {
    const path = join(dir, "derived.yaml");
    writeFileSync(path, serialiseDerived(result.derived));
    stdout.write(`\nwrote ${path}\n`);
  } else {
    stdout.write(`\n(dry run — pass --write to emit derived.yaml)\n`);
  }

  // Non-zero when any tier is off target: this is a build step, and a calibration
  // that did not converge is a result to look at, not one to commit unexamined.
  return result.tiers.every((t) => t.converged) ? 0 : 1;
}
