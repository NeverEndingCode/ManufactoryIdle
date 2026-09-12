import { loadBundleDir } from "@manufactory/content";
import { SLICE_BUNDLE_DIR } from "./src/bootstrap.js";
import { clearsTargets, smallestClearing, tierCeilings, withCapPerTier } from "./src/calibrate.js";

const slice = loadBundleDir(SLICE_BUNDLE_DIR);
const started = Date.now();
const solved = smallestClearing(
  (v) =>
    clearsTargets(
      tierCeilings({ bundle: withCapPerTier(slice, v), maxTier: 10, policy: "greedy", seed: 42 }),
      1.25,
    ),
  { seed: 1, floor: 1 },
);
console.log(`capPerTier = ${solved.value.toFixed(4)}  cleared=${solved.cleared}  ${solved.evaluations} runs  ${((Date.now() - started) / 1000).toFixed(0)}s`);

for (const c of tierCeilings({ bundle: withCapPerTier(slice, solved.value), maxTier: 10, policy: "greedy", seed: 42 })) {
  const v = c.ceiling === null ? "-" : c.ceiling.toFixed(2);
  const verdict = c.ceiling === null ? "not evaluated" : c.ceiling >= c.target * 1.25 ? "clears" : "SHORT";
  console.log(`  tier ${String(c.tier).padStart(2)}  target ${String(c.target).padStart(5)}  ceiling ${v.padStart(9)}  ${verdict}`);
}
