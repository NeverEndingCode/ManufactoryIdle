// L-3: the feel pair, one factory log book and one trend book per store. Created outside React,
// on first use (main.tsx calls it right after new GameStore), so StrictMode's double mount
// can't subscribe twice or miss the first adoption. App hands it down through FeelContext.
import { createContext, useContext } from "react";
import type { AdoptEvent, GameStore } from "../sync/store.js";

export type FeelStore = Pick<GameStore, "onAdopt" | "later" | "now">;

/** What a book needs from the store: every adoption, in order. */
export interface Book {
  record(e: AdoptEvent): void;
}

// Minimal books until Task 3 (factory-log.ts) and Task 5 (trend.ts) fill them in.
export type FactoryLogBook = Book;
export type TrendBook = Book;

export interface Feel {
  log: FactoryLogBook;
  trend: TrendBook;
}

/** A book that keeps nothing yet. */
function stubBook(): Book {
  return { record() {} };
}

const feels = new WeakMap<object, Feel>();

/** The store's feel pair; the first call creates it and subscribes both books for the store's
 * lifetime, every later call returns the same pair. */
export function feelOf(store: FeelStore): Feel {
  let feel = feels.get(store);
  if (feel === undefined) {
    feel = { log: stubBook(), trend: stubBook() };
    const { log, trend } = feel;
    store.onAdopt((e) => log.record(e));
    store.onAdopt((e) => trend.record(e));
    feels.set(store, feel);
  }
  return feel;
}

export const FeelContext = createContext<Feel | null>(null);

/** The feel pair App provides; throws outside FeelContext. */
export function useFeel(): Feel {
  const feel = useContext(FeelContext);
  if (feel === null) throw new Error("useFeel outside FeelContext");
  return feel;
}
