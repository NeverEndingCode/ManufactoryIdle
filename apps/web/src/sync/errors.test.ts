import { describe, expect, it } from "vitest";
import { classify } from "./errors.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("classify (W-11)", () => {
  it("200: adopt the body", async () => {
    const body = { state: {}, stateVersion: 3 };
    expect(await classify(json(200, body))).toEqual({ kind: "adopt", body });
  });

  it("409: rejected, the body passed through", async () => {
    const body = {
      failedAction: { type: "TAP", count: 1, clientElapsedMs: 50 },
      index: 0,
      reason: "nope",
    };
    expect(await classify(json(409, body))).toEqual({ kind: "rejected", body });
  });

  it("429: paused for Retry-After seconds, no banner", async () => {
    expect(await classify(json(429, { error: "rate-limited" }, { "retry-after": "3" }))).toEqual({
      kind: "paused",
      retryAfterMs: 3_000,
      banner: null,
    });
  });

  it("429 with a missing or bad Retry-After counts as 1 s", async () => {
    for (const headers of [{}, { "retry-after": "soon" }, { "retry-after": "1.5" }] as Record<
      string,
      string
    >[]) {
      expect(await classify(json(429, {}, headers))).toMatchObject({ retryAfterMs: 1_000 });
    }
  });

  it("503 accounts-unavailable: paused 5 s, with the banner", async () => {
    const res = json(503, { error: "accounts-unavailable" }, { "retry-after": "5" });
    expect(await classify(res)).toEqual({
      kind: "paused",
      retryAfterMs: 5_000,
      banner: "accounts-unavailable",
    });
  });

  it("503 without Retry-After counts as 5 s; another 503 has no banner", async () => {
    expect(await classify(json(503, { error: "busy" }))).toEqual({
      kind: "paused",
      retryAfterMs: 5_000,
      banner: null,
    });
  });

  it("a thrown fetch (null) and a 5xx retry with the same key", async () => {
    expect(await classify(null)).toEqual({ kind: "retry" });
    expect(await classify(json(500, { error: "internal error" }))).toEqual({ kind: "retry" });
    expect(await classify(json(502, "bad gateway"))).toEqual({ kind: "retry" });
  });

  it("400: a client bug", async () => {
    const body = { error: "body/actions must be array" };
    expect(await classify(json(400, body))).toEqual({ kind: "client-bug", status: 400, body });
  });

  it("401: unauthorized; 404: no world", async () => {
    expect(await classify(json(401, { error: "unauthorized" }))).toEqual({ kind: "unauthorized" });
    const guest401 = (body: string, scheme = "Guest") =>
      new Response(body, { status: 401, headers: { "www-authenticate": scheme } });
    expect(await classify(guest401('{"error":"unauthorized"}'))).toEqual({
      kind: "unauthorized",
      apiGuest: true,
    });
    expect(await classify(guest401("<html>denied</html>"))).toEqual({ kind: "unauthorized" });
    expect(await classify(guest401('{"error":"unauthorized"}', "Bearer"))).toEqual({
      kind: "unauthorized",
    });
    expect(await classify(json(404, { error: "no world" }))).toEqual({ kind: "no-world" });
  });

  it("408 and 425 retry", async () => {
    expect(await classify(json(408, {}))).toEqual({ kind: "retry" });
    expect(await classify(json(425, {}))).toEqual({ kind: "retry" });
  });

  it("403 is a client bug", async () => {
    expect(await classify(json(403, { error: "forbidden" }))).toEqual({
      kind: "client-bug",
      status: 403,
      body: { error: "forbidden" },
    });
  });

  it("1xx and 3xx retry", async () => {
    // Response can't be built with a 1xx status.
    const informational = { status: 103, headers: new Headers(), text: async () => "" } as Response;
    expect(await classify(informational)).toEqual({ kind: "retry" });
    expect(await classify(new Response(null, { status: 302, headers: { location: "/x" } }))).toEqual({
      kind: "retry",
    });
  });

  it("a 2xx that is not JSON retries", async () => {
    expect(await classify(new Response("<html>ok</html>", { status: 200 }))).toEqual({
      kind: "retry",
    });
  });

  it("a 503 with a bad Retry-After counts as 1 s", async () => {
    expect(await classify(json(503, {}, { "retry-after": "later" }))).toMatchObject({
      kind: "paused",
      retryAfterMs: 1_000,
    });
  });
});
