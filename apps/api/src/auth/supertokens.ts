// SuperTokens wiring (spec 3b). Accounts are optional (R-16): without
// SUPERTOKENS_CONNECTION_URI this returns null and the API stays guest-only.
// Discord and GitHub are configured only when their credentials are set (R-12).
//
// supertokens-node 24's Fastify adapter is structural (no fastify peer dependency): its
// `plugin` adds a root preHandler hook (skip-override) that serves /auth/* (Fastify's 404
// route runs root hooks too) and its `errorHandler()` renders SuperTokens errors.
import cors from "@fastify/cors";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as supertokens from "supertokens-node";
import { errorHandler, plugin } from "supertokens-node/framework/fastify";
import * as EmailPassword from "supertokens-node/recipe/emailpassword";
import * as Session from "supertokens-node/recipe/session";
import * as ThirdParty from "supertokens-node/recipe/thirdparty";
import type { ProviderInput } from "supertokens-node/recipe/thirdparty/types";
import type { SessionVerifier } from "../identity.js";

export type Env = Record<string, string | undefined>;

export interface SuperTokensAccounts {
  /** Registers CORS for WEBSITE_DOMAIN and SuperTokens' plugin (its /auth/* routes). */
  register(app: FastifyInstance): void;
  /** Renders a SuperTokens error and returns true; returns false for any other error.
   * The API's error handler calls this first, so SuperTokens' handler runs ahead of it. */
  handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  /** The session's SuperTokens user id, or null without a session (`sessionRequired: false`). */
  verifySession: SessionVerifier;
}

const set = (v: string | undefined): v is string => v !== undefined && v !== "";

/** The third-party providers whose client id and secret are both set (R-12). */
export function providersFromEnv(env: Env): ProviderInput[] {
  const providers: ProviderInput[] = [];
  for (const [thirdPartyId, prefix] of [
    ["discord", "DISCORD"],
    ["github", "GITHUB"],
  ] as const) {
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (set(clientId) && set(clientSecret)) {
      providers.push({ config: { thirdPartyId, clients: [{ clientId, clientSecret }] } });
    }
  }
  return providers;
}

/** Null when SUPERTOKENS_CONNECTION_URI is unset (R-16); otherwise initializes the SDK
 * (process-global, once) and returns the wiring. Contacts no core until a request needs it. */
export function superTokensFromEnv(env: Env): SuperTokensAccounts | null {
  const connectionURI = env.SUPERTOKENS_CONNECTION_URI;
  if (!set(connectionURI)) return null;
  const websiteDomain = env.WEBSITE_DOMAIN || "http://localhost:5173";

  supertokens.init({
    framework: "fastify",
    supertokens: {
      connectionURI,
      ...(set(env.SUPERTOKENS_API_KEY) ? { apiKey: env.SUPERTOKENS_API_KEY } : {}),
    },
    appInfo: {
      appName: "Manufactory Idle",
      apiDomain: env.API_DOMAIN || "http://localhost:8080",
      websiteDomain,
      apiBasePath: "/auth",
    },
    recipeList: [
      EmailPassword.init(),
      ThirdParty.init({ signInAndUpFeature: { providers: providersFromEnv(env) } }),
      Session.init(),
    ],
  });

  // getSession needs the reply (it may set or clear tokens); our verifier only gets the
  // request, so each request's reply is remembered for the life of the request.
  const replies = new WeakMap<FastifyRequest, FastifyReply>();
  const renderError = errorHandler();

  return {
    register(app) {
      app.register(cors, {
        origin: websiteDomain,
        // getAllCORSHeaders includes authorization (header-mode sessions and Guest tokens).
        allowedHeaders: ["content-type", ...supertokens.getAllCORSHeaders()],
        methods: ["GET", "PUT", "POST", "DELETE"],
        credentials: true,
      });
      app.register(plugin);
      app.addHook("onRequest", async (request, reply) => {
        replies.set(request, reply);
      });
    },
    async handleError(error, request, reply) {
      if (!supertokens.Error.isErrorFromSuperTokens(error)) return false;
      await renderError(error, request, reply);
      return true;
    },
    async verifySession(request) {
      const reply = replies.get(request);
      if (!reply) throw new Error("verifySession: request did not pass the onRequest hook");
      // An invalid or expired token throws (TRY_REFRESH_TOKEN); handleError renders the 401.
      const session = await Session.getSession(request, reply, { sessionRequired: false });
      return session === undefined ? null : session.getUserId();
    },
  };
}
