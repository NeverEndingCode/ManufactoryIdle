import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleChecksum, loadBundleDir } from "@manufactory/content";
import { pgliteDb } from "./db/pglite.js";
import { migrate } from "./db/migrate.js";
import type { Db } from "./db/db.js";
import { openContentStore } from "./content.js";

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
  await db.close();
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

  it("rejects an unknown version", async () => {
    const store = await openContentStore(db, SLICE);
    await expect(store.get("unknown")).rejects.toThrow(/unknown/);
  });
});
