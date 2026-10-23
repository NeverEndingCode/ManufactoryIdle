import { afterEach, describe, expect, it, vi } from "vitest";
import { browserFetch } from "./fetch.js";

const g = globalThis as { window?: unknown };
afterEach(() => {
  delete g.window;
});

describe("browserFetch (S-2)", () => {
  it("13. reaches whatever window.fetch is at call time", async () => {
    const f1 = vi.fn(async () => new Response("1"));
    const f2 = vi.fn(async () => new Response("2"));
    g.window = { fetch: f1 };
    await browserFetch("/a", { method: "POST" });
    (g.window as { fetch: unknown }).fetch = f2;
    await browserFetch("/b");
    expect(f1.mock.calls).toEqual([["/a", { method: "POST" }]]);
    expect(f2.mock.calls).toEqual([["/b", undefined]]);
  });
});
