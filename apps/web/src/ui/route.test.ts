// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseRoute, routePath, useRoute, type Route } from "./route.js";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

describe("parseRoute (S-10)", () => {
  it.each<[string, Route]>([
    ["/", { kind: "game" }],
    ["", { kind: "game" }],
    ["/handbook", { kind: "handbook", itemId: null }],
    ["/handbook/", { kind: "handbook", itemId: null }],
    ["/handbook/iron_plate", { kind: "handbook", itemId: "iron_plate" }],
    ["/handbook/iron_plate/", { kind: "handbook", itemId: "iron_plate" }],
    ["/handbook/iron%5Fplate", { kind: "handbook", itemId: "iron_plate" }],
    ["/handbook/%E0%A4%A", { kind: "handbook", itemId: null }],
    ["/account/callback/discord", { kind: "callback", provider: "discord" }],
    ["/account/callback/github/", { kind: "callback", provider: "github" }],
    ["/account/callback/", { kind: "game" }],
    ["/account/callback/Disc%20ord", { kind: "game" }],
    ["/account/callback/a/b", { kind: "game" }],
    ["/account/reset-password", { kind: "game" }],
    ["/nope", { kind: "game" }],
    ["/handbook/a/b", { kind: "game" }],
    ["/account", { kind: "game" }],
  ])("%s", (path, route) => {
    expect(parseRoute(path)).toEqual(route);
  });

  it("routePath round-trips the canonical paths", () => {
    for (const p of ["/", "/handbook", "/handbook/iron_plate", "/account/callback/github"]) {
      expect(routePath(parseRoute(p))).toBe(p);
    }
    expect(routePath({ kind: "handbook", itemId: "a b" })).toBe("/handbook/a%20b");
    expect(parseRoute(routePath({ kind: "handbook", itemId: "a/b" }))).toEqual({
      kind: "handbook",
      itemId: "a/b",
    });
  });
});

describe("useRoute", () => {
  it("replaces an unknown path with / and keeps a known one with its query", () => {
    history.replaceState(null, "", "/nope?x=1");
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toEqual({ kind: "game" });
    expect(location.pathname).toBe("/");
    cleanup();

    history.replaceState(null, "", "/handbook/screw?x=1");
    const r2 = renderHook(() => useRoute());
    expect(r2.result.current[0]).toEqual({ kind: "handbook", itemId: "screw" });
    expect(location.pathname + location.search).toBe("/handbook/screw?x=1");
  });

  it("O-8: keeps the callback's query for the SDK to read", () => {
    history.replaceState(null, "", "/account/callback/github?code=c&state=s");
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toEqual({ kind: "callback", provider: "github" });
    expect(location.pathname + location.search).toBe("/account/callback/github?code=c&state=s");
  });

  it("O-1: an old reset link is an unknown path, replaced with /", () => {
    history.replaceState(null, "", "/account/reset-password?token=t");
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toEqual({ kind: "game" });
    expect(location.pathname + location.search).toBe("/");
  });

  it("navigates with pushState and follows popstate", () => {
    const { result } = renderHook(() => useRoute());
    const before = history.length;
    act(() => result.current[1]({ kind: "handbook", itemId: "screw" }));
    expect(location.pathname).toBe("/handbook/screw");
    expect(history.length).toBe(before + 1);
    expect(result.current[0]).toEqual({ kind: "handbook", itemId: "screw" });

    act(() => {
      history.replaceState(null, "", "/handbook");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toEqual({ kind: "handbook", itemId: null });
  });
});
