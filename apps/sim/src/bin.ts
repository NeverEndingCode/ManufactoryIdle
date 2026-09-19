#!/usr/bin/env node
// sim run --policy greedy --content <dir> --until tier:10 --report json
// sim run --policy casual --seed 42
// sim play --seed 42
// sim calibrate --content <dir> --max-tier 3 --write
// sim gate --smoke
import { parseArgs } from "node:util";
import { argv, exit, stderr, stdout } from "node:process";
import { POLICY_NAMES, type PolicyName } from "./policies.js";
import { formatReport } from "./report.js";
import { runSimulation } from "./run.js";

const USAGE = `usage:
  sim run  [--policy greedy|casual|optimal|bottleneck] [--content <dir>]
           [--seed <n>] [--until tier:<n>] [--max-days <n>] [--report text|json]
  sim play [--content <dir>] [--seed <n>]
  sim calibrate [--content <dir>] [--policy <name>] [--seed <n>] [--max-tier <n>]
           [--tolerance <f>] [--write] [--no-solve-reff]
           [--scales a,b,c] [--no-refine]
  sim gate [--content <dir>] [--seed <n>] [--smoke] [--max-days <n>] [--emit-pins]

  gate is spec E.5's pacing gate: it runs the policies and fails the build on a
  tier time outside tolerance, dead time over threshold, an observed r_eff at the
  runaway floor, or a determinism divergence. --smoke runs greedy to tier 4 in
  seconds and is the per-commit form; the full gate runs three policies to tier 10
  and takes about fifteen minutes. --emit-pins prints a paste-ready known-red block
  from the current measurements, for re-pinning after a calibration run.

  calibrate solves the free content numbers against pacing.targetCollectionsToTier
  by running the simulator (spec B.7): it scans r_eff, then bisects each tier's
  delivery amounts underneath the winner. --no-solve-reff holds r_eff where the
  bundle authored it and solves amounts only. --scales replaces the coarse r_eff
  grid, which matters because cost rises steeply with the scale: measured on the
  slice, 0.5 took 417s and 4.0 took 7,774s. It prints what it found;
  --write emits it to <dir>/derived.yaml, which the loader lays over the authored
  files. Expect it to take a while: every step of every search is a real run.
`;

function parseUntilTier(value: string | undefined): number {
  if (value === undefined) return 1;
  const match = /^tier:(\d+)$/.exec(value);
  if (!match) throw new Error(`--until must look like "tier:3", got "${value}"`);
  return Number(match[1]);
}

async function main(): Promise<number> {
  const mode = argv[2];
  if (mode !== "run" && mode !== "play" && mode !== "calibrate" && mode !== "gate") {
    stderr.write(USAGE);
    return 2;
  }

  const { values } = parseArgs({
    args: argv.slice(3),
    options: {
      policy: { type: "string", default: "greedy" },
      content: { type: "string" },
      seed: { type: "string", default: "42" },
      until: { type: "string", default: "tier:1" },
      "max-days": { type: "string", default: "365" },
      report: { type: "string", default: "text" },
      "max-tier": { type: "string" },
      tolerance: { type: "string", default: "0.05" },
      write: { type: "boolean", default: false },
      "no-solve-reff": { type: "boolean", default: false },
      scales: { type: "string" },
      "no-refine": { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
      "emit-pins": { type: "boolean", default: false },
    },
  });

  if (mode === "gate") {
    const { runGate } = await import("./gate-cli.js");
    return runGate({
      contentDir: values.content,
      seed: Number(values.seed),
      smoke: values.smoke,
      emitPins: values["emit-pins"],
      maxDays: Number(values["max-days"]),
    });
  }

  if (mode === "calibrate") {
    const { runCalibration } = await import("./calibrate-cli.js");
    return runCalibration({
      contentDir: values.content,
      policy: values.policy as PolicyName,
      seed: Number(values.seed),
      maxTier: values["max-tier"] === undefined ? undefined : Number(values["max-tier"]),
      tolerance: Number(values.tolerance),
      write: values.write,
      solveREff: !values["no-solve-reff"],
      refine: !values["no-refine"],
      scales:
        values.scales === undefined
          ? undefined
          : values.scales.split(",").map((v) => Number(v.trim())),
    });
  }

  if (mode === "play") {
    const { startPlay } = await import("./play.js");
    await startPlay({ contentDir: values.content, seed: Number(values.seed) });
    return 0;
  }

  const policy = values.policy as PolicyName;
  if (!POLICY_NAMES.includes(policy)) {
    stderr.write(`unknown policy "${values.policy}"\n${USAGE}`);
    return 2;
  }

  const report = runSimulation({
    policy,
    contentDir: values.content,
    seed: Number(values.seed),
    untilTier: parseUntilTier(values.until),
    maxSimMs: Number(values["max-days"]) * 24 * 60 * 60 * 1000,
  });

  stdout.write(
    values.report === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatReport(report)}\n`,
  );
  return report.finished ? 0 : 1;
}

main().then(
  (code) => exit(code),
  (error: unknown) => {
    stderr.write(`${String(error)}\n`);
    exit(2);
  },
);
