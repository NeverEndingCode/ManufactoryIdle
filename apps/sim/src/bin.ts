#!/usr/bin/env node
// sim run --policy greedy --content <dir> --until tier:10 --report json
// sim run --policy casual --seed 42
// sim play --seed 42
import { parseArgs } from "node:util";
import { argv, exit, stderr, stdout } from "node:process";
import { POLICY_NAMES, type PolicyName } from "./policies.js";
import { formatReport } from "./report.js";
import { runSimulation } from "./run.js";

const USAGE = `usage:
  sim run  [--policy greedy|casual|optimal|bottleneck] [--content <dir>]
           [--seed <n>] [--until tier:<n>] [--max-days <n>] [--report text|json]
  sim play [--content <dir>] [--seed <n>]
`;

function parseUntilTier(value: string | undefined): number {
  if (value === undefined) return 1;
  const match = /^tier:(\d+)$/.exec(value);
  if (!match) throw new Error(`--until must look like "tier:3", got "${value}"`);
  return Number(match[1]);
}

async function main(): Promise<number> {
  const mode = argv[2];
  if (mode !== "run" && mode !== "play") {
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
    },
  });

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
