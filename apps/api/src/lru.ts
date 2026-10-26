// A small least-recently-used map. A Map iterates in insertion order, so re-inserting on
// every use keeps the oldest entry first, and that is the one evicted.
export class Lru<V> {
  readonly #entries = new Map<string, V>();

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`an Lru needs a capacity of at least 1, not ${capacity}`);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.capacity) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
  }
}
