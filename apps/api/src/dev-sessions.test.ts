import { afterEach, describe, expect, it } from "vitest";
import { devServer, type DevServerOptions } from "./dev-server.js";
import { FAKE_USER_COOKIE } from "./dev-sessions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const ORIGIN = "http://localhost:5173";
const NOT_HERE = { status: "GENERAL_ERROR", message: "Sign-in isn't available from this address." };

async function open(opts: DevServerOptions = { fakeSessions: true }) {
  const dev = await devServer(opts);
  cleanups.push(async () => {
    await dev.app.close();
    await dev.db.close();
  });
  const { app } = dev;
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers });
  const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const authURL = (
    id: string,
    redirect = `${ORIGIN}/account/callback/${id}`,
    headers: Record<string, string> = {},
  ) =>
    get(
      `/auth/authorisationurl?thirdPartyId=${encodeURIComponent(id)}&redirectURIOnProviderDashboard=${encodeURIComponent(redirect)}`,
      headers,
    );
  /** Steps 1–3 of the sign-in: the authorisation URL, then the fake provider. Returns the 302. */
  const authorize = async (id: string, user: string | null) => {
    const url = (await authURL(id)).json().urlWithQueryParams as string;
    return get(`${url}&state=s1`, user === null ? {} : { cookie: `${FAKE_USER_COOKIE}=${user}` });
  };
  const paramsOf = (location: string): Record<string, string> =>
    Object.fromEntries(new URL(location, "http://x").searchParams);
  const signInUp = (
    id: string,
    params: Record<string, string>,
    redirect = `${ORIGIN}/account/callback/${id}`,
  ) =>
    post("/auth/signinup", {
      thirdPartyId: id,
      redirectURIInfo: { redirectURIOnProviderDashboard: redirect, redirectURIQueryParams: params },
    });
  /** The whole sign-in, end to end (steps 1–4). */
  const signIn = async (user: string, id = "discord") => {
    const location = (await authorize(id, user)).headers.location as string;
    return signInUp(id, paramsOf(location));
  };
  const cookieOf = (res: { headers: Record<string, unknown> }): string => {
    const raw = res.headers["set-cookie"];
    const line = (Array.isArray(raw) ? raw : [raw as string]).find((c) =>
      c.startsWith("sAccessToken="),
    )!;
    return line.split(";")[0]!;
  };
  return { ...dev, get, post, authURL, authorize, paramsOf, signInUp, signIn, cookieOf };
}

