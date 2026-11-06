// U-4: the command line's words, pure. The command (U-4a), the phone's short form (U-4b), the
// run button's visible label and accessible name (V-17), and the NEXT_BUY model (U-4c), all
// from bottleneckRow's model plus the snapshot. Nothing new reaches the store.
import {
  DECIMAL_ZERO,
  liquidCap,
  type ItemId,
  type LaneId,
  type MachineClassId,
} from "@manufactory/engine";
import { shownStock } from "../sync/interpolate.js";
import type { Snapshot } from "../sync/snapshot.js";
import {
  className,
  isPowerTarget,
  plural,
  rateText,
  type BottleneckModel,
  type BuyMachine,
  type FrameAction,
} from "./derive.js";
import { itemLabel, itemName, laneLabel, machineLabel } from "./names.js";
import { fmt } from "./notation.js";
import { preview } from "./preview.js";
import type { Affordability } from "./quote.js";
import { quote } from "./quote.js";
import { themeDef, type ThemeDef, type Voice } from "./theme.js";

export type FrameSpend = Exclude<FrameAction, { type: "SET_RESERVE" }>;
export type RunKind = "bar" | "split" | "card" | "sheet";

/** The plain voice names things by their content names (V-16); what a reader hears (U-1h). */
export const PLAIN: ThemeDef = themeDef("clean-dark");

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const percent = (p: number) => `${Math.round(p * 100)}%`;

function laneName(s: Snapshot, lane: LaneId): string {
  return s.content.lanes.get(lane)?.name ?? lane;
}

function classSingular(s: Snapshot, machineClass: MachineClassId): string {
  return s.content.machineClasses.get(machineClass)?.name ?? machineClass;
}

/** "buy 4 constructor_mk1 --lane iron --for rotor" [Buy 4 Constructor Mk.1 for Rotor]. */
export function commandText(m: BottleneckModel | null, s: Snapshot, voice: Voice): string {
  if (m === null) return voice === "shell" ? "# all lines fed" : "Everything is running";
  const a = m.action;
  if (a === null) return voice === "shell" ? `# ${m.text.toLowerCase()}` : m.text;
  const shell = voice === "shell";
  switch (a.type) {
    case "BUY_MACHINE": {
      if (shell) {
        const machine = `${a.machineClass}_mk${a.mark}`.toLowerCase();
        const target = m.itemId === null ? "" : ` --for ${m.itemId.toLowerCase()}`;
        return `buy ${a.count} ${machine} --lane ${a.lane.toLowerCase()}${target}`;
      }
      const machine = machineLabel(s, a.machineClass, a.mark, PLAIN);
      const target = m.itemId === null ? "" : ` for ${itemName(s, m.itemId)}`;
      return `Buy ${a.count} ${machine}${target}`;
    }
    case "BUY_STORAGE":
      return shell
        ? `storage +${a.levels} ${a.itemId.toLowerCase()}`
        : `Buy storage for ${itemName(s, a.itemId)}`;
    case "BUY_QS":
      return shell
        ? `qs +${a.levels} --lane ${a.lane.toLowerCase()}`
        : `Buy Quantum Storage for ${laneName(s, a.lane)}`;
    case "SET_RESERVE":
      return shell
        ? `reserve ${a.itemId.toLowerCase()} ${percent(a.percent)}`
        : `Reserve ${percent(a.percent)} of ${itemName(s, a.itemId)}`;
  }
}

/** The phone's short form: "4 constructor → ROTOR" [4 Constructor → Rotor]. */
export function shortText(m: BottleneckModel | null, s: Snapshot, voice: Voice): string {
  const a = m?.action ?? null;
  if (m === null || a === null) return commandText(m, s, voice);
  const shell = voice === "shell";
  const item = (id: ItemId) => (shell ? id.toUpperCase() : itemName(s, id));
  switch (a.type) {
    case "BUY_MACHINE": {
      const machine = shell ? a.machineClass.toLowerCase() : classSingular(s, a.machineClass);
      return m.itemId === null
        ? `${a.count} ${machine}`
        : `${a.count} ${machine} → ${item(m.itemId)}`;
    }
    case "BUY_STORAGE":
      return `${shell ? "storage" : "Storage"} → ${item(a.itemId)}`;
    case "BUY_QS":
      return `${shell ? "qs" : "QS"} → ${shell ? a.lane.toUpperCase() : laneName(s, a.lane)}`;
    case "SET_RESERVE":
      return `${shell ? "reserve" : "Reserve"} ${percent(a.percent)} → ${item(a.itemId)}`;
  }
}

