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

/** localStorage under GUEST_TOKEN_KEY; if any access throws, an in-memory store with
 * persistent: false. A probe write at construction catches storage that reads but can't
 * write (Safari's old private mode); a later throw also falls back, keeping the token. */
export function browserTokenStorage(
  ls: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): TokenStorage {
  const memory = memoryTokenStorage();
  if (ls === undefined) return memory;
  try {
    ls.setItem(PROBE_KEY, "1");
    ls.removeItem(PROBE_KEY);
    memory.set(ls.getItem(GUEST_TOKEN_KEY) ?? "");
    if (memory.get() === "") memory.clear();
  } catch {
    return memoryTokenStorage();
  }
  const store: TokenStorage = {
    persistent: true,
    get() {
      if (!store.persistent) return memory.get();
      try {
        return ls.getItem(GUEST_TOKEN_KEY);
      } catch {
        store.persistent = false;
        return memory.get();
      }
    },
    set(token) {
      memory.set(token);
      if (!store.persistent) return;
      try {
        ls.setItem(GUEST_TOKEN_KEY, token);
      } catch {
        store.persistent = false;
      }
    },
    clear() {
      memory.clear();
      if (!store.persistent) return;
      try {
        ls.removeItem(GUEST_TOKEN_KEY);
      } catch {
        store.persistent = false;
      }
    },
  };
  return store;
}
