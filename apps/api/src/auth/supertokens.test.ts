import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as supertokens from "supertokens-node";
import { readFileSync } from "node:fs";
import type { APIInterface } from "supertokens-node/recipe/thirdparty";
import {
  PROVIDER_TABLE,
  appInfoFor,
  callbackURL,
  guardThirdPartyApis,
  providersFromEnv,
  superTokensFromEnv,
} from "./supertokens.js";

// No SuperTokens core here. init is process-global (vitest isolates this file) and a second
// call is a no-op; the describes that call superTokensFromEnv with a connection URI point it
// at one nothing listens on, and never reach it.
const quiet = { info: () => {}, warn: () => {} };

describe("appInfoFor", () => {
  it("names the app, the /auth API and the /account website (W-26)", () => {
    expect(appInfoFor("https://x.example", "https://x.example")).toEqual({
      appName: "Manufactory Idle",
      apiDomain: "https://x.example",
      websiteDomain: "https://x.example",
      apiBasePath: "/auth",
      websiteBasePath: "/account",
    });
  });
});

describe("superTokensFromEnv", () => {
  it("is null without SUPERTOKENS_CONNECTION_URI (R-16)", () => {
    expect(superTokensFromEnv({})).toBeNull();
    expect(superTokensFromEnv({ SUPERTOKENS_CONNECTION_URI: "" })).toBeNull();
    expect(
      superTokensFromEnv({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }),
    ).toBeNull();
  });

  it("requires API_DOMAIN and WEBSITE_DOMAIN when accounts are on", () => {
    const uri = { SUPERTOKENS_CONNECTION_URI: "http://127.0.0.1:1" };
    expect(() => superTokensFromEnv(uri, quiet)).toThrow(
      "SUPERTOKENS_CONNECTION_URI is set, so API_DOMAIN and WEBSITE_DOMAIN must be set too",
    );
    expect(() =>
      superTokensFromEnv({ ...uri, API_DOMAIN: "https://api.example.com" }, quiet),
    ).toThrow("so WEBSITE_DOMAIN must be set too");
    expect(() =>
      superTokensFromEnv({ ...uri, WEBSITE_DOMAIN: "https://example.com", API_DOMAIN: "" }, quiet),
    ).toThrow("so API_DOMAIN must be set too");
  });
});

const BOTH = {
  DISCORD_CLIENT_ID: "did",
  DISCORD_CLIENT_SECRET: "dsecret",
  GITHUB_CLIENT_ID: "gid",
  GITHUB_CLIENT_SECRET: "gsecret",
};

describe("providersFromEnv (R-12)", () => {
  it("adds a provider only when both its client id and secret are set", () => {
    expect(providersFromEnv({})).toEqual([]);
    expect(
      providersFromEnv({ DISCORD_CLIENT_ID: "d", GITHUB_CLIENT_SECRET: "s", GITHUB_CLIENT_ID: "" }),
    ).toEqual([]);
    expect(
      providersFromEnv({
        DISCORD_CLIENT_ID: "did",
        DISCORD_CLIENT_SECRET: "dsecret",
        GITHUB_CLIENT_ID: "gid",
        GITHUB_CLIENT_SECRET: "gsecret",
      }),
    ).toEqual([
      {
        config: {
          thirdPartyId: "discord",
          clients: [{ clientId: "did", clientSecret: "dsecret" }],
        },
      },
      {
        config: { thirdPartyId: "github", clients: [{ clientId: "gid", clientSecret: "gsecret" }] },
      },
    ]);
  });

  it("is one table: discord, then github (O-2)", () => {
    expect(PROVIDER_TABLE).toEqual([
      ["discord", "DISCORD"],
      ["github", "GITHUB"],
    ]);
  });

  it("sets no scope, so the SDK's defaults apply (O-2)", () => {
    const providers = providersFromEnv(BOTH);
    expect(providers).toHaveLength(2);
    for (const p of providers) expect(p.config).not.toHaveProperty("scope");
  });

  it("lists the providers in table order, whatever the env's order", () => {
    const reversed = Object.fromEntries(Object.entries(BOTH).reverse());
    expect(providersFromEnv(reversed).map((p) => p.config.thirdPartyId)).toEqual([
      "discord",
      "github",
    ]);
  });
});

describe("callbackURL (O-4)", () => {
  it("is the website origin's /account/callback/<id>", () => {
    expect(callbackURL("https://x.example/", "github")).toBe(
      "https://x.example/account/callback/github",
    );
    expect(callbackURL("http://localhost:5173", "discord")).toBe(
      "http://localhost:5173/account/callback/discord",
    );
  });
});

