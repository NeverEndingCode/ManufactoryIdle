import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundleDir, serialiseDerived, type Derived } from "@manufactory/content";
import { afterEach, describe, expect, it } from "vitest";
import { CALIBRATION_FIXTURE_DIR } from "./bootstrap.js";
import { calibrateOptionsFromFlags, runCalibration } from "./calibrate-cli.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway copy of the frozen calibration fixture: nothing here writes to the real one. */
function tempBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "calibrate-cli-"));
  temps.push(dir);
  cpSync(CALIBRATION_FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

const BASE = { policy: "greedy", seed: 42, tolerance: 0.05, solveREff: false } as const;

describe("a partial --write (ruling C-1)", () => {
  it("is refused, names --merge, and leaves derived.yaml alone when none existed", () => {
    const dir = tempBundle();
    expect(() => runCalibration({ ...BASE, contentDir: dir, maxTier: 1, write: true })).toThrow(
      /--merge/,
    );
    expect(existsSync(join(dir, "derived.yaml"))).toBe(false);
  });

  it("is refused and leaves an existing derived.yaml byte-identical", () => {
    const dir = tempBundle();
    const path = join(dir, "derived.yaml");
    writeFileSync(path, "# hand-placed sentinel\nderived: {}\n");
    const before = readFileSync(path);
    expect(() => runCalibration({ ...BASE, contentDir: dir, maxTier: 1, write: true })).toThrow(
      /--merge/,
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe("--merge", () => {
  it("keeps the higher tiers' amounts, nulls their observations, and loads", () => {
    const dir = tempBundle();
    const authored = loadBundleDir(dir, { applyDerived: false });
    const tierCount = Math.max(...authored.milestones.map((m) => m.tier));
    expect(tierCount).toBeGreaterThan(1);
    // Distinctive amounts, so "kept" cannot be confused with "re-solved".
    const previous: Derived = {
      run: {
        calibratedAt: "2020-01-01T00:00:00.000Z",
        policy: "greedy",
        seed: 42,
        targetCollectionsToTier: authored.pacing.targetCollectionsToTier,
        observedCollectionsToTier: authored.milestones.map((m) => m.tier + 0.5),
      },
      milestones: authored.milestones.map((m) => ({
        tier: m.tier,
        requires: m.requires.map((r) => ({ item: r.item, amount: r.amount + 7 })),
      })),
    };
    writeFileSync(join(dir, "derived.yaml"), serialiseDerived(previous));

    runCalibration({ ...BASE, contentDir: dir, maxTier: 1, write: true, merge: true });

    const written = loadBundleDir(dir, { applyDerived: false }).derived!;
    const byTier = new Map(written.milestones!.map((m) => [m.tier, m]));
    expect(written.milestones!.map((m) => m.tier).sort((a, b) => a - b)).toEqual(
      previous.milestones!.map((m) => m.tier).sort((a, b) => a - b),
    );
    for (const old of previous.milestones!) {
      if (old.tier === 1) continue;
      expect(byTier.get(old.tier)!.requires).toEqual(old.requires);
    }
    const observed = written.run!.observedCollectionsToTier;
    expect(observed).toHaveLength(tierCount);
    expect(observed[0]).not.toBeNull();
    expect(observed.slice(1).every((o) => o === null)).toBe(true);
    // Tier 1 was re-solved this run, not carried over.
    expect(byTier.get(1)!.requires).not.toEqual(previous.milestones!.find((m) => m.tier === 1)!.requires);
    // And the merged file is one the loader accepts, overlay included.
    expect(() => loadBundleDir(dir)).not.toThrow();
  }, 600_000);
});

describe("--scale (ruling C-2)", () => {
  it("is shorthand for --scales <s> --no-refine", () => {
    const options = calibrateOptionsFromFlags({
      policy: "greedy",
      seed: "42",
      tolerance: "0.05",
      write: false,
      "no-solve-reff": false,
      "no-refine": false,
      merge: false,
      scale: "0.5",
    });
    expect(options.scales).toEqual([0.5]);
    expect(options.refine).toBe(false);
  });

  it("leaves refinement on for --scales", () => {
    const options = calibrateOptionsFromFlags({
      policy: "greedy",
      seed: "42",
      tolerance: "0.05",
      write: false,
      "no-solve-reff": false,
      "no-refine": false,
      merge: false,
      scales: "0.5, 1",
    });
    expect(options.scales).toEqual([0.5, 1]);
    expect(options.refine).toBe(true);
  });
});
