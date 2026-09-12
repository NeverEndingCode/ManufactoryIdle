import { loadBundleDir } from "@manufactory/content";
import { SLICE_BUNDLE_DIR } from "./src/bootstrap.js";
import { tierCeilings, withREffScale } from "./src/calibrate.js";
const slice = loadBundleDir(SLICE_BUNDLE_DIR);
for (const scale of [4, 8]) {
  const started = Date.now();
  const ceilings = tierCeilings({ bundle: withREffScale(slice, scale), maxTier: 10, policy: "greedy", seed: 42 });
  console.log(`\nscale ${scale} (${((Date.now() - started) / 1000).toFixed(0)}s):`);
  for (const c of ceilings.filter((c) => c.ceiling !== null)) {
    console.log(`  tier ${String(c.tier).padStart(2)}  target ${c.target.toFixed(0).padStart(5)}  ceiling ${c.ceiling!.toFixed(2).padStart(8)}  ${c.ceiling! >= c.target ? "clears" : "SHORT"}`);
  }
}