describe("guardThirdPartyApis (O-4)", () => {
  const SITE = "https://x.example";
  const GENERAL_ERROR = {
    status: "GENERAL_ERROR",
    message: "Sign-in isn't available from this address.",
  };
  const provider = (id: string) => ({ id }) as never;

  // Like the SDK's override proxy (supertokens-js-override's getProxyObject), whose methods
  // forward through `this._call`: a method called detached from `original` throws.
  function fakeOriginal() {
    const calls = { authorisationUrlGET: 0, signInUpPOST: 0 };
    const original = {
      async authorisationUrlGET(this: unknown) {
        if (this !== original) throw new TypeError("called without the proxy as this");
        calls.authorisationUrlGET++;
        return { status: "OK" as const, urlWithQueryParams: "u" };
      },
      async signInUpPOST(this: unknown) {
        if (this !== original) throw new TypeError("called without the proxy as this");
        calls.signInUpPOST++;
        return { status: "SIGN_IN_UP_NOT_ALLOWED" as const, reason: "original" };
      },
      appleRedirectHandlerPOST: undefined,
    } as unknown as APIInterface;
    return { calls, guarded: guardThirdPartyApis(SITE)(original) };
  }

  const authorise = (guarded: APIInterface, id: string, uri: string) =>
    guarded.authorisationUrlGET!({
      provider: provider(id),
      redirectURIOnProviderDashboard: uri,
      tenantId: "public",
      options: {} as never,
      userContext: {} as never,
    });

  it("authorisationUrlGET passes the exact callback URL through", async () => {
    const { calls, guarded } = fakeOriginal();
    expect(await authorise(guarded, "github", `${SITE}/account/callback/github`)).toEqual({
      status: "OK",
      urlWithQueryParams: "u",
    });
    expect(calls.authorisationUrlGET).toBe(1);
  });

  it("authorisationUrlGET refuses any other redirect URI, without calling the original", async () => {
    const { calls, guarded } = fakeOriginal();
    for (const uri of [
      "https://evil.example/account/callback/github",
      `${SITE}/account/callback/discord`,
      `${SITE}/account/callback/github/`,
      `${SITE}/account/callback/github?next=https://evil.example`,
      "http://x.example/account/callback/github",
      `${SITE}/account/callback/github/../discord`,
    ]) {
      expect(await authorise(guarded, "github", uri), uri).toEqual(GENERAL_ERROR);
    }
    expect(calls.authorisationUrlGET).toBe(0);
  });

  const signInUp = (guarded: APIInterface, extra: object) =>
    guarded.signInUpPOST!({
      provider: provider("discord"),
      tenantId: "public",
      session: undefined,
      shouldTryLinkingWithSessionUser: false,
      options: {} as never,
      userContext: {} as never,
      ...extra,
    } as never);

  it("signInUpPOST refuses oAuthTokens without redirectURIInfo", async () => {
    const { calls, guarded } = fakeOriginal();
    expect(await signInUp(guarded, { oAuthTokens: { access_token: "t" } })).toEqual(GENERAL_ERROR);
    expect(calls.signInUpPOST).toBe(0);
  });

  it("signInUpPOST refuses a foreign redirect URI and passes the exact one through", async () => {
    const { calls, guarded } = fakeOriginal();
    const info = (uri: string) => ({
      redirectURIInfo: {
        redirectURIOnProviderDashboard: uri,
        redirectURIQueryParams: { code: "c" },
      },
    });
    expect(await signInUp(guarded, info("https://evil.example/account/callback/discord"))).toEqual(
      GENERAL_ERROR,
    );
    expect(calls.signInUpPOST).toBe(0);
    expect(await signInUp(guarded, info(`${SITE}/account/callback/discord`))).toEqual({
      status: "SIGN_IN_UP_NOT_ALLOWED",
      reason: "original",
    });
    expect(calls.signInUpPOST).toBe(1);
  });

  it("keeps a disabled API disabled", () => {
    const original = {
      authorisationUrlGET: undefined,
      signInUpPOST: undefined,
      appleRedirectHandlerPOST: undefined,
    } as unknown as APIInterface;
    const guarded = guardThirdPartyApis(SITE)(original);
    expect(guarded.authorisationUrlGET).toBeUndefined();
    expect(guarded.signInUpPOST).toBeUndefined();
  });
});

