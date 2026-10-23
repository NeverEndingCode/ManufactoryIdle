// A fake SuperTokens front-end driver interface (FDI) for the dev server and the web
// client's account e2e, so no real SuperTokens core is needed. It is reachable only from
// dev-server.ts with fakeSessions: true (dev.ts: DEV_FAKE_SESSIONS=1), never from main.ts.
// Passwords are kept in plain memory: this is a test double, not authentication.
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDeps } from "./server.js";
import type { SessionVerifier } from "./identity.js";

/** supertokens-node 24.0.3's FDIs, from its CHANGELOG (21.0.0: 3.1, 4.0; 4.1; 23.0.1: 4.2). Re-check
 *  against the repo's frontendDriverInterfaceSupported.json at tag v24.0.3 when bumping. */
export const NODE_FDI: readonly string[] = ["3.1", "4.0", "4.1", "4.2"];

export interface FakeSessions {
  accounts: NonNullable<ServerDeps["accounts"]>;
  verifySession: SessionVerifier;
}

const COOKIE = "sAccessToken";
const PREFIX = "dev.";
const SESSION_MS = 3600_000;

function cookieValue(request: FastifyRequest, name: string): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function fakeSessions(opts: { clock?: () => number } = {}): FakeSessions {
  const clock = opts.clock ?? Date.now;
  const users = new Map<string, { userId: string; password: string; timeJoined: number }>();
  const sessions = new Map<string, string>();
  const resetTokens = new Map<string, string>(); // token -> email
  const latestToken = new Map<string, string>(); // email -> token

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

  const userBody = (email: string, u: { userId: string; timeJoined: number }) => ({
    id: u.userId,
    emails: [email],
    timeJoined: u.timeJoined,
    tenantIds: ["public"],
    isPrimaryUser: false,
    phoneNumbers: [],
    thirdParty: [],
    loginMethods: [
      {
        recipeId: "emailpassword",
        recipeUserId: u.userId,
        tenantIds: ["public"],
        email,
        verified: true,
        timeJoined: u.timeJoined,
      },
    ],
  });

  const field = (request: FastifyRequest, id: string): string => {
    const fields = (request.body as { formFields?: Array<{ id: string; value: unknown }> } | null)
      ?.formFields;
    const v = fields?.find((f) => f.id === id)?.value;
    return typeof v === "string" ? v : "";
  };
  // Mirrors supertokens-node's defaultPasswordValidator (emailpassword/utils.js); first failure wins.
  const passwordError = (p: string): string | null => {
    if (p.length < 8) return "Password must contain at least 8 characters, including a number";
    if (p.length >= 100) return "Password's length must be lesser than 100 characters";
    if (!/[A-Za-z]/.test(p)) return "Password must contain at least one alphabet";
    if (!/[0-9]/.test(p)) return "Password must contain at least one number";
    return null;
  };

  const accounts: FakeSessions["accounts"] = {
    register(app: FastifyInstance) {
      void app.register(async (scope) => {
        scope.addHook("preHandler", async (request, reply) => {
          const header = request.headers["fdi-version"];
          if (header === undefined) return;
          const offered = String(header).split(",").map((v) => v.trim());
          if (!offered.some((v) => NODE_FDI.includes(v))) {
            return reply.code(400).send({
              message: `fdi-version mismatch: the client sent ${String(header)}, this fake speaks ${NODE_FDI.join(", ")}`,
            });
          }
        });

        scope.post("/auth/signup", async (request, reply) => {
          const email = field(request, "email").trim().toLowerCase();
          const password = field(request, "password");
          const errors: Array<{ id: string; error: string }> = [];
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errors.push({ id: "email", error: "Email is invalid" });
          } else if (users.has(email)) {
            errors.push({ id: "email", error: "This email already exists. Please sign in instead." });
          }
          const pe = passwordError(password);
          if (pe) errors.push({ id: "password", error: pe });
          if (errors.length > 0) return reply.send({ status: "FIELD_ERROR", formFields: errors });
          const u = { userId: randomUUID(), password, timeJoined: clock() };
          users.set(email, u);
          startSession(reply, u.userId);
          return reply.send({ status: "OK", user: userBody(email, u) });
        });

        scope.post("/auth/signin", async (request, reply) => {
          const email = field(request, "email").trim().toLowerCase();
          const u = users.get(email);
          if (!u || u.password !== field(request, "password")) {
            return reply.send({ status: "WRONG_CREDENTIALS_ERROR" });
          }
          startSession(reply, u.userId);
          return reply.send({ status: "OK", user: userBody(email, u) });
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

        scope.post("/auth/user/password/reset/token", async (request, reply) => {
          const email = field(request, "email").trim().toLowerCase();
          if (users.has(email)) {
            const token = randomBytes(16).toString("hex");
            resetTokens.set(token, email);
            latestToken.set(email, token);
          }
          return reply.send({ status: "OK" });
        });

        scope.post("/auth/user/password/reset", async (request, reply) => {
          const token = (request.body as { token?: unknown } | null)?.token;
          const email = typeof token === "string" ? resetTokens.get(token) : undefined;
          if (email === undefined) {
            return reply.send({ status: "RESET_PASSWORD_INVALID_TOKEN_ERROR" });
          }
          const password = field(request, "password");
          const pe = passwordError(password);
          if (pe) {
            return reply.send({ status: "FIELD_ERROR", formFields: [{ id: "password", error: pe }] });
          }
          users.get(email)!.password = password;
          resetTokens.delete(token as string);
          return reply.send({ status: "OK" });
        });

        scope.get<{ Querystring: { email?: string } }>("/auth/dev/reset-link", async (request, reply) => {
          const token = latestToken.get((request.query.email ?? "").trim().toLowerCase());
          if (token === undefined || !resetTokens.has(token)) {
            return reply.code(404).send({ error: "no-reset-token" });
          }
          return reply.send({ link: `/account/reset-password?token=${token}&tenantId=public` });
        });
      });
    },
    async handleError() {
      return false;
    },
  };

  return { accounts, verifySession };
}
