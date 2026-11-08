// U-9b / L-12 / L-13: the ten-minute sparklines. A ring of ten one-minute buckets per world,
// kept beside the store and outside React, fed on each adoption: the previous snapshot's segment
// [prev.atMs, min(next.atMs, prev.nextBoundaryAtMs)) is credited, time-weighted, at its own
// rates. Time no snapshot covered (a hidden tab, offline) stays unknown, drawn "·". The open
// segment of the latest snapshot is credited at read time and never stored.
//
// The cost is bounded: ten slots, each a map over the items of the schedules credited into it,
// so at most 10 × (catalog items) numbers. A slot is reused by the minute ten minutes on, which
// drops whatever it held (an item that has gone included). Nothing is persisted.
import type { ItemId } from "@manufactory/engine";
import { serverNow, type Snapshot } from "../sync/snapshot.js";
import type { AdoptEvent } from "../sync/store.js";

export const TREND_BUCKETS = 10;
export const BUCKET_MS = 60_000;
/** A window whose range is within 2% of its largest magnitude is drawn flat, and is "steady". */
export const STEADY_BAND = 0.02;

export type TrendWord = "rising" | "falling" | "steady";

export interface TrendBook {
  /** Resets on prev === null (L-4); else credits prev's segment. Bumps the version. */
  record(e: AdoptEvent): void;
  /** Oldest first; the open segment of `latest` credited up to serverMs, not stored. */
  window(itemId: ItemId, latest: Pick<Snapshot, "schedule">, serverMs: number): (number | null)[];
  version(): number;
  /** Arms the minute timer while anyone is subscribed (L-12). */
  subscribe(fn: () => void): () => void;
  /** Test-only: the slots holding a minute, and the numbers in them. */
  size(): { slots: number; numbers: number };
}

interface Slot {
  key: number;
  coveredMs: number;
  /** Per item: the sum of rate × ms over the covered time. */
  sums: Map<ItemId, number>;
}

const EMPTY = Number.NEGATIVE_INFINITY;
const emptySlot = (): Slot => ({ key: EMPTY, coveredMs: 0, sums: new Map() });
const slotOf = (key: number) => ((key % TREND_BUCKETS) + TREND_BUCKETS) % TREND_BUCKETS;
const mod = (a: number, b: number) => ((a % b) + b) % b;

/** [start, end) cut at the minutes, as [bucket key, ms] pairs; only the last ten minutes of it,
 * so a long uncut segment costs ten steps, not one per minute. */
function pieces(start: number, end: number): [number, number][] {
  const out: [number, number][] = [];
  const last = Math.floor(end / BUCKET_MS);
  let t = Math.max(start, (last - (TREND_BUCKETS - 1)) * BUCKET_MS);
  while (t < end) {
    const key = Math.floor(t / BUCKET_MS);
    const until = Math.min(end, (key + 1) * BUCKET_MS);
    out.push([key, until - t]);
    t = until;
  }
  return out;
}

/** Where a snapshot's rates stop being known: its boundary, or never. */
const boundaryOf = (s: Pick<Snapshot, "schedule">) => s.schedule.nextBoundaryAtMs ?? Infinity;

