// The one hook between React and the store (W-3, W-6).
import { useSyncExternalStore } from "react";
import type { GameStore, StoreView } from "./store.js";

export function useGame(store: Pick<GameStore, "subscribe" | "getView">): StoreView {
  return useSyncExternalStore(store.subscribe, store.getView);
}
