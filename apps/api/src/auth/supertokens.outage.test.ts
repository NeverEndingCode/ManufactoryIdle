import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import * as supertokens from "supertokens-node";
import { AccountsUnavailableError } from "../identity.js";
import { superTokensFromEnv } from "./supertokens.js";

// getSession is mocked so the test can make it fail as the SDK's querier does when no core
// answers. (A real token cannot provoke that cheaply: the SDK turns a failed JWKS fetch into
// TRY_REFRESH_TOKEN, a SuperTokens error.) Everything else in the SDK is real; init is
// process-global and vitest isolates this file.
const getSession = vi.hoisted(() => vi.fn());
vi.mock("supertokens-node/recipe/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSession,
}));

describe("verifySession's outage tagging", () => {
  it("tags a non-SuperTokens error as AccountsUnavailableError, and passes SuperTokens errors through", async () => {
    const accounts = superTokensFromEnv(
      {
        SUPERTOKENS_CONNECTION_URI: "http://127.0.0.1:1",
        API_DOMAIN: "http://localhost:8080",
        WEBSITE_DOMAIN: "http://localhost:5173",
      },
      { info: () => {}, warn: () => {} },
    )!;
    const app = Fastify();
    accounts.register(app);
    const seen: unknown[] = [];
    app.get("/who", async (request) => {
      try {
        return { user: await accounts.verifySession(request) };
      } catch (err) {
        seen.push(err);
        return { thrown: true };
      }
    });
    const STError = supertokens.Error as unknown as new (o: { type: string; message: string }) => Error;
    const core = new Error("No SuperTokens core available to query");
    const refresh = new STError({ type: "TRY_REFRESH_TOKEN", message: "try refresh" });
    try {
      getSession.mockRejectedValueOnce(core);
      await app.inject({ method: "GET", url: "/who" });
      getSession.mockRejectedValueOnce(refresh);
      await app.inject({ method: "GET", url: "/who" });
      getSession.mockResolvedValueOnce({ getUserId: () => "u1" });
      const ok = await app.inject({ method: "GET", url: "/who" });
      expect(ok.json()).toEqual({ user: "u1" });

      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeInstanceOf(AccountsUnavailableError);
      expect((seen[0] as Error).cause).toBe(core);
      expect(seen[1]).toBe(refresh);
    } finally {
      await app.close();
    }
  });
});