export function createTrendBook(d: {
  later(fn: () => void, ms: number): () => void;
  now(): number;
}): TrendBook {
  let ring: Slot[] = Array.from({ length: TREND_BUCKETS }, emptySlot);
  /** L-13's fence: the furthest server ms credited. Every credit starts at or after it. */
  let committedTo = Number.NEGATIVE_INFINITY;
  /** The last adopted snapshot: the server clock for the minute timer. */
  let latest: Pick<Snapshot, "schedule" | "receivedAt"> | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  let cancel: (() => void) | null = null;

  const bump = () => {
    version++;
    for (const fn of [...listeners]) fn();
  };

  function disarm() {
    cancel?.();
    cancel = null;
  }

  /** One timer for the next server minute, while subscribed and the clock is known. */
  function arm() {
    disarm();
    if (listeners.size === 0 || latest === null) return;
    const ms = serverNow(latest as Snapshot, d.now());
    cancel = d.later(
      () => {
        cancel = null;
        bump();
        arm();
      },
      BUCKET_MS - mod(ms, BUCKET_MS),
    );
  }

  function credit(s: Pick<Snapshot, "schedule">, start: number, end: number) {
    const from = Math.max(start, committedTo);
    if (!(end > from)) return;
    const rates = Object.entries(s.schedule.items);
    for (const [key, ms] of pieces(from, end)) {
      let slot = ring[slotOf(key)]!;
      // An older minute than the slot holds is out of the window already.
      if (slot.key > key) continue;
      if (slot.key < key) slot = ring[slotOf(key)] = { key, coveredMs: 0, sums: new Map() };
      slot.coveredMs += ms;
      for (const [id, r] of rates)
        slot.sums.set(id, (slot.sums.get(id) ?? 0) + r.netPerSecond * ms);
    }
    committedTo = Math.max(committedTo, end);
  }

  return {
    record({ prev, next }) {
      if (prev === null) {
        ring = Array.from({ length: TREND_BUCKETS }, emptySlot);
        committedTo = Number.NEGATIVE_INFINITY;
      } else {
        credit(prev, prev.schedule.atMs, Math.min(next.schedule.atMs, boundaryOf(prev)));
      }
      latest = next;
      bump();
      // The first snapshot starts the clock, and a later one may move the server's against the
      // client's: (re-)aim the timer while anyone listens.
      if (listeners.size > 0) arm();
    },

    window(itemId, s, serverMs) {
      const now = Math.floor(serverMs / BUCKET_MS);
      const rate = s.schedule.items[itemId]?.netPerSecond ?? 0;
      const open = new Map(
        pieces(Math.max(s.schedule.atMs, committedTo), Math.min(serverMs, boundaryOf(s))),
      );
      const out: (number | null)[] = [];
      for (let key = now - TREND_BUCKETS + 1; key <= now; key++) {
        const slot = ring[slotOf(key)]!;
        const mine = slot.key === key;
        const extra = open.get(key) ?? 0;
        const covered = (mine ? slot.coveredMs : 0) + extra;
        const sum = (mine ? (slot.sums.get(itemId) ?? 0) : 0) + rate * extra;
        out.push(covered > 0 ? sum / covered : null);
      }
      return out;
    },

    version: () => version,

    subscribe(fn) {
      listeners.add(fn);
      // Always: arm() cancels the live timer first, and after store.stop() (which drops the
      // timer and leaves `cancel` stale) a new subscriber re-arms.
      arm();
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) disarm();
      };
    },

    size() {
      const held = ring.filter((s) => s.key !== EMPTY);
      return { slots: held.length, numbers: held.reduce((n, s) => n + s.sums.size, 0) };
    },
  };
}

const CELLS = "▁▂▃▄▅▆▇█";
const UNKNOWN = "·";
const STEADY = "▄";

const known = (values: readonly (number | null)[]) => values.filter((v) => v !== null);

/** Inside the band: the range is within 2% of the largest magnitude (all zero included). */
function steady(vs: readonly number[]): boolean {
  const max = Math.max(...vs);
  const min = Math.min(...vs);
  return max - min <= STEADY_BAND * Math.max(...vs.map(Math.abs));
}

/** "▁▂…█" scaled per row from the window's min to its max; "·" for unknown; all "▄" when steady. */
export function sparkline(values: readonly (number | null)[]): string {
  const vs = known(values);
  if (vs.length === 0) return UNKNOWN.repeat(values.length);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const flat = steady(vs);
  return values
    .map((v) =>
      v === null
        ? UNKNOWN
        : flat
          ? STEADY
          : CELLS[Math.round(((v - min) / (max - min)) * (CELLS.length - 1))],
    )
    .join("");
}

/** The sign of the last known bucket minus the first, beyond the steady band; null with fewer
 * than two known. */
export function trendWord(values: readonly (number | null)[]): TrendWord | null {
  const vs = known(values);
  if (vs.length < 2) return null;
  const diff = vs.at(-1)! - vs[0]!;
  if (Math.abs(diff) <= STEADY_BAND * Math.max(...vs.map(Math.abs))) return "steady";
  return diff > 0 ? "rising" : "falling";
}

/** What a row draws: the cells, the word for its name, and down when its rate is below 0. */
export interface RowTrend {
  cells: string;
  word: TrendWord | null;
  down: boolean;
}

export function rowTrend(book: TrendBook, s: Snapshot, itemId: ItemId, serverMs: number): RowTrend {
  const values = book.window(itemId, s, serverMs);
  return {
    cells: sparkline(values),
    word: trendWord(values),
    down: (s.schedule.items[itemId]?.netPerSecond ?? 0) < 0,
  };
}
