import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentCache } from "./content-cache.js";
import { makeRig, type TestRig } from "./test-rig.js";
import type { HealthResponse } from "./wire.js";

let rig: TestRig;
let checksum: string;

beforeEach(async () => {
  rig = await makeRig();
  checksum = ((await (await rig.fetch("/api/health")).json()) as HealthResponse).contentChecksum;
  rig.fetch.calls.length = 0;
});
afterEach(async () => {
  await rig.close();
});

const contentCalls = () => rig.fetch.calls.filter((c) => c.url.startsWith("/api/content/"));

describe("ContentCache", () => {
  it("dedupes concurrent gets of one checksum into one request", async () => {
    const cache = new ContentCache(rig.fetch);
    const [a, b] = await Promise.all([cache.get(checksum), cache.get(checksum)]);
    expect(a).toBe(b);
    expect(contentCalls()).toEqual([
      { method: "GET", url: `/api/content/${checksum}`, body: undefined },
    ]);
    // And a later get is served from memory.
    await cache.get(checksum);
    expect(contentCalls()).toHaveLength(1);
  });

  it("returns the indexed slice", async () => {
    const content = await new ContentCache(rig.fetch).get(checksum);
    expect(content.stockItemIds.length).toBe(32);
  });

  it("rejects an unknown checksum and retries it on the next get", async () => {
    const cache = new ContentCache(rig.fetch);
    const unknown = "0".repeat(64);
    await expect(cache.get(unknown)).rejects.toThrow();
    expect(contentCalls()).toHaveLength(1);
    await expect(cache.get(unknown)).rejects.toThrow();
    expect(contentCalls()).toHaveLength(2);
  });

  it("prefetch swallows the rejection but still populates the cache", async () => {
    const cache = new ContentCache(rig.fetch);
    cache.prefetch("0".repeat(64));
    cache.prefetch(checksum);
    await cache.get(checksum);
    expect(contentCalls().filter((c) => c.url.endsWith(checksum))).toHaveLength(1);
  });
});
