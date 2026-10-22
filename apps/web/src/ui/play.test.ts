// Q-14: "playable to tier 10", proven in process. A scripted player that decides only from the
// client's own builders (the priority list's reorderVisible, the drawer's idleMove and
// moveMachines, the frame's action and its affordability), applies each action to the state
// the client's numbers describe, and advances game time with resolve. pnpm test runs it to
// tier 6; the web-play CI job runs it to tier 10 (WEB_PLAY_TIER=10).
import {
  apply,
  applyBatch,
  initialWorld,
  installedMachines,
  resolve,
  type Action,
  type ItemId,
  type WorldState,
} from "@manufactory/engine";
import { beforeAll, describe, expect, it } from "vitest";
import type { Snapshot } from "../sync/snapshot.js";
import { bottleneckRow } from "./derive.js";
import { drawerModel, idleMove, moveMachines, type MachineSection } from "./machines.js";
import { reorderVisible, visiblePriority } from "./priority-model.js";
import { affordability } from "./quote.js";
import { CLIENT_T0, loadSlice, snapshotOf, type Slice } from "./test-fixtures.js";

const raw = process.env.WEB_PLAY_TIER;
const TARGET = raw ? Number(raw) : 6;
if (!Number.isInteger(TARGET) || TARGET < 1 || TARGET > 10) {
  throw new Error(`WEB_PLAY_TIER must be an integer from 1 to 10, got "${raw}"`);
}
const H = 3_600_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 30 * 60_000;
const LIMIT_MS = 400 * H;
/** Game-time bounds. The plan's probe measured 9.2 h to tier 6 and 132 h to tier 10; this
 * player measured 10.85 h and 180.8 h (2026-10-22). */
const BOUND_H = TARGET >= 10 ? 300 : 24;

let slice: Slice;
beforeAll(() => {
  slice = loadSlice();
});

interface Run {
  state: WorldState;
  tierAtH: Record<number, number>;
  rejected: string[];
  actions: number;
  decisions: number;
}

/** The next milestone's items, in `requires` order, at visible indices 1, 2, … (under power):
 * one REORDER_PRIORITY per item out of place. */
function reorders(s: Snapshot): Action[] {
  const next = s.content.milestoneByTier.get(s.display.state.tier + 1);
  if (!next) return [];
  const visible = visiblePriority(s).map((r) => r.entryId);
  let all = s.display.state.priority.map((e) => e.id);
  const out: Action[] = [];
  const wanted = [...new Set(next.requires.map((q) => `item:${q.item}`))].filter((id) =>
    visible.includes(id),
  );
  wanted.forEach((id, i) => {
    const shown = all.filter((x) => visible.includes(x));
    if (shown[i + 1] === id) return;
    all = reorderVisible(all, shown, id, i + 1);
    out.push({ type: "REORDER_PRIORITY", entries: all });
  });
  return out;
}

/** The lane-class's section, fresh from the snapshot. */
function sectionFor(s: Snapshot, lane: string, machineClass: string): MachineSection {
  return sections(s).find((x) => x.lane === lane && x.machineClass === machineClass)!;
}

/** Each installed lane-class's drawer section, from an item one of its recipes makes. */
function sections(s: Snapshot): MachineSection[] {
  const out: MachineSection[] = [];
  for (const ids of s.content.recipesByLaneClass.values()) {
    const first = s.content.recipes.get(ids[0]!);
    if (!first || installedMachines(s.display.state, first.lane, first.machineClass) === 0)
      continue;
    for (const id of ids) {
      const item: ItemId = s.content.recipes.get(id)!.primaryOutput;
      if (!s.content.items.has(item)) continue;
      const sec = drawerModel(s, item).machines;
      if (sec && sec.lane === first.lane && sec.machineClass === first.machineClass) {
        out.push(sec);
        break;
      }
    }
  }
  return out;
}

function play(target: number): Run {
  const { content } = slice;
  let state = initialWorld(content, 1, 0);
  const run: Run = { state, tierAtH: {}, rejected: [], actions: 0, decisions: 0 };
  const snap = () => snapshotOf(slice, state, { receivedAt: CLIENT_T0 });
  /** Applies a batch to s.display.state; the result becomes the state. */
  const act = (s: Snapshot, batch: readonly Action[]): boolean => {
    const r =
      batch.length === 1
        ? apply(s.display.state, content, batch[0]!, s.display.state.seed)
        : applyBatch(s.display.state, content, batch, s.display.state.seed);
    if (r.rejected) {
      run.rejected.push(`${r.reason}: ${JSON.stringify(batch)}`);
      return false;
    }
    const before = state.tier;
    state = r.state;
    run.actions += batch.length;
    if (state.tier > before) run.tierAtH[state.tier] = state.lastResolvedAt / H;
    return true;
  };

  while (state.tier < target && state.lastResolvedAt < LIMIT_MS) {
    run.decisions += 1;
    let s = snap();
    // 2. The next milestone's items just below power.
    for (const a of reorders(s)) if (act(s, [a])) s = snap();
    // 3. Idle machines to a starved recipe, per lane-class.
    for (const sec of sections(s)) {
      const fresh = sectionFor(s, sec.lane, sec.machineClass);
      const mv = idleMove(s, fresh);
      if (mv && act(s, moveMachines(fresh, mv.from, mv.to, mv.n))) s = snap();
    }
    // 4. The frame.
    const m = bottleneckRow(s);
    const aff = m?.action ? affordability(s, m.action, s.schedule.atMs) : null;
    if (m?.action && aff?.affordable && act(s, [m.action])) continue;
    // 5. Wait.
    const inMs = aff === null ? null : aff.affordable ? 0 : aff.inMs;
    const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, inMs ?? MAX_WAIT_MS));
    const before = state.tier;
    state = resolve(state, content, wait).state;
    if (state.tier > before) run.tierAtH[state.tier] = state.lastResolvedAt / H;
  }
  run.state = state;
  return run;
}

describe("the builder-only player (Q-14)", () => {
  it(
    `reaches tier ${TARGET} from the client's builders alone`,
    // Hang guards, not budgets: a shared CI runner ran several times slower than local (PR #23).
    // Measured locally: tier 6 about 7.6 s, tier 10 about 61 s. 480 s stays under the
    // web-play job's 10-minute cap.
    { timeout: TARGET >= 10 ? 480_000 : 180_000 },
    () => {
      const t0 = performance.now();
      const run = play(TARGET);
      const hours = run.state.lastResolvedAt / H;
      console.info(
        `web-play: tier ${run.state.tier} at ${hours.toFixed(2)} h game time, ` +
          `${run.actions} actions, ${run.decisions} decisions, ` +
          `${((performance.now() - t0) / 1000).toFixed(1)} s wall; tier hours ` +
          JSON.stringify(
            Object.fromEntries(Object.entries(run.tierAtH).map(([k, v]) => [k, +v.toFixed(2)])),
          ),
      );
      expect(run.rejected).toEqual([]);
      if (TARGET === 6) {
        // Pinned before the S-18 changes (Phase 4c): the player's run must not move.
        expect(run.actions).toBe(275);
        expect(run.tierAtH[6]).toBe(10.845218848871589);
      }
      expect(run.state.tier).toBeGreaterThanOrEqual(TARGET);
      expect(hours).toBeLessThanOrEqual(BOUND_H);
    },
  );
});
