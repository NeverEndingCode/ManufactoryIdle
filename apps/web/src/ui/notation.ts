// S-11 / W-17: the number notation, one small external store. Every number on screen goes
// through fmt(), never the engine's format with a literal mode (a source scan enforces it).
// Components that show numbers re-render on a change because App reads useNotation(); the
// per-snapshot memos (laneRows in LaneView, drawerModel) key on the mode too.
import { useSyncExternalStore } from "react";
import { D, format, type Dec, type NotationMode } from "@manufactory/engine";

export const NOTATION_KEY = "mi.notation";

export const NOTATIONS: readonly NotationMode[] = [
  "hybrid",
  "short",
  "doubled",
  "names",
  "sci",
  "eng",
];

export const NOTATION_LABELS: Readonly<Record<NotationMode, string>> = {
  hybrid: "Hybrid",
  short: "Short",
  doubled: "Doubled letters",
  names: "Names",
  sci: "Scientific",
  eng: "Engineering",
};

const SAMPLES = [D(12_345_678), D(1.5e18)] as const;

/** Two numbers in a mode, for the settings sheet: where the modes differ. */
export function notationSample(m: NotationMode): string {
  return SAMPLES.map((v) => format(v, m)).join(" · ");
}

const isMode = (v: unknown): v is NotationMode => NOTATIONS.includes(v as NotationMode);

/** The stored choice; "hybrid" when unset, unknown or unreadable (a per-viewer convenience). */
export function storedNotation(): NotationMode {
  try {
    const v = localStorage.getItem(NOTATION_KEY);
    return isMode(v) ? v : "hybrid";
  } catch {
    return "hybrid";
  }
}

let mode: NotationMode = storedNotation();
const listeners = new Set<() => void>();

export function currentNotation(): NotationMode {
  return mode;
}

export function setNotation(next: NotationMode): void {
  try {
    localStorage.setItem(NOTATION_KEY, next);
  } catch {
    /* kept in memory for this tab */
  }
  if (next === mode) return;
  mode = next;
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The engine's format in the player's notation. */
export function fmt(value: Dec): string {
  return format(value, mode);
}

export function useNotation(): [NotationMode, (m: NotationMode) => void] {
  return [useSyncExternalStore(subscribe, currentNotation, currentNotation), setNotation];
}
