#!/usr/bin/env node
// `pnpm content:check` — spec B.6. Exits non-zero on any error so CI fails the
// build on structurally broken content.
//
// With no arguments it checks *every* bundle under `bundles/`. That default is
// deliberate: this script was previously pinned to `bundles/fixture`, so the
// 44-recipe vertical slice was authored, shipped, and left entirely ungated —
// a green `content:check` said nothing about the content the game actually
// uses. Discovering the directory list means a new bundle cannot be added
// without being checked.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv, exit, stderr, stdout } from "node:process";
import { bundleChecksum } from "./checksum.js";
import { loadBundleDir } from "./load.js";
import { validateBundle } from "./validate/index.js";

const bundlesRoot = fileURLToPath(new URL("../bundles", import.meta.url));

function discoverBundles(): string[] {
  return readdirSync(bundlesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${bundlesRoot}/${e.name}`)
    .sort();
}

const dirs = argv.length > 2 ? argv.slice(2) : discoverBundles();
if (dirs.length === 0) {
  stderr.write(`no bundles found under ${bundlesRoot}\n`);
  exit(2);
}

let failed = false;

for (const dir of dirs) {
  let bundle;
  try {
    bundle = loadBundleDir(dir);
  } catch (error) {
    stderr.write(`check 1 (schema) failed for ${dir}:\n${String(error)}\n`);
    failed = true;
    continue;
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
    failed = true;
    continue;
  }

  stdout.write(
    `${bundle.version}: ${bundle.lanes.length} lanes, ${bundle.items.length} items, ` +
      `${bundle.recipes.length} recipes, ${bundle.machineClasses.length} machine classes\n` +
      `checksum ${bundleChecksum(bundle)}\n`,
  );
}

// Every bundle is checked before exiting, so one broken bundle does not hide
// the state of the others.
if (failed) exit(1);
