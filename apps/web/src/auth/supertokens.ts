// The AccountClient over supertokens-web-js (W-15, S-1): cookie mode, same origin, imported
// statically (Q-17) and initialised only when GET /api/health says accounts: true. The SDK's
// statuses are mapped here, so nothing else knows them; a network throw is "unavailable".
import SuperTokens from "supertokens-web-js";
import EmailPassword from "supertokens-web-js/recipe/emailpassword";
import Session from "supertokens-web-js/recipe/session";
import STGeneralError from "supertokens-web-js/utils/error";
import type { AccountClient, AuthField, AuthResult, ResetResult } from "./accounts.js";

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
        recipeList: [Session.init({ tokenTransferMethod: "cookie" }), EmailPassword.init()],
      });
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
      } catch {
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
      } catch {
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
