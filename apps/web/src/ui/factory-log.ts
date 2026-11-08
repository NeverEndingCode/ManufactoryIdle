// U-9a: the factory log. logEntries is pure: one adoption's drafts, in L-8's order (the
// purchase, the tier-up, storage full in content order, then the bottleneck). The book keeps
// them: the dedupe on the client's monotonic clock (L-8), a 200-line ring, and a reset on every
// adoption with prev === null, which is the first snapshot of a session and every world change
// (L-4). Each line has two voices (L-5): `text` with the terminal's ids, `said` with content
// names, so a screen reader never hears an id. Numbers are formatted once, at creation.
import { itemStateTag, liquidCap, type Action, type ItemId } from "@manufactory/engine";
import type { Batch } from "../sync/outbox.js";
import type { Snapshot } from "../sync/snapshot.js";
import type { AdoptEvent } from "../sync/store.js";
import {
  BOTTLENECK_BUY_LABEL,
  bottleneckKey,
  bottleneckRow,
  laneItemIds,
  rateText,
  unlockedLanes,
  type BottleneckModel,
} from "./derive.js";
import { mwText } from "./dock-model.js";
import { itemLabel, laneLabel, machineLabel } from "./names.js";
import { fmt } from "./notation.js";
import type { ThemeDef } from "./theme.js";
import { unlockSummary, unlockedAt, voiceTheme } from "./unlocks.js";

export type LogTone = "normal" | "advice" | "milestone";

export interface LogEntry {
  seq: number;
  /** The wall clock, for display only (U-9a). */
  atLocalMs: number;
  tone: LogTone;
  /** What the dedupe compares: buy:<batch id>, tier:<n>, full:<item>, bottleneck:<to-key>. */
  key: string;
  /** The shell voice, with ids. */
  text: string;
  /** The plain voice, with content names. */
  said: string;
}

export type LogDraft = Omit<LogEntry, "seq" | "atLocalMs">;

export const LOG_CAP = 200;
export const DEDUPE_MS = 60_000;
export const FULL_EVERY_MS = 600_000;

const SHELL = voiceTheme("shell");
const PLAIN = voiceTheme("plain");

type Spend = Extract<
  Action,
  { type: "BUY_MACHINE" | "DISMANTLE" | "UPGRADE_MARK" | "BUY_STORAGE" | "BUY_QS" }
>;

/** L-6: the player's spends. Anything else in a batch (a setting, a tap) logs nothing. */
function isSpend(a: Action): a is Spend {
  return (
    a.type === "BUY_MACHINE" ||
    a.type === "DISMANTLE" ||
    a.type === "UPGRADE_MARK" ||
    a.type === "BUY_STORAGE" ||
    a.type === "BUY_QS"
  );
}

/** L-6: drawer:<item>:<verb> → the item; the bottleneck buy → prev's framed item; anything else
 *  (a generator's power:<class>:<verb> included) → null. */
export function itemOfLabel(label: string, prev: Snapshot): ItemId | null {
  if (label === BOTTLENECK_BUY_LABEL) return bottleneckRow(prev)?.itemId ?? null;
  const parts = label.split(":");
  if (parts.length === 3 && parts[0] === "drawer" && prev.content.items.has(parts[1]!))
    return parts[1]!;
  return null;
}

const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** One line in both voices: `line` is called with the terminal's names, then the plain ones. */
function draft(tone: LogTone, key: string, line: (theme: ThemeDef) => string): LogDraft {
  return { tone, key, text: line(SHELL), said: capitalise(line(PLAIN)) };
}

/** "+0.4 → +1.2/s": one /s. */
function rateChange(prev: Snapshot, next: Snapshot, itemId: ItemId): string {
  const net = (s: Snapshot) => s.schedule.items[itemId]?.netPerSecond ?? 0;
  return `${rateText(net(prev)).replace(/\/s$/, "")} → ${rateText(net(next))}`;
}

function nextMark(s: Snapshot, machineClass: string, fromMark: number): number {
  const marks = s.content.machineClasses.get(machineClass)?.marks ?? [];
  const above = marks.map((m) => m.mark).filter((m) => m > fromMark);
  return above.length === 0 ? fromMark + 1 : Math.min(...above);
}

function purchase(prev: Snapshot, next: Snapshot, settled: Batch): LogDraft | null {
  const a = settled.actions.find(isSpend);
  if (a === undefined) return null;
  const key = `buy:${settled.id}`;
  switch (a.type) {
    case "BUY_STORAGE": {
      const cap = (s: Snapshot) => fmt(liquidCap(s.content, s.state, a.itemId));
      return draft(
        "normal",
        key,
        (t) =>
          `storage +${a.levels} ${itemLabel(next, a.itemId, t)} · cap ${cap(prev)} → ${cap(next)}`,
      );
    }
    case "BUY_QS":
      return {
        tone: "normal",
        key,
        text: `qs +${a.levels} --lane ${laneLabel(next, a.lane, SHELL)}`,
        said: `Quantum storage +${a.levels} · ${laneLabel(next, a.lane, PLAIN)} lane`,
      };
    default: {
      const machine = (t: ThemeDef) =>
        a.type === "UPGRADE_MARK"
          ? `upgraded ${machineLabel(next, a.machineClass, a.fromMark, t)} → ${machineLabel(next, a.machineClass, nextMark(next, a.machineClass, a.fromMark), t)}`
          : `${a.type === "BUY_MACHINE" ? "bought" : "dismantled"} ${a.count} ${machineLabel(next, a.machineClass, a.mark, t)}`;
      const lane = (t: ThemeDef) => `${machine(t)} (${laneLabel(next, a.lane, t)})`;
      if (settled.label.startsWith("power:")) {
        // A generator (K-12): no item is named, so the grid's supply is.
        const mw = (s: Snapshot) => mwText(s.display.solution.power.supplyMw);
        return draft("normal", key, (t) => `${lane(t)} · grid ${mw(prev)} → ${mw(next)} MW`);
      }
      const itemId = itemOfLabel(settled.label, prev);
      if (itemId === null) return draft("normal", key, lane);
      return draft(
        "normal",
        key,
        (t) => `${lane(t)} · ${itemLabel(next, itemId, t)} ${rateChange(prev, next, itemId)}`,
      );
    }
  }
}

