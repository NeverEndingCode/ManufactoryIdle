// W-15: the only account interface the store sees. The SDK lives behind it, in
// supertokens.ts; nothing outside src/auth/ imports supertokens-web-js (eslint.config.js).

/** O-2: display names by thirdPartyId. An id with no name renders as the id itself. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  discord: "Discord",
  github: "GitHub",
  google: "Google",
};

export function providerName(id: string): string {
  return Object.hasOwn(PROVIDER_NAMES, id) ? PROVIDER_NAMES[id]! : id;
}

/** O-9: who signed in, as the callback learned it. */
export interface Account {
  provider: string;
  email: string | null;
}

/** authorisationURL's answer (O-5 step 3). */
export type StartResult =
  | { ok: true; url: string }
  | { ok: false; kind: "not-allowed"; reason: string }
  | { ok: false; kind: "unavailable" };

/** O-7, O-10: why a callback didn't sign in. */
export type SignInFailure =
  | { kind: "denied" }
  | { kind: "provider-error"; code: string | null }
  | { kind: "no-email" }
  | { kind: "not-allowed"; reason: string }
  | { kind: "stale" }
  | { kind: "unknown-provider" }
  | { kind: "unavailable" };

export type SignInResult = { ok: true; account: Account } | ({ ok: false } & SignInFailure);

export interface AccountClient {
  /** Idempotent; the store calls it once health says accounts: true. */
  init(): void;
  /** False on any failure. At boot a transient refresh failure therefore demotes a signed-in
   * player to a guest (the parked token returns), and a later sign-in's 409 re-parks it. */
  hasSession(): Promise<boolean>;
  /** The SDK's getAuthorisationURLWithQueryParamsAndSetState for
   * `${origin}/account/callback/${provider}` (frontendRedirectURI only). It stores the state in
   * sessionStorage for 10 minutes. Never throws. */
  authorisationURL(provider: string): Promise<StartResult>;
  /** O-7's checks, then signInAndUp. Reads the SDK's stored state; `search` is location.search.
   * Never throws. */
  finishSignIn(provider: string, search: string): Promise<SignInResult>;
  /** False when the server couldn't be reached; the session is then kept. */
  signOut(): Promise<boolean>;
}
