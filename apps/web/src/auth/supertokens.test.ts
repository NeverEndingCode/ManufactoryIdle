// superTokensClient's mapping of the SDK's statuses (W-15), with the SDK mocked.
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
    signIn: vi.fn(),
    signUp: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    submitNewPassword: vi.fn(),
    doesSessionExist: vi.fn(),
    signOut: vi.fn(),
  };
});

vi.mock("supertokens-web-js", () => ({ default: { init: sdk.init } }));
vi.mock("supertokens-web-js/recipe/emailpassword", () => ({
  default: {
    init: () => "emailpassword",
    signIn: sdk.signIn,
    signUp: sdk.signUp,
    sendPasswordResetEmail: sdk.sendPasswordResetEmail,
    submitNewPassword: sdk.submitNewPassword,
  },
}));
vi.mock("supertokens-web-js/recipe/session", () => ({
  default: {
    init: (config: unknown) => ({ session: config }),
    doesSessionExist: sdk.doesSessionExist,
    signOut: sdk.signOut,
  },
}));
vi.mock("supertokens-web-js/utils/error", () => ({ default: sdk.STGeneralError }));

const { superTokensClient } = await import("./supertokens.js");

beforeEach(() => vi.clearAllMocks());

describe("superTokensClient (W-15)", () => {
  it("initialises once, in cookie mode on /auth at the origin", () => {
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
      recipeList: [{ session: { tokenTransferMethod: "cookie" } }, "emailpassword"],
    });
  });

  it("sends the two form fields, and maps OK", async () => {
    sdk.signUp.mockResolvedValue({ status: "OK" });
    expect(await superTokensClient("o").signUp("a@x", "pw")).toEqual({ ok: true, email: "a@x" });
    expect(sdk.signUp).toHaveBeenCalledWith({
      formFields: [
        { id: "email", value: "a@x" },
        { id: "password", value: "pw" },
      ],
    });
  });

  it("maps wrong credentials and a FIELD_ERROR", async () => {
    const client = superTokensClient("o");
    sdk.signIn.mockResolvedValueOnce({ status: "WRONG_CREDENTIALS_ERROR" });
    expect(await client.signIn("a@x", "pw")).toEqual({ ok: false, kind: "wrong-credentials" });
    sdk.signIn.mockResolvedValueOnce({
      status: "FIELD_ERROR",
      formFields: [{ id: "password", error: "Password must contain at least 8 characters" }],
    });
    expect(await client.signIn("a@x", "pw")).toEqual({
      ok: false,
      kind: "field",
      fields: [{ id: "password", error: "Password must contain at least 8 characters" }],
    });
  });

  it("carries an STGeneralError's message through, in sign-in and in reset", async () => {
    const client = superTokensClient("o");
    sdk.signIn.mockRejectedValueOnce(new sdk.STGeneralError("Accounts are paused"));
    expect(await client.signIn("a@x", "pw")).toEqual({
      ok: false,
      kind: "not-allowed",
      reason: "Accounts are paused",
    });
    sdk.sendPasswordResetEmail.mockRejectedValueOnce(new sdk.STGeneralError("Accounts are paused"));
    expect(await client.sendReset("a@x")).toEqual({
      ok: false,
      kind: "field",
      fields: [{ id: "email", error: "Accounts are paused" }],
    });
    sdk.submitNewPassword.mockRejectedValueOnce(new sdk.STGeneralError("Accounts are paused"));
    expect(await client.submitNewPassword("pw")).toEqual({
      ok: false,
      kind: "field",
      fields: [{ id: "password", error: "Accounts are paused" }],
    });
  });

  it("maps a network throw to unavailable, and a failed sign-out to false", async () => {
    const client = superTokensClient("o");
    const network = new TypeError("Failed to fetch");
    sdk.signUp.mockRejectedValueOnce(network);
    expect(await client.signUp("a@x", "pw")).toEqual({ ok: false, kind: "unavailable" });
    sdk.sendPasswordResetEmail.mockRejectedValueOnce(network);
    expect(await client.sendReset("a@x")).toEqual({ ok: false, kind: "unavailable" });
    sdk.submitNewPassword.mockRejectedValueOnce(network);
    expect(await client.submitNewPassword("pw")).toEqual({ ok: false, kind: "unavailable" });
    sdk.signOut.mockRejectedValueOnce(network);
    expect(await client.signOut()).toBe(false);
    sdk.doesSessionExist.mockRejectedValueOnce(network);
    expect(await client.hasSession()).toBe(false);
  });

  it("maps the reset statuses", async () => {
    const client = superTokensClient("o");
    sdk.submitNewPassword.mockResolvedValueOnce({ status: "RESET_PASSWORD_INVALID_TOKEN_ERROR" });
    expect(await client.submitNewPassword("pw")).toEqual({ ok: false, kind: "invalid-token" });
    sdk.sendPasswordResetEmail.mockResolvedValueOnce({ status: "OK" });
    expect(await client.sendReset("a@x")).toEqual({ ok: true });
    sdk.sendPasswordResetEmail.mockResolvedValueOnce({
      status: "PASSWORD_RESET_NOT_ALLOWED",
      reason: "Not allowed",
    });
    expect(await client.sendReset("a@x")).toEqual({
      ok: false,
      kind: "field",
      fields: [{ id: "email", error: "Not allowed" }],
    });
  });
});
