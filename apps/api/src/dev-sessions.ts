// A fake SuperTokens front-end driver interface (FDI) for the dev server and the web
// client's account e2e, so no real SuperTokens core is needed. It is reachable only from
// dev-server.ts with fakeSessions: true (dev.ts: DEV_FAKE_SESSIONS=1), never from main.ts.
// It speaks ThirdParty (O-14): /auth/authorisationurl, a fake provider at
// /auth/dev/oauth/authorize that signs in whoever the dev-oauth-user cookie names, and
// /auth/signinup. Like the real API it pins the redirect URI to /account/callback/<id>
// (O-4, on the path: the dev origin varies), and it only ever redirects to a path, never
// to another host. This is a test double, not authentication.
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDeps } from "./server.js";
import type { SessionVerifier } from "./identity.js";

/** supertokens-node 24.0.3's FDIs, from the repo's frontendDriverInterfaceSupported.json at tag
 *  v24.0.3 (the npm tarball ships none). Re-check it there when bumping. */
export const NODE_FDI: readonly string[] = [
  "1.17",
  "1.18",
  "1.19",
  "2.0",
  "3.0",
  "3.1",
  "4.0",
  "4.1",
  "4.2",
];

export interface FakeSessions {
  accounts: NonNullable<ServerDeps["accounts"]>;
  verifySession: SessionVerifier;
}

const COOKIE = "sAccessToken";
const PREFIX = "dev.";
const SESSION_MS = 3600_000;

/** The cookie naming the fake provider's user (O-14); `player` when absent or malformed.
 *  `deny`, `no-email` and `not-allowed` are the fake's failure cases. */
export const FAKE_USER_COOKIE = "dev-oauth-user";
const FAKE_USER = /^[a-z0-9-]{1,40}$/;
const DEFAULT_PROVIDERS = ["discord", "github"] as const;

/** O-4's answer, as guardThirdPartyApis gives it (not imported: that module loads the SDK). */
const NOT_HERE = {
  status: "GENERAL_ERROR",
  message: "Sign-in isn't available from this address.",
} as const;
const NOT_ALLOWED_REASON =
  "Cannot sign in / up due to security reasons. Please contact support. (ERR_CODE_DEV)";

const callbackPath = (thirdPartyId: string): string => `/account/callback/${thirdPartyId}`;

