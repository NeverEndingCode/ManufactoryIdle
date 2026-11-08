// U-1a / U-1i: the six themes, as data-theme on <html> (tokens.css keys on it). CSS holds
// everything visual; this table holds only what CSS can't: the copy voice, the name casing,
// the lock, and the settings swatch. Stored as mi.theme per device; old values migrate on read.
// index.html's inline script applies the migrated value before first paint (V-6); main.tsx then
// applies the capability-aware one and the theme-color meta. A locked theme without its
// capability renders as terminal and stays stored, so a grant restores it.
import { useSyncExternalStore } from "react";
import type { Capability } from "./capabilities.js";

export type ThemeId =
  "terminal" | "clean-dark" | "clean-oled" | "clean-light" | "cosy" | "industrial";
export type Voice = "shell" | "plain";
/** IRON_ORE | Iron Ore | IRON ORE (U-1h). */
export type NameStyle = "id" | "title" | "upper";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  scheme: "dark" | "light";
  voice: Voice;
  names: NameStyle;
  effects: boolean;
  lock: Capability | null;
  /** The settings swatch and theme-color; a test pins them equal to tokens.css (--bg, --t-body, --advice). */
  swatch: { bg: string; body: string; advice: string };
}

/** U-1a's order. */
export const THEMES: readonly ThemeDef[] = [
  {
    id: "terminal",
    name: "Retro terminal",
    scheme: "dark",
    voice: "shell",
    names: "id",
    effects: true,
    lock: null,
    swatch: { bg: "#050a06", body: "#4ee06c", advice: "#ffb000" },
  },
  {
    id: "clean-dark",
    name: "Clean (Dark)",
    scheme: "dark",
    voice: "plain",
    names: "title",
    effects: false,
    lock: null,
    swatch: { bg: "#18181b", body: "#e4e4e7", advice: "#fb923c" },
  },
  {
    id: "clean-oled",
    name: "Clean (OLED Dark)",
    scheme: "dark",
    voice: "plain",
    names: "title",
    effects: false,
    lock: null,
    swatch: { bg: "#000000", body: "#e4e4e7", advice: "#fb923c" },
  },
  {
    id: "clean-light",
    name: "Clean (Light)",
    scheme: "light",
    voice: "plain",
    names: "title",
    effects: false,
    lock: null,
    swatch: { bg: "#ffffff", body: "#18181b", advice: "#c2410c" },
  },
  {
    id: "cosy",
    name: "Cosy",
    scheme: "light",
    voice: "plain",
    names: "title",
    effects: false,
    lock: "theme:cosy",
    swatch: { bg: "#f5ede1", body: "#3b2f26", advice: "#9c4226" },
  },
  {
    id: "industrial",
    name: "Industrial",
    scheme: "dark",
    voice: "plain",
    names: "upper",
    effects: false,
    lock: "theme:industrial",
    swatch: { bg: "#17191b", body: "#d6d3cc", advice: "#ef6a4c" },
  },
];

export const DEFAULT_THEME: ThemeId = "terminal";
export const THEME_KEY = "mi.theme";

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function themeDef(id: ThemeId): ThemeDef {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_THEME)!;
}

function isThemeId(v: string | null): v is ThemeId {
  return v !== null && BY_ID.has(v as ThemeId);
}

/** dark→clean-dark, light→clean-light, system|null|unknown→terminal; a ThemeId passes through. */
export function migrateTheme(raw: string | null): ThemeId {
  if (raw === "dark") return "clean-dark";
  if (raw === "light") return "clean-light";
  return isThemeId(raw) ? raw : DEFAULT_THEME;
}

