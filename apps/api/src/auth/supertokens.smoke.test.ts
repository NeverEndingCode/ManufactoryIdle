// The one test against a real SuperTokens core (spec 3b). Skipped unless
// SUPERTOKENS_CONNECTION_URI is set (see infra/README.md); `pnpm test` never runs it.
// Game state lives in PGlite as in the other tests; only auth goes to the core.
// Accounts are OAuth only (O-1), so users and sessions are made with the SDK's own
// functions, with no email/password route and no provider round trip (O-15).
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as Session from "supertokens-node/recipe/session";
import * as ThirdParty from "supertokens-node/recipe/thirdparty";
import { pgliteDb } from "../db/pglite.js";
import { migrate } from "../db/migrate.js";
import type { Db } from "../db/db.js";
import { openContentStore } from "../content.js";
import { buildServer } from "../server.js";
import { identityAuth } from "../identity.js";
import { callbackURL, superTokensFromEnv } from "./supertokens.js";

const SLICE = fileURLToPath(
  new URL("../../../../packages/content/bundles/vertical-slice", import.meta.url),
);

describe.skipIf(!process.env.SUPERTOKENS_CONNECTION_URI)(
  "SuperTokens smoke",
  { timeout: 60_000 },
  () => {
    let db: Db;
    let app: FastifyInstance;
    let websiteDomain: string;

    beforeAll(async () => {
      db = await pgliteDb();
      await migrate(db);
      const content = await openContentStore(db, SLICE);
      // Local-dev domains unless the environment names its own; dummy Discord credentials
      // (never sent anywhere: authorisationurl only builds a URL) so a provider is configured.
      const env = {
        API_DOMAIN: "http://localhost:8080",
        WEBSITE_DOMAIN: "http://localhost:5173",
        ...process.env,
        DISCORD_CLIENT_ID: "smoke-id",
        DISCORD_CLIENT_SECRET: "smoke-secret",
      };
      websiteDomain = env.WEBSITE_DOMAIN;
      const accounts = superTokensFromEnv(env)!;
      expect(accounts.providers).toContain("discord");
      app = buildServer({
        db,
        content,
        clock: Date.now,
        auth: identityAuth({ db, content, clock: Date.now, verifySession: accounts.verifySession }),
        verifySession: accounts.verifySession,
        accounts,
      });
    });
    afterAll(async () => {
      await app?.close();
      await db?.close();
    });

    // A new Discord user straight through the core, and a session for it (O-15).
    async function newSession() {
      const id = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const user = await ThirdParty.manuallyCreateOrUpdateUser(
        "public",
        "discord",
        id,
        `${id}@example.com`,
        true,
      );
      if (user.status !== "OK") throw new Error(`manuallyCreateOrUpdateUser: ${user.status}`);
      return Session.createNewSessionWithoutRequestResponse("public", user.recipeUserId);
    }
    const bearer = async () => `Bearer ${(await newSession()).getAccessToken()}`;

    it("a new account gets a lazily created world", async () => {
      const world = await app.inject({
        method: "GET",
        url: "/api/world",
        headers: { authorization: await bearer() },
      });
      expect(world.statusCode).toBe(200);
      expect(world.json()).toHaveProperty("stateVersion", 0);
      expect(
        await db.query("select 1 from players where supertokens_user_id is not null"),
      ).toHaveLength(1);
    });

    it("a new account claims a guest's world", async () => {
      const guest = await app.inject({ method: "POST", url: "/api/guests" });
      const { guestToken } = guest.json() as { guestToken: string };
      const claim = await app.inject({
        method: "POST",
        url: "/api/auth/claim",
        headers: { authorization: await bearer() },
        payload: { guestToken },
      });
      expect(claim.statusCode).toBe(200);
      const unauthenticated = await app.inject({
        method: "GET",
        url: "/api/world",
        headers: { authorization: "Bearer not-a-token" },
      });
      expect(unauthenticated.statusCode).toBe(401);
    });

    // W-2's cookie check, now on the refresh route: it is the FDI route that sets
    // sAccessToken for a session the core made, given only the refresh cookie (O-15).
    it("a cookie-mode refresh sets a SameSite=Lax sAccessToken and no anti-csrf header (W-2)", async () => {
      const { refreshToken } = (await newSession()).getAllSessionTokensDangerously();
      expect(typeof refreshToken).toBe("string");
      const res = await app.inject({
        method: "POST",
        url: "/auth/session/refresh",
        headers: { "st-auth-mode": "cookie", cookie: `sRefreshToken=${refreshToken}` },
      });
      expect(res.statusCode).toBe(200);
      const cookies = ([] as string[]).concat(res.headers["set-cookie"] as string | string[]);
      const access = cookies.find((c) => c.startsWith("sAccessToken="));
      expect(access).toBeDefined();
      expect(access).toMatch(/SameSite=Lax/i);
      expect(res.headers).not.toHaveProperty("anti-csrf");
    });

    // The default scopes and the redirect guard, against a real core (O-2, O-4).
    it("authorisationurl answers Discord's URL for the pinned URI, and GENERAL_ERROR for another", async () => {
      const authorise = (uri: string) =>
        app.inject({
          method: "GET",
          url: "/auth/authorisationurl",
          query: { thirdPartyId: "discord", redirectURIOnProviderDashboard: uri },
        });
      const good = await authorise(callbackURL(websiteDomain, "discord"));
      expect(good.statusCode).toBe(200);
      const body = good.json() as { status: string; urlWithQueryParams: string };
      expect(body.status).toBe("OK");
      const url = new URL(body.urlWithQueryParams);
      expect(url.host).toBe("discord.com");
      expect(url.searchParams.get("scope")).toBe("identify email");

      const foreign = await authorise("https://evil.example/account/callback/discord");
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json()).toEqual({
        status: "GENERAL_ERROR",
        message: "Sign-in isn't available from this address.",
      });
    });
  },
);
