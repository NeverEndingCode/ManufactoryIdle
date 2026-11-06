// SuperTokens wiring (spec 3b). Accounts are optional (R-16): without
// SUPERTOKENS_CONNECTION_URI this returns null and the API stays guest-only.
// Accounts are OAuth only (O-1): ThirdParty and Session, no email/password and no mail.
// Each provider in PROVIDER_TABLE is configured only when its credentials are set (R-12, O-2),
// and the redirect URI is pinned to the website's /account/callback/<id> (O-4).
//
// supertokens-node 24's Fastify adapter is structural (no fastify peer dependency): its
// `plugin` adds a root preHandler hook (skip-override) that serves /auth/* (Fastify's 404
// route runs root hooks too) and its `errorHandler()` renders SuperTokens errors.
import cors from "@fastify/cors";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as supertokens from "supertokens-node";
import { errorHandler, plugin } from "supertokens-node/framework/fastify";
import * as Session from "supertokens-node/recipe/session";
import * as ThirdParty from "supertokens-node/recipe/thirdparty";
import type { APIInterface } from "supertokens-node/recipe/thirdparty";
import type { ProviderInput } from "supertokens-node/recipe/thirdparty/types";
import { AccountsUnavailableError, type SessionVerifier } from "../identity.js";

export type Env = Record<string, string | undefined>;
export type Log = (message: string) => void;

export interface SuperTokensAccounts {
  /** Registers CORS for WEBSITE_DOMAIN and SuperTokens' plugin (its /auth/* routes). */
  register(app: FastifyInstance): void;
  /** Renders a SuperTokens error and returns true; returns false for any other error.
   * The API's error handler calls this first, so SuperTokens' handler runs ahead of it. */
  handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  /** The session's SuperTokens user id, or null without a session (`sessionRequired: false`). */
  verifySession: SessionVerifier;
  /** O-3: the configured thirdPartyIds, in PROVIDER_TABLE order. */
  providers: readonly string[];
}

const set = (v: string | undefined): v is string => v !== undefined && v !== "";

/** O-2: one line per provider: [thirdPartyId, env prefix]. Google later: ["google", "GOOGLE"]. */
export const PROVIDER_TABLE = [
  ["discord", "DISCORD"],
  ["github", "GITHUB"],
] as const satisfies readonly (readonly [thirdPartyId: string, envPrefix: string])[];

/** The providers whose <PREFIX>_CLIENT_ID and _SECRET are both set, in table order (R-12).
 * No scope: the SDK's defaults (Discord identify+email, GitHub read:user+user:email) apply. */
export function providersFromEnv(env: Env): ProviderInput[] {
  const providers: ProviderInput[] = [];
  for (const [thirdPartyId, prefix] of PROVIDER_TABLE) {
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (set(clientId) && set(clientSecret)) {
      providers.push({ config: { thirdPartyId, clients: [{ clientId, clientSecret }] } });
    }
  }
  return providers;
}

/** O-4: the exact URL each provider must redirect to. The origin drops any trailing slash. */
export function callbackURL(websiteDomain: string, thirdPartyId: string): string {
  return `${new URL(websiteDomain).origin}/account/callback/${thirdPartyId}`;
}

const NOT_HERE = {
  status: "GENERAL_ERROR",
  message: "Sign-in isn't available from this address.",
} as const;

/** O-4: ThirdParty's `override.apis`. Both APIs answer GENERAL_ERROR unless the redirect URI
 * is exactly callbackURL(websiteDomain, provider.id) (no prefix match: GitHub accepts
 * sub-paths of a registered URI), and signInUpPOST refuses `oAuthTokens` outright, since a
 * token minted for some other app would sign in as its owner. A disabled API stays disabled. */
export function guardThirdPartyApis(
  websiteDomain: string,
): (original: APIInterface) => APIInterface {
  const pinned = (thirdPartyId: string, uri: string) =>
    uri === callbackURL(websiteDomain, thirdPartyId);
  return (original) => {
    const { authorisationUrlGET, signInUpPOST } = original;
    return {
      ...original,
      authorisationUrlGET:
        authorisationUrlGET &&
        (async (input) =>
          pinned(input.provider.id, input.redirectURIOnProviderDashboard)
            ? authorisationUrlGET(input)
            : NOT_HERE),
      signInUpPOST:
        signInUpPOST &&
        (async (input) =>
          "redirectURIInfo" in input &&
          input.redirectURIInfo !== undefined &&
          pinned(input.provider.id, input.redirectURIInfo.redirectURIOnProviderDashboard)
            ? signInUpPOST(input)
            : NOT_HERE),
    };
  };
}

/** O-3: logged when accounts are on but no provider is: sign-in is then unavailable. */
const NO_PROVIDER = `accounts are on but no sign-in provider is configured (set ${PROVIDER_TABLE.map(
  ([, prefix]) => `${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET`,
).join(", or ")})`;

/** The SuperTokens appInfo for one deployment (S-9, W-26). */
export function appInfoFor(apiDomain: string, websiteDomain: string) {
  return {
    appName: "Manufactory Idle" as const,
    apiDomain,
    websiteDomain,
    apiBasePath: "/auth" as const,
    // Where the web client mounts its account routes (O-17). No recipe sends links any more;
    // the OAuth callbacks live under it, at /account/callback/<id>, by our choice (O-4).
    websiteBasePath: "/account" as const,
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

  const providers = providersFromEnv(env);
  if (providers.length === 0) log.warn(NO_PROVIDER);

  supertokens.init({
    framework: "fastify",
    supertokens: {
      connectionURI,
      ...(set(env.SUPERTOKENS_API_KEY) ? { apiKey: env.SUPERTOKENS_API_KEY } : {}),
    },
    appInfo: appInfoFor(apiDomain, websiteDomain),
    recipeList: [
      ThirdParty.init({
        signInAndUpFeature: { providers },
        override: { apis: guardThirdPartyApis(websiteDomain) },
      }),
      Session.init(),
    ],
  });

  // getSession needs the reply (it may set or clear tokens); our verifier only gets the
  // request, so each request's reply is remembered for the life of the request.
  const replies = new WeakMap<FastifyRequest, FastifyReply>();
  const renderError = errorHandler();

  return {
    providers: providers.map((p) => p.config.thirdPartyId),
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
      // This includes an SDK bug: any non-SuperTokens error is treated as an outage and answered
      // 503, which fails closed (the caller is never authenticated by guessing).
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