function tierUp(prev: Snapshot, next: Snapshot): LogDraft | null {
  const tier = next.state.tier;
  if (tier <= prev.state.tier) return null;
  const u = unlockedAt(next.content, tier);
  return draft("milestone", `tier:${tier}`, (t) => {
    const summary = unlockSummary(next, u, t.voice);
    const word = t.voice === "shell" ? "TIER" : "tier";
    return `${word} ${tier} reached${summary === "" ? "" : ` · ${summary} unlocked`}`;
  });
}

/** U-9a: each item shown as a row in `next` that gains FULL, in content order. */
function storageFull(prev: Snapshot, next: Snapshot): LogDraft[] {
  const isFull = (s: Snapshot, id: ItemId) =>
    itemStateTag(s.content, s.display.state, id) === "FULL";
  return unlockedLanes(next)
    .flatMap((lane) => laneItemIds(next, lane.id))
    .filter((id) => isFull(next, id) && !isFull(prev, id))
    .map((id) =>
      draft(
        "normal",
        `full:${id}`,
        (t) => `${itemLabel(next, id, t)} storage full · raise it or use it`,
      ),
    );
}

/** L-7: the framed item's name, else "power" or "unlisted" for a frameless one. */
function bottleneckName(s: Snapshot, b: BottleneckModel, t: ThemeDef): string {
  if (b.itemId !== null) return itemLabel(s, b.itemId, t);
  return s.display.solution.bottleneck?.kind === "power" ? "power" : "unlisted";
}

function bottleneck(prev: Snapshot, next: Snapshot): LogDraft | null {
  const from = bottleneckRow(prev);
  const to = bottleneckRow(next);
  const toKey = bottleneckKey(to);
  if (bottleneckKey(from) === toKey) return null;
  const key = `bottleneck:${toKey ?? "none"}`;
  if (to === null) return draft("advice", key, () => "bottleneck cleared");
  if (from === null)
    return draft("advice", key, (t) => `bottleneck: ${bottleneckName(next, to, t)}`);
  return draft(
    "advice",
    key,
    (t) => `bottleneck moved: ${bottleneckName(prev, from, t)} → ${bottleneckName(next, to, t)}`,
  );
}

/** Pure: the drafts for one adoption, in L-8's order; no dedupe; [] when prev is null. */
export function logEntries(
  prev: Snapshot | null,
  next: Snapshot,
  settled: Batch | null,
): LogDraft[] {
  if (prev === null) return [];
  const out: LogDraft[] = [];
  const bought = settled === null ? null : purchase(prev, next, settled);
  if (bought !== null) out.push(bought);
  const tier = tierUp(prev, next);
  if (tier !== null) out.push(tier);
  out.push(...storageFull(prev, next));
  const moved = bottleneck(prev, next);
  if (moved !== null) out.push(moved);
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "14:02:11": the local wall clock, zero-padded. */
export function logTime(atLocalMs: number): string {
  const d = new Date(atLocalMs);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface FactoryLogBook {
  record(e: AdoptEvent): void;
  /** Oldest first; the same array object until a line is added or the log resets. */
  entries(): readonly LogEntry[];
  version(): number;
  subscribe(fn: () => void): () => void;
}

/** The book: `now` is the store's monotonic clock (the windows), `wallNow` the display time. */
export function createFactoryLog(d: { now(): number; wallNow?: () => number }): FactoryLogBook {
  const wallNow = d.wallNow ?? Date.now;
  let entries: readonly LogEntry[] = [];
  let version = 0;
  let seq = 0;
  /** When each key last logged: the 60 s window, and storage full's 10 min one. Never pruned,
   *  and needn't be: they're bounded by the content, not by time. Purchases never enter them;
   *  lastFull holds at most one full:<item> per item, and lastSaid one tier:<n> per tier plus
   *  the bottleneck:<to-key> keys (one per item, the frameless one and "none"). Both are
   *  cleared with the log on a new session or world. */
  const lastSaid = new Map<string, number>();
  const lastFull = new Map<string, number>();
  const listeners = new Set<() => void>();
  const changed = () => {
    version++;
    for (const fn of [...listeners]) fn();
  };

  /** Purchases are never deduped (L-6): a second identical buy is a second action. */
  function keep(draft: LogDraft, now: number): boolean {
    if (draft.key.startsWith("buy:")) return true;
    const [seen, window] = draft.key.startsWith("full:")
      ? [lastFull, FULL_EVERY_MS]
      : [lastSaid, DEDUPE_MS];
    const last = seen.get(draft.key);
    if (last !== undefined && now - last < window) return false;
    seen.set(draft.key, now);
    return true;
  }

  return {
    record(e) {
      if (e.prev === null) {
        // L-4: a new session or a new world. Its first snapshot logs nothing.
        entries = [];
        lastSaid.clear();
        lastFull.clear();
        changed();
        return;
      }
      const now = d.now();
      const kept = logEntries(e.prev, e.next, e.settled).filter((x) => keep(x, now));
      if (kept.length === 0) return;
      const at = wallNow();
      const added = kept.map((x) => ({ ...x, seq: seq++, atLocalMs: at }));
      entries = [...entries, ...added].slice(-LOG_CAP);
      changed();
    },
    entries: () => entries,
    version: () => version,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