/** "[ buy 4 ]", "[ store ]", "[ qs ]", "[ reserve ]" [Buy 4, Store, QS, Reserve]. */
function verb(a: FrameAction, voice: Voice): string {
  const shell = voice === "shell";
  switch (a.type) {
    case "BUY_MACHINE":
      return shell ? `buy ${a.count}` : `Buy ${a.count}`;
    case "BUY_STORAGE":
      return shell ? "store" : "Store";
    case "BUY_QS":
      return shell ? "qs" : "QS";
    case "SET_RESERVE":
      return shell ? "reserve" : "Reserve";
  }
}

const seconds = (inMs: number) => Math.max(1, Math.ceil(inMs / 1000));

/**
 * The run button's visible label, from the frame's own logic (U-4a): busy reads "running…",
 * unaffordable counts down on the 4 Hz tick ("affordable in 12s", "[ 12s ]" on the phone) or
 * reads "not affordable yet"; otherwise "run" on the bar, the verb elsewhere ("[ buy 4 ]" on
 * the phone, "buy 4" on the card, whose key hint is its own span).
 */
export function runLabel(
  m: BottleneckModel,
  _s: Snapshot,
  voice: Voice,
  kind: RunKind,
  a: Affordability,
  busy: boolean,
): string {
  const shell = voice === "shell";
  const action = m.action;
  if (action === null) return "—";
  if (busy) return shell ? "running…" : "Running…";
  if (!a.affordable) {
    if (a.inMs === null) return shell ? "not affordable yet" : "Not affordable yet";
    const n = seconds(a.inMs);
    if (kind === "split" || kind === "sheet") return `[ ${n}s ]`;
    return shell ? `affordable in ${n}s` : `Affordable in ${n}s`;
  }
  if (kind === "bar") return shell ? "run" : "Run";
  if (kind === "card") return verb(action, voice);
  return shell ? `[ ${verb(action, voice)} ]` : verb(action, voice);
}

/** "Buy 1 Constructor", "Buy storage for Iron Plate", "Buy Quantum Storage for Iron" (the
 * frame's spendText, moved). */
export function spendText(s: Snapshot, a: FrameSpend): string {
  switch (a.type) {
    case "BUY_MACHINE":
      return `Buy ${a.count} ${className(s, a.machineClass, a.count)}`;
    case "BUY_STORAGE":
      return `Buy storage for ${itemName(s, a.itemId)}`;
    case "BUY_QS":
      return `Buy Quantum Storage for ${laneName(s, a.lane)}`;
  }
}

/** The reserve's name: "Reserve 30% of Screw" (the frame's ReserveButton text, moved). */
export function reserveText(s: Snapshot, a: Extract<FrameAction, { type: "SET_RESERVE" }>): string {
  return `Reserve ${percent(a.percent)} of ${itemName(s, a.itemId)}`;
}

/** V-17: the plain spend text, plus ", affordable in N seconds" when off. */
export function runName(m: BottleneckModel, s: Snapshot, a: Affordability): string {
  const action = m.action;
  if (action === null) return "Nothing to run";
  const base = action.type === "SET_RESERVE" ? reserveText(s, action) : spendText(s, action);
  if (a.affordable) return base;
  if (a.inMs === null) return `${base}, not affordable yet`;
  const n = seconds(a.inMs);
  return `${base}, affordable in ${n} ${plural(n, "second")}`;
}

/** U-4b: the left button's name, "Why: next buy is 4 Constructor for Rotor. Open details". */
export function whyName(m: BottleneckModel | null, s: Snapshot): string {
  const a = m?.action ?? null;
  let what: string;
  if (m === null) what = "everything is running";
  else if (a === null) what = m.text.replace(/\.$/, "");
  else {
    const target = m.itemId === null ? "" : ` for ${itemName(s, m.itemId)}`;
    switch (a.type) {
      case "BUY_MACHINE":
        what = `next buy is ${a.count} ${classSingular(s, a.machineClass)}${target}`;
        break;
      case "BUY_STORAGE":
        what = `next buy is storage for ${itemName(s, a.itemId)}`;
        break;
      case "BUY_QS":
        what = `next buy is Quantum Storage for ${laneName(s, a.lane)}`;
        break;
      case "SET_RESERVE":
        what = `next is a reserve of ${percent(a.percent)} of ${itemName(s, a.itemId)}`;
        break;
    }
  }
  return `Why: ${what}. Open details`;
}

export interface NextBuyModel {
  /** "+4 CONSTRUCTOR_MK1 → ROTOR" */
  action: string;
  /** Per bottleneck kind (U-4c). */
  why: string;
  /** "IRON" */
  lane: string | null;
  /** ["160 IRON_PLATE (have 3.2k)"] */
  cost: string[];
  /** ["ROTOR +0.4/s → +1.2/s"] | ["IRON_PLATE cap 10.0k → 15.0k"] | ["IRON quantum +1 level"] |
   * ["SCREW keeps 30% in stock"] */
  effect: string[];
  /** Only a BUY_MACHINE with count > 1. */
  buyOne: BuyMachine | null;
  /** The "open ROTOR" target. */
  open: ItemId | null;
}

