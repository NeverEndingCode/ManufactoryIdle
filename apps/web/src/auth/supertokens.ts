// The AccountClient over supertokens-web-js (W-15, S-1): cookie mode, same origin, imported
// statically (Q-17) and initialised only when GET /api/health says accounts: true. The SDK's
// statuses are mapped here, so nothing else knows them; a network throw is "unavailable".
import SuperTokens from "supertokens-web-js";
import EmailPassword from "supertokens-web-js/recipe/emailpassword";
import Session from "supertokens-web-js/recipe/session";
import ThirdParty from "supertokens-web-js/recipe/thirdparty";
import STGeneralError from "supertokens-web-js/utils/error";
import { OAUTH_CONSUMED_KEY } from "../sync/constants.js";
import type {
  AccountClient,
  AuthField,
  AuthResult,
  ResetResult,
  SignInResult,
  StartResult,
} from "./accounts.js";

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

type FieldErrors = { id: string; error: string }[];

const fields = (formFields: FieldErrors) =>
  formFields.map((f) => ({
    id: (f.id === "password" ? "password" : "email") as AuthField,
    error: f.error,
  }));

const form = (values: Partial<Record<AuthField, string>>) =>
  Object.entries(values).map(([id, value]) => ({ id, value: value ?? "" }));

export function superTokensClient(origin: string): AccountClient {
  let initialised = false;

  async function sign(
    call: typeof EmailPassword.signIn | typeof EmailPassword.signUp,
    email: string,
    password: string,
  ): Promise<AuthResult> {
    try {
      const res = await call({ formFields: form({ email, password }) });
      switch (res.status) {
        case "OK":
          return { ok: true, email };
        case "FIELD_ERROR":
          return { ok: false, kind: "field", fields: fields(res.formFields) };
        case "WRONG_CREDENTIALS_ERROR":
          return { ok: false, kind: "wrong-credentials" };
        case "SIGN_IN_NOT_ALLOWED":
        case "SIGN_UP_NOT_ALLOWED":
          return { ok: false, kind: "not-allowed", reason: res.reason };
      }
    } catch (err) {
      // GENERAL_ERROR carries a message meant for the player.
      if (STGeneralError.isThisError(err))
        return { ok: false, kind: "not-allowed", reason: err.message };
      return { ok: false, kind: "unavailable" };
    }
  }

  return {
    init() {
      if (initialised) return;
      initialised = true;
      SuperTokens.init({
        appInfo: { appName: "Manufactory Idle", apiDomain: origin, apiBasePath: "/auth" },
        recipeList: [
          Session.init({ tokenTransferMethod: "cookie" }),
          ThirdParty.init(),
          EmailPassword.init(),
        ],
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
    signUp: (email, password) => sign(EmailPassword.signUp, email, password),
    signIn: (email, password) => sign(EmailPassword.signIn, email, password),
    async signOut() {
      try {
        await Session.signOut();
        return true;
      } catch {
        return false;
      }
    },
    async sendReset(email): Promise<ResetResult> {
      try {
        const res = await EmailPassword.sendPasswordResetEmail({ formFields: form({ email }) });
        switch (res.status) {
          case "OK":
            return { ok: true };
          case "FIELD_ERROR":
            return { ok: false, kind: "field", fields: fields(res.formFields) };
          case "PASSWORD_RESET_NOT_ALLOWED":
            // ResetResult has no "not-allowed": the reason is about the email.
            return { ok: false, kind: "field", fields: [{ id: "email", error: res.reason }] };
        }
      } catch (err) {
        // GENERAL_ERROR: its message reaches the player, as in sign-in (on the email field).
        if (STGeneralError.isThisError(err)) {
          return { ok: false, kind: "field", fields: [{ id: "email", error: err.message }] };
        }
        return { ok: false, kind: "unavailable" };
      }
    },
    async submitNewPassword(password): Promise<ResetResult> {
      try {
        // The SDK reads ?token= (and tenantId) from the page URL itself.
        const res = await EmailPassword.submitNewPassword({ formFields: form({ password }) });
        switch (res.status) {
          case "OK":
            return { ok: true };
          case "FIELD_ERROR":
            return { ok: false, kind: "field", fields: fields(res.formFields) };
          case "RESET_PASSWORD_INVALID_TOKEN_ERROR":
            return { ok: false, kind: "invalid-token" };
        }
      } catch (err) {
        if (STGeneralError.isThisError(err)) {
          return { ok: false, kind: "field", fields: [{ id: "password", error: err.message }] };
        }
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