/** O-4 on the path: any origin, but exactly /account/callback/<id>, no query or fragment. */
function pinned(thirdPartyId: string, uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return url.pathname === callbackPath(thirdPartyId) && url.search === "" && url.hash === "";
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function fakeSessions(
  opts: { clock?: () => number; providers?: readonly string[] } = {},
): FakeSessions {
  const clock = opts.clock ?? Date.now;
  const providers: readonly string[] = [...(opts.providers ?? DEFAULT_PROVIDERS)];
  /** Keyed "<thirdPartyId>:<user>": the same user on two providers is two users (O-12). */
  const users = new Map<string, { userId: string; timeJoined: number }>();
  const sessions = new Map<string, string>();
  /** Single-use codes from the fake provider, deleted on first use. */
  const codes = new Map<string, { thirdPartyId: string; redirectPath: string; user: string }>();

  const sessionIdOf = (request: FastifyRequest): string | null => {
    const v = cookieValue(request, COOKIE);
    return v !== null && v.startsWith(PREFIX) && sessions.has(v.slice(PREFIX.length))
      ? v.slice(PREFIX.length)
      : null;
  };
  const verifySession: SessionVerifier = async (request) => {
    const id = sessionIdOf(request);
    return id === null ? null : sessions.get(id)!;
  };

  const frontToken = (uid: string): string =>
    Buffer.from(JSON.stringify({ uid, ate: clock() + SESSION_MS, up: {} })).toString("base64");

  const startSession = (reply: FastifyReply, userId: string): void => {
    const id = randomBytes(24).toString("base64url");
    sessions.set(id, userId);
    reply.header("set-cookie", `${COOKIE}=${PREFIX}${id}; Path=/; HttpOnly; SameSite=Lax`);
    reply.header("front-token", frontToken(userId));
  };

  /** supertokens-node's User.toJson() for a ThirdParty user. */
  const userBody = (
    thirdPartyId: string,
    user: string,
    u: { userId: string; timeJoined: number },
  ) => {
    const email = `${user}@${thirdPartyId}.example`;
    const thirdParty = { id: thirdPartyId, userId: user };
    return {
      id: u.userId,
      emails: [email],
      timeJoined: u.timeJoined,
      tenantIds: ["public"],
      isPrimaryUser: false,
      phoneNumbers: [],
      thirdParty: [thirdParty],
      webauthn: { credentialIds: [] },
      loginMethods: [
        {
          recipeId: "thirdparty",
          recipeUserId: u.userId,
          tenantIds: ["public"],
          email,
          thirdParty,
          verified: true,
          timeJoined: u.timeJoined,
        },
      ],
    };
  };

  const unlisted = (reply: FastifyReply, thirdPartyId: unknown) =>
    reply.code(400).send({
      message: `the provider ${String(thirdPartyId)} could not be found in the configuration`,
    });
  const listed = (thirdPartyId: unknown): thirdPartyId is string =>
    typeof thirdPartyId === "string" && providers.includes(thirdPartyId);

  const accounts: FakeSessions["accounts"] = {
    register(app: FastifyInstance) {
      void app.register(async (scope) => {
        scope.addHook("preHandler", async (request, reply) => {
          const header = request.headers["fdi-version"];
          if (header === undefined) return;
          const offered = String(header)
            .split(",")
            .map((v) => v.trim());
          if (!offered.some((v) => NODE_FDI.includes(v))) {
            return reply.code(400).send({
              message: `fdi-version mismatch: the client sent ${String(header)}, this fake speaks ${NODE_FDI.join(", ")}`,
            });
          }
        });

        scope.get<{
          Querystring: { thirdPartyId?: string; redirectURIOnProviderDashboard?: string };
        }>("/auth/authorisationurl", async (request, reply) => {
          const { thirdPartyId, redirectURIOnProviderDashboard: uri } = request.query;
          if (!listed(thirdPartyId)) return unlisted(reply, thirdPartyId);
          if (!pinned(thirdPartyId, uri)) return reply.send(NOT_HERE);
          const q = new URLSearchParams({ thirdPartyId, redirect_uri: uri as string });
          // Path-only: the SDK appends &state= and the page stays on its own origin.
          return reply.send({ status: "OK", urlWithQueryParams: `/auth/dev/oauth/authorize?${q}` });
        });

        // The fake provider. Its Location is always a path built from a listed id: the host
        // (and path) of redirect_uri are never used, so this is no open redirect even in dev.
        scope.get<{ Querystring: { thirdPartyId?: string; state?: string } }>(
          "/auth/dev/oauth/authorize",
          async (request, reply) => {
            const { thirdPartyId, state } = request.query;
            if (!listed(thirdPartyId)) return unlisted(reply, thirdPartyId);
            const raw = cookieValue(request, FAKE_USER_COOKIE);
            const user = raw !== null && FAKE_USER.test(raw) ? raw : "player";
            const redirectPath = callbackPath(thirdPartyId);
            const q = new URLSearchParams();
            if (user === "deny") {
              q.set("error", "access_denied");
            } else {
              const code = randomBytes(16).toString("hex");
              codes.set(code, { thirdPartyId, redirectPath, user });
              q.set("code", code);
            }
            if (typeof state === "string") q.set("state", state);
            return reply.redirect(`${redirectPath}?${q}`, 302);
          },
        );

        scope.post("/auth/signinup", async (request, reply) => {
          const body = (request.body ?? {}) as {
            thirdPartyId?: unknown;
            redirectURIInfo?: {
              redirectURIOnProviderDashboard?: unknown;
              redirectURIQueryParams?: Record<string, unknown>;
            };
          };
          const { thirdPartyId, redirectURIInfo: info } = body;
          if (!listed(thirdPartyId)) return unlisted(reply, thirdPartyId);
          // O-4: no redirectURIInfo (the oAuthTokens variant) or a foreign URI.
          if (typeof info !== "object" || info === null) return reply.send(NOT_HERE);
          if (!pinned(thirdPartyId, info.redirectURIOnProviderDashboard))
            return reply.send(NOT_HERE);
          const code = info.redirectURIQueryParams?.code;
          const grant = typeof code === "string" ? codes.get(code) : undefined;
          if (grant !== undefined) codes.delete(code as string);
          const path = new URL(info.redirectURIOnProviderDashboard as string).pathname;
          if (
            grant === undefined ||
            grant.thirdPartyId !== thirdPartyId ||
            grant.redirectPath !== path
          ) {
            // What the real API answers when the provider's token exchange throws.
            return reply.code(500).send({ error: "internal error" });
          }
          if (grant.user === "no-email")
            return reply.send({ status: "NO_EMAIL_GIVEN_BY_PROVIDER" });
          if (grant.user === "not-allowed") {
            return reply.send({ status: "SIGN_IN_UP_NOT_ALLOWED", reason: NOT_ALLOWED_REASON });
          }
          const key = `${thirdPartyId}:${grant.user}`;
          let u = users.get(key);
          const createdNewRecipeUser = u === undefined;
          if (u === undefined) {
            u = { userId: randomUUID(), timeJoined: clock() };
            users.set(key, u);
          }
          startSession(reply, u.userId);
          return reply.send({
            status: "OK",
            createdNewRecipeUser,
            user: userBody(thirdPartyId, grant.user, u),
          });
        });

        scope.post("/auth/signout", async (request, reply) => {
          const id = sessionIdOf(request);
          if (id !== null) sessions.delete(id);
          reply.header(
            "set-cookie",
            `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
          );
          reply.header("front-token", "remove");
          return reply.send({ status: "OK" });
        });

        scope.post("/auth/session/refresh", async (request, reply) => {
          const userId = await verifySession(request);
          if (userId === null) {
            reply.header("front-token", "remove");
            return reply.code(401).send({ message: "unauthorised" });
          }
          reply.header("front-token", frontToken(userId));
          return reply.send({});
        });
      });
    },
    async handleError() {
      return false;
    },
    providers,
  };

  return { accounts, verifySession };
}
