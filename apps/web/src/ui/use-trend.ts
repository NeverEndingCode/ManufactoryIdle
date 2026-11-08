// L-12: the trend book's version, for a memo key. It changes on an adoption and once a server
// minute (the book's own timer, armed only while something here is subscribed), never at 4 Hz.
import { useSyncExternalStore } from "react";
import type { TrendBook } from "./trend.js";

export function useTrend(book: TrendBook): number {
  return useSyncExternalStore(book.subscribe, book.version, book.version);
}
