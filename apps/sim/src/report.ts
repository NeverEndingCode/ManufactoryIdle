// Spec E.2's report, in collections rather than hours per spec 16.2: with an 8h
// offline cap a player gets about three meaningful collections a day, so a tier
// costing 40 collections is a two-week tier no matter what the hour count claims.
//
// This file is where Math.pow becomes legal again. r_eff = r / m needs
// m = step^(1/interval), a fractional power, which spec E.4 bans from
// state-affecting paths -- and this is a reporting figure that never re-enters
// state, which is exactly why the engine's economy module does not compute it.
import type { IndexedContent, LaneId, MachineClassId } from "@manufactory/engine";
import type { PolicyName } from "./policies.js";

export interface TierMark {
  tier: number;
  atMs: number;
  collections: number;
}

export interface REffRow {
  lane: LaneId;
  machineClass: MachineClassId;
  authored: number;
  observed: number | null;
}

export interface RunReport {
  policy: PolicyName;
  contentVersion: string;
  seed: number;
  reachedTier: number;
  finished: boolean;
  simulatedMs: number;
  collections: number;
  tierTimes: TierMark[];
  /** Spec 16.6's pace-decay detector, as a hard number. */
  maxDeadTimeMs: number;
  purchases: number;
  bindingConstraints: { recipeId: string; boundMs: number }[];
  rEff: REffRow[];
}

/** r_eff = r / m, where m is the ladder's multiplier growth per machine (spec D3). */
export function authoredREff(content: IndexedContent, machineClass: MachineClassId): number {
  const cls = content.machineClasses.get(machineClass);
  if (!cls) return Number.NaN;
  const m = Math.pow(cls.ladder.step, 1 / cls.ladder.interval);
  return cls.costRatio / m;
}

/**
 * The same figure measured over a run: cost growth per machine divided by
 * multiplier growth per machine, across the machines actually bought.
 *
 * Counts are the mark-weighted ladder input, which is exact while a run stays on one
 * mark and an approximation across a mark boundary, where the cost curve resets but
 * the ladder does not (spec B.2). Phase 2's calibration measures per-mark segments.
 */
export function observedREff(
  costRatio: number,
  ladderStep: number,
  ladderInterval: number,
  fromCount: number,
  toCount: number,
): number | null {
  const delta = toCount - fromCount;
  if (delta <= 0) return null;
  const costGrowth = Math.pow(costRatio, delta);
  const stepsBefore = Math.floor(fromCount / ladderInterval);
  const stepsAfter = Math.floor(toCount / ladderInterval);
  const multiplierGrowth = Math.pow(ladderStep, stepsAfter - stepsBefore);
  return Math.pow(costGrowth / multiplierGrowth, 1 / delta);
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

export function formatReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push(
    `policy ${report.policy}  content ${report.contentVersion}  seed ${report.seed}  ` +
      `${report.finished ? "finished" : "budget exhausted"}`,
  );
  lines.push(
    `reached tier ${report.reachedTier} in ${report.collections.toFixed(2)} collections ` +
      `(${duration(report.simulatedMs)}), ${report.purchases} purchases`,
  );
  lines.push("");
  lines.push("tier   collections   elapsed");
  for (const mark of report.tierTimes) {
    lines.push(
      `${String(mark.tier).padStart(4)}   ${mark.collections.toFixed(2).padStart(11)}   ` +
        duration(mark.atMs),
    );
  }
  lines.push("");
  lines.push(`max dead time between meaningful events: ${duration(report.maxDeadTimeMs)}`);
  lines.push("");
  lines.push("binding constraint            time bound");
  for (const row of report.bindingConstraints.slice(0, 8)) {
    lines.push(`${row.recipeId.padEnd(28)}  ${duration(row.boundMs)}`);
  }
  lines.push("");
  lines.push("lane / class                  r_eff authored   observed");
  for (const row of report.rEff) {
    lines.push(
      `${`${row.lane}/${row.machineClass}`.padEnd(28)}  ${row.authored.toFixed(4).padStart(15)}   ` +
        (row.observed === null ? "       -" : row.observed.toFixed(4).padStart(8)),
    );
  }
  return lines.join("\n");
}
