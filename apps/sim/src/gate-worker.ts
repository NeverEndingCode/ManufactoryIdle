// One `sim gate` run, in its own worker thread.
//
// The gate's runs are independent -- each is one `runSimulation` from a fresh world --
// so they parallelise perfectly even though a single run cannot: every step depends on
// the state the last one produced. Running them side by side makes the gate cost its
// slowest run instead of the sum.
//
// The worker loads the bundle itself rather than receiving the indexed content: an
// `IndexedContent` is a graph of Maps that would be structured-cloned on every post, and
// re-indexing from disk is milliseconds against runs of minutes.
import { parentPort, workerData } from "node:worker_threads";
import { writeSync } from "node:fs";
import { loadBundleDir } from "@manufactory/content";
import { indexContent, type ContentBundle } from "@manufactory/engine";
import type { PolicyName } from "./policies.js";
import { progressPrinter } from "./report.js";
import { runSimulation } from "./run.js";

export interface GateJob {
  /** Shown on progress lines, so interleaved output from several runs stays readable. */
  label: string;
  policy: PolicyName;
  contentDir: string;
  seed: number;
  untilTier: number;
  maxSimMs: number;
  stopWhenDeadMs: number;
}

const job = workerData as GateJob;
const content = indexContent(loadBundleDir(job.contentDir) as ContentBundle);
const report = runSimulation({
  policy: job.policy,
  seed: job.seed,
  content,
  untilTier: job.untilTier,
  maxSimMs: job.maxSimMs,
  stopWhenDeadMs: job.stopWhenDeadMs,
  // Straight to fd 2, not `process.stderr`. In a worker, `process.stderr` forwards to
  // the main thread asynchronously, and this run is one synchronous loop that never
  // yields -- measured on the first parallel gate, every progress line arrived in one
  // burst when the run ended, so a stalled run and a slow one looked identical again.
  // `writeSync` goes to the shared descriptor immediately.
  onProgress: progressPrinter(job.label, (line) => writeSync(2, `${line}\n`)),
});
parentPort!.postMessage(report);
