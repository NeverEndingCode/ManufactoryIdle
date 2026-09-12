#!/usr/bin/env node
// sim run --policy greedy --content <dir> --until tier:10 --report json
// sim run --policy casual --seed 42
// sim play --seed 42
// sim calibrate --content <dir> --max-tier 3 --write
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

  calibrate solves the free content numbers against pacing.targetCollectionsToTier
  by running the simulator (spec B.7): it scans r_eff, then bisects each tier's
  delivery amounts underneath the winner. --no-solve-reff holds r_eff where the
  bundle authored it and solves amounts only. It prints what it found;
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
  if (mode !== "run" && mode !== "play" && mode !== "calibrate") {
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
    },
  });

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
