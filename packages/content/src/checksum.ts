// Spec B.6 check 11 and spec section 12.7: a bundle is identified by a checksum
// so a save pinned to a content version is pinned to exactly those numbers.
// Object key order must not affect the result — yaml authors reorder keys freely
// — but array order must, because lane order and recipe order are meaningful.
import { createHash } from "node:crypto";
import type { Bundle } from "./schema.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function bundleChecksum(bundle: Bundle): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(bundle))).digest("hex");
}
