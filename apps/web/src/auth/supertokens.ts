// The AccountClient over supertokens-web-js (W-15, S-1): cookie mode, same origin, imported
// statically (Q-17) and initialised only when GET /api/health says accounts: true. Two recipes,
// Session and ThirdParty (O-1: accounts are OAuth only, so no EmailPassword). The SDK's
// statuses are mapped here, so nothing else knows them; a network throw is "unavailable".
import SuperTokens from "supertokens-web-js";
import Session from "supertokens-web-js/recipe/session";
import ThirdParty from "supertokens-web-js/recipe/thirdparty";
import STGeneralError from "supertokens-web-js/utils/error";
import { OAUTH_CONSUMED_KEY } from "../sync/constants.js";
import type { AccountClient, SignInResult, StartResult } from "./accounts.js";

/** O-7: a provider's `error` code is shown only when it looks like one. */
const ERROR_CODE = /^[a-z0-9_.-]{1,40}$/i;
const STALE = { ok: false, kind: "stale" } as const;

/** sessionStorage can throw on any access (blocked site data); the marker is best-effort. */
function consumedState(): string | null {
  try {
    return globalThis.sessionStorage.getItem(OAUTH_CONSUMED_KEY);
  } catch {
    return null;
  }
}

function markConsumed(state: string): void {
  try {
    globalThis.sessionStorage.setItem(OAUTH_CONSUMED_KEY, state);
  } catch {
    // Without the marker a reload can re-POST a spent code; the server refuses it (O-8's
    // other guards still hold: done() replaces the URL, hasSession() runs first).
  }
}

export function superTokensClient(origin: string): AccountClient {
  let initialised = false;

  return {
    init() {
      if (initialised) return;
      initialised = true;
      SuperTokens.init({
        appInfo: { appName: "Manufactory Idle", apiDomain: origin, apiBasePath: "/auth" },
        recipeList: [Session.init({ tokenTransferMethod: "cookie" }), ThirdParty.init()],
      });
    },
    async authorisationURL(provider): Promise<StartResult> {
      try {
        const url = await ThirdParty.getAuthorisationURLWithQueryParamsAndSetState({
          thirdPartyId: provider,
          frontendRedirectURI: `${origin}/account/callback/${provider}`,
        });
        return { ok: true, url };
      } catch (err) {
        if (STGeneralError.isThisError(err))
          return { ok: false, kind: "not-allowed", reason: err.message };
        return { ok: false, kind: "unavailable" };
      }
    },
    async finishSignIn(provider, search): Promise<SignInResult> {
      // O-7, in order. The SDK checks the state too, but throws a plain Error for every case.
      const query = new URLSearchParams(search);
      const error = query.get("error");
      if (error !== null) {
        // error_description is the provider's (or a crafted link's) text: never read.
        if (error === "access_denied") return { ok: false, kind: "denied" };
        return { ok: false, kind: "provider-error", code: ERROR_CODE.test(error) ? error : null };
      }
      let stored: ReturnType<typeof ThirdParty.getStateAndOtherInfoFromStorage>;
      try {
        stored = ThirdParty.getStateAndOtherInfoFromStorage();
      } catch {
        stored = undefined;
      }
      if (stored === undefined || stored === null) return STALE;
      // The SDK posts the stored thirdPartyId, not the one in our path: they must agree.
      if (stored.thirdPartyId !== provider) return STALE;
      const state = query.get("state");
      if (state === null || state !== stored.stateForAuthProvider) return STALE;
      if (stored.expiresAt < Date.now()) return STALE;
      if (!query.get("code")) return STALE;
      if (consumedState() === state) return STALE;
      // Before the call: a reload mid-request must never spend the code again.
      markConsumed(state);
      try {
        const res = await ThirdParty.signInAndUp();
        switch (res.status) {
          case "OK":
            return { ok: true, account: { provider, email: res.user.emails[0] ?? null } };
          case "NO_EMAIL_GIVEN_BY_PROVIDER":
            return { ok: false, kind: "no-email" };
          case "SIGN_IN_UP_NOT_ALLOWED":
            return { ok: false, kind: "not-allowed", reason: res.reason };
          default:
            // A status this build doesn't know (a newer SDK or server).
            return { ok: false, kind: "unavailable" };
        }
      } catch (err) {
        if (STGeneralError.isThisError(err))
          return { ok: false, kind: "not-allowed", reason: err.message };
        return { ok: false, kind: "unavailable" };
      }
    },
    async hasSession() {
      try {
        return await Session.doesSessionExist();
      } catch {
        return false;
      }
    },
    async signOut() {
      try {
        await Session.signOut();
        return true;
      } catch {
        return false;
      }
    },
  };
}