/** The limiting target's name: "power", or its item's label in the theme. */
function targetLabel(s: Snapshot, limitingTarget: string, theme: ThemeDef): string {
  if (isPowerTarget(s, limitingTarget)) return "power";
  const entry = s.state.priority.find((e) => e.id === limitingTarget);
  if (entry?.itemId != null) return itemLabel(s, entry.itemId, theme);
  return limitingTarget;
}

function whyLine(s: Snapshot, m: BottleneckModel, theme: ThemeDef): string {
  const b = s.display.solution.bottleneck;
  if (b === null) return m.text;
  const target = targetLabel(s, b.limitingTarget, theme);
  const framed = m.itemId === null ? null : itemLabel(s, m.itemId, theme);
  switch (b.kind) {
    case "recipe":
      if (framed === null) return `limiting ${target}`;
      // The framed item is its own target: it's short of machines, not "X limits X".
      return framed === target ? `${framed} is short of machines` : `${framed} limits ${target}`;
    case "power":
      return `power limits ${target}`;
    case "storage":
      return `${itemLabel(s, b.itemId, theme)} is full, limiting ${target}`;
    case "reserve":
      return `${itemLabel(s, b.itemId, theme)} never banks, limiting ${target}`;
  }
}

/** A machine buy's effect on the framed item: preview's own delta, as rateText. */
export function machineEffect(
  s: Snapshot,
  m: BottleneckModel,
  action: BuyMachine,
  theme: ThemeDef,
): string {
  const p = preview(s, [action]);
  if (!p.ok) return p.reason;
  const d = m.itemId === null ? undefined : p.deltas.find((x) => x.itemId === m.itemId);
  const shown = d ?? p.deltas[0];
  if (shown === undefined) return "no change to rates now";
  return `${itemLabel(s, shown.itemId, theme)} ${rateText(shown.before)} → ${rateText(shown.after)}`;
}

function effectLines(s: Snapshot, m: BottleneckModel, a: FrameAction, theme: ThemeDef): string[] {
  switch (a.type) {
    case "BUY_MACHINE":
      return [machineEffect(s, m, a, theme)];
    case "BUY_STORAGE": {
      const level = own(s.state.storageLevel, a.itemId) ?? 0;
      const after = {
        ...s.state,
        storageLevel: { ...s.state.storageLevel, [a.itemId]: level + a.levels },
      };
      const before = liquidCap(s.content, s.state, a.itemId);
      const next = liquidCap(s.content, after, a.itemId);
      return [`${itemLabel(s, a.itemId, theme)} cap ${fmt(before)} → ${fmt(next)}`];
    }
    case "BUY_QS":
      return [`${laneLabel(s, a.lane, theme)} quantum +${a.levels} ${plural(a.levels, "level")}`];
    case "SET_RESERVE":
      return [`${itemLabel(s, a.itemId, theme)} keeps ${percent(a.percent)} in stock`];
  }
}

function actionLine(s: Snapshot, m: BottleneckModel, a: FrameAction, theme: ThemeDef): string {
  const to = (id: ItemId | null) => (id === null ? "" : ` → ${itemLabel(s, id, theme)}`);
  switch (a.type) {
    case "BUY_MACHINE":
      return `+${a.count} ${machineLabel(s, a.machineClass, a.mark, theme)}${to(m.itemId)}`;
    case "BUY_STORAGE":
      return `+${a.levels} storage${to(a.itemId)}`;
    case "BUY_QS":
      return `+${a.levels} qs → ${laneLabel(s, a.lane, theme)}`;
    case "SET_RESERVE":
      return `reserve ${percent(a.percent)}${to(a.itemId)}`;
  }
}

/** Only while the card/sheet is open (a preview costs ~2–13 ms). serverMs is the 4 Hz "have":
 * the shown stock plus bound, as affordability counts it (W-13). Null with nothing to run. */
export function nextBuyModel(
  s: Snapshot,
  m: BottleneckModel,
  serverMs: number,
  theme: ThemeDef,
): NextBuyModel | null {
  const a = m.action;
  if (a === null) return null;
  const cost: string[] = [];
  for (const [itemId, amount] of quote(s.content, s.state, a).cost) {
    const have = shownStock(s, itemId, serverMs).plus(own(s.state.bound, itemId) ?? DECIMAL_ZERO);
    cost.push(`${fmt(amount)} ${itemLabel(s, itemId, theme)} (have ${fmt(have)})`);
  }
  return {
    action: actionLine(s, m, a, theme),
    why: whyLine(s, m, theme),
    lane: m.laneId === null ? null : laneLabel(s, m.laneId, theme),
    cost,
    effect: effectLines(s, m, a, theme),
    buyOne: a.type === "BUY_MACHINE" && a.count > 1 ? { ...a, count: 1 } : null,
    open: m.itemId,
  };
}
