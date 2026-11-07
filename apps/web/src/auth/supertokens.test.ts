// @vitest-environment jsdom
// superTokensClient's mapping of the SDK's statuses (W-15), with the SDK mocked. jsdom for
// sessionStorage (O-7's consumed marker).
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  class STGeneralError extends Error {
    static isThisError(err: unknown): err is STGeneralError {
      return err instanceof STGeneralError;
    }
  }
  return {
    STGeneralError,
    init: vi.fn(),
    doesSessionExist: vi.fn(),
    signOut: vi.fn(),
    getAuthorisationURLWithQueryParamsAndSetState: vi.fn(),
    getStateAndOtherInfoFromStorage: vi.fn(),
    signInAndUp: vi.fn(),
  };
});

vi.mock("supertokens-web-js", () => ({ default: { init: sdk.init } }));
vi.mock("supertokens-web-js/recipe/session", () => ({
  default: {
    init: (config: unknown) => ({ session: config }),
    doesSessionExist: sdk.doesSessionExist,
    signOut: sdk.signOut,
  },
}));
vi.mock("supertokens-web-js/recipe/thirdparty", () => ({
  default: {
    init: () => "thirdparty",
    getAuthorisationURLWithQueryParamsAndSetState:
      sdk.getAuthorisationURLWithQueryParamsAndSetState,
    getStateAndOtherInfoFromStorage: sdk.getStateAndOtherInfoFromStorage,
    signInAndUp: sdk.signInAndUp,
  },
}));
vi.mock("supertokens-web-js/utils/error", () => ({ default: sdk.STGeneralError }));

const { superTokensClient } = await import("./supertokens.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("superTokensClient (W-15)", () => {
  it("1. initialises once, in cookie mode on /auth at the origin, with no EmailPassword (O-1)", () => {
    const client = superTokensClient("https://game.example");
    client.init();
    client.init();
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledWith({
      appInfo: {
        appName: "Manufactory Idle",
        apiDomain: "https://game.example",
        apiBasePath: "/auth",
      },
      recipeList: [{ session: { tokenTransferMethod: "cookie" } }, "thirdparty"],
    });
  });

  it("maps a failed sign-out to false, and a failed session check to no session", async () => {
    const client = superTokensClient("o");
    const network = new TypeError("Failed to fetch");
    sdk.signOut.mockRejectedValueOnce(network);
    expect(await client.signOut()).toBe(false);
    sdk.doesSessionExist.mockRejectedValueOnce(network);
    expect(await client.hasSession()).toBe(false);
  });
});

/** The SDK's stored state (supertokens-oauth-state-2), as getStateAndOtherInfoFromStorage gives it. */
function stored(over: Record<string, unknown> = {}) {
  return {
    stateForAuthProvider: "st-1",
    thirdPartyId: "github",
    tenantId: undefined,
    expiresAt: Date.now() + 60_000,
    redirectURIOnProviderDashboard: "https://game.example/account/callback/github",
    ...over,
  };
}

const user = (emails: string[]) => ({ id: "u1", emails, thirdParty: [], loginMethods: [] });

