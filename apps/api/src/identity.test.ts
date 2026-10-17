import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { initialWorld, serializeWorld, type Action } from "@manufactory/engine";
import { pgliteDb } from "./db/pglite.js";
import { migrate } from "./db/migrate.js";
import type { Db } from "./db/db.js";
import { openContentStore, type ContentStore } from "./content.js";
import { buildServer } from "./server.js";
import { identityAuth, noSessions, type SessionVerifier } from "./identity.js";
import { claimGuest, createPlayerWithWorld } from "./worlds.js";

const SLICE = fileURLToPath(
  new URL("../../../packages/content/bundles/vertical-slice", import.meta.url),
);
const T0 = 1_760_000_000_000;
let now = T0;

// Test-only fake: the "session" is whatever the x-test-user header says.
const verifySession: SessionVerifier = async (request) => {
  const h = request.headers["x-test-user"];
  return typeof h === "string" ? h : null;
};

let db: Db;
let store: ContentStore;
let app: FastifyInstance;

beforeEach(async () => {
  now = T0;
  db = await pgliteDb();
  await migrate(db);
  store = await openContentStore(db, SLICE);
  app = buildServer({
    db,
    content: store,
    clock: () => now,
    auth: identityAuth({ db, content: store, clock: () => now, verifySession }),
    verifySession,
  });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

const getWorld = (headers: Record<string, string>) =>
  app.inject({ method: "GET", url: "/api/world", headers });

describe("lazy account players", () => {
  it("creates one player and world on the first request, and nothing on the second", async () => {
    const first = await getWorld({ "x-test-user": "u1" });
    expect(first.statusCode).toBe(200);
    const players = await db.query<{ id: string; supertokens_user_id: string; guest_token: null }>(
      "select id, supertokens_user_id, guest_token from players",
    );
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({ supertokens_user_id: "u1", guest_token: null });
    const worlds = await db.query<{ state: unknown; initial_seed: number }>(
      "select state, initial_seed from player_worlds",
    );
    expect(worlds).toHaveLength(1);
    const expected = initialWorld(store.current.content, worlds[0]!.initial_seed, T0);
    expect(worlds[0]!.state).toEqual(JSON.parse(serializeWorld(expected)));

    expect((await getWorld({ "x-test-user": "u1" })).statusCode).toBe(200);
    expect(await db.query("select 1 from players")).toHaveLength(1);
    expect(await db.query("select 1 from player_worlds")).toHaveLength(1);
  });

  it("leaves one player after concurrent first requests (R-17)", async () => {
    const res = await Promise.all([
      getWorld({ "x-test-user": "u2" }),
      getWorld({ "x-test-user": "u2" }),
    ]);
    expect(res.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await db.query("select 1 from players where supertokens_user_id = 'u2'")).toHaveLength(
      1,
    );
  });

  it("returns the existing player when the insert loses the race (R-17 conflict path)", async () => {
    const key = { superTokensUserId: "u2b" };
    const a = await createPlayerWithWorld(db, key, store, T0);
    const b = await createPlayerWithWorld(db, key, store, T0);
    expect(b.playerId).toBe(a.playerId);
    expect(b.world.id).toBe(a.world.id);
    expect(await db.query("select 1 from players")).toHaveLength(1);
    expect(await db.query("select 1 from player_worlds")).toHaveLength(1);
  });
});

describe("precedence and guests", () => {
  it("a session wins over a guest token (R-13)", async () => {
    const created = await app.inject({ method: "POST", url: "/api/guests" });
    const token = (created.json() as { guestToken: string }).guestToken;
    const guestHeaders = { authorization: `Guest ${token}` };
    const before = await db.query("select id, state, state_version from player_worlds");

    const res = await getWorld({ ...guestHeaders, "x-test-user": "u3" });
    expect(res.statusCode).toBe(200);
    const u3 = await db.query<{ id: string }>(
      "select id from players where supertokens_user_id = 'u3'",
    );
    expect(u3).toHaveLength(1);
    const worlds = await db.query<{ player_id: string }>("select player_id from player_worlds");
    expect(worlds.map((w) => w.player_id)).toContain(u3[0]!.id);
    expect(await db.query("select id, state, state_version from player_worlds where player_id <> $1", [u3[0]!.id])).toEqual(before);
    // The session was opened for u3, not for the guest.
    const sessions = await db.query<{ player_id: string }>("select player_id from sessions");
    expect(sessions.map((s) => s.player_id)).toEqual([u3[0]!.id]);
  });

  it("serves guest-only requests, and 401s with neither", async () => {
    const created = await app.inject({ method: "POST", url: "/api/guests" });
    const token = (created.json() as { guestToken: string }).guestToken;
    expect((await getWorld({ authorization: `Guest ${token}` })).statusCode).toBe(200);
    expect((await getWorld({})).statusCode).toBe(401);
    expect(await db.query("select 1 from players")).toHaveLength(1);
  });
});

const BUY_MINER: Action = {
  type: "BUY_MACHINE",
  lane: "iron",
  machineClass: "miner",
  mark: 1,
  count: 1,
};

const newGuest = async () =>
  ((await app.inject({ method: "POST", url: "/api/guests" })).json() as { guestToken: string })
    .guestToken;
const claim = (user: string | null, body: unknown, extra: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/auth/claim",
    headers: { ...(user ? { "x-test-user": user } : {}), ...extra },
    payload: body as object,
  });
describe("POST /api/auth/claim", () => {
  it("claims a played guest world before the account's first request", async () => {
    const token = await newGuest();
    now = T0 + 10 * 60_000;
    const played = await app.inject({
      method: "POST",
      url: "/api/actions",
      headers: { authorization: `Guest ${token}` },
      payload: { idempotencyKey: "k-1", baseVersion: 0, actions: [BUY_MINER] },
    });
    expect(played.statusCode).toBe(200);
    const before = await db.query<{ player_id: string; state: unknown; state_version: string }>(
      "select player_id, state, state_version::text as state_version from player_worlds",
    );
    const logBefore = await db.query("select * from action_log");
    expect(before).toHaveLength(1);

    const res = await claim("u5", { guestToken: token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("stateVersion", 1);

    const players = await db.query<{ id: string; supertokens_user_id: string; guest_token: null }>(
      "select id, supertokens_user_id, guest_token from players",
    );
    expect(players).toHaveLength(1);
    expect(players[0]).toMatchObject({
      id: before[0]!.player_id,
      supertokens_user_id: "u5",
      guest_token: null,
    });
    expect(
      await db.query(
        "select player_id, state, state_version::text as state_version from player_worlds",
      ),
    ).toEqual(before);
    expect(await db.query("select * from action_log")).toEqual(logBefore);

    const world = await getWorld({ "x-test-user": "u5" });
    expect(world.statusCode).toBe(200);
    expect(world.json()).toHaveProperty("stateVersion", 1);
    expect(await db.query("select 1 from players")).toHaveLength(1);
    expect((await getWorld({ authorization: `Guest ${token}` })).statusCode).toBe(401);
  });

  it("409s when the account already has a world, leaving the guest untouched", async () => {
    const token = await newGuest();
    expect((await getWorld({ "x-test-user": "u6" })).statusCode).toBe(200);
    const res = await claim("u6", { guestToken: token });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "already-has-world" });
    expect(await db.query("select 1 from players")).toHaveLength(2);
    expect(
      await db.query("select 1 from players where guest_token is not null and supertokens_user_id is null"),
    ).toHaveLength(1);
    expect((await getWorld({ authorization: `Guest ${token}` })).statusCode).toBe(200);
  });

  it("404s on an unknown token, and when the guest was already claimed (R-18)", async () => {
    const unknown = await claim("u7", { guestToken: "A".repeat(43) });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "unknown-guest" });
    expect(await db.query("select 1 from players")).toHaveLength(0);

    const token = await newGuest();
    expect((await claim("u5", { guestToken: token })).statusCode).toBe(200);
    const again = await claim("u7", { guestToken: token });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ error: "unknown-guest" });
  });

  it("401s without a session and 400s on a malformed body", async () => {
    const token = await newGuest();
    expect((await claim(null, { guestToken: token })).statusCode).toBe(401);
    expect(
      (await claim(null, { guestToken: token }, { authorization: `Guest ${token}` })).statusCode,
    ).toBe(401);
    for (const body of [{}, { guestToken: "short" }, { guestToken: token, extra: 1 }]) {
      expect((await claim("u8", body)).statusCode).toBe(400);
    }
    expect(await db.query("select 1 from players where supertokens_user_id is not null")).toHaveLength(0);
  });

  it("answers already-has-world when the account's player appears between check and update", async () => {
    const token = await newGuest();
    // Deterministic race: the account's player is inserted just before the claim's update.
    const racing = (inner: Db): Db => ({
      query: async (sql, params) => {
        if (/^\s*update players set supertokens_user_id/i.test(sql)) {
          await inner.query("insert into players (supertokens_user_id) values ('u9')");
        }
        return inner.query(sql, params);
      },
      transaction: (fn) => inner.transaction((tx) => fn(racing(tx))),
      close: () => inner.close(),
    });
    const result = await claimGuest(racing(db), token, "u9");
    expect(result).toEqual({ claimed: false, reason: "already-has-world" });
    expect(
      await db.query("select 1 from players where guest_token is not null and supertokens_user_id is null"),
    ).toHaveLength(1);
  });
});

