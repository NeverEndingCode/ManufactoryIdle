import { describe, expect, it } from "vitest";
import { providersFromEnv, superTokensFromEnv } from "./supertokens.js";

// No SuperTokens core here, and init is process-global: these tests never call init.
describe("superTokensFromEnv", () => {
  it("is null without SUPERTOKENS_CONNECTION_URI (R-16)", () => {
    expect(superTokensFromEnv({})).toBeNull();
    expect(superTokensFromEnv({ SUPERTOKENS_CONNECTION_URI: "" })).toBeNull();
    expect(
      superTokensFromEnv({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }),
    ).toBeNull();
  });
});

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
});
