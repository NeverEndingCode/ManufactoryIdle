import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleChecksum, loadBundleDir } from "@manufactory/content";
import { pgliteDb } from "./db/pglite.js";
import { migrate } from "./db/migrate.js";
import type { Db } from "./db/db.js";
import { openContentStore } from "./content.js";
import { indexContent } from "@manufactory/engine";

const SLICE = fileURLToPath(
  new URL("../../../packages/content/bundles/vertical-slice", import.meta.url),
);
const FIXTURE = fileURLToPath(
  new URL("../../../packages/content/bundles/fixture", import.meta.url),
);

let db: Db;
beforeEach(async () => {
  db = await pgliteDb();
  await migrate(db);
});
afterEach(async () => {
  await db?.close();
});

describe("openContentStore", () => {
  it("records the bundle once, by checksum", async () => {
    const store = await openContentStore(db, SLICE);
    const checksum = bundleChecksum(loadBundleDir(SLICE));
    expect(store.current.version).toBe(checksum);
    await openContentStore(db, SLICE);
    const rows = await db.query<{ version: string; checksum: string }>(
      "select version, checksum from content_versions",
    );
    expect(rows).toEqual([{ version: checksum, checksum }]);
  });

  it("refuses a label already published under another checksum, naming both", async () => {
    const slice = loadBundleDir(SLICE);
    // A row with the slice's label but other numbers.
    const rogue = structuredClone(slice);
    rogue.recipes.find((r) => r.outputs.length > 0)!.outputs[0]!.rate = "12345";
    const rogueSum = bundleChecksum(rogue);
    await db.query("insert into content_versions (version, checksum, bundle) values ($1, $1, $2::jsonb)", [
      rogueSum,
      JSON.stringify(rogue),
    ]);
    const error = await openContentStore(db, SLICE).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toContain(rogueSum);
    expect(error?.message).toContain(bundleChecksum(slice));
    expect(await db.query("select 1 from content_versions")).toHaveLength(1);
  });

  it("serves an older version from the table, not from memory", async () => {
    const a = await openContentStore(db, SLICE);
    const versionA = a.current.version;
    const b = await openContentStore(db, FIXTURE);
    expect(b.current.version).not.toBe(versionA);
    const got = await b.get(versionA);
    expect(got.bundle).toEqual(a.current.content.bundle);
    expect(got.recipes.size).toBe(a.current.content.recipes.size);
    expect((await b.get(b.current.version)).bundle).toEqual(b.current.content.bundle);
  });

  it("reads a miss through the given transaction (no deadlock on PGlite)", async () => {
    const b = await openContentStore(db, FIXTURE);
    const slice = loadBundleDir(SLICE);
    const version = bundleChecksum(slice);
    const got = await db.transaction(async (tx) => {
      // A row only this transaction can see: proves the read goes through tx.
      await tx.query(
        "insert into content_versions (version, checksum, bundle) values ($1, $1, $2::jsonb)",
        [version, JSON.stringify(slice)],
      );
      return b.get(version, tx);
    });
    expect(got.bundle).toEqual(slice);
  }, 5_000);

  it("rejects a row whose bundle does not match its version", async () => {
    const a = await openContentStore(db, SLICE);
    const b = await openContentStore(db, FIXTURE);
    await db.query(
      `update content_versions
          set bundle = bundle || '{"tampered": true}'::jsonb
        where version = $1`,
      [a.current.version],
    );
    await expect(b.get(a.current.version)).rejects.toThrow(/checksum mismatch/);
  });

  it("rejects an unknown version", async () => {
    const store = await openContentStore(db, SLICE);
    await expect(store.get("unknown")).rejects.toThrow(/unknown/);
  });
});

describe("the content LRU", () => {
  /** Counts the store's bundle reads, so a hit (no read) and a reload (one read) can be told apart. */
  function counting(inner: Db): Db & { reads: number } {
    const wrapped: Db & { reads: number } = {
      reads: 0,
      query: (sql, params) => {
        if (/select bundle from content_versions/.test(sql)) wrapped.reads += 1;
        return inner.query(sql, params);
      },
      transaction: (fn) => inner.transaction(fn),
      close: () => inner.close(),
    };
    return wrapped;
  }

  /** Publishes n small variants of the slice (only the authored label differs) and returns their versions. */
  async function publishVariants(n: number): Promise<string[]> {
    const slice = loadBundleDir(SLICE);
    const versions: string[] = [];
    for (let i = 0; i < n; i++) {
      const variant = { ...slice, version: `${slice.version}-variant-${i}` };
      indexContent(variant); // a real, indexable bundle
      const version = bundleChecksum(variant);
      await db.query(
        "insert into content_versions (version, checksum, bundle) values ($1, $1, $2::jsonb)",
        [version, JSON.stringify(variant)],
      );
      versions.push(version);
    }
    return versions;
  }

  it("evicts the least recently used past 8 entries, and reloads an evicted version from the table", async () => {
    const counted = counting(db);
    const store = await openContentStore(counted, FIXTURE); // the current version: entry 1
    const versions = await publishVariants(9);
    for (const v of versions.slice(0, 7)) await store.get(v); // entries 2..8: full
    expect(counted.reads).toBe(7);
    for (const v of versions.slice(0, 7)) await store.get(v); // all hits
    expect(counted.reads).toBe(7);

    await store.get(store.current.version); // touch the current version: variant 0 is now oldest
    await store.get(versions[7]!); // a 9th entry evicts variant 0
    expect(counted.reads).toBe(8);
    await store.get(versions[1]!); // still cached
    await store.get(store.current.version); // still cached
    expect(counted.reads).toBe(8);
    const reloaded = await store.get(versions[0]!); // evicted: read again
    expect(counted.reads).toBe(9);
    expect(reloaded.bundle.version).toBe(`${loadBundleDir(SLICE).version}-variant-0`);
  });

  it("dedupes concurrent misses on one version: one read, one index, the same object", async () => {
    const counted = counting(db);
    const store = await openContentStore(counted, FIXTURE);
    const [v] = await publishVariants(1);
    const [a, b, c] = await Promise.all([store.get(v!), store.get(v!), store.get(v!)]);
    expect(counted.reads).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("a failed load is not cached: concurrent waiters all fail, and a later get retries", async () => {
    const counted = counting(db);
    const store = await openContentStore(counted, FIXTURE);
    const results = await Promise.allSettled([store.get("missing"), store.get("missing")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(counted.reads).toBe(1);
    await expect(store.get("missing")).rejects.toThrow(/unknown/);
    expect(counted.reads).toBe(2);
  });
});

describe("the content LRU inside a transaction", () => {
  it("a transaction's miss does not wait on a root-db load of the same version (PGlite deadlock)", async () => {
    const store = await openContentStore(db, FIXTURE);
    const slice = loadBundleDir(SLICE);
    const version = bundleChecksum(slice);
    await db.query(
      "insert into content_versions (version, checksum, bundle) values ($1, $1, $2::jsonb)",
      [version, JSON.stringify(slice)],
    );
    const [inTx, outside] = await Promise.all([
      db.transaction(async (tx) => {
        // Let the root get below start its load first, queued behind this transaction.
        await new Promise((r) => setTimeout(r, 20));
        return store.get(version, tx);
      }),
      new Promise((r) => setTimeout(r, 5)).then(() => store.get(version)),
    ]);
    expect((inTx as { bundle: unknown }).bundle).toEqual(slice);
    expect((outside as { bundle: unknown }).bundle).toEqual(slice);
  }, 5_000);
});
