// Loading the bundle and standing up a world. This module is also where the
// structural compatibility between @manufactory/content's Zod-inferred `Bundle` and
// @manufactory/engine's hand-declared `ContentBundle` is checked: the assignment in
// `loadContent` fails to typecheck the moment the two drift, which is the guard
// that lets spec A.2 keep the engine free of a content import.
import { fileURLToPath } from "node:url";
import { loadBundleDir } from "@manufactory/content";
import {
  indexContent,
  initialWorld,
  type ContentBundle,
  type IndexedContent,
  type WorldState,
} from "@manufactory/engine";

export const FIXTURE_BUNDLE_DIR = fileURLToPath(
  new URL("../../../packages/content/bundles/fixture", import.meta.url),
);

export function loadContent(dir: string = FIXTURE_BUNDLE_DIR): IndexedContent {
  const bundle: ContentBundle = loadBundleDir(dir);
  return indexContent(bundle);
}

/** Simulated worlds start at t = 0, so report times are elapsed times. */
export function newWorld(content: IndexedContent, seed: number): WorldState {
  return initialWorld(content, seed, 0);
}
