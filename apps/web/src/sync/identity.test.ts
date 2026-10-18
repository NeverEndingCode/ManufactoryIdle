import { describe, expect, it } from "vitest";
import { GUEST_TOKEN_KEY } from "./constants.js";
import { browserTokenStorage, memoryTokenStorage } from "./identity.js";

/** A Storage stand-in, no jsdom: a Map behind the four methods the client uses. */
function stubStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

function throwingStorage(): Storage {
  const boom = () => {
    throw new DOMException("denied", "SecurityError");
  };
  return {
    length: 0,
    key: boom,
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    clear: boom,
  };
}

describe("browserTokenStorage (W-14)", () => {
  it("falls back to memory, persistent: false, when every access throws", () => {
    const tokens = browserTokenStorage(throwingStorage());
    expect(tokens.persistent).toBe(false);
    expect(tokens.get()).toBeNull();
    tokens.set("abc");
    expect(tokens.get()).toBe("abc");
    tokens.clear();
    expect(tokens.get()).toBeNull();
  });

  it("keeps the token under mi.guestToken in a working Storage", () => {
    const ls = stubStorage();
    const tokens = browserTokenStorage(ls);
    expect(tokens.persistent).toBe(true);
    tokens.set("tok");
    expect(GUEST_TOKEN_KEY).toBe("mi.guestToken");
    expect(ls.map.get("mi.guestToken")).toBe("tok");
    expect(browserTokenStorage(ls).get()).toBe("tok");
    tokens.clear();
    expect(ls.map.has("mi.guestToken")).toBe(false);
    // The probe leaves nothing behind.
    expect([...ls.map.keys()]).toEqual([]);
  });
});

describe("browserTokenStorage, the global", () => {
  it("falls back to memory when reading the localStorage global throws", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("site data blocked", "SecurityError");
      },
    });
    try {
      const tokens = browserTokenStorage();
      expect(tokens.persistent).toBe(false);
      tokens.set("abc");
      expect(tokens.get()).toBe("abc");
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("memoryTokenStorage", () => {
  it("round-trips and is never persistent", () => {
    const tokens = memoryTokenStorage();
    expect(tokens.persistent).toBe(false);
    tokens.set("x");
    expect(tokens.get()).toBe("x");
    tokens.clear();
    expect(tokens.get()).toBeNull();
  });
});