describe("fake sessions", { timeout: 60_000 }, () => {
  it("health lists the fake providers with the flag, none without", async () => {
    const on = await open();
    expect((await on.get("/api/health")).json()).toMatchObject({
      accounts: true,
      providers: ["discord", "github"],
    });
    const one = await open({ fakeSessions: true, fakeProviders: ["github"] });
    expect((await one.get("/api/health")).json()).toMatchObject({
      accounts: true,
      providers: ["github"],
    });
    const off = await open({});
    expect((await off.get("/api/health")).json()).toMatchObject({ accounts: false, providers: [] });
  });

  // Mutation caught: pinning by prefix or ignoring the provider id lets the second and third
  // cases through; returning an absolute URL breaks the path-only check.
  it("authorisationurl: a path-only URL for a listed provider and its exact callback", async () => {
    const { authURL } = await open();
    const ok = await authURL("discord");
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { status: string; urlWithQueryParams: string };
    expect(body.status).toBe("OK");
    expect(body.urlWithQueryParams.startsWith("/auth/dev/oauth/authorize?")).toBe(true);
    const q = new URL(body.urlWithQueryParams, "http://x").searchParams;
    expect(q.get("thirdPartyId")).toBe("discord");
    expect(q.get("redirect_uri")).toBe(`${ORIGIN}/account/callback/discord`);

    const unlisted = await authURL("google");
    expect(unlisted.statusCode).toBe(400);
    expect(unlisted.json()).toEqual({
      message: "the provider google could not be found in the configuration",
    });

    expect((await authURL("discord", `${ORIGIN}/account/callback/github`)).json()).toEqual(
      NOT_HERE,
    );
    expect((await authURL("discord", `${ORIGIN}/elsewhere`)).json()).toEqual(NOT_HERE);
    expect((await authURL("discord", `${ORIGIN}/account/callback/discord/x`)).json()).toEqual(
      NOT_HERE,
    );
    expect((await authURL("discord", "not a url")).json()).toEqual(NOT_HERE);
  });

  // Mutation caught: redirecting to redirect_uri itself (not just its path) sends the player
  // to evil.example.
  it("authorize: the 302 is path-only, to our callback, whatever redirect_uri says", async () => {
    const { get, authorize } = await open();
    const res = await authorize("discord", "alice");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(
      /^\/account\/callback\/discord\?code=[0-9a-f]{32}&state=s1$/,
    );

    const evil = await get(
      `/auth/dev/oauth/authorize?thirdPartyId=discord&redirect_uri=${encodeURIComponent("https://evil.example/account/callback/discord")}&state=s1`,
    );
    expect(evil.statusCode).toBe(302);
    expect(evil.headers.location).toMatch(
      /^\/account\/callback\/discord\?code=[0-9a-f]{32}&state=s1$/,
    );

    const deny = await authorize("discord", "deny");
    expect(deny.statusCode).toBe(302);
    expect(deny.headers.location).toBe("/account/callback/discord?error=access_denied&state=s1");
  });

  it("authorize: a cookie outside the pattern is the default player", async () => {
    const { authorize, paramsOf, signInUp } = await open();
    const res = await authorize("discord", "Not_A_User!");
    const ok = await signInUp("discord", paramsOf(res.headers.location as string));
    expect(ok.json().user.emails).toEqual(["player@discord.example"]);
    const none = await authorize("github", null);
    const ok2 = await signInUp("github", paramsOf(none.headers.location as string));
    expect(ok2.json().user.emails).toEqual(["player@github.example"]);
  });

  // Mutation caught: keying users by user alone makes alice on GitHub the Discord alice (O-12).
  it("signinup: creates, then finds, a ThirdParty user per provider, with a session", async () => {
    const { signIn } = await open();
    const before = Date.now();
    const first = await signIn("alice");
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("application/json");
    const body = first.json();
    expect(body.status).toBe("OK");
    expect(body.createdNewRecipeUser).toBe(true);
    expect(body.user).toMatchObject({
      emails: ["alice@discord.example"],
      tenantIds: ["public"],
      isPrimaryUser: false,
      phoneNumbers: [],
      thirdParty: [{ id: "discord", userId: "alice" }],
    });
    expect(body.user.loginMethods[0]).toMatchObject({
      recipeId: "thirdparty",
      recipeUserId: body.user.id,
      email: "alice@discord.example",
      thirdParty: { id: "discord", userId: "alice" },
    });
    const setCookie = ([] as string[]).concat(first.headers["set-cookie"] as string | string[]);
    const line = setCookie.find((c) => c.startsWith("sAccessToken=dev."))!;
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("Path=/");
    const front = JSON.parse(
      Buffer.from(first.headers["front-token"] as string, "base64").toString(),
    );
    expect(front.uid).toBe(body.user.id);
    expect(front.ate).toBeGreaterThan(before);
    expect(front.up).toEqual({});

    const again = (await signIn("alice")).json();
    expect(again.status).toBe("OK");
    expect(again.createdNewRecipeUser).toBe(false);
    expect(again.user.id).toBe(body.user.id);

    const github = (await signIn("alice", "github")).json();
    expect(github.createdNewRecipeUser).toBe(true);
    expect(github.user.emails).toEqual(["alice@github.example"]);
    expect(github.user.id).not.toBe(body.user.id);
  });

  // Mutation caught: not deleting a used code lets the reuse succeed.
  it("signinup failures", async () => {
    const { authorize, paramsOf, signInUp, post } = await open();
    const params = paramsOf((await authorize("discord", "bob")).headers.location as string);
    expect((await signInUp("discord", params)).json().status).toBe("OK");
    const reused = await signInUp("discord", params);
    expect(reused.statusCode).toBe(500);
    expect(reused.json()).toEqual({ error: "internal error" });

    const crossed = paramsOf((await authorize("discord", "bob")).headers.location as string);
    const asGithub = await signInUp("github", crossed);
    expect(asGithub.statusCode).toBe(500);
    expect(asGithub.json()).toEqual({ error: "internal error" });

    const made = await signInUp("discord", { code: "0".repeat(32), state: "s1" });
    expect(made.statusCode).toBe(500);

    const noInfo = await post("/auth/signinup", {
      thirdPartyId: "discord",
      oAuthTokens: { access_token: "x" },
    });
    expect(noInfo.json()).toEqual(NOT_HERE);
    const elsewhere = paramsOf((await authorize("discord", "bob")).headers.location as string);
    expect((await signInUp("discord", elsewhere, `${ORIGIN}/elsewhere`)).json()).toEqual(NOT_HERE);
    const unlisted = await signInUp("google", elsewhere);
    expect(unlisted.statusCode).toBe(400);
    expect(unlisted.json()).toEqual({
      message: "the provider google could not be found in the configuration",
    });

    const noEmail = paramsOf((await authorize("discord", "no-email")).headers.location as string);
    const r1 = await signInUp("discord", noEmail);
    expect(r1.json()).toEqual({ status: "NO_EMAIL_GIVEN_BY_PROVIDER" });
    expect(r1.headers["set-cookie"]).toBeUndefined();
    const notAllowed = paramsOf(
      (await authorize("discord", "not-allowed")).headers.location as string,
    );
    expect((await signInUp("discord", notAllowed)).json()).toEqual({
      status: "SIGN_IN_UP_NOT_ALLOWED",
      reason: "Cannot sign in / up due to security reasons. Please contact support. (ERR_CODE_DEV)",
    });
  });

  it("the cookie is a session for /api/world and claim", async () => {
    const { get, post, signIn, cookieOf } = await open();
    const world = await get("/api/world", { cookie: cookieOf(await signIn("alice")) });
    expect(world.statusCode).toBe(200);

    const s2 = await signIn("bob");
    const { guestToken } = (await post("/api/guests")).json() as { guestToken: string };
    const claim = await post("/api/auth/claim", { guestToken }, { cookie: cookieOf(s2) });
    expect(claim.statusCode).toBe(200);
    const after = await get("/api/world", { authorization: `Guest ${guestToken}` });
    expect(after.statusCode).toBe(401);
  });

  it("sign-out clears the cookie and revokes the session", async () => {
    const { get, post, signIn, cookieOf } = await open();
    const cookie = cookieOf(await signIn("alice"));
    const out = await post("/auth/signout", undefined, { cookie });
    expect(out.json()).toEqual({ status: "OK" });
    expect(out.headers["front-token"]).toBe("remove");
    const cleared = ([] as string[])
      .concat(out.headers["set-cookie"] as string | string[])
      .find((c) => c.startsWith("sAccessToken="))!;
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await get("/api/world", { cookie })).statusCode).toBe(401);
    expect((await get("/api/world")).statusCode).toBe(401);
  });

  it("refresh needs the cookie", async () => {
    const { post, signIn, cookieOf } = await open();
    const cookie = cookieOf(await signIn("alice"));
    const ok = await post("/auth/session/refresh", undefined, { cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["front-token"]).toBeDefined();
    expect(ok.headers["front-token"]).not.toBe("remove");
    const no = await post("/auth/session/refresh");
    expect(no.statusCode).toBe(401);
    expect(no.json()).toEqual({ message: "unauthorised" });
    expect(no.headers["front-token"]).toBe("remove");
  });

  it("rejects an fdi-version the node SDK does not speak", async () => {
    const { authURL } = await open();
    const bad = await authURL("discord", undefined, { "fdi-version": "1.16" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("fdi-version mismatch");
    expect((await authURL("discord", undefined, { "fdi-version": "4.2,4.1" })).json().status).toBe(
      "OK",
    );
    expect((await authURL("discord")).json().status).toBe("OK");
  });

  it("the email/password endpoints are gone", async () => {
    const { get, post } = await open();
    const form = {
      formFields: [
        { id: "email", value: "a@example.com" },
        { id: "password", value: "hunter2hunter2" },
      ],
    };
    expect((await post("/auth/signup", form)).statusCode).toBe(404);
    expect((await post("/auth/signin", form)).statusCode).toBe(404);
    expect((await post("/auth/user/password/reset/token", form)).statusCode).toBe(404);
    expect((await get("/auth/dev/reset-link?email=a@example.com")).statusCode).toBe(404);
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
