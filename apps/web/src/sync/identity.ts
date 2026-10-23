// The guest token (W-14): localStorage under mi.guestToken, or memory where storage throws
// (some private modes), behind the "this factory will be lost" banner.
import { GUEST_TOKEN_KEY } from "./constants.js";

export interface TokenStorage {
  get(): string | null;
  set(token: string): void;
  clear(): void;
  /** False when the token lives only in memory and dies with the tab. */
  persistent: boolean;
}

export function memoryTokenStorage(): TokenStorage {
  let token: string | null = null;
  return {
    get: () => token,
    set: (t) => {
      token = t;
    },
    clear: () => {
      token = null;
    },
    persistent: false,
  };
}

const PROBE_KEY = "mi.storageProbe";

/** localStorage under `key` (GUEST_TOKEN_KEY, or PARKED_GUEST_TOKEN_KEY for S-6); if any
 * access throws, an in-memory store with persistent: false. Even reading the global can throw
 * (Chrome with site data blocked). A probe write at construction catches storage that reads
 * but can't write (Safari's old private mode); a later throw also falls back, keeping the
 * token. */
export function browserTokenStorage(arg?: Storage, key: string = GUEST_TOKEN_KEY): TokenStorage {
  let ls: Storage | undefined;
  try {
    ls = arg ?? (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return memoryTokenStorage();
  }
  const memory = memoryTokenStorage();
  if (ls === undefined) return memory;
  try {
    ls.setItem(PROBE_KEY, "1");
    ls.removeItem(PROBE_KEY);
    memory.set(ls.getItem(key) ?? "");
    if (memory.get() === "") memory.clear();
  } catch {
    return memoryTokenStorage();
  }
  const store: TokenStorage = {
    persistent: true,
    get() {
      if (!store.persistent) return memory.get();
      try {
        return ls.getItem(key);
      } catch {
        store.persistent = false;
        return memory.get();
      }
    },
    set(token) {
      memory.set(token);
      if (!store.persistent) return;
      try {
        ls.setItem(key, token);
      } catch {
        store.persistent = false;
      }
    },
    clear() {
      memory.clear();
      if (!store.persistent) return;
      try {
        ls.removeItem(key);
      } catch {
        store.persistent = false;
      }
    },
  };
  return store;
}
