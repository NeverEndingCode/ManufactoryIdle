// buildServer takes its dependencies (db, content, a clock, an auth resolver) so tests
// run it on PGlite with a fake clock through inject(), with no network (spec 3a layout).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { schedule, serializeWorld, type Action, type IndexedContent } from "@manufactory/engine";
import type { Db } from "./db/db.js";
import type { ContentStore } from "./content.js";
import { actionsBodySchema } from "./http/actions-schema.js";
import {
  ActionRejectedError,
  WorldNotFoundError,
  applyActions,
  createGuest,
  viewWorld,
  type World,
} from "./worlds.js";

export type Auth = (request: FastifyRequest) => Promise<{ playerId: string } | null>;

/** The 3a resolver: `Authorization: Guest <token>` → that guest player's id, else null. */
export function guestAuth(db: Db): Auth {
  return async (request) => {
    const match = /^Guest ([A-Za-z0-9_-]{1,128})$/.exec(request.headers.authorization ?? "");
    if (!match) return null;
    const rows = await db.query<{ id: string }>("select id from players where guest_token = $1", [
      match[1],
    ]);
    return rows.length === 0 ? null : { playerId: rows[0]!.id };
  };
}

export interface ServerDeps {
  db: Db;
  content: ContentStore;
  clock: () => number;
  auth: Auth;
}

interface ActionsBody {
  idempotencyKey: string;
  baseVersion: number;
  actions: Action[];
}

function worldView(world: World, content: IndexedContent) {
  return {
    state: JSON.parse(serializeWorld(world.state)) as unknown,
    schedule: schedule(world.state, content),
    stateVersion: world.stateVersion,
    contentVersion: world.contentVersion,
  };
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { db, content, clock, auth } = deps;
  const app = Fastify({
    // Fastify's Ajv defaults would strip unknown properties (removeAdditional) and coerce
    // "1" to 1 (coerceTypes); both would turn a malformed action into an accepted one.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  async function requirePlayer(request: FastifyRequest, reply: FastifyReply) {
    const who = await auth(request);
    if (!who) {
      await reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return who.playerId;
  }

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof WorldNotFoundError) return reply.code(404).send({ error: "no world" });
    if (error instanceof ActionRejectedError) {
      return reply
        .code(409)
        .send({ failedAction: error.action, index: error.index, reason: error.reason });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (error as Error).message });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/api/health", async () => ({ ok: true, contentVersion: content.current.version }));

  app.post("/api/guests", async (_request, reply) => {
    const { guestToken, world } = await createGuest(db, content, clock());
    return reply.code(201).send({ guestToken, world: worldView(world, content.current.content) });
  });

  app.get("/api/world", async (request, reply) => {
    const playerId = await requirePlayer(request, reply);
    if (playerId === null) return reply;
    const { world, content: pinned } = await viewWorld(db, content, playerId, clock());
    return worldView(world, pinned);
  });

  // Auth runs in preValidation, so a missing token is a 401 even with a malformed body.
  app.post<{ Body: ActionsBody }>(
    "/api/actions",
    {
      schema: { body: actionsBodySchema },
      preValidation: async (request, reply) => {
        const playerId = await requirePlayer(request, reply);
        if (playerId !== null) request.playerId = playerId;
      },
    },
    async (request) => {
      const { actions, idempotencyKey } = request.body;
      const {
        world,
        content: pinned,
        summary,
      } = await applyActions(db, content, request.playerId!, actions, idempotencyKey, clock());
      return { ...worldView(world, pinned), summary };
    },
  );

  return app;
}

declare module "fastify" {
  interface FastifyRequest {
    playerId?: string;
  }
}
