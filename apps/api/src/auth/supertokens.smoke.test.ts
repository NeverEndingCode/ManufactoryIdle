// The one test against a real SuperTokens core (spec 3b). Skipped unless
// SUPERTOKENS_CONNECTION_URI is set (see infra/README.md); `pnpm test` never runs it.
// Game state lives in PGlite as in the other tests; only auth goes to the core.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pgliteDb } from "../db/pglite.js";
import { migrate } from "../db/migrate.js";
import type { Db } from "../db/db.js";
import { openContentStore } from "../content.js";
import { buildServer } from "../server.js";
import { identityAuth } from "../identity.js";
import { superTokensFromEnv } from "./supertokens.js";

const SLICE = fileURLToPath(
  new URL("../../../../packages/content/bundles/vertical-slice", import.meta.url),
);

describe.skipIf(!process.env.SUPERTOKENS_CONNECTION_URI)("SuperTokens smoke", () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await pgliteDb();
    await migrate(db);
    const content = await openContentStore(db, SLICE);
    // Local-dev domains unless the environment names its own.
    const accounts = superTokensFromEnv({
      API_DOMAIN: "http://localhost:8080",
      WEBSITE_DOMAIN: "http://localhost:5173",
      ...process.env,
    })!;
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

  // Signs up through SuperTokens' own route, in header mode, and returns the access token.
  async function signUp(): Promise<string> {
    const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      headers: { "st-auth-mode": "header" },
      payload: {
        formFields: [
          { id: "email", value: email },
          { id: "password", value: "smoke-test-password-1" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("status", "OK");
    const token = res.headers["st-access-token"];
    expect(typeof token).toBe("string");
    return token as string;
  }

  it("a new account gets a lazily created world", async () => {
    const token = await signUp();
    const world = await app.inject({
      method: "GET",
      url: "/api/world",
      headers: { authorization: `Bearer ${token}` },
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
    const token = await signUp();
    const claim = await app.inject({
      method: "POST",
      url: "/api/auth/claim",
      headers: { authorization: `Bearer ${token}` },
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

  it("a cookie-mode sign-up sets a SameSite=Lax sAccessToken and no anti-csrf header (W-2)", async () => {
    const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      headers: { "st-auth-mode": "cookie" },
      payload: {
        formFields: [
          { id: "email", value: email },
          { id: "password", value: "smoke-test-password-1" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] as string | string[]);
    const access = cookies.find((c) => c.startsWith("sAccessToken="));
    expect(access).toBeDefined();
    expect(access).toMatch(/SameSite=Lax/i);
    expect(res.headers).not.toHaveProperty("anti-csrf");
  });
});
