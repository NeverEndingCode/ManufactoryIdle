// Content by checksum (W-4, W-5): the browser never loads a bundle from disk, it fetches the
// one a world pinned from GET /api/content/:checksum and indexes it once.
import { indexContent, type ContentBundle, type IndexedContent } from "@manufactory/engine";
import type { FetchLike } from "./wire.js";

/** In memory, by checksum. Concurrent gets share one request; a failed load is dropped, so a
 * later get retries. Bundles are immutable under their checksum, so nothing is ever evicted. */
export class ContentCache {
  readonly #fetch: FetchLike;
  readonly #byChecksum = new Map<string, Promise<IndexedContent>>();

  constructor(fetch: FetchLike) {
    this.#fetch = fetch;
  }

  get(checksum: string): Promise<IndexedContent> {
    const known = this.#byChecksum.get(checksum);
    if (known) return known;
    const loading = this.#load(checksum);
    this.#byChecksum.set(checksum, loading);
    loading.catch(() => {
      if (this.#byChecksum.get(checksum) === loading) this.#byChecksum.delete(checksum);
    });
    return loading;
  }

  /** get(), with its rejection swallowed: a later get retries and reports it. */
  prefetch(checksum: string): void {
    this.get(checksum).catch(() => {});
  }

  async #load(checksum: string): Promise<IndexedContent> {
    const res = await this.#fetch(`/api/content/${encodeURIComponent(checksum)}`);
    if (!res.ok) throw new Error(`GET /api/content/${checksum}: ${res.status}`);
    return indexContent((await res.json()) as ContentBundle);
  }
}