describe("superTokensClient: the OAuth redirect (O-7)", () => {
  it("2. authorisationURL pins the callback URI, and maps OK, GENERAL_ERROR and a throw", async () => {
    const client = superTokensClient("https://game.example");
    sdk.getAuthorisationURLWithQueryParamsAndSetState.mockResolvedValueOnce("/fake?state=s");
    expect(await client.authorisationURL("github")).toEqual({ ok: true, url: "/fake?state=s" });
    expect(sdk.getAuthorisationURLWithQueryParamsAndSetState).toHaveBeenCalledWith({
      thirdPartyId: "github",
      frontendRedirectURI: "https://game.example/account/callback/github",
    });
    sdk.getAuthorisationURLWithQueryParamsAndSetState.mockRejectedValueOnce(
      new sdk.STGeneralError("Sign-in isn't available from this address."),
    );
    expect(await client.authorisationURL("github")).toEqual({
      ok: false,
      kind: "not-allowed",
      reason: "Sign-in isn't available from this address.",
    });
    sdk.getAuthorisationURLWithQueryParamsAndSetState.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    expect(await client.authorisationURL("github")).toEqual({ ok: false, kind: "unavailable" });
  });

  it("3. the provider's error params: never the SDK, never error_description", async () => {
    const client = superTokensClient("https://game.example");
    sdk.getStateAndOtherInfoFromStorage.mockReturnValue(stored());
    const evil = "Click%20evil.example%20to%20recover";
    const cases: [string, unknown][] = [
      ["?error=access_denied&state=x", { ok: false, kind: "denied" }],
      [
        "?error=server_error&state=st-1",
        { ok: false, kind: "provider-error", code: "server_error" },
      ],
      ["?error=%3Cscript%3E&state=st-1", { ok: false, kind: "provider-error", code: null }],
    ];
    for (const [search, want] of cases) {
      const result = await client.finishSignIn("github", `${search}&error_description=${evil}`);
      expect(result).toEqual(want);
      expect(JSON.stringify(result)).not.toContain("evil");
    }
    expect(sdk.signInAndUp).not.toHaveBeenCalled();
  });

  it("4. no stored state, or another provider's, is stale", async () => {
    const client = superTokensClient("https://game.example");
    sdk.getStateAndOtherInfoFromStorage.mockReturnValueOnce(undefined);
    expect(await client.finishSignIn("github", "?code=c&state=st-1")).toEqual({
      ok: false,
      kind: "stale",
    });
    sdk.getStateAndOtherInfoFromStorage.mockReturnValueOnce(stored({ thirdPartyId: "discord" }));
    expect(await client.finishSignIn("github", "?code=c&state=st-1")).toEqual({
      ok: false,
      kind: "stale",
    });
    expect(sdk.signInAndUp).not.toHaveBeenCalled();
  });

  it("5. a mismatched or missing state, no code, or an expired state is stale", async () => {
    const client = superTokensClient("https://game.example");
    const cases: [string, ReturnType<typeof stored>][] = [
      ["?code=c&state=other", stored()],
      ["?code=c", stored()],
      ["?state=st-1", stored()],
      ["?code=c&state=st-1", stored({ expiresAt: Date.now() - 1 })],
    ];
    for (const [search, state] of cases) {
      sdk.getStateAndOtherInfoFromStorage.mockReturnValueOnce(state);
      expect(await client.finishSignIn("github", search)).toEqual({ ok: false, kind: "stale" });
    }
    expect(sdk.signInAndUp).not.toHaveBeenCalled();
  });

  it("6. the consumed marker: a state is spent once, and marked before the SDK call", async () => {
    const client = superTokensClient("https://game.example");
    sdk.getStateAndOtherInfoFromStorage.mockReturnValue(stored());
    sdk.signInAndUp.mockResolvedValue({ status: "OK", user: user(["a@x"]) });
    expect((await client.finishSignIn("github", "?code=c&state=st-1")).ok).toBe(true);
    expect(await client.finishSignIn("github", "?code=c&state=st-1")).toEqual({
      ok: false,
      kind: "stale",
    });
    expect(sdk.signInAndUp).toHaveBeenCalledTimes(1);

    sessionStorage.clear();
    sdk.getStateAndOtherInfoFromStorage.mockReturnValue(stored({ stateForAuthProvider: "st-2" }));
    sdk.signInAndUp.mockReturnValueOnce(new Promise(() => {}));
    void client.finishSignIn("github", "?code=c&state=st-2");
    await vi.waitFor(() => expect(sdk.signInAndUp).toHaveBeenCalledTimes(2));
    expect(sessionStorage.getItem("mi.oauthConsumed")).toBe("st-2");
  });

  it("7. maps the sign-in statuses", async () => {
    const client = superTokensClient("https://game.example");
    let n = 0;
    const finish = () => {
      n += 1;
      sdk.getStateAndOtherInfoFromStorage.mockReturnValueOnce(
        stored({ stateForAuthProvider: `st-${n}` }),
      );
      return client.finishSignIn("github", `?code=c&state=st-${n}`);
    };
    sdk.signInAndUp.mockResolvedValueOnce({ status: "OK", user: user(["a@x", "b@x"]) });
    expect(await finish()).toEqual({ ok: true, account: { provider: "github", email: "a@x" } });
    sdk.signInAndUp.mockResolvedValueOnce({ status: "OK", user: user([]) });
    expect(await finish()).toEqual({ ok: true, account: { provider: "github", email: null } });
    sdk.signInAndUp.mockResolvedValueOnce({ status: "NO_EMAIL_GIVEN_BY_PROVIDER" });
    expect(await finish()).toEqual({ ok: false, kind: "no-email" });
    sdk.signInAndUp.mockResolvedValueOnce({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "r" });
    expect(await finish()).toEqual({ ok: false, kind: "not-allowed", reason: "r" });
    sdk.signInAndUp.mockRejectedValueOnce(new sdk.STGeneralError("paused"));
    expect(await finish()).toEqual({ ok: false, kind: "not-allowed", reason: "paused" });
    sdk.signInAndUp.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await finish()).toEqual({ ok: false, kind: "unavailable" });
    // A status this build doesn't know (a newer SDK or server) is unavailable, never undefined.
    sdk.signInAndUp.mockResolvedValueOnce({ status: "SOMETHING_NEW" });
    expect(await finish()).toEqual({ ok: false, kind: "unavailable" });

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    sdk.signInAndUp.mockResolvedValueOnce({ status: "OK", user: user(["c@x"]) });
    expect(await finish()).toEqual({ ok: true, account: { provider: "github", email: "c@x" } });
  });
});
