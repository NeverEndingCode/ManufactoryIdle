// W-15: the only account interface the store sees. The SDK lives behind it, in
// supertokens.ts; nothing outside src/auth/ imports supertokens-web-js (eslint.config.js).

export type AuthField = "email" | "password";

export type AuthResult =
  | { ok: true; email: string }
  | { ok: false; kind: "field"; fields: { id: AuthField; error: string }[] }
  | { ok: false; kind: "wrong-credentials" }
  | { ok: false; kind: "not-allowed"; reason: string }
  | { ok: false; kind: "unavailable" };

export type ResetResult =
  | { ok: true }
  | { ok: false; kind: "field"; fields: { id: AuthField; error: string }[] }
  | { ok: false; kind: "invalid-token" }
  | { ok: false; kind: "unavailable" };

export interface AccountClient {
  /** Idempotent; the store calls it once health says accounts: true. */
  init(): void;
  /** False on any failure. At boot a transient refresh failure therefore demotes a signed-in
   * player to a guest (the parked token returns), and a later sign-in's 409 re-parks it. */
  hasSession(): Promise<boolean>;
  signUp(email: string, password: string): Promise<AuthResult>;
  signIn(email: string, password: string): Promise<AuthResult>;
  /** False when the server couldn't be reached; the session is then kept. */
  signOut(): Promise<boolean>;
  sendReset(email: string): Promise<ResetResult>;
  /** The token comes from the page URL (/account/reset-password?token=…). */
  submitNewPassword(password: string): Promise<ResetResult>;
}
