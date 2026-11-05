// U-1i: what this player has unlocked beyond the base game. Today that's nothing: Spec 2's
// prestige store will fill it from the world or the account, and nothing else changes when it
// does. theme.ts reads it through syncCapabilities (V-7).
import type { StoreView } from "../sync/store.js";

export type Capability = "theme:cosy" | "theme:industrial";

const NONE: ReadonlySet<Capability> = new Set();

/** Empty until Spec 2's prestige store; nothing else changes when it fills. */
export function capabilities(_view: StoreView): ReadonlySet<Capability> {
  return NONE;
}
