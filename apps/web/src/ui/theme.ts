// S-11 / W-17: System / Dark / Light as data-theme on <html> (tokens.css keys on it). System
// removes the attribute, so prefers-color-scheme decides. Stored as mi.theme, a per-viewer
// convenience; main.tsx applies it before the first render.
import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "dark" | "light";
export const THEME_KEY = "mi.theme";

const CHOICES: readonly ThemeChoice[] = ["system", "dark", "light"];

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

let theme: ThemeChoice = storedTheme();
const listeners = new Set<() => void>();

export function setTheme(next: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* kept in memory for this tab */
  }
  applyTheme(next);
  if (next === theme) return;
  theme = next;
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const current = () => theme;

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  return [useSyncExternalStore(subscribe, current, current), setTheme];
}
