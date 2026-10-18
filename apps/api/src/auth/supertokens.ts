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
import { SMTPService } from "supertokens-node/recipe/emailpassword/emaildelivery";
import * as Session from "supertokens-node/recipe/session";
import * as ThirdParty from "supertokens-node/recipe/thirdparty";
import type { ProviderInput } from "supertokens-node/recipe/thirdparty/types";
import { AccountsUnavailableError, type SessionVerifier } from "../identity.js";

export type Env = Record<string, string | undefined>;
export type Log = (message: string) => void;
/** EmailPassword's email delivery service (the SDK doesn't export the interface here). */
export type ResetMailService = NonNullable<
  NonNullable<NonNullable<Parameters<typeof EmailPassword.init>[0]>["emailDelivery"]>["service"]
>;

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

/** How password-reset mail is delivered (R-24). Never SuperTokens' default, which POSTs
 * the email and the live reset link to api.supertokens.io: SMTP when all five SMTP_*
 * vars are set, otherwise a service that sends nothing and logs no address or token. */
export function passwordResetDelivery(
  env: Env,
  log: Log,
): { kind: "smtp" | "none"; service: ResetMailService } {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM } = env;
  if (set(SMTP_HOST) && set(SMTP_PORT) && set(SMTP_USER) && set(SMTP_PASSWORD) && set(SMTP_FROM)) {
    const port = Number(SMTP_PORT);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      throw new Error(
        `SMTP_PORT must be an integer from 1 to 65535, got ${JSON.stringify(SMTP_PORT)}`,
      );
    }
    return {
      kind: "smtp",
      service: new SMTPService({
        smtpSettings: {
          host: SMTP_HOST,
          port,
          secure: port === 465,
          authUsername: SMTP_USER,
          password: SMTP_PASSWORD,
          from: { name: "Manufactory Idle", email: SMTP_FROM },
        },
      }),
    };
  }
  return {
    kind: "none",
    service: {
      async sendEmail() {
        log("password reset email not sent: SMTP not configured");
      },
    },
  };
}

/** Null when SUPERTOKENS_CONNECTION_URI is unset (R-16). Otherwise API_DOMAIN and
 * WEBSITE_DOMAIN are required (cookieSecure follows apiDomain's scheme, so a missing
 * https API_DOMAIN would drop the cookies' Secure flag), and the SDK is initialized.
 *
 * `supertokens.init` is once per process: a second call is a silent no-op that keeps the
 * first config, so call this once (main.ts). It contacts no core until a request needs it. */
export function superTokensFromEnv(
  env: Env,
  log: { info: Log; warn: Log } = { info: console.log, warn: console.warn },
): SuperTokensAccounts | null {
  const connectionURI = env.SUPERTOKENS_CONNECTION_URI;
  if (!set(connectionURI)) return null;
  const missing = (["API_DOMAIN", "WEBSITE_DOMAIN"] as const).filter((k) => !set(env[k]));
  if (missing.length > 0) {
    throw new Error(
      `SUPERTOKENS_CONNECTION_URI is set, so ${missing.join(" and ")} must be set too`,
    );
  }
  const apiDomain = env.API_DOMAIN!;
  const websiteDomain = env.WEBSITE_DOMAIN!;
  if (!apiDomain.startsWith("https://")) {
    log.warn(
      `API_DOMAIN ${apiDomain} is not https: session cookies will not be Secure (fine for local dev only)`,
    );
  }

  supertokens.init({
    framework: "fastify",
    supertokens: {
      connectionURI,
      ...(set(env.SUPERTOKENS_API_KEY) ? { apiKey: env.SUPERTOKENS_API_KEY } : {}),
    },
    appInfo: {
      appName: "Manufactory Idle",
      apiDomain,
      websiteDomain,
      apiBasePath: "/auth",
    },
    recipeList: [
      EmailPassword.init({
        emailDelivery: { service: passwordResetDelivery(env, log.info).service },
      }),
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
      // SuperTokens' preHandler sends /auth/* replies without `return reply`, so Fastify
      // stops only because reply.sent (raw.writableEnded) is already true. An async onSend
      // hook would delay that and let the request run on; re-check /auth/* before adding one.
      app.register(plugin);
      app.addHook("onRequest", async (request, reply) => {
        replies.set(request, reply);
      });
    },
    async handleError(error, request, reply) {
      if (!supertokens.Error.isErrorFromSuperTokens(error)) return false;
      // UNKNOWN_ERROR would be sent as a 500 with its message: let the API's generic 500
      // (which logs it) answer instead.
      if (error.type === supertokens.Error.UNKNOWN_ERROR) return false;
      try {
        await renderError(error, request, reply);
      } catch {
        return false; // no recipe claimed it (the SDK rethrows): the API's handler answers
      }
      return reply.sent;
    },
    async verifySession(request) {
      const reply = replies.get(request);
      if (!reply) throw new Error("verifySession: request did not pass the onRequest hook");
      // An invalid or expired token throws (TRY_REFRESH_TOKEN); handleError renders the 401.
      // Anything else getSession throws is not a SuperTokens error but a failure to talk to
      // the core: the SDK's querier throws plain Errors when no core answers ("No SuperTokens
      // core available to query", after retrying refused connections), a core non-200, or
      // the fetch error itself. The SDK has no typed error for these, so rather than match
      // its message strings, every non-SuperTokens error is tagged as an outage here: the
      // API answers 503 and never falls back to the guest token. Our own invariant error
      // above is thrown outside this try, so it stays a 500. (A failed JWKS fetch is not one
      // of these: the SDK reports it as TRY_REFRESH_TOKEN, a 401, before this sees it.)
      let session: Awaited<ReturnType<typeof Session.getSession>>;
      try {
        session = await Session.getSession(request, reply, { sessionRequired: false });
      } catch (err) {
        if (supertokens.Error.isErrorFromSuperTokens(err)) throw err;
        throw new AccountsUnavailableError(err);
      }
      return session === undefined ? null : session.getUserId();
    },
  };
}