describe("accounts disabled (R-16)", () => {
  // main.ts's wiring when SUPERTOKENS_CONNECTION_URI is unset: no verifier, no accounts.
  let guestOnly: FastifyInstance;
  beforeEach(() => {
    guestOnly = buildServer({
      db,
      content: store,
      clock: () => now,
      auth: identityAuth({ db, content: store, clock: () => now, verifySession: noSessions }),
    });
  });
  afterEach(() => guestOnly.close());

  it("claim answers 503 accounts-disabled, and guests still play", async () => {
    const created = await guestOnly.inject({ method: "POST", url: "/api/guests" });
    const token = (created.json() as { guestToken: string }).guestToken;
    const res = await guestOnly.inject({
      method: "POST",
      url: "/api/auth/claim",
      headers: { "x-test-user": "u10" },
      payload: { guestToken: token },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "accounts-disabled" });
    expect(
      (await guestOnly.inject({ method: "GET", url: "/api/world", headers: { "x-test-user": "u10" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await guestOnly.inject({ method: "POST", url: "/auth/signup", payload: {} })).statusCode,
    ).toBe(404);
    expect(
      (
        await guestOnly.inject({
          method: "GET",
          url: "/api/world",
          headers: { authorization: `Guest ${token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(await db.query("select 1 from players where supertokens_user_id is not null")).toHaveLength(0);
  });
});

describe("a failing session check", () => {
  it("does not fall back to the guest token", async () => {
    const throwing = buildServer({
      db,
      content: store,
      clock: () => now,
      auth: identityAuth({
        db,
        content: store,
        clock: () => now,
        verifySession: async () => {
          throw new Error("core unreachable");
        },
      }),
    });
    try {
      const created = await throwing.inject({ method: "POST", url: "/api/guests" });
      const token = (created.json() as { guestToken: string }).guestToken;
      const res = await throwing.inject({
        method: "GET",
        url: "/api/world",
        headers: { authorization: `Guest ${token}` },
      });
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal error" });
    } finally {
      await throwing.close();
    }
  });
});

describe("accounts wiring", () => {
  it("registers accounts before the routes and runs their error handler first", async () => {
    class AccountsError extends Error {}
    const seen: unknown[] = [];
    const wired = buildServer({
      db,
      content: store,
      clock: () => now,
      auth: identityAuth({ db, content: store, clock: () => now, verifySession }),
      verifySession,
      accounts: {
        register(instance) {
          instance.get("/auth/boom", async () => {
            throw new AccountsError("boom");
          });
        },
        async handleError(error, _request, reply) {
          seen.push(error);
          if (!(error instanceof AccountsError)) return false;
          await reply.code(401).send({ message: "try refresh token" });
          return true;
        },
      },
    });
    try {
      const boom = await wired.inject({ method: "GET", url: "/auth/boom" });
      expect(boom.statusCode).toBe(401);
      expect(boom.json()).toEqual({ message: "try refresh token" });
      // Errors that aren't the accounts' fall through to the API's handler.
      const malformed = await wired.inject({
        method: "POST",
        url: "/api/auth/claim",
        headers: { "x-test-user": "u11" },
        payload: { guestToken: "short" },
      });
      expect(malformed.statusCode).toBe(400);
      expect(seen).toHaveLength(2);
    } finally {
      await wired.close();
    }
  });
});
