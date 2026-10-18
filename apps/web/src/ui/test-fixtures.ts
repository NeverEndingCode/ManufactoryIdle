// Test-only: snapshots built straight from the slice bundle and engine fixture worlds, with no
// server. Excluded from tsconfig.json and from the browser lint block, like sync/test-rig.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleChecksum, loadBundleDir } from "@manufactory/api/bundle";
import {
  deserializeWorld,
  indexContent,
  initialWorld,
  schedule,
  serializeWorld,
  type ContentBundle,
  type IndexedContent,
  type WorldState,
} from "@manufactory/engine";
import { makeSnapshot, type Snapshot } from "../sync/snapshot.js";

// Paths from strings, not URL objects: under jsdom the global URL is jsdom's, which
// fileURLToPath refuses. That is also why this file doesn't import sync/test-rig.ts.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SLICE_DIR = join(ROOT, "packages/content/bundles/vertical-slice");
const FIXTURES = join(ROOT, "packages/engine/src/resolve/fixtures");

/** As sync/test-rig.ts: the server clock's start, and a performance.now()-like client start. */
export const SERVER_T0 = 1_760_000_000_000;
export const CLIENT_T0 = 1_000_000;

export interface Slice {
  content: IndexedContent;
  checksum: string;
}

/** The vertical slice, indexed, straight from the bundle directory. */
export function loadSlice(): Slice {
  const bundle = loadBundleDir(SLICE_DIR);
  return { content: indexContent(bundle as ContentBundle), checksum: bundleChecksum(bundle) };
}

/** The real worldView shape: the serialized state and the engine's schedule of it. */
export function snapshotOf(
  slice: Slice,
  state: WorldState,
  opts: { stateVersion?: number; persistedAtMs?: number; receivedAt?: number } = {},
): Snapshot {
  return makeSnapshot(
    {
      state: JSON.parse(serializeWorld(state)) as unknown,
      schedule: schedule(state, slice.content),
      stateVersion: opts.stateVersion ?? 0,
      contentChecksum: slice.checksum,
      ...(opts.persistedAtMs === undefined ? {} : { persistedAtMs: opts.persistedAtMs }),
    },
    slice.content,
    opts.receivedAt ?? CLIENT_T0,
  );
}

/** A fresh guest's world, as POST /api/guests makes it, at SERVER_T0. */
export function freshState(slice: Slice): WorldState {
  return initialWorld(slice.content, 1, SERVER_T0);
}

/** An engine fixture world (packages/engine/src/resolve/fixtures). */
export function fixtureState(file: string): WorldState {
  return deserializeWorld(readFileSync(join(FIXTURES, file), "utf8"));
}
