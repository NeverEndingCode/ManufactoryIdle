// Spec A.5: Decimals persist as canonical strings, never as JSON numbers, and the
// output must be byte-stable so two processes agree on a save's identity. Object
// keys are emitted in sorted order for that reason; arrays keep their order, which
// is meaningful for `priority` and for `installed`'s per-mark counts.
import { fromCanonical, toCanonical, type Dec } from "../numbers/decimal.js";
import type { ItemId, LaneId } from "../content/types.js";
import { WORLD_SCHEMA_VERSION, type WorldState } from "./world.js";

// Reading a record's keys via Object.keys is safe even when a key happens to be
// "constructor" or another Object.prototype property name: Object.keys returns
// only own enumerable keys, never anything resolved through the prototype chain.
//
// Writing is a separate hazard, handled below: `out[key] = value` goes through
// [[Set]], which for key === "__proto__" reassigns the object's prototype instead
// of creating an own property with that name. Every helper here builds its result
// with Object.fromEntries instead, which creates own data properties via
// CreateDataPropertyOrThrow and is safe for "__proto__" too.
function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}

function encodeDecimals(record: Record<string, Dec>): Record<string, string> {
  return Object.fromEntries(sortedKeys(record).map((key) => [key, toCanonical(record[key]!)]));
}

function decodeDecimals(record: Record<string, string>): Record<string, Dec> {
  return Object.fromEntries(sortedKeys(record).map((key) => [key, fromCanonical(record[key]!)]));
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(sortedKeys(record).map((key) => [key, record[key]!]));
}

function sortInstalled(
  installed: WorldState["installed"],
): Record<string, Record<string, number[]>> {
  return Object.fromEntries(
    sortedKeys(installed).map((lane) => [lane, sortRecord(installed[lane]!)]),
  );
}

/**
 * Plain objects nested in the state (priority entries, timers, the seed) are emitted with
 * sorted keys too, recursively; arrays keep their order. Without this a world read back
 * from storage that re-orders keys (Postgres jsonb does) serializes to different bytes.
 * Key order carries no meaning, so this changes no schema version: older strings with
 * unsorted keys still deserialize, and re-serialize canonically.
 */
function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  // Only plain objects (prototype Object or null) are rebuilt. Anything else -- a
  // Decimal, a Date, a Map -- is returned as-is: rebuilding it from its own keys would
  // drop its prototype (and toJSON), so a nested Decimal would serialize as its
  // internal fields instead of its canonical string.
  if (value !== null && typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(sortedKeys(record).map((key) => [key, canonical(record[key])])) as T;
  }
  return value;
}

export function serializeWorld(state: WorldState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    contentVersion: state.contentVersion,
    seed: canonical(state.seed),
    tier: state.tier,
    installed: sortInstalled(state.installed),
    assignment: sortRecord(state.assignment),
    activeRecipe: sortRecord(state.activeRecipe),
    stored: encodeDecimals(state.stored),
    quantum: encodeDecimals(state.quantum),
    bound: encodeDecimals(state.bound),
    storageLevel: sortRecord(state.storageLevel),
    qsLevel: sortRecord(state.qsLevel),
    reserve: sortRecord(state.reserve),
    priority: canonical(state.priority),
    powerBank: toCanonical(state.powerBank),
    tapStacks: state.tapStacks,
    timers: canonical(state.timers),
    lifetime: encodeDecimals(state.lifetime),
    lastResolvedAt: state.lastResolvedAt,
  });
}

interface WirePayload {
  schemaVersion: number;
  contentVersion: string;
  seed: WorldState["seed"];
  tier: number;
  installed: Record<LaneId, Record<string, number[]>>;
  assignment: Record<string, number>;
  activeRecipe: Record<ItemId, string>;
  stored: Record<string, string>;
  quantum: Record<string, string>;
  bound: Record<string, string>;
  storageLevel: Record<string, number>;
  qsLevel: Record<string, number>;
  reserve: Record<string, number>;
  priority: WorldState["priority"];
  powerBank: string;
  tapStacks: number;
  timers: WorldState["timers"];
  lifetime: Record<string, string>;
  lastResolvedAt: number;
}

export function deserializeWorld(text: string): WorldState {
  const wire = JSON.parse(text) as WirePayload;
  if (wire.schemaVersion !== WORLD_SCHEMA_VERSION) {
    throw new Error(
      `unsupported world schema version ${wire.schemaVersion}, expected ${WORLD_SCHEMA_VERSION}`,
    );
  }
  return {
    schemaVersion: wire.schemaVersion,
    contentVersion: wire.contentVersion,
    seed: wire.seed,
    tier: wire.tier,
    installed: wire.installed,
    assignment: wire.assignment,
    activeRecipe: wire.activeRecipe,
    stored: decodeDecimals(wire.stored),
    quantum: decodeDecimals(wire.quantum),
    bound: decodeDecimals(wire.bound),
    storageLevel: wire.storageLevel,
    qsLevel: wire.qsLevel,
    reserve: wire.reserve,
    priority: wire.priority,
    powerBank: fromCanonical(wire.powerBank),
    tapStacks: wire.tapStacks,
    timers: wire.timers,
    lifetime: decodeDecimals(wire.lifetime),
    lastResolvedAt: wire.lastResolvedAt,
  };
}
