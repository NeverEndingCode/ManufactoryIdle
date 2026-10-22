import { afterEach, describe, expect, it } from "vitest";
import { devServer } from "./dev-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function open(fakeSessions = true) {
  const dev = await devServer(fakeSessions ? { fakeSessions: true } : {});
  cleanups.push(async () => {
    await dev.app.close();
    await dev.db.close();
  });
  const { app } = dev;
  const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const form = (email: string, password: string) => ({
    formFields: [
      { id: "email", value: email },
      { id: "password", value: password },
    ],
  });
  const signUp = (email: string, password = "hunter2hunter2") =>
    post("/auth/signup", form(email, password));
  const cookieOf = (res: { headers: Record<string, unknown> }): string => {
    const raw = res.headers["set-cookie"];
    const line = (Array.isArray(raw) ? raw : [raw as string]).find((c) => c.startsWith("sAccessToken="))!;
    return line.split(";")[0]!;
  };
  return { ...dev, post, form, signUp, cookieOf };
}

describe("fake sessions", () => {
  it("health says accounts: true with the flag, false without", async () => {
    const on = await open();
    expect((await on.app.inject({ method: "GET", url: "/api/health" })).json()).toHaveProperty("accounts", true);
    const off = await open(false);
    expect((await off.app.inject({ method: "GET", url: "/api/health" })).json()).toHaveProperty("accounts", false);
  });

  it("sign-up gives OK, a session cookie and a front-token", async () => {
    const { signUp } = await open();
    const before = Date.now();
    const res = await signUp("a@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const body = res.json();
    expect(body.status).toBe("OK");
    expect(body.user).toMatchObject({
      emails: ["a@example.com"],
      tenantIds: ["public"],
      isPrimaryUser: false,
      phoneNumbers: [],
      thirdParty: [],
    });
    const setCookie = ([] as string[]).concat(res.headers["set-cookie"] as string | string[]);
    const line = setCookie.find((c) => c.startsWith("sAccessToken=dev."))!;
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Path=/");
    const front = JSON.parse(Buffer.from(res.headers["front-token"] as string, "base64").toString());
    expect(front.uid).toBe(body.user.id);
    expect(front.ate).toBeGreaterThan(before);
    expect(front.up).toEqual({});
  });

  it("sign-up field errors", async () => {
    const { signUp } = await open();
    await signUp("a@example.com");
    const dup = (await signUp("a@example.com")).json();
    expect(dup).toEqual({
      status: "FIELD_ERROR",
      formFields: [{ id: "email", error: "This email already exists. Please sign in instead." }],
    });
    const bad = (await signUp("nope")).json();
    expect(bad.formFields).toEqual([{ id: "email", error: "Email is invalid" }]);
    const short = (await signUp("b@example.com", "short1")).json();
    expect(short.formFields).toEqual([
      { id: "password", error: "Password must contain at least 8 characters, including a number" },
    ]);
  });

  it("sign-in: wrong password, then right", async () => {
    const { signUp, post, form } = await open();
    await signUp("a@example.com", "rightpass1");
    const wrong = await post("/auth/signin", form("a@example.com", "wrongpass1"));
    expect(wrong.json()).toEqual({ status: "WRONG_CREDENTIALS_ERROR" });
    const unknown = await post("/auth/signin", form("z@example.com", "rightpass1"));
    expect(unknown.json()).toEqual({ status: "WRONG_CREDENTIALS_ERROR" });
    const ok = await post("/auth/signin", form("a@example.com", "rightpass1"));
    expect(ok.json().status).toBe("OK");
    expect(ok.headers["set-cookie"]).toBeDefined();
  });

  it("the cookie is a session for /api/world and claim", async () => {
    const { app, signUp, post, cookieOf } = await open();
    const s1 = await signUp("a@example.com");
    const world = await app.inject({ method: "GET", url: "/api/world", headers: { cookie: cookieOf(s1) } });
    expect(world.statusCode).toBe(200);

    const s2 = await signUp("b@example.com");
    const { guestToken } = (await post("/api/guests")).json() as { guestToken: string };
    const claim = await post("/api/auth/claim", { guestToken }, { cookie: cookieOf(s2) });
    expect(claim.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/api/world",
      headers: { authorization: `Guest ${guestToken}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("sign-out clears the cookie and revokes the session", async () => {
    const { app, signUp, post, cookieOf } = await open();
    const cookie = cookieOf(await signUp("a@example.com"));
    const out = await post("/auth/signout", undefined, { cookie });
    expect(out.json()).toEqual({ status: "OK" });
    expect(out.headers["front-token"]).toBe("remove");
    const cleared = ([] as string[])
      .concat(out.headers["set-cookie"] as string | string[])
      .find((c) => c.startsWith("sAccessToken="))!;
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    const replay = await app.inject({ method: "GET", url: "/api/world", headers: { cookie } });
    expect(replay.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/world" })).statusCode).toBe(401);
  });

  it("rejects an fdi-version the node SDK does not speak", async () => {
    const { post, form } = await open();
    const bad = await post("/auth/signup", form("a@example.com", "hunter2hunter2"), { "fdi-version": "1.17" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("fdi-version mismatch");
    const ok = await post("/auth/signup", form("a@example.com", "hunter2hunter2"), { "fdi-version": "4.2,4.1" });
    expect(ok.statusCode).toBe(200);
    const none = await post("/auth/signup", form("b@example.com", "hunter2hunter2"));
    expect(none.statusCode).toBe(200);
  });

  it("password reset", async () => {
    const { app, signUp, post, form } = await open();
    await signUp("a@example.com", "oldpass123");
    expect((await post("/auth/user/password/reset/token", { formFields: [{ id: "email", value: "a@example.com" }] })).json()).toEqual({ status: "OK" });
    expect((await post("/auth/user/password/reset/token", { formFields: [{ id: "email", value: "x@example.com" }] })).json()).toEqual({ status: "OK" });
    const link = await app.inject({ method: "GET", url: "/auth/dev/reset-link?email=a@example.com" });
    const path = (link.json() as { link: string }).link;
    expect(path.startsWith("/account/reset-password?token=")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/auth/dev/reset-link?email=x@example.com" })).statusCode).toBe(404);
    const token = new URL(path, "http://x").searchParams.get("token")!;
    const reset = await post("/auth/user/password/reset", { formFields: [{ id: "password", value: "newpass123" }], token });
    expect(reset.json()).toEqual({ status: "OK" });
    expect((await post("/auth/signin", form("a@example.com", "newpass123"))).json().status).toBe("OK");
    expect((await post("/auth/signin", form("a@example.com", "oldpass123"))).json().status).toBe("WRONG_CREDENTIALS_ERROR");
    const bogus = await post("/auth/user/password/reset", { formFields: [{ id: "password", value: "newpass123" }], token: "made-up" });
    expect(bogus.json()).toEqual({ status: "RESET_PASSWORD_INVALID_TOKEN_ERROR" });
  });

  it("refresh needs the cookie", async () => {
    const { signUp, post, cookieOf } = await open();
    const cookie = cookieOf(await signUp("a@example.com"));
    const ok = await post("/auth/session/refresh", undefined, { cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["front-token"]).toBeDefined();
    expect(ok.headers["front-token"]).not.toBe("remove");
    const no = await post("/auth/session/refresh");
    expect(no.statusCode).toBe(401);
    expect(no.json()).toEqual({ message: "unauthorised" });
    expect(no.headers["front-token"]).toBe("remove");
  });

  it("refuses to exist in production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(devServer({ fakeSessions: true })).rejects.toThrow(/production/);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