describe("superTokensFromEnv providers (O-3)", () => {
  const ON = {
    SUPERTOKENS_CONNECTION_URI: "http://127.0.0.1:1",
    API_DOMAIN: "https://api.example.com",
    WEBSITE_DOMAIN: "https://example.com",
  };
  const NO_PROVIDER =
    "accounts are on but no sign-in provider is configured (set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, or GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)";

  it("lists the configured providers, in table order", () => {
    expect(superTokensFromEnv({ ...ON, ...BOTH }, quiet)!.providers).toEqual(["discord", "github"]);
    expect(
      superTokensFromEnv({ ...ON, GITHUB_CLIENT_ID: "g", GITHUB_CLIENT_SECRET: "s" }, quiet)!
        .providers,
    ).toEqual(["github"]);
  });

  it("warns once when accounts are on but no provider is configured", () => {
    const warn = vi.fn();
    expect(superTokensFromEnv(ON, { info: () => {}, warn })!.providers).toEqual([]);
    expect(warn.mock.calls).toEqual([[NO_PROVIDER]]);
  });

  it("does not warn about providers when one is configured", () => {
    const warn = vi.fn();
    superTokensFromEnv(
      {
        ...ON,
        API_DOMAIN: "http://localhost:8080",
        DISCORD_CLIENT_ID: "d",
        DISCORD_CLIENT_SECRET: "s",
      },
      { info: () => {}, warn },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("not https");
  });

  it("warns, by name only, about each provider with exactly one of its two variables set", () => {
    const warn = vi.fn();
    const accounts = superTokensFromEnv(
      {
        ...ON,
        DISCORD_CLIENT_ID: "public-discord-id",
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "top-secret-github",
      },
      { info: () => {}, warn },
    )!;
    expect(accounts.providers).toEqual([]);
    expect(warn.mock.calls).toEqual([
      ["DISCORD_CLIENT_ID is set but DISCORD_CLIENT_SECRET is not: discord sign-in is off"],
      ["GITHUB_CLIENT_SECRET is set but GITHUB_CLIENT_ID is not: github sign-in is off"],
      [NO_PROVIDER],
    ]);
    for (const [line] of warn.mock.calls) {
      expect(line).not.toContain("public-discord-id");
      expect(line).not.toContain("top-secret-github");
    }
    const quietWarn = vi.fn();
    superTokensFromEnv({ ...ON, ...BOTH }, { info: () => {}, warn: quietWarn });
    expect(quietWarn).not.toHaveBeenCalled();
  });

  it("has no email/password recipe and no SMTP (O-1)", () => {
    const source = readFileSync(new URL("./supertokens.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/emailpassword/i);
    expect(source).not.toContain("SMTP");
  });
});

describe("handleError (SDK initialized, no core contacted)", () => {
  // init is process-global: this runs on the SDK config the first describe to init set.
  it("renders SuperTokens' own errors, and leaves the rest to the API's handler", async () => {
    const warn = vi.fn();
    const accounts = superTokensFromEnv(
      {
        SUPERTOKENS_CONNECTION_URI: "http://127.0.0.1:1",
        API_DOMAIN: "http://localhost:8080",
        WEBSITE_DOMAIN: "http://localhost:5173",
        DISCORD_CLIENT_ID: "d",
        DISCORD_CLIENT_SECRET: "s",
      },
      { info: () => {}, warn },
    )!;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("not https");

    const app = Fastify();
    app.setErrorHandler(async (error, request, reply) => {
      if (await accounts.handleError(error, request, reply)) return reply;
      return reply.code(500).send({ error: "internal error" });
    });
    const thrower = (error: Error) => async () => {
      throw error;
    };
    const STError = supertokens.Error as unknown as new (o: {
      type: string;
      message: string;
    }) => Error;
    app.get("/bad-input", thrower(new STError({ type: "BAD_INPUT_ERROR", message: "bad" })));
    app.get(
      "/unknown",
      thrower(new STError({ type: "UNKNOWN_ERROR", message: "secret internals" })),
    );
    // No recipe claims this type, so the SDK's error handler rethrows it.
    app.get("/unclaimed", thrower(new STError({ type: "NOBODY_HANDLES_THIS", message: "x" })));
    app.get("/plain", thrower(new Error("plain")));
    try {
      const bad = await app.inject({ method: "GET", url: "/bad-input" });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ message: "bad" });
      for (const url of ["/unknown", "/unclaimed", "/plain"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(500);
        expect(res.json()).toEqual({ error: "internal error" });
      }
    } finally {
      await app.close();
    }
  });
});
