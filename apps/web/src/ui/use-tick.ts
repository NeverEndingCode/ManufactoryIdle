// W-7: the shared 4 Hz text tick. The one timer is the store's (subscribeTick: TEXT_TICK_MS,
// stopped while the tab is hidden by setVisible). This shares one subscription to it through
// a context, so only mounted numbers -- the visible lane's -- listen, and they re-render at
// 4 Hz without touching the store's view.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { GameStore } from "../sync/store.js";

export interface TickSource {
  subscribe(fn: () => void): () => void;
  /** Bumps once per tick. */
  getTick(): number;
}

export function createTickSource(store: Pick<GameStore, "subscribeTick">): TickSource {
  let n = 0;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;
  return {
    subscribe(fn) {
      listeners.add(fn);
      unsubscribe ??= store.subscribeTick(() => {
        n += 1;
        for (const l of listeners) l();
      });
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0 && unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    },
    getTick: () => n,
  };
}

export const TickContext = createContext<TickSource | null>(null);

export function useTickSource(): TickSource {
  const source = useContext(TickContext);
  if (!source) throw new Error("useTick outside <TickContext.Provider>");
  return source;
}

/** Re-renders the caller at 4 Hz; returns the tick count. */
export function useTick(): number {
  const source = useTickSource();
  return useSyncExternalStore(source.subscribe, source.getTick);
}
