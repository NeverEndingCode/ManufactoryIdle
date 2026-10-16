// Content versions (spec R-4): a world pins the bundleChecksum it was created on.
// The server publishes the bundle it started with into content_versions and serves
// older pinned versions from that table, through a small LRU of indexed bundles.
import { bundleChecksum, loadBundleDir } from "@manufactory/content";
import { indexContent, type ContentBundle, type IndexedContent } from "@manufactory/engine";
import type { Db } from "./db/db.js";

const LRU_CAPACITY = 8;

export interface ContentStore {
  /** The version new worlds are created on (the bundle the server started with). */
  current: { version: string; content: IndexedContent };
  /** The indexed bundle for a pinned version: memory first, then content_versions.bundle; throws if unknown.
   * Inside a transaction pass its `tx`: a miss then reads through it (a root-db query inside a
   * PGlite transaction deadlocks, and on `pg` it would run outside the transaction). */
  get(version: string, tx?: Db): Promise<IndexedContent>;
}

export async function openContentStore(db: Db, dir: string): Promise<ContentStore> {
  const bundle: ContentBundle = loadBundleDir(dir);
  const version = bundleChecksum(loadBundleDir(dir));
  const content = indexContent(bundle);

  await db.transaction(async (tx) => {
    await tx.query(
      `insert into content_versions (version, checksum, bundle) values ($1, $1, $2::jsonb)
       on conflict (version) do nothing`,
      [version, JSON.stringify(bundle)],
    );
  });

  // Map iteration order is insertion order, so the first key is the least recently used.
  const cache = new Map<string, IndexedContent>();
  const remember = (v: string, c: IndexedContent): IndexedContent => {
    cache.delete(v);
    cache.set(v, c);
    if (cache.size > LRU_CAPACITY) cache.delete(cache.keys().next().value as string);
    return c;
  };
  remember(version, content);

  return {
    current: { version, content },
    async get(v, tx) {
      const hit = cache.get(v);
      if (hit) return remember(v, hit);
      const rows = await (tx ?? db).query<{ bundle: ContentBundle }>(
        "select bundle from content_versions where version = $1",
        [v],
      );
      if (rows.length === 0) throw new Error(`unknown content version: ${v}`);
      return remember(v, indexContent(rows[0]!.bundle));
    },
  };
}
