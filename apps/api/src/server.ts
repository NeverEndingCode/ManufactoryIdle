// buildServer takes its dependencies (db, content, a clock, an auth resolver) so tests
// run it on PGlite with a fake clock through inject(), with no network (spec 3a layout).
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { schedule, serializeWorld, type Action, type IndexedContent } from "@manufactory/engine";
import type { Db } from "./db/db.js";
import type { ContentStore } from "./content.js";
import { actionsBodySchema } from "./http/actions-schema.js";
import { TokenBucket, type BucketConfig } from "./http/token-bucket.js";
import {
  WorldNotFoundError,
  applyActions,
  claimGuest,
  createGuest,
  hashGuestToken,
  viewWorld,
  type World,
} from "./worlds.js";

export type Auth = (request: FastifyRequest) => Promise<{ playerId: string } | null>;

/** The 3a resolver: `Authorization: Guest <token>` → that guest player's id, else null.
 * Tokens are 32 random bytes in base64url (43 chars); only their sha256 is stored. */
export function guestAuth(db: Db): Auth {
  return async (request) => {
    const match = /^guest\s+([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? "");
    if (!match) return null;
    const rows = await db.query<{ id: string }>("select id from players where guest_token = $1", [
      hashGuestToken(match[1]!),
    ]);
    return rows.length === 0 ? null : { playerId: rows[0]!.id };
  };
}

export interface ServerDeps {
  db: Db;
  content: ContentStore;
  clock: () => number;
  auth: Auth;
  /** The raw session check (no lazy creation) for /api/auth/claim. Omitted: claim answers 503. */
  verifySession?: (request: FastifyRequest) => Promise<string | null>;
  /** SuperTokens (src/auth/supertokens.ts): registered before the routes, and its error
   * handler runs ahead of the API's. Omitted: guest-only, no /auth/* routes (R-16). */
  accounts?: {
    register(app: FastifyInstance): void;
    handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  };
  /** Per-instance, in-memory rate limits (R-23). Omitted: the defaults. */
  limits?: {
    /** Per player id, shared by /api/world and /api/actions. Default 30 burst, 3 per second. */
    player?: BucketConfig;
    /** Per client IP (`request.ip`) on POST /api/guests. Default 5 per hour. */
    guestsPerIp?: BucketConfig;
  };
  /** Fastify `logger` options, or a pino-compatible instance. Omitted: no logging. */
  logger?: FastifyServerOptions["logger"] | FastifyBaseLogger;
}

function isLoggerInstance(logger: ServerDeps["logger"]): logger is FastifyBaseLogger {
  return typeof logger === "object" && typeof (logger as { child?: unknown }).child === "function";
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
  const { db, content, clock, auth, verifySession, accounts, logger } = deps;
  const playerBucket = new TokenBucket(
    deps.limits?.player ?? { capacity: 30, refillPerSec: 3 },
    clock,
  );
  const guestBucket = new TokenBucket(
    deps.limits?.guestsPerIp ?? { capacity: 5, refillPerSec: 5 / 3600 },
    clock,
  );
  // Behind a reverse proxy, request.ip is the proxy's address unless Fastify's `trustProxy`
  // option is set; main.ts must set it for such a deployment, or every guest shares one bucket.
  async function limited(bucket: TokenBucket, key: string, reply: FastifyReply): Promise<boolean> {
    const taken = bucket.take(key);
    if (taken.ok) return false;
    await reply.code(429).header("retry-after", String(taken.retryAfterSec)).send({ error: "rate-limited" });
    return true;
  }
  const app = Fastify({
    // Fastify 5 takes a ready-made logger as `loggerInstance`; `logger` only takes options.
    ...(isLoggerInstance(logger) ? { loggerInstance: logger } : { logger: logger ?? false }),
    // Fastify's Ajv defaults would strip unknown properties (removeAdditional) and coerce
    // "1" to 1 (coerceTypes); both would turn a malformed action into an accepted one.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  async function requirePlayer(request: FastifyRequest, reply: FastifyReply) {
    const who = await auth(request);
    if (!who) {
      await reply.code(401).header("www-authenticate", "Guest").send({ error: "unauthorized" });
      return null;
    }
    // Rate limit after auth, so an unauthenticated call neither spends nor reveals a bucket.
    // A replayed idempotency key still spends a token: it costs a locked transaction.
    if (await limited(playerBucket, who.playerId, reply)) return null;
    return who.playerId;
  }

  accounts?.register(app);

  app.setErrorHandler(async (error, request, reply) => {
    if (accounts && (await accounts.handleError(error, request, reply))) return reply;
    if (error instanceof WorldNotFoundError) return reply.code(404).send({ error: "no world" });
    const {
      statusCode: status,
      validation,
      code,
      message,
    } = error as {
      statusCode?: number;
      validation?: unknown;
      code?: string;
      message?: string;
    };
    if (status !== undefined && status >= 400 && status < 500) {
      // Only Fastify's own errors (validation, FST_*) carry messages written for clients.
      const ours = validation !== undefined || code?.startsWith("FST_") === true;
      return reply.code(status).send({ error: ours ? message : "request failed" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/api/health", async () => ({ ok: true, contentVersion: content.current.version }));

  app.post("/api/guests", async (request, reply) => {
    if (await limited(guestBucket, request.ip, reply)) return reply;
    const { guestToken, world } = await createGuest(db, content, clock());
    return reply.code(201).send({ guestToken, world: worldView(world, content.current.content) });
  });

  app.get("/api/world", async (request, reply) => {
    const playerId = await requirePlayer(request, reply);
    if (playerId === null) return reply;
    const now = clock();
    const { world, content: pinned } = await viewWorld(db, content, playerId, now);
    // The only write a read makes (spec D.3): note that the player is here. It touches
    // neither player_worlds nor players.last_seen_at. 3c closes idle sessions. The
    // sessions_one_open partial unique index makes this race-safe.
    const agent = request.headers["user-agent"];
    await db.query(
      `insert into sessions (player_id, opened_at, client)
       values ($1, to_timestamp($2 / 1000.0), $3)
       on conflict (player_id) where closed_at is null do nothing`,
      [playerId, now, typeof agent === "string" ? agent.slice(0, 200) : null],
    );
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
    async (request, reply) => {
      const { actions, idempotencyKey } = request.body;
      const { status, body } = await applyActions(
        db,
        content,
        request.playerId!,
        actions,
        idempotencyKey,
        clock(),
        ({ world, content: pinned, summary }) => ({ ...worldView(world, pinned), summary }),
      );
      return reply.code(status).send(body);
    },
  );

  // Needs a session but not lazy creation: a never-seen account must be able to claim.
  // Auth runs in preValidation, so a missing session is a 401 even with a malformed body.
  app.post<{ Body: { guestToken: string } }>(
    "/api/auth/claim",
    {
      schema: {
        body: {
          type: "object",
          required: ["guestToken"],
          additionalProperties: false,
          properties: { guestToken: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
        },
      },
      preValidation: async (request, reply) => {
        if (!verifySession) {
          return reply.code(503).send({ error: "accounts-disabled" });
        }
        const userId = await verifySession(request);
        if (userId === null) {
          return reply.code(401).header("www-authenticate", "Guest").send({ error: "unauthorized" });
        }
        request.sessionUserId = userId;
      },
    },
    async (request, reply) => {
      const result = await claimGuest(db, request.body.guestToken, request.sessionUserId!);
      if (!result.claimed) {
        return reply
          .code(result.reason === "already-has-world" ? 409 : 404)
          .send({ error: result.reason });
      }
      const { world, content: pinned } = await viewWorld(db, content, result.playerId, clock());
      return worldView(world, pinned);
    },
  );

  return app;
}

declare module "fastify" {
  interface FastifyRequest {
    playerId?: string;
    sessionUserId?: string;
  }
}
