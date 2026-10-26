import { describe, expect, it } from "vitest";
import { Lru } from "./lru.js";

describe("Lru", () => {
  it("evicts the least recently used entry past its capacity", () => {
    const lru = new Lru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
    expect(lru.size).toBe(2);
  });

  it("counts a read as a use", () => {
    const lru = new Lru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe(1);
  });

  it("replaces a key in place, without evicting another", () => {
    const lru = new Lru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10);
    expect(lru.size).toBe(2);
    expect(lru.get("a")).toBe(10);
    expect(lru.get("b")).toBe(2);
  });

  it("refuses a capacity below one", () => {
    expect(() => new Lru(0)).toThrow();
  });
});