export function storedTheme(): ThemeId {
  try {
    return migrateTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function isLocked(def: ThemeDef, caps: ReadonlySet<Capability>): boolean {
  return def.lock !== null && !caps.has(def.lock);
}

interface ResolveOpts {
  search?: string;
  dev?: boolean;
}

/** The theme to render: a locked theme without its capability renders terminal.
 *  In dev only, ?theme=<id> wins regardless of the lock. */
export function resolveTheme(
  stored: ThemeId,
  caps: ReadonlySet<Capability>,
  opts: ResolveOpts = {},
): ThemeId {
  const dev = opts.dev ?? import.meta.env.DEV;
  if (dev) {
    const search = opts.search ?? (typeof location === "undefined" ? "" : location.search);
    const forced = new URLSearchParams(search).get("theme");
    if (isThemeId(forced)) return forced;
  }
  return isLocked(themeDef(stored), caps) ? DEFAULT_THEME : stored;
}

/** Sets data-theme (always, terminal included) and meta[name=theme-color] to the swatch bg. Returns the applied id. */
export function applyTheme(
  stored: ThemeId,
  caps: ReadonlySet<Capability>,
  root: HTMLElement = document.documentElement,
  opts?: ResolveOpts,
): ThemeId {
  const applied = resolveTheme(stored, caps, opts);
  root.setAttribute("data-theme", applied);
  const doc = root.ownerDocument;
  if (root === doc.documentElement) {
    let meta = doc.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta === null) {
      meta = doc.createElement("meta");
      meta.name = "theme-color";
      doc.head.append(meta);
    }
    meta.content = themeDef(applied).swatch.bg;
  }
  return applied;
}

// The store: { stored, caps }, replaced whole on a change so useSyncExternalStore sees it.
interface ThemeState {
  stored: ThemeId;
  caps: ReadonlySet<Capability>;
}

let state: ThemeState = { stored: storedTheme(), caps: new Set() };
const listeners = new Set<() => void>();

function commit(next: ThemeState): void {
  state = next;
  applyTheme(state.stored, state.caps);
  for (const fn of [...listeners]) fn();
}

/** Stores and applies; a locked id without its capability does nothing and returns false. */
export function setTheme(next: ThemeId): boolean {
  if (isLocked(themeDef(next), state.caps)) return false;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* kept in memory for this tab */
  }
  commit({ ...state, stored: next });
  return true;
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** V-7: App calls this once per view; it re-applies only when the set's contents change. */
export function syncCapabilities(caps: ReadonlySet<Capability>): void {
  if (sameSet(caps, state.caps)) return;
  commit({ ...state, caps: new Set(caps) });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const current = () => state;

export function useTheme(): { stored: ThemeId; applied: ThemeDef; set(id: ThemeId): boolean } {
  const { stored, caps } = useSyncExternalStore(subscribe, current, current);
  return { stored, applied: themeDef(resolveTheme(stored, caps)), set: setTheme };
}

// U-1i, U-9c / L-16: "Glow and scanlines", per device. Stored as mi.crt: "off", or absent for on
// (the default). Off is data-crt="off" on <html>, which tokens.css turns into no glow and no
// scanlines. index.html's inline script applies it before first paint, as it does the theme.
export const CRT_KEY = "mi.crt";

/** Only "off" is off: absent, junk and anything else are on. */
export function crtFrom(raw: string | null): boolean {
  return raw !== "off";
}

function storedCrt(): boolean {
  try {
    return crtFrom(localStorage.getItem(CRT_KEY));
  } catch {
    return true;
  }
}

let crt = storedCrt();

/** The setting as this tab holds it (storage read once, then kept in memory). */
export function crtOn(): boolean {
  return crt;
}

/** data-crt="off" when off; no attribute when on. */
export function applyCrt(root: HTMLElement = document.documentElement, on: boolean = crt): void {
  if (on) root.removeAttribute("data-crt");
  else root.setAttribute("data-crt", "off");
}

/** Stores (or, for on, removes) mi.crt and applies it; storage errors keep it in memory. */
export function setCrt(on: boolean): void {
  try {
    if (on) localStorage.removeItem(CRT_KEY);
    else localStorage.setItem(CRT_KEY, "off");
  } catch {
    /* kept in memory for this tab */
  }
  crt = on;
  applyCrt();
  for (const fn of [...listeners]) fn();
}

const currentCrt = () => crt;

export function useCrt(): { on: boolean; set(on: boolean): void } {
  const on = useSyncExternalStore(subscribe, currentCrt, currentCrt);
  return { on, set: setCrt };
}
