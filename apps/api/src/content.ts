// Content versions (spec R-4): a world pins the bundleChecksum it was created on.
// The server publishes the bundle it started with into content_versions and serves
// older pinned versions from that table, through a small LRU of indexed bundles.
import { bundleChecksum, loadBundleDir, type Bundle } from "@manufactory/content";
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
  const loaded = loadBundleDir(dir);
  const version = bundleChecksum(loaded);
  const bundle: ContentBundle = loaded;
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

  // Misses in flight, by version: concurrent gets of one uncached version share one read and
  // one indexContent. A failed load is dropped from here, so a later get retries. Sharing a
  // load is safe whatever querier ran it, since a content_versions row never changes, with one
  // exception: a caller inside a transaction never waits on a load running on the root db.
  // On PGlite that root query is queued behind the caller's own transaction, a deadlock.
  const loading = new Map<string, { on: Db; promise: Promise<IndexedContent> }>();
  const load = async (v: string, q: Db): Promise<IndexedContent> => {
    const rows = await q.query<{ bundle: Bundle }>(
      "select bundle from content_versions where version = $1",
      [v],
    );
    if (rows.length === 0) throw new Error(`unknown content version: ${v}`);
    const stored = rows[0]!.bundle;
    // The version is the bundle's checksum, which survives the jsonb round trip; a
    // mismatch means the row was edited or corrupted, and a world must never run on
    // content other than the version it pinned.
    const actual = bundleChecksum(stored);
    if (actual !== v) {
      throw new Error(`content version ${v}: stored bundle checksum mismatch (got ${actual})`);
    }
    return remember(v, indexContent(stored));
  };

  return {
    current: { version, content },
    async get(v, tx) {
      const hit = cache.get(v);
      if (hit) return remember(v, hit);
      const q = tx ?? db;
      const pending = loading.get(v);
      if (pending && (q === db || pending.on !== db)) return pending.promise;
      const promise = load(v, q).finally(() => {
        if (loading.get(v)?.promise === promise) loading.delete(v);
      });
      loading.set(v, { on: q, promise });
      return promise;
    },
  };
}
