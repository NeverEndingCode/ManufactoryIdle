// S-10 / W-3: routing is a location.pathname switch over three paths, with pushState and
// popstate. Panes and sheets stay component state. The route is one small external store, so
// every useRoute() reads the same value.
import { useEffect, useSyncExternalStore } from "react";
import type { ItemId } from "@manufactory/engine";

export type Route =
  { kind: "game" } | { kind: "handbook"; itemId: ItemId | null } | { kind: "reset-password" };

const GAME: Route = { kind: "game" };

/** A trailing slash is fine; the item is decoded (a malformed escape shows the index); any
 * other path is the game. */
export function parseRoute(pathname: string): Route {
  let p = pathname === "" ? "/" : pathname;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/") return GAME;
  const parts = p.slice(1).split("/");
  if (parts[0] === "handbook") {
    if (parts.length === 1) return { kind: "handbook", itemId: null };
    if (parts.length !== 2) return GAME;
    try {
      const itemId = decodeURIComponent(parts[1]!);
      return { kind: "handbook", itemId: itemId === "" ? null : itemId };
    } catch {
      return { kind: "handbook", itemId: null };
    }
  }
  if (parts.length === 2 && parts[0] === "account" && parts[1] === "reset-password")
    return { kind: "reset-password" };
  return GAME;
}

export function routePath(r: Route): string {
  switch (r.kind) {
    case "game":
      return "/";
    case "handbook":
      return r.itemId === null ? "/handbook" : `/handbook/${encodeURIComponent(r.itemId)}`;
    case "reset-password":
      return "/account/reset-password";
  }
}

/** An unknown path, which the switch shows as the game and replaces with "/". */
function isUnknown(pathname: string): boolean {
  const r = parseRoute(pathname);
  return r.kind === "game" && pathname !== "/" && pathname !== "";
}

const listeners = new Set<() => void>();
let current: { path: string; route: Route } | null = null;

function read(): Route {
  const path = location.pathname;
  if (current === null || current.path !== path) current = { path, route: parseRoute(path) };
  return current.route;
}

function emit(): void {
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (listeners.size === 1) window.addEventListener("popstate", emit);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) window.removeEventListener("popstate", emit);
  };
}

export function navigate(next: Route): void {
  const path = routePath(next);
  if (location.pathname + location.search !== path) history.pushState(null, "", path);
  emit();
}

export function useRoute(): [Route, (next: Route) => void] {
  const route = useSyncExternalStore(subscribe, read, () => GAME);
  useEffect(() => {
    if (isUnknown(location.pathname)) {
      history.replaceState(history.state, "", "/");
      emit();
    }
  }, [route]);
  return [route, navigate];
}
