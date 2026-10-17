import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { initialWorld, serializeWorld } from "@manufactory/engine";
import { pgliteDb } from "./db/pglite.js";
import { migrate } from "./db/migrate.js";
import type { Db } from "./db/db.js";
import { openContentStore, type ContentStore } from "./content.js";
import { buildServer } from "./server.js";
import { identityAuth, type SessionVerifier } from "./identity.js";
import { createPlayerWithWorld } from "./worlds.js";

const SLICE = fileURLToPath(
  new URL("../../../packages/content/bundles/vertical-slice", import.meta.url),
);
const T0 = 1_760_000_000_000;

// Test-only fake: the "session" is whatever the x-test-user header says.
const verifySession: SessionVerifier = async (request) => {
  const h = request.headers["x-test-user"];
  return typeof h === "string" ? h : null;
};

let db: Db;
let store: ContentStore;
let app: FastifyInstance;

beforeEach(async () => {
  db = await pgliteDb();
  await migrate(db);
  store = await openContentStore(db, SLICE);
  app = buildServer({
    db,
    content: store,
    clock: () => T0,
    auth: identityAuth({ db, content: store, clock: () => T0, verifySession }),
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
