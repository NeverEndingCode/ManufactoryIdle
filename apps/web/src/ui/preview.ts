// The drawer's projection (W-13, Q-1, Q-2): the actions applied to a copy of the display
// state, with only the cost's shortfall credited to `bound`, then one scheduleDetail and a
// diff against the display solve. Client against client, so no cross-engine noise.
import {
  applyBatch,
  D,
  DECIMAL_ZERO,
  format,
  scheduleDetail,
  type Action,
  type Bottleneck,
  type Dec,
  type Effect,
  type ItemId,
  type LaneId,
  type PowerReport,
  type Solution,
  type WorldState,
} from "@manufactory/engine";
import type { Snapshot } from "../sync/snapshot.js";
import { rateText } from "./derive.js";
import { creditFor, isSpend, quote } from "./quote.js";

export interface RateDelta {
  itemId: ItemId;
  before: number;
  after: number;
}

export type Preview =
  | {
      ok: true;
      credit: Map<ItemId, Dec>;
      effects: Effect[];
      /** applyBatch's state: what the server would hold right after the batch. */
      state: WorldState;
      /** scheduleDetail(state).solution. */
      solution: Solution;
      /** |after − before| > 1e-9 · max(1, |before|), largest relative change first. */
      deltas: RateDelta[];
      power: { before: PowerReport; after: PowerReport };
      bottleneck: { before: Bottleneck; after: Bottleneck };
    }
  /** The reducer's own rejection text. */
  | { ok: false; reason: string };

const RATE_TOLERANCE = 1e-9;
const MAX_RATE_LINES = 4;

const memo = new WeakMap<Snapshot, Map<string, Preview>>();

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function withCredit(state: WorldState, credit: ReadonlyMap<ItemId, Dec>): WorldState {
  if (credit.size === 0) return state;
  const bound = new Map<ItemId, Dec>(Object.entries(state.bound));
  for (const [itemId, amount] of credit) {
    bound.set(itemId, (own(state.bound, itemId) ?? DECIMAL_ZERO).plus(amount));
  }
  return { ...state, bound: Object.fromEntries(bound) };
}

function relativeChange(d: RateDelta): number {
  return Math.abs(d.after - d.before) / Math.max(Math.abs(d.before), RATE_TOLERANCE);
}

function compute(s: Snapshot, actions: readonly Action[]): Preview {
  const base = s.display.state;
  const spend = actions.find(isSpend);
  const credit = spend === undefined ? new Map<ItemId, Dec>() : creditFor(base, quote(s.content, base, spend));
  const r = applyBatch(withCredit(base, credit), s.content, actions, base.seed);
  if (r.rejected) return { ok: false, reason: r.reason };

  const before = s.display.solution;
  const after = scheduleDetail(r.state, s.content).solution;
  const deltas: RateDelta[] = [];
  for (const itemId of s.content.stockItemIds) {
    const b = before.itemRates.get(itemId)?.net ?? 0;
    const a = after.itemRates.get(itemId)?.net ?? 0;
    if (Math.abs(a - b) > RATE_TOLERANCE * Math.max(1, Math.abs(b))) {
      deltas.push({ itemId, before: b, after: a });
    }
  }
  // Stable, so equal changes keep the bundle's order.
  deltas.sort((x, y) => relativeChange(y) - relativeChange(x));
  return {
    ok: true,
    credit,
    effects: r.effects,
    state: r.state,
    solution: after,
    deltas,
    power: { before: before.power, after: after.power },
    bottleneck: { before: before.bottleneck, after: after.bottleneck },
  };
}

/** base = s.display.state; credit = creditFor(base, quote(base, spend)); applyBatch with the
 * credit in bound; scheduleDetail. At most one SpendAction in `actions` (throws otherwise).
 * Memoised per (snapshot, JSON.stringify(actions)). */
export function preview(s: Snapshot, actions: readonly Action[]): Preview {
  if (actions.filter(isSpend).length > 1) {
    throw new Error("preview: at most one spend per batch");
  }
  let bySnapshot = memo.get(s);
  if (bySnapshot === undefined) {
    bySnapshot = new Map();
    memo.set(s, bySnapshot);
  }
  const key = JSON.stringify(actions);
  const hit = bySnapshot.get(key);
  if (hit !== undefined) return hit;
  const p = compute(s, actions);
  bySnapshot.set(key, p);
  return p;
}

function mw(n: number): string {
  return format(D(n), "hybrid");
}

function powerChanged(p: { before: PowerReport; after: PowerReport }): boolean {
  const { before: b, after: a } = p;
  const moved = (x: number, y: number) => Math.abs(x - y) > RATE_TOLERANCE * Math.max(1, Math.abs(x));
  return moved(b.demandMw, a.demandMw) || moved(b.supplyMw, a.supplyMw);
}

/** Plain lines for the drawer: "Iron Plate +0.333/s → +0.667/s", "Power 22.0 / 200 MW →
 * 26.0 / 200 MW", "Clears the bottleneck" when the bottleneck moves, or "No change to rates
 * now" (pillar 4). The lane's items first, at most four rate lines. A rejection is its reason. */
export function previewLines(s: Snapshot, p: Preview, laneId: LaneId): string[] {
  if (!p.ok) return [p.reason];
  const inLane = (d: RateDelta) => s.content.items.get(d.itemId)?.lane === laneId;
  const ordered = [...p.deltas.filter(inLane), ...p.deltas.filter((d) => !inLane(d))];
  const lines = ordered
    .slice(0, MAX_RATE_LINES)
    .map(
      (d) =>
        `${s.content.items.get(d.itemId)?.name ?? d.itemId} ${rateText(d.before)} → ${rateText(d.after)}`,
    );
  const power = powerChanged(p.power);
  if (power) {
    const { before: b, after: a } = p.power;
    lines.push(
      `Power ${mw(b.demandMw)} / ${mw(b.supplyMw)} MW → ${mw(a.demandMw)} / ${mw(a.supplyMw)} MW`,
    );
  }
  if (JSON.stringify(p.bottleneck.after) !== JSON.stringify(p.bottleneck.before)) {
    lines.push("Clears the bottleneck");
  }
  if (p.deltas.length === 0 && !power) lines.push("No change to rates now");
  return lines;
}
