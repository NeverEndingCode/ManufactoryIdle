// The drawer's projection (W-13, Q-1, Q-2): the actions applied to a copy of the display
// state, with only the cost's shortfall credited to `bound`, then one scheduleDetail and a
// diff against the display solve. Client against client, so no cross-engine noise.
import {
  applyBatch,
  D,
  DECIMAL_ZERO,
  liquid,
  SPEND_RESIDUAL_TOLERANCE,
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
import { fmt } from "./notation.js";
import { rateText } from "./derive.js";
import { creditedState, creditFor, isSpend, quote } from "./quote.js";

export interface RateDelta {
  itemId: ItemId;
  before: number;
  after: number;
}

export type Preview =
  | {
      ok: true;
      effects: Effect[];
      /** The shortfall Q-1 credits, as creditFor reports it. */
      credit: Map<ItemId, Dec>;
      /** applyBatch's state: what the server would hold right after the batch. */
      state: WorldState;
      /** scheduleDetail(state).solution: the solve of `detailState`, not of `state`. */
      solution: Solution;
      /** scheduleDetail's state: `state` advanced past any internal unpins, which is the
       * state `solution` and every "after" rate come from. */
      detailState: WorldState;
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

function relativeChange(d: RateDelta): number {
  return Math.abs(d.after - d.before) / Math.max(Math.abs(d.before), RATE_TOLERANCE);
}

/** A broken invariant in compute: the drawer shows "preview unavailable" instead of crashing. */
class PreviewInvariantError extends Error {}

export const PREVIEW_UNAVAILABLE = "preview unavailable";

function compute(s: Snapshot, actions: readonly Action[]): Preview {
  const base = s.display.state;
  const spend = actions.find(isSpend);
  const q = spend === undefined ? null : quote(s.content, base, spend);
  const credit = q === null ? new Map<ItemId, Dec>() : creditFor(base, q);
  const credited = q === null || credit.size === 0 ? base : creditedState(base, q);
  const r = applyBatch(credited, s.content, actions, base.seed);
  if (r.rejected) return { ok: false, reason: r.reason };
  // A credited item the action also refunds can only be credited to `bound`, which leaves a
  // residue of a few ULPs in its liquid stock after the spend. The purchase at the moment it
  // becomes affordable drains every credited item to exactly zero, so snap a residue there:
  // EMPTY, not FLOWING. A residue past SPEND_RESIDUAL_TOLERANCE is a bug, not rounding.
  let snapped = r.state;
  for (const itemId of credit.keys()) {
    const residue = liquid(snapped, itemId);
    if (residue.lte(DECIMAL_ZERO)) continue;
    if (residue.gt(q!.cost.get(itemId)!.times(SPEND_RESIDUAL_TOLERANCE))) {
      throw new PreviewInvariantError(`preview: "${itemId}" is left with a residue of ${residue.toString()}`);
    }
    snapped = {
      ...snapped,
      stored: { ...snapped.stored, [itemId]: DECIMAL_ZERO },
      quantum: { ...snapped.quantum, [itemId]: DECIMAL_ZERO },
    };
  }

  const before = s.display.solution;
  const detail = scheduleDetail(snapped, s.content);
  const after = detail.solution;
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
    state: snapped,
    solution: after,
    detailState: detail.state,
    deltas,
    power: { before: before.power, after: after.power },
    bottleneck: { before: before.bottleneck, after: after.bottleneck },
  };
}

/** base = s.display.state; credit = creditFor(base, quote(base, spend)); applyBatch on
 * creditedState (each short item drained exactly); scheduleDetail. At most one SpendAction in `actions` (throws otherwise).
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
  let p: Preview;
  try {
    p = compute(s, actions);
  } catch (err) {
    if (!(err instanceof PreviewInvariantError)) throw err;
    console.error(err.message);
    p = { ok: false, reason: PREVIEW_UNAVAILABLE };
  }
  bySnapshot.set(key, p);
  return p;
}

function mw(n: number): string {
  return fmt(D(n));
}

function powerChanged(p: { before: PowerReport; after: PowerReport }): boolean {
  const { before: b, after: a } = p;
  const moved = (x: number, y: number) => Math.abs(x - y) > RATE_TOLERANCE * Math.max(1, Math.abs(x));
  return moved(b.demandMw, a.demandMw) || moved(b.supplyMw, a.supplyMw);
}

/** The advice with its mark dropped: buying a machine can change only which mark is advised
 * (PL-1 steps down past an unpayable one), and that does not clear anything. */
function adviceOf(b: Bottleneck): unknown {
  if (b === null || !("mark" in b)) return b;
  const { mark: _mark, ...rest } = b;
  return rest;
}

/** Whether the bottleneck itself moved, ignoring a change of advised mark alone. */
export function bottleneckMoved(p: { before: Bottleneck; after: Bottleneck }): boolean {
  return JSON.stringify(adviceOf(p.after)) !== JSON.stringify(adviceOf(p.before));
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
  if (bottleneckMoved(p.bottleneck)) lines.push("Clears the bottleneck");
  if (p.deltas.length === 0 && !power) lines.push("No change to rates now");
  return lines;
}
