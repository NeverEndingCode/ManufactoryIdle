#!/usr/bin/env node
// `pnpm content:check` — spec B.6. Exits non-zero on any error so CI fails the
// build on structurally broken content.
import { argv, exit, stderr, stdout } from "node:process";
import { bundleChecksum } from "./checksum.js";
import { loadBundleDir } from "./load.js";
import { validateBundle } from "./validate/index.js";

const dir = argv[2];
if (!dir) {
  stderr.write("usage: content:check <bundle-directory>\n");
  exit(2);
}

let bundle;
try {
  bundle = loadBundleDir(dir);
} catch (error) {
  stderr.write(`check 1 (schema) failed for ${dir}:\n${String(error)}\n`);
  exit(1);
}

const issues = validateBundle(bundle);
const errors = issues.filter((i) => i.severity === "error");
const warnings = issues.filter((i) => i.severity === "warning");

// Warnings print but do not fail: a cyclic recipe is unselectable, not broken
// content (spec B.6 check 6). They go to stderr so a green build still surfaces them.
if (warnings.length > 0) {
  stderr.write(`${warnings.length} warning(s) in ${dir}:\n`);
  for (const i of warnings) stderr.write(`  [check ${i.check}] ${i.message}\n`);
}

if (errors.length > 0) {
  stderr.write(`${errors.length} problem(s) in ${dir}:\n`);
  for (const i of errors) stderr.write(`  [check ${i.check}] ${i.message}\n`);
  exit(1);
}

stdout.write(
  `${bundle.version}: ${bundle.lanes.length} lanes, ${bundle.items.length} items, ` +
    `${bundle.recipes.length} recipes, ${bundle.machineClasses.length} machine classes\n` +
    `checksum ${bundleChecksum(bundle)}\n`,
);
