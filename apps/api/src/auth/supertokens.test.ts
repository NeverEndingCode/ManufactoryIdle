import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as supertokens from "supertokens-node";
import { SMTPService } from "supertokens-node/recipe/emailpassword/emaildelivery";
import { passwordResetDelivery, providersFromEnv, superTokensFromEnv } from "./supertokens.js";

// No SuperTokens core here. init is process-global (vitest isolates this file); only the
// last describe initializes it, against a URI nothing listens on, and never reaches it.
const quiet = { info: () => {}, warn: () => {} };

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

describe("passwordResetDelivery (R-24)", () => {
  const SMTP = {
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "mailer",
    SMTP_PASSWORD: "pw",
    SMTP_FROM: "noreply@example.com",
  };
  const RESET = {
    type: "PASSWORD_RESET" as const,
    user: { id: "u1", recipeUserId: undefined, email: "player@example.com" },
    passwordResetLink: "https://example.com/auth/reset-password?token=SECRET-TOKEN",
    tenantId: "public",
    userContext: {},
  };

  it("without full SMTP config, sends nothing and logs no address or token", async () => {
    for (const env of [{}, { ...SMTP, SMTP_PASSWORD: undefined }, { ...SMTP, SMTP_FROM: "" }]) {
      const log = vi.fn();
      const delivery = passwordResetDelivery(env, log);
      expect(delivery.kind).toBe("none");
      expect(delivery.service).not.toBeInstanceOf(SMTPService);
      await delivery.service.sendEmail(RESET as never);
      expect(log.mock.calls).toEqual([["password reset email not sent: SMTP not configured"]]);
    }
  });

  it("uses the SDK's SMTP service when all five SMTP vars are set", () => {
    const delivery = passwordResetDelivery(SMTP, () => {});
    expect(delivery.kind).toBe("smtp");
    expect(delivery.service).toBeInstanceOf(SMTPService);
    expect(() => passwordResetDelivery({ ...SMTP, SMTP_PORT: "nope" }, () => {})).toThrow(
      "SMTP_PORT",
    );
  });
});

describe("handleError (SDK initialized, no core contacted)", () => {
  it("renders SuperTokens' own errors, and leaves the rest to the API's handler", async () => {
    const warn = vi.fn();
    const accounts = superTokensFromEnv(
      {
        SUPERTOKENS_CONNECTION_URI: "http://127.0.0.1:1",
        API_DOMAIN: "http://localhost:8080",
        WEBSITE_DOMAIN: "http://localhost:5173",
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
