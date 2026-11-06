# OAuth accounts (Discord, GitHub), email/password dropped: Design and Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accounts become OAuth only. When this lands:
- a player signs in with Discord or GitHub, one button per provider the server has configured, in the UI-1 retro-terminal style;
- the sign-in leaves the page for the provider and comes back to `/account/callback/:provider`. The guest's progress comes along through the same claim path the store uses today (S-5, S-6, the W-16 erratum). Nothing is lost on the way out, and nothing is sent to a world before the claim is decided on the way back;
- email/password is gone everywhere: the EmailPassword recipe, SMTP reset mail (R-24), the reset-password route and UI, and the dev fake's emailpassword endpoints;
- adding Google later is one line in the server's provider table plus two env vars;
- the dev fake (`DEV_FAKE_SESSIONS=1`) speaks the ThirdParty FDI, so the account e2e signs in through it with both providers.

**Architecture:**
- **Task 1 (API):** the recipe swap. EmailPassword and SMTP go. A provider table drives `providersFromEnv`. A ThirdParty API override pins the redirect URI to `WEBSITE_DOMAIN/account/callback/<id>` and refuses the `oAuthTokens` variant. `/api/health` gains `providers`. The smoke test moves off email sign-up.
- **Task 2 (API, dev):** the fake ThirdParty in `dev-sessions.ts`: `/auth/authorisationurl`, a fake provider page at `/auth/dev/oauth/authorize` that redirects straight back, and `/auth/signinup`. The emailpassword endpoints go. The FDI check stays.
- **Task 3 (web, additive):** the `AccountClient` gains `authorisationURL` and `finishSignIn` over `supertokens-web-js`'s ThirdParty recipe. The store gains `beginSignIn` (drain, then leave), the callback boot (finish, then the existing claim), `providers`, `leaving` and the `{ provider, email }` account. `accounts.test.ts` moves onto the redirect flow. The email/password methods still exist, so the UI keeps compiling.
- **Task 4 (web, subtractive plus UI):** the email/password methods leave the client, the store and the UI. The Account section becomes the provider buttons. The callback route is wired, and `ResetPassword` and its route are deleted. `main.tsx` passes the callback and `pageshow`.
- **Task 5:** `accounts.spec` is rewritten against the fake (both providers, the claim, the 409 park, failures, the drain), `layout-320` is updated, and the READMEs and `deploy.sh`'s core probe are updated. Then the full verification, e2e included.

**Tech Stack:** TypeScript ESM, Fastify, `supertokens-node` 24.0.3, `supertokens-web-js` 0.16.0 (its `recipe/thirdparty` is in the installed package; verified at `node_modules/.pnpm/supertokens-web-js@0.16.0/node_modules/supertokens-web-js/recipe/thirdparty/index.d.ts`), React 18.3, vitest 4 + jsdom + Testing Library, `@playwright/test` (Chromium). There are no new npm dependencies.

**Base:** branch `oauth` at f7fe024 (`ui-terminal`, PR #29, UI-1, not yet merged). The Phase 3 and 4 rulings stand unless an O-ruling below supersedes them. The superseded ones are listed at the end.

## What was verified in the installed SDKs (for the reviewer)

- **The web SDK's state lives in `sessionStorage`**, under `supertokens-oauth-state-2`, which is per tab. It expires 10 minutes after `getAuthorisationURLWithQueryParamsAndSetState` (`lib/build/recipe/thirdparty/recipeImplementation.js`, `stateExpiry = Date.now() + 1000 * 60 * 10`). The SDK never removes it after `signInAndUp`, so a reload of the callback URL would verify the same state again and re-POST a used code. O-7 and O-8 close that.
- **`signInAndUp` throws a plain `Error`**, not an `STGeneralError`, for:
  - no stored state;
  - no `state` in the URL;
  - an expired state;
  - a mismatched state;
  - an `error` query param, which it checks only *after* the state.

  A network failure is also a plain throw (a `TypeError`). So the client can't tell these apart after the fact, and O-7 checks them before calling the SDK.
- **The state stored with the URL includes `thirdPartyId`.** `signInAndUp` posts *that* id, not the one in our path. O-7 checks that the two agree.
- **`appendQueryParamsToURL` accepts a path-only URL** (`lib/build/utils.js:52-74`), so the fake can return `/auth/dev/oauth/authorize?...` and stay on the page's origin behind the Vite and preview proxies.
- **The web querier strips `/public/`** from `/<tenantId>/authorisationurl` and `/<tenantId>/signinup` (`lib/build/querier.js:194`). So the fake serves `/auth/authorisationurl` and `/auth/signinup`, the same as the old `/auth/signup`.
- **The built-in provider defaults already have the scopes we need:**
  - Discord: `scope = ["identify", "email"]` when unset (`supertokens-node/lib/build/recipe/thirdparty/providers/discord.js:28-29`);
  - GitHub: `scope = ["read:user", "user:email"]` when unset (`github.js:82-83`). It also fetches `https://api.github.com/user/emails` for private addresses (`github.js:93-97`).

  So we override nothing (O-2).
- **`ThirdParty.getProvider` and `authorisationUrlGET` read the tenant from the core** (`Multitenancy.getTenant`), so neither runs in a unit test without a core. The redirect guard is unit-tested as a pure override over a fake original (Task 1). The real `authorisationurl` is checked in the smoke test.
- **`deploy.sh`'s core probe is `/auth/emailpassword/email/exists`**, which disappears with the recipe. `/auth/loginmethods` (Multitenancy, `recipe/multitenancy/constants.js:18`) also reads the tenant from the core and answers `{"status":"OK",...}`, so it replaces that probe (O-16).
- **Correction to the brief:** `infra/unraid/README.md` lists `DISCORD_*` and `GITHUB_*` only as generic optional variables. It doesn't list the callback URLs. Task 5 adds them.

## Rulings made in this plan

- **O-1. Accounts are OAuth only.**
  - The API drops `EmailPassword.init`, `SMTPService`, `passwordResetDelivery` and `ResetMailService`. `SMTP_*` are no longer read.
  - The web client drops `EmailPassword` from the SDK init, `signUp`, `signIn`, `sendReset`, `submitNewPassword`, `AuthField`, `ResetResult`, the forms, `ResetPassword.tsx` and the `reset-password` route.
  - The fake drops `/auth/signup`, `/auth/signin`, `/auth/user/password/reset{,/token}` and `/auth/dev/reset-link`.
  - An old reset link (`/account/reset-password?...`) is now an unknown path, and `useRoute` replaces it with `/`.
  - The live database has 0 email/password users, so nothing is migrated. No API schema change: the core owns its tables.
  - *Why:* the user's decision. There's no mail to run, and no passwords to hold.
- **O-2. Adding a provider is one line in one table.**
  - `apps/api/src/auth/supertokens.ts` exports `PROVIDER_TABLE = [["discord", "DISCORD"], ["github", "GITHUB"]] as const`. `providersFromEnv` maps over it, in table order. Google later is `["google", "GOOGLE"]` plus `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
  - The web client's `PROVIDER_NAMES` already lists `google: "Google"`. An id with no name renders as the id itself, so no client change is ever required.
  - No `scope` is set, so the SDK defaults above apply. A test pins that the config carries no `scope` key.
  - *Why:* the user's requirement, and the SDK's defaults are exactly the required scopes.
- **O-3. `/api/health` gains `providers: string[]`**, the configured `thirdPartyId`s in table order (`[]` without accounts).
  - `accounts` keeps its meaning (the SuperTokens env is set), so `accounts: true, providers: []` is possible. The client then says "Sign-in isn't available right now".
  - `superTokensFromEnv` logs a warning in that case: `accounts are on but no sign-in provider is configured (set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET, or GITHUB_…)`.
  - The client accepts only ids matching `^[a-z0-9-]{1,32}$` and treats a missing field as `[]`, which covers an older server.
  - *Why:* the user's decision. The regex keeps a hostile or broken health answer from putting arbitrary text into a URL path.
- **O-4. The redirect URI is pinned on the server, and tokens are never accepted directly.**
  - `guardThirdPartyApis(websiteDomain)` is a ThirdParty `override.apis`:
    - **`authorisationUrlGET`** answers `{ status: "GENERAL_ERROR", message: "Sign-in isn't available from this address." }` unless `redirectURIOnProviderDashboard === <WEBSITE_DOMAIN origin>/account/callback/<provider.id>` exactly;
    - **`signInUpPOST`** answers the same `GENERAL_ERROR` for a request without `redirectURIInfo` (the `oAuthTokens` variant), or for one whose `redirectURIInfo.redirectURIOnProviderDashboard` isn't that exact URL.
  - The origin is `new URL(WEBSITE_DOMAIN).origin`, so a trailing slash in the env is harmless.
  - The fake mirrors both checks on the path (Task 2).
  - *Why:* the providers already refuse unregistered redirect URIs, but GitHub accepts sub-paths of a registered one. A pinned URI is defence in depth against an open redirect. `oAuthTokens` would let a token minted for some other app sign in as its owner.
- **O-5. A sign-in leaves the page only with an empty outbox.** `store.beginSignIn(provider)`:
  1. **Guards.** It refuses (`unavailable`) unless accounts are on, the provider is listed, the identity is `guest`, `auth` is `idle` and `leaving` is `null`. It refuses with `storage` when a guest token exists and `tokens.persistent` is false: the token lives only in memory, and the page is about to unload. The SDK's state needs `sessionStorage` too.
  2. **Drain.** It sets `leaving = provider` and emits. It ends any tap hold and enqueues the pending taps as one batch. Then it waits for `idle()`. If any batch is still pending after that (one waiting out a backoff or a 429/503 pause), it clears `leaving` and refuses with `unsaved`.
  3. **URL.** It calls `client.authorisationURL(provider)`. A failure clears `leaving` and returns that failure.
  4. **Navigate.** If anything became pending meanwhile, it refuses with `unsaved`. Otherwise it calls `navigate(url)` and resolves `{ ok: true }`.
  - The outbox is never stopped, and the hold (S-4) is not used: nothing is held because nothing must wait for a claim before the page leaves.
  - The guest token stays in `localStorage` (`mi.guestToken`) untouched.
  - *Why:* the outbox is in memory (`outbox.ts`), so a batch not yet acknowledged when the page unloads would be lost. Refusing is the only way to lose nothing without persisting batches.
- **O-6. The callback is consumed at boot, before anything world-shaped is sent, and then it is the existing claim.**
  - `main.tsx` passes `callback: { provider, search, done }` when the path is `/account/callback/:provider`. The boot (S-3) becomes:
    1. **health** (retried as today; the callback waits);
    2. **checks.** If accounts are off, there's no client, or the provider isn't in `providers`: call `done()`, raise `sign-in-failed` (`unavailable` or `unknown-provider`), and boot normally;
    3. **`init()`, then `hasSession()`.**
       - **true:** this is a reload after a success, or a stray hit. Call `done()`, ignore the callback with no notice, and continue the existing session boot (it claims if a guest token is present, per the W-16 erratum).
       - **false:** set `identity = "guest"` and `auth = "held"`, and emit. Nothing has been sent, so there's nothing to drain. Then call `client.finishSignIn(provider, search)` and `done()`.
         - **On success:** `#enterSession(account)`, which is the code `#signIn` runs today after a success (identity `session`, `claimPending`, `#claimOnce()`), plus the `signed-in` notice and the stored label (O-9). From here it's S-5 and S-6 unchanged: 200 adopts, 404 drops, 409 parks with `account-has-factory`, 401 releases, and network/5xx retries while held.
         - **On failure:** raise `sign-in-failed` with that kind's text, then `#release()`. The guest resumes: GET with its token, or `POST /api/guests` if it has none.
  - **Never before the decision:** no `GET /api/world`, `POST /api/guests` or `POST /api/actions` goes out before `finishSignIn` answers and, on success, before the claim answers.
  - **`stop()` mid-callback:** the outcome is still recorded (a success sets `claimPending`), so `start()` resumes the claim. A failure leaves `auth` `idle`, and `start()` resumes as a guest.
  - *Why:* the user's "same post-sign-in path". A guest GET before the sign-in would only flash the guest world. A guest creation before it would, with no token, mint an empty guest and then claim it.
- **O-7. The client checks everything it can before calling the SDK, and never echoes provider text.** `finishSignIn(provider, search)` does, in order:
  1. `error` in `search`: `access_denied` → `denied`; anything else → `provider-error` with `code` = the value if it matches `^[a-z0-9_.-]{1,40}$`i, else `null`. `error_description` is **never** read or shown.
  2. No stored state (`ThirdParty.getStateAndOtherInfoFromStorage()`) → `stale`.
  3. A stored `thirdPartyId !== provider` → `stale`.
  4. No `state` param, or a `state` that differs from `stateForAuthProvider` → `stale`.
  5. `expiresAt < Date.now()` → `stale`.
  6. No `code` param → `stale`.
  7. The `state` equals `sessionStorage["mi.oauthConsumed"]` → `stale`.

  Then it writes `mi.oauthConsumed = state` (try/catch) and calls `ThirdParty.signInAndUp()`. The results map as:
  - `OK` → `{ ok: true, account: { provider, email: user.emails[0] ?? null } }`;
  - `NO_EMAIL_GIVEN_BY_PROVIDER` → `no-email`;
  - `SIGN_IN_UP_NOT_ALLOWED` → `not-allowed` with its `reason`;
  - an `STGeneralError` → `not-allowed` with its message;
  - any other throw → `unavailable`.
  - *Why:* each check gives the player the right sentence and never spends a used code. `error_description` is attacker-controllable text (anyone can craft a callback link), so it must never reach our UI.
- **O-8. The callback URL is cleared exactly once, after the attempt, and nothing clears it earlier.**
  - `done()` is `() => replaceRoute({ kind: "game" })`. The store calls it once on every path in O-6: after `finishSignIn` resolves, or immediately when the callback is skipped.
  - `parseRoute` recognises `/account/callback/<id>` (`<id>` matching `^[a-z0-9-]{1,32}$`) as `{ kind: "callback", provider }`, so `useRoute`'s unknown-path effect never strips `?code=…&state=…` before the SDK reads `window.location`.
  - While the route is `callback`, `App` renders only the loading line, "Signing in…", so no navigation can change the URL mid-request.
  - *Why:* this is the double-sign-in guard together with O-7's marker and O-6's `hasSession()`-first.
- **O-9. What a signed-in player sees.**
  - `StoreView.account` becomes `{ provider: string | null; email: string | null } | null`.
  - The label is stored as JSON under `mi.account` (`browserTokenStorage(undefined, ACCOUNT_LABEL_KEY)`), written on a successful callback and cleared in `#leaveSession`. A session boot reads it; malformed or missing gives `{ provider: null, email: null }`.
  - The Account section reads:
    - "Signed in with Discord as a@b.example";
    - "Signed in with Discord" with no email;
    - "Signed in" with neither.
  - *Why:* S-11's "no user-info route" stands (no API change). The label is display-only and per-device, like the session cookie it describes.
- **O-10. Notices.** Two new kinds, both toasts (`Notices.tsx`'s `TOASTS`, dismissable):
  - **`signed-in`:** `Signed in with <Name>[ as <email>].`
  - **`sign-in-failed`**, with the text per kind:

    | Kind | Text |
    |---|---|
    | `denied` | `Sign-in with <Name> was cancelled. You're still playing as a guest.` |
    | `provider-error` | `<Name> couldn't sign you in[ (<code>)]. Try again from Settings.` |
    | `no-email` | `<Name> didn't share an email address, and an account needs one. Check the email on your <Name> account, then try again.` |
    | `not-allowed` | the server's reason |
    | `stale` | `That sign-in didn't finish in this tab, or it took too long. Start it again from Settings.` |
    | `unknown-provider` | `That sign-in provider isn't available here.` |
    | `unavailable` | `Couldn't reach the server to finish signing in. You're still playing as a guest; try again from Settings.` |

  - `beginSignIn`'s refusals are form errors in the Account section, not notices:

    | Refusal | Text |
    |---|---|
    | `unsaved` | `Your last actions haven't reached the server yet. Try again in a moment.` |
    | `storage` | `This browser isn't saving your factory, so it would be lost on the way to <Name>. Allow this site to store data, then try again.` |
    | `unavailable` | `Couldn't reach the server. Try again.` |
    | `not-allowed` | the reason |

  - `#leaveSession` and a new `beginSignIn` drop both toasts.
  - *Why:* the callback runs with the sheet closed, so its outcome needs a channel that's always on screen and announced (W-20's one region).
- **O-11. `leaving` is a view field, cleared when the page comes back.**
  - `StoreView.leaving: string | null` is the provider while the drain and the navigation run. While it's set, the Account buttons are `aria-disabled`, and the chosen one reads "Opening <Name>…" with `aria-busy`.
  - `store.pageShown(persisted)`, from `pageshow`, clears it when `persisted` (a bfcache restore after Back from the provider). So does a `LEAVE_TIMEOUT_MS = 15_000` timer armed at `navigate`.
  - Nothing else changes while `leaving`. The modal sheet is the only place a player can act from, the outbox keeps running, and `pagehide`'s keepalive flush works as today.
  - *Why:* without it, a Back from Discord restores a page whose buttons stay disabled forever.
- **O-12. No account linking.** The same email on Discord and on GitHub is two SuperTokens users, so two players.
  - *Why:* linking needs the AccountLinking recipe and an email-verification policy. That's out of scope, and the core's default is safe (no takeover through an unverified email).
- **O-13. The save chip needs a provider.** `showsChip` adds `view.providers.length > 0`. The chip opens Settings at Account. There's no sign-up/sign-in mode any more.
  - *Why:* a nudge to an unavailable action is noise.
- **O-14. The fake ThirdParty (Task 2).**
  - **Providers.** `fakeSessions({ clock, providers = ["discord", "github"] })`, and its `accounts.providers` is that list.
  - **`GET /auth/authorisationurl?thirdPartyId&redirectURIOnProviderDashboard`:**
    - an unlisted provider → `400 { message: "the provider <id> could not be found in the configuration" }`;
    - a redirect URI whose path isn't exactly `/account/callback/<id>` (any origin) → `GENERAL_ERROR` as O-4;
    - otherwise `{ status: "OK", urlWithQueryParams: "/auth/dev/oauth/authorize?thirdPartyId=<id>&redirect_uri=<encoded>" }`. The SDK appends `&state=`.
  - **`GET /auth/dev/oauth/authorize`** is the fake provider. It reads the fake user from the `dev-oauth-user` cookie (`^[a-z0-9-]{1,40}$`, default `player`).
    - User `deny` → `302 /account/callback/<id>?error=access_denied&state=<state>`.
    - Otherwise it issues a single-use random `code` bound to `{ thirdPartyId, redirectURI, user }` and answers `302 /account/callback/<id>?code=<code>&state=<state>`.
    - The `Location` is always path-only. The host of `redirect_uri` is never used, so the fake is no open redirect even in dev.
  - **`POST /auth/signinup`:**
    - an unlisted provider → 400 as above;
    - no `redirectURIInfo` → `GENERAL_ERROR`;
    - an unknown, used, or other-provider code, or a mismatched redirect URI → `500 { error: "internal error" }`. That's what the real API answers when the provider's token exchange throws;
    - user `no-email` → `{ status: "NO_EMAIL_GIVEN_BY_PROVIDER" }`;
    - user `not-allowed` → `{ status: "SIGN_IN_UP_NOT_ALLOWED", reason: "Cannot sign in / up due to security reasons. Please contact support. (ERR_CODE_DEV)" }`;
    - otherwise find or create the user keyed `<id>:<user>` (email `<user>@<id>.example`), start a session as today, and answer `{ status: "OK", createdNewRecipeUser, user }` with a ThirdParty-shaped user (`thirdParty: [{ id, userId: user }]`, `loginMethods[0].recipeId: "thirdparty"`).
  - `signout`, `session/refresh`, the cookie, the front-token and the FDI check are unchanged.
  - *Why:* the e2e needs both providers, a fresh user per run (the reused dev server keeps users in memory), a 409, a denial and the two SDK statuses, all without a page-routing trick.
- **O-15. The smoke test makes sessions without email.**
  - It creates a user with `ThirdParty.manuallyCreateOrUpdateUser("public", "discord", "smoke-<rand>", "smoke-<rand>@example.com", true)` and a session with `Session.createNewSessionWithoutRequestResponse("public", recipeUserId)`. It uses `session.getAccessToken()` as `Authorization: Bearer`.
  - The W-2 cookie check moves to `POST /auth/session/refresh` with `cookie: sRefreshToken=<refresh token>` and `st-auth-mode: cookie`: the new `sAccessToken` is `SameSite=Lax` and there's no `anti-csrf` header.
  - Two new checks, with dummy `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` in the smoke env:
    - `/auth/authorisationurl` with the pinned URI returns a `discord.com/oauth2/authorize` URL whose `scope` is `identify email`;
    - a foreign URI gets `GENERAL_ERROR`.
  - *Why:* the real path stays covered, and the scopes and the guard are checked against a real core.
- **O-16. The deploy probe moves to `/auth/loginmethods`, and the first deploy needs one manual step.**
  - `deploy.sh`'s smoke asks `GET /auth/loginmethods` and requires `"status":"OK"`. It also logs `providers` from health, without requiring any: the user sets the env vars on their own schedule.
  - `deploy.sh` runs one version behind itself (`infra/unraid/README.md`, "Redeploy"). So **the first deploy of this branch must be run from the new checkout:** `git -C /mnt/user/appdata/manufactory/src fetch && git -C … checkout <sha>`, then `bash …/src/infra/unraid/deploy.sh <sha>`. Otherwise the old probe 404s and the script rolls back. Task 5 writes this into the runbook.
  - *Why:* the old probe's endpoint no longer exists.
- **O-17. `websiteBasePath` stays `"/account"`.** No recipe sends links any more, and the callback paths live under `/account` by our choice. `appInfoFor`'s comment changes; its test doesn't.
  - *Why:* changing it buys nothing and churns S-9's test.
- **O-18. The buttons speak the theme's voice, as the save chip does.**
  - In the `shell` voice the visible text is `> login --discord`. In `plain` it's "Sign in with Discord".
  - The accessible name is always "Sign in with Discord" (`aria-label`), and each button carries `data-provider="discord"`. They're full-width `.btn.secondary` rows, at least 44 px tall, in table order, in a `role="group"` labelled by the section's heading, "Sign in".
  - A one-line note above them: "Save this factory to an account and play it anywhere. Signing in the first time creates the account."
  - *Why:* UI-1's chip set the precedent (`> save_factory` with `aria-label="Save your factory"`).
- **O-19. The web work is additive, then subtractive.** Task 3 adds the OAuth flow beside the email/password methods (the UI still uses them), and moves the store tests onto the new flow. Task 4 removes the old methods together with their UI.
  - *Why:* every commit then passes `pnpm test`, `pnpm lint` and `pnpm typecheck`.

## Global Constraints

As given, verbatim:

> work only in .claude/worktrees/oauth on branch oauth; never run `pnpm format`; verify with `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, then `pnpm --filter @manufactory/web e2e`, sequentially in the foreground, never in the background; never `pkill -f`; no containers; heavy suites get explicit vitest timeouts `describe(name, { timeout: 60_000 }, …)` because CI is 10–20× slower; no new npm dependencies (supertokens-web-js's ThirdParty recipe is already in the installed package — verify); commit trailers exactly:
>   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
>   Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
> and do not push.

In detail:

- **Where to work:** only `.claude/worktrees/oauth`, on branch `oauth`. Never touch the top-level checkout.
- **Never run `pnpm format`.**
- **Verification:** `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, then `pnpm --filter @manufactory/web e2e`. Run them sequentially, in the foreground, never in the background. Never run lint or typecheck while a test run is going, because turbo builds race.
  - Tasks 1–4 commit on green `pnpm test`, `pnpm lint` and `pnpm typecheck`.
  - From Task 2 until Task 5, `accounts.spec.ts` and `layout-320.spec.ts`'s account steps are expected red: the fake no longer signs up. The other e2e specs must stay green; Task 4 runs the e2e to check that.
  - Task 5 runs everything, e2e included, all green.
  - For a single suite: `pnpm --filter @manufactory/<api|web> exec vitest run <path>`.
- **Never `pkill -f`.**
- **No containers.**
- **Heavy suites get explicit vitest timeouts:** `describe(name, { timeout: 60_000 }, …)`, because CI is 10–20× slower. That covers every new or rewritten describe in:
  - `apps/web/src/sync/accounts.test.ts` (PGlite rig);
  - `apps/api/src/dev-sessions.test.ts` (PGlite dev server);
  - `apps/web/src/ui/Settings.test.tsx` (renders the sheet).
- **No new npm dependencies.** `supertokens-web-js`'s ThirdParty recipe is already in the installed package. Verify it before Task 3: `ls node_modules/.pnpm/supertokens-web-js@0.16.0/node_modules/supertokens-web-js/recipe/thirdparty`.
- **No API database schema change** beyond what SuperTokens' core owns. No engine or content changes.
- **Commit trailers, exactly:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01JAcheZCx3UG14cqpboczzJ
  ```
- Do not push.

## Review Focus

These are the five failure modes most likely to bite a player.

1. **Guest progress lost across the redirect** (O-5, O-6).
   - `beginSignIn` navigates only after `idle()` with zero pending batches, and taps are flushed first. A batch in backoff refuses with `unsaved`, and a memory-only token refuses with `storage`.
   - On return, nothing world-shaped goes out before `finishSignIn` and the claim answer, so the claim can never be pre-empted into a 409 by a lazily created account world (R-14).
   - (Task 3 tests 1–4 and 6; Task 5 e2e steps 2 and 9.)
2. **Double sign-in on a callback reload** (O-6, O-7, O-8).
   - `hasSession()` runs before `finishSignIn`. `mi.oauthConsumed` refuses a repeat state. `done()` replaces the URL once.
   - `parseRoute` keeps the callback path, so the URL isn't stripped before the SDK reads it.
   - (Task 3 tests 7–8, Task 4 route tests, Task 5 e2e step 3.)
3. **An open redirect through `frontendRedirectURI` or `redirect_uri`** (O-4, O-14).
   - The client builds the URI from `location.origin` and a listed, regex-checked id.
   - The server pins `redirectURIOnProviderDashboard` on both APIs and refuses `oAuthTokens`.
   - The fake redirects path-only.
   - (Task 1 tests 3–4, Task 2 tests 2–3.)
4. **A stale `state`** (O-7).
   - A callback in a tab without the stored state (another tab, a mobile app handoff, or more than 10 minutes later), with another provider's state, or with a mismatched state gets the `stale` notice. It never calls the SDK and never spends the code.
   - (Task 3 client tests 4–6; Task 5 e2e step 7.)
5. **Provider error params** (O-7, O-10).
   - `error=access_denied` reads "cancelled", and any other `error` reads `provider-error` with a sanitised code. `error_description` is never shown.
   - The player is back in the game as the same guest, with the token untouched and no `/auth/signinup` request.
   - (Task 3 client test 3, store test 9; Task 5 e2e step 6.)

---

### Task 1: API: OAuth-only recipes, the provider table, the redirect guard, and `providers` in health

**Files:**
- **Modify:**
  - `apps/api/src/auth/supertokens.ts`: drop EmailPassword, SMTP, `passwordResetDelivery` and `ResetMailService`. Add `PROVIDER_TABLE`, `guardThirdPartyApis`, `providers` on `SuperTokensAccounts`, and the no-provider warning. Update the header and `appInfoFor` comments (O-17).
  - `apps/api/src/auth/supertokens.test.ts`: drop the R-24 describe. Add tests 1–5.
  - `apps/api/src/auth/supertokens.smoke.test.ts`: rewrite per O-15.
  - `apps/api/src/server.ts`: `ServerDeps.accounts.providers`, and health's `providers`.
  - `apps/api/src/server.test.ts`: the health tests.
  - `apps/api/src/dev-sessions.ts`: `accounts.providers: []` for now (Task 2 fills it).
  - `apps/api/src/dev-sessions.test.ts` and `dev-server.test.ts`: the health assertions gain `providers`.
  - `apps/web/src/sync/test-rig.ts`: the rig's `accounts` literal gains `providers: ["discord", "github"]`, so the web package typechecks.

**Interfaces:**

```ts
// apps/api/src/auth/supertokens.ts
/** O-2: one line per provider: [thirdPartyId, env prefix]. Google later: ["google", "GOOGLE"]. */
export const PROVIDER_TABLE: readonly (readonly [thirdPartyId: string, envPrefix: string])[];
/** The providers whose <PREFIX>_CLIENT_ID and _SECRET are both set, in table order. No scope: the SDK's defaults. */
export function providersFromEnv(env: Env): ProviderInput[];
/** O-4: the exact URL each provider must redirect to. */
export function callbackURL(websiteDomain: string, thirdPartyId: string): string; // `${new URL(d).origin}/account/callback/${id}`
/** O-4: ThirdParty override.apis. */
export function guardThirdPartyApis(websiteDomain: string): (original: APIInterface) => APIInterface;
export interface SuperTokensAccounts {
  register(app: FastifyInstance): void;
  handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  verifySession: SessionVerifier;
  /** O-3: the configured thirdPartyIds, in PROVIDER_TABLE order. */
  providers: readonly string[];
}

// apps/api/src/server.ts
accounts?: { register(…): void; handleError(…): Promise<boolean>; providers: readonly string[] };
// GET /api/health → { ok: true, contentChecksum, accounts: boolean, providers: string[] }
```

`supertokens.init`'s `recipeList` becomes `[ThirdParty.init({ signInAndUpFeature: { providers }, override: { apis: guardThirdPartyApis(websiteDomain) } }), Session.init()]`.

Steps:
- [ ] **Step 1: Write the failing tests** (`supertokens.test.ts` unless named).
  1. **`PROVIDER_TABLE` and `providersFromEnv`.**
     - The table is exactly `[["discord","DISCORD"],["github","GITHUB"]]`.
     - The existing R-12 cases stay.
     - New: no provider config has a `scope` key.
     - New: with both set, the order is the table's.
  2. **`callbackURL`.** `("https://x.example/", "github")` → `https://x.example/account/callback/github`. `("http://localhost:5173", "discord")` → `http://localhost:5173/account/callback/discord`.
  3. **`guardThirdPartyApis`, `authorisationUrlGET`,** over a fake original that resolves `{ status: "OK", urlWithQueryParams: "u" }` and records calls:
     - the exact URL passes through, and the original is called once;
     - each of these gets the `GENERAL_ERROR` and the original is never called: another origin, another provider's path, a trailing slash, an added query, `http` for an `https` domain, and `/account/callback/github/../discord`.
  4. **`guardThirdPartyApis`, `signInUpPOST`.**
     - `oAuthTokens` without `redirectURIInfo` → `GENERAL_ERROR`, original not called.
     - A foreign `redirectURIOnProviderDashboard` → `GENERAL_ERROR`.
     - The exact one passes through.
     - An original that is `undefined` stays `undefined`, because the API is disabled.
  5. **`superTokensFromEnv`:**
     - `providers` equals the configured ids;
     - with none, `log.warn` is called once with the no-provider line;
     - with one, there's no such warning (the `not https` warning is separate);
     - the module imports nothing from `recipe/emailpassword`: a source scan of `supertokens.ts` for `emailpassword` and `SMTP`.
  6. **`server.test.ts`:**
     - health without accounts is `{ ok, contentChecksum, accounts: false, providers: [] }`;
     - with `accounts: { …, providers: ["github"] }` it's `accounts: true, providers: ["github"]`.
- [ ] **Step 2:** run `pnpm --filter @manufactory/api exec vitest run src/auth src/server.test.ts`. Watch them fail.
- [ ] **Step 3: Implement.** Then update the dev fake's and the web rig's `accounts` literals.
- [ ] **Step 4: Rewrite the smoke test (O-15).**
  - Its env adds `DISCORD_CLIENT_ID=smoke-id` and `DISCORD_CLIENT_SECRET=smoke-secret`.
  - The four cases:
    - lazy world;
    - claim;
    - cookie-mode refresh with SameSite=Lax and no `anti-csrf`;
    - `authorisationurl`: the good URI (assert host `discord.com` and `scope` `identify email`) and a foreign one (`GENERAL_ERROR`).
  - It still `skipIf`s without `SUPERTOKENS_CONNECTION_URI`. If the refresh route turns out to need more than the refresh cookie in cookie mode, keep the SameSite check on whichever FDI route sets `sAccessToken` with a core-made session, and record which in the test's comment.
- [ ] **Step 5:** rerun Step 2's suites. Green.
- [ ] **Step 6: Mutations, each undone by hand:**
  - compare with `startsWith` instead of `===` in the guard: test 3 fails (the `/../` and query cases);
  - drop the `oAuthTokens` check: test 4 fails;
  - add `scope: ["identify"]` to the Discord config: test 1 fails;
  - send `providers: []` from health regardless: test 6 fails.
- [ ] **Step 7:** run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`. Commit: `API: accounts are OAuth only; a provider table, a pinned redirect URI, and providers in health (O-1 to O-4)`.

---

### Task 2: the dev fake speaks ThirdParty

**Files:**
- **Modify:**
  - `apps/api/src/dev-sessions.ts`: the emailpassword endpoints, the password validator and the reset maps go, and O-14 comes in. The header comment changes.
  - `apps/api/src/dev-server.ts`: an optional `fakeProviders?: string[]` passed through.
  - `apps/api/src/dev-sessions.test.ts`: rewritten as `describe("fake sessions", { timeout: 60_000 }, …)`.

**Interfaces:**

```ts
export function fakeSessions(opts?: { clock?: () => number; providers?: readonly string[] }): FakeSessions;
// FakeSessions.accounts.providers === opts.providers ?? ["discord", "github"]
export const FAKE_USER_COOKIE = "dev-oauth-user";
```

The test helper signs in end to end with `app.inject`:
1. `GET /auth/authorisationurl?thirdPartyId=<id>&redirectURIOnProviderDashboard=http://localhost:5173/account/callback/<id>`;
2. append `&state=s1` and `GET` it with `cookie: dev-oauth-user=<user>`;
3. read the 302's `Location`;
4. `POST /auth/signinup` with `redirectURIQueryParams` parsed from it.

Steps:
- [ ] **Step 1: Write the failing tests.**
  1. **Health:** `accounts: true, providers: ["discord","github"]` with the flag. `devServer({ fakeSessions: true, fakeProviders: ["github"] })` gives `["github"]`. Without the flag it's `false, []`.
  2. **`authorisationurl`.**
     - OK with a path-only `urlWithQueryParams` starting `/auth/dev/oauth/authorize?`.
     - An unlisted provider → 400 with the message.
     - A redirect path of `/account/callback/github` for `discord`, or `/elsewhere`, → `GENERAL_ERROR`.
  3. **`authorize`.**
     - The 302 `Location` is exactly `/account/callback/discord?code=<…>&state=s1`, path-only, even when `redirect_uri` is `https://evil.example/account/callback/discord`. The latter is refused one step earlier by `authorisationurl`, but `authorize` itself must not trust it either.
     - User `deny` → `?error=access_denied&state=s1`, with no code.
     - A cookie value outside the regex → treated as `player`.
  4. **`signinup` OK.**
     - The status is OK, with `createdNewRecipeUser: true`, then `false` for the same user and provider.
     - `user.emails` is `["alice@discord.example"]`, and `thirdParty` is `[{ id: "discord", userId: "alice" }]`.
     - The session cookie and front-token look as before.
     - The same user on GitHub is a different `user.id` (O-12).
  5. **`signinup` failures:**
     - reusing a code → 500 `{ error: "internal error" }`;
     - a code from `discord` posted as `github` → 500;
     - no `redirectURIInfo` → `GENERAL_ERROR`;
     - user `no-email` → `NO_EMAIL_GIVEN_BY_PROVIDER`;
     - user `not-allowed` → `SIGN_IN_UP_NOT_ALLOWED` with a reason.
  6. **Unchanged behaviour, kept on a session from test 4's helper:**
     - the cookie works for `/api/world` and claim;
     - sign-out clears it;
     - refresh needs the cookie;
     - the FDI check: `1.16` → 400, `4.2,4.1` OK, none OK, now on `/auth/authorisationurl`;
     - production refusal.
  7. **Gone:** `POST /auth/signup`, `/auth/signin`, `/auth/user/password/reset/token` and `GET /auth/dev/reset-link` all answer 404.
- [ ] **Step 2:** run `pnpm --filter @manufactory/api exec vitest run src/dev-sessions.test.ts src/dev-server.test.ts`. Watch them fail.
- [ ] **Step 3: Implement O-14.** Codes are `randomBytes(16).toString("hex")` in a `Map<code, { thirdPartyId, redirectPath, user }>`, deleted on first use. Users live in a `Map<"<id>:<user>", { userId, timeJoined }>`.
- [ ] **Step 4:** rerun Step 2. Green.
- [ ] **Step 5: Mutations, each undone by hand:**
  - redirect to `redirect_uri` itself instead of its path: test 3 fails;
  - don't delete a used code: test 5 fails;
  - key users by user only, not provider and user: test 4's O-12 case fails.
- [ ] **Step 6:** run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`. Commit: `API: the dev fake speaks ThirdParty (authorisation URL, a fake provider, sign-in-up); its email/password endpoints go (O-14)`.

---

### Task 3: web: the redirect sign-in in the AccountClient and the store (additive)

**Files:**
- **Modify:**
  - `apps/web/src/auth/accounts.ts`: add the types below, keeping the email/password ones for now.
  - `apps/web/src/auth/supertokens.ts`: `ThirdParty.init()` joins the `recipeList` after `Session` and before `EmailPassword`. Add `authorisationURL` and `finishSignIn`.
  - `apps/web/src/auth/supertokens.test.ts`: mock `supertokens-web-js/recipe/thirdparty`, and add client tests 1–7.
  - `apps/web/src/sync/wire.ts`: `HealthResponse.providers?: unknown`.
  - `apps/web/src/sync/constants.ts`: `ACCOUNT_LABEL_KEY = "mi.account"`, `OAUTH_CONSUMED_KEY = "mi.oauthConsumed"` and `LEAVE_TIMEOUT_MS = 15_000`.
  - `apps/web/src/sync/store.ts`: O-5, O-6 and O-9 to O-11. `#signIn`'s success branch is factored into `#enterSession(account: { provider: string | null; email: string | null })`, which both paths use.
  - `apps/web/src/sync/test-rig.ts`: `rigAccounts` gains the new methods (below).
  - `apps/web/src/sync/accounts.test.ts`: moved onto the redirect flow (the table below), plus store tests 1–12.
  - `apps/web/src/ui/test-fixtures.ts`: the view defaults gain `providers: []`, `leaving: null`, and `account` in its new shape.

**Interfaces:**

```ts
// apps/web/src/auth/accounts.ts
export const PROVIDER_NAMES: Readonly<Record<string, string>>; // { discord: "Discord", github: "GitHub", google: "Google" }
export function providerName(id: string): string;              // PROVIDER_NAMES[id] ?? id
export interface Account { provider: string; email: string | null }
export type StartResult =
  | { ok: true; url: string }
  | { ok: false; kind: "not-allowed"; reason: string }
  | { ok: false; kind: "unavailable" };
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
  init(): void;
  hasSession(): Promise<boolean>;
  /** The SDK's getAuthorisationURLWithQueryParamsAndSetState for `${origin}/account/callback/${provider}`
   *  (frontendRedirectURI only). It stores the state in sessionStorage for 10 minutes. Never throws. */
  authorisationURL(provider: string): Promise<StartResult>;
  /** O-7's checks, then signInAndUp. Reads the SDK's stored state; `search` is location.search. Never throws. */
  finishSignIn(provider: string, search: string): Promise<SignInResult>;
  signOut(): Promise<boolean>;
  // …plus, until Task 4: signUp, signIn, sendReset, submitNewPassword
}

// apps/web/src/sync/store.ts
export interface SignInCallback { provider: string; search: string; done(): void }
export type BeginResult =
  | { ok: true }
  | { ok: false; kind: "unsaved" | "storage" | "unavailable" }
  | { ok: false; kind: "not-allowed"; reason: string };
// GameStoreDeps += callback?: SignInCallback; navigate?: (url: string) => void  // default: (u) => window.location.assign(u)
//                  accountLabel?: TokenStorage                                   // default: memory
// StoreView     += providers: readonly string[]; leaving: string | null
//                  account: { provider: string | null; email: string | null } | null
// Notice.kind   += "signed-in" | "sign-in-failed"
// GameStore     += beginSignIn(provider: string): Promise<BeginResult>; pageShown(persisted: boolean): void
```

`rigAccounts(rig, opts)` gains a shared `tab: { state: { provider: string; state: string } | null; consumed: string | null }`, which stands in for the tab's `sessionStorage` across "page loads" (the stores). It also gains `opts.finishGate?: Promise<void>` and `opts.startFails?: StartResult`.
- **`authorisationURL(p)`** records `authorisationURL <p>`, sets `tab.state = { provider: p, state: "s<n>" }`, and returns `{ ok: true, url: "/fake/authorize?provider=<p>&state=s<n>" }`.
- **`finishSignIn(p, search)`** records `finishSignIn <p>`, applies O-7's checks to `tab`, awaits `finishGate`, and then:
  - `?error=access_denied` → `denied` (O-7's first check, before the gate);
  - the code `no-email` → `no-email`;
  - any other code `<user>` → `rig.session.user = "u:<user>"` and `{ ok: true, account: { provider: p, email: "<user>@<p>.test" } }`.

The test helper `redirect(made, user, opts?)` runs the redirect end to end:
1. on page 1, `beginSignIn("discord")`, capturing the URL through `navigate`;
2. `page1.store.stop()`;
3. build page 2 with `storeOn(rig, { tokens, parked, accountLabel, callback: { provider, search: "?code=<user>&state=<state>", done }, …opts })`;
4. `await page2.store.start()` and `idle()`.

It returns page 2 and the `done` call count.

Steps:
- [ ] **Step 0:** verify the recipe exists (Global Constraints). Read `recipeImplementation.js`'s `signInAndUp` and `verifyAndGetStateOrThrowError` once, to confirm the facts at the top of this plan.
- [ ] **Step 1: Write the failing client tests** (`supertokens.test.ts`, SDK mocked).
  1. **init.** The `recipeList` is `[session, "thirdparty", "emailpassword"]`, and `init` runs once.
  2. **`authorisationURL("github")`** calls the SDK with exactly `{ thirdPartyId: "github", frontendRedirectURI: "https://game.example/account/callback/github" }`. There's no `redirectURIOnProviderDashboard`. OK maps to `{ ok: true, url }`, an `STGeneralError` to `not-allowed`, and a `TypeError` to `unavailable`.
  3. **The error params.** `?error=access_denied&state=x` → `denied`. `?error=server_error` → `provider-error` with `"server_error"`. `?error=<script>` → `provider-error` with `null`. The SDK's `signInAndUp` is never called, and the result never contains `error_description`'s text: pass a distinctive one and assert it's absent from `JSON.stringify(result)`.
  4. **No stored state** → `stale`. A stored state for `discord` on the `github` callback → `stale`.
  5. **A mismatched `state`, no `state`, or no `code`** → `stale`. An `expiresAt` in the past → `stale`.
  6. **The consumed marker.** A first call with a good state calls `signInAndUp` once. A second call with the same search → `stale`, and still one call. The marker is written *before* the SDK call: a `signInAndUp` that never resolves still leaves it set.
  7. **The statuses.**
     - OK maps to `{ ok: true, account: { provider, email } }`, with `emails[0]`, or `null` for `[]`.
     - `NO_EMAIL_GIVEN_BY_PROVIDER` → `no-email`.
     - `SIGN_IN_UP_NOT_ALLOWED` → `not-allowed` with the reason.
     - An `STGeneralError` → `not-allowed` with its message.
     - A `TypeError` → `unavailable`.
     - A `sessionStorage` that throws on `setItem` still proceeds.
- [ ] **Step 2: Write the failing store tests.** These go in `accounts.test.ts`, in a new `describe("GameStore OAuth redirect (O-5, O-6)", { timeout: 60_000 }, …)`.
  1. **The drain.** A guest with a reorder in flight (`rig.fetch.hold`) and three taps pending calls `beginSignIn("discord")`.
     - `view.leaving === "discord"` at once.
     - `navigate` isn't called until the held response is released.
     - The calls end in the reorder POST, then the tap POST, then `authorisationURL discord`, then navigate.
     - The world's action log has both keys. `view.pending` is empty at navigate.
  2. **Unsaved.** A batch waiting out a 503 pause (a wrapped fetch answers `503` with `Retry-After: 30` once) → `{ ok: false, kind: "unsaved" }`. `navigate` isn't called, `leaving` is `null`, and the batch is still pending and goes out after the pause.
  3. **Storage.** `tokens` is a memory storage (`persistent: false`) holding a token → `storage`. `authorisationURL` isn't called.
  4. **Guards.**
     - A provider not in `providers` → `unavailable`.
     - Under a session → `unavailable`.
     - A second `beginSignIn` while `leaving` → `unavailable`, with one `authorisationURL` call.
     - `startFails: { ok: false, kind: "not-allowed", reason: "r" }` → that result, and `leaving` cleared.
  5. **`leaving` clears** on `pageShown(true)`, not on `pageShown(false)`, and after `LEAVE_TIMEOUT_MS` (rig clock).
  6. **The callback claims first** (was test 5). A guest at state version 1 is redirected.
     - Page 2's first world-ish call is `POST /api/auth/claim` with page 1's token and no `Authorization`. No `GET /api/world` and no `POST /api/guests` comes before it.
     - The view is version 1, with the same seed, identity `session`, account `{ provider: "discord", email: "alice@discord.test" }`, and `auth` `idle`.
     - `tokens` is empty and `done` was called once.
     - The `signed-in` notice reads "Signed in with Discord as alice@discord.test."
     - `accountLabel` holds the JSON.
  7. **The hold on return** (replaces test 6). With `finishGate` closed: advance past the boundary, `onFocus()`, `onOnline()`. Nothing world-ish goes out, and `view.auth === "held"`. Open the gate: the claim goes first, then the GET.
  8. **A callback with a live session** (a reload after success): `finishSignIn` isn't called, `done` is called once, and there's no notice. A token present means the existing boot claim runs; none means a GET.
  9. **Failures.** For each of `denied`, `stale` (a callback with no `tab.state`), `no-email`, and `unavailable` (the rig's `finishSignIn` throws):
     - the `sign-in-failed` notice has O-10's text;
     - identity is `guest`, and `done` is called once;
     - the token is untouched, and the next world call is `GET /api/world` with `Guest <same token>`.

     With no token, the next call is `POST /api/guests`.
  10. **An unknown provider** (`callback.provider = "gitlab"`) or accounts off: the `sign-in-failed` notice is `unknown-provider` or `unavailable`, `done` once, `finishSignIn` never called, and a normal guest boot.
  11. **`stop()` and `start()` mid-callback** (gate closed). Nothing is sent while stopped. After the gate opens, `start()` resumes the claim once.
  12. **The label on reload.** A session boot with `accountLabel` holding `{"provider":"github","email":"b@x"}` gives `account` exactly that. Junk JSON gives `{ provider: null, email: null }`. Sign-out clears the key.
- [ ] **Step 3: Move the existing `accounts.test.ts` tests onto the redirect flow.** Use `redirect()` wherever a test called `signUp`/`signIn`. Each moved describe gets `{ timeout: 60_000 }`.

  | Existing test | Becomes |
  |---|---|
  | 1, 2, 3, 4a–4d (boot paths) | kept; `account` assertions take the new shape |
  | 5 (sign-up claims first) | replaced by new test 6 |
  | 6 (the hold with held batches) | replaced by new tests 1 and 7: there are no held batches across a page load (O-5) |
  | 7 (409 parks, drops the held batch) | via `redirect()` to a user whose account already has a world; the "held batch" assertion goes, the park and notice assertions stay |
  | 8 (404), 9a, 9b, 10 | via `redirect()` |
  | 11 (a failed sign-in releases) | replaced by new test 9 |
  | 12 (a lost claim response retries, held) | via `redirect()`, with `rig.fetch.dropNextResponse` set before page 2 starts |
  | Round 1: B ×3, C, E, F (503, 401) | via `redirect()` |
  | D (a guest-creation retry mid-sign-in sends nothing) | rewritten: a callback boot with no token sends no `POST /api/guests` before `finishSignIn` answers |
  | D (a keepalive after a reset is ignored) | kept |
  | F (stop/start mid-hold, mid-claim) | via `redirect()` with `finishGate`, and `dropNextResponse` |
  | F (a failed sign-out) | kept |
  | Rounds 2 and 3 | wherever they reach a session through `signUp`, use `redirect()`; the assertions are unchanged |

- [ ] **Step 4:** run `pnpm --filter @manufactory/web exec vitest run src/auth src/sync`. Watch the new tests fail.
- [ ] **Step 5: Implement.**
  - **The client:** O-7, in that order.
  - **`#boot`:** O-6's branches after health.
  - **`beginSignIn`:** O-5.
  - **`pageShown`:** O-11.
  - **The health parse:** O-3.
  - **`#leaveSession`:** clears `accountLabel` and drops the two toasts.
  - The old `signUp`/`signIn` route through `#enterSession({ provider: null, email })`.
- [ ] **Step 6:** rerun Step 4's suites, then the whole web suite. Green.
- [ ] **Step 7: Mutations, each undone by hand:**
  - in `beginSignIn`, skip the pending check after `idle()`: store test 2 fails (navigate is called);
  - in the callback boot, call `#release()` before `finishSignIn` (a guest GET first): store test 7 fails;
  - write the consumed marker after `signInAndUp` instead of before: client test 6's never-resolving case fails;
  - drop `hasSession()`-first in the callback branch: store test 8 fails (`finishSignIn` called);
  - read `error_description` into `provider-error`: client test 3 fails;
  - call `done()` twice on success: store test 6 fails.
- [ ] **Step 8:** run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`. Commit: `Web: sign in by redirect: the AccountClient's ThirdParty calls, the drain before leaving, and the callback boot onto the existing claim (O-5 to O-11)`.

---

### Task 4: web: the provider buttons and the callback route; email/password leaves the client

**Files:**
- **Modify:**
  - `apps/web/src/auth/accounts.ts`: remove `AuthField`, `AuthResult`, `ResetResult`, `signUp`, `signIn`, `sendReset` and `submitNewPassword`.
  - `apps/web/src/auth/supertokens.ts`: remove `EmailPassword` (the import, the `init`, the mapping), so the `recipeList` is `[session, thirdparty]`. Update the header comment.
  - `apps/web/src/auth/supertokens.test.ts`: remove the email/password tests, and update test 1.
  - `apps/web/src/sync/store.ts`: remove `signUp`, `signIn`, `sendReset`, `submitNewPassword` and `#signIn`.
  - `apps/web/src/sync/test-rig.ts`: `rigAccounts` loses the old methods.
  - `apps/web/src/ui/AccountForms.tsx`: rewritten as `AccountSection` with `ProviderButtons` and `SignedIn`. `Field`, `fieldErrorsOf`, `fieldSummary`, `useInvalidFocus`, `SignForm` and `ForgotForm` go. `useRun`, `FormError` and `ACCOUNTS_OFF` stay.
  - `apps/web/src/ui/Settings.tsx`: the props are `store: Pick<GameStore, "beginSignIn" | "signOut">`, `view` and `section?: "account"`. `mode` and `AccountMode` go.
  - `apps/web/src/ui/Settings.module.css`: `.providers` (column, gap 8 px) and `.provider` (full width, `justify-content: flex-start`, text left). The `.field*` and `.page` rules go when nothing uses them; grep.
  - `apps/web/src/ui/Settings.test.tsx`: tests 4–7 are rewritten (below).
  - `apps/web/src/ui/route.ts` and `route.test.ts`: `reset-password` goes, and `{ kind: "callback"; provider: string }` comes in (O-8).
  - `apps/web/src/ui/App.tsx`: the `ResetPassword` branch goes. The callback route renders `<p className="app-loading">Signing in…</p>`. `onSaveChip` opens `{ section: "account" }`.
  - `apps/web/src/ui/Shell.tsx`: `showsChip` adds `view.providers.length > 0` (O-13). Its tests go in `Shell.test.tsx`.
  - `apps/web/src/ui/Notices.tsx`: `TOASTS` adds `signed-in` and `sign-in-failed`.
  - `apps/web/src/ui/test-fixtures.ts`: the fake store's `signUp`/`signIn` give way to `beginSignIn: vi.fn(() => Promise.resolve<BeginResult>({ ok: true }))`.
  - `apps/web/src/main.tsx`: the callback, `navigate`, `accountLabel` and `pageshow` (below).
- **Delete:** `apps/web/src/ui/ResetPassword.tsx`.

**Interfaces:**

```ts
// route.ts
export type Route = { kind: "game" } | { kind: "handbook"; itemId: ItemId | null } | { kind: "callback"; provider: string };
// parseRoute("/account/callback/<id>") with /^[a-z0-9-]{1,32}$/ → callback; anything else under /account → game (unknown, replaced)

// main.tsx
const first = parseRoute(location.pathname);
const store = new GameStore({
  …,
  accountLabel: browserTokenStorage(undefined, ACCOUNT_LABEL_KEY),
  navigate: (url) => window.location.assign(url),
  ...(first.kind === "callback"
    ? { callback: { provider: first.provider, search: location.search, done: () => replaceRoute({ kind: "game" }) } }
    : {}),
});
window.addEventListener("pageshow", (e) => store.pageShown(e.persisted));

// AccountForms.tsx
export function AccountSection(p: { store: Pick<GameStore, "beginSignIn" | "signOut">; view: StoreView; focusFirst: boolean }): JSX.Element;
```

The `AccountSection` states, in order:
- `accounts === "off"` → `ACCOUNTS_OFF`;
- a session → `SignedIn` (O-9's line, the parked line, Sign out);
- `accounts` or identity `"unknown"` → "Checking the server…";
- `providers` empty → "Sign-in isn't available right now." (`data-signin-unavailable`);
- otherwise the heading "Sign in", O-18's note and one button per provider.

A button press runs `store.beginSignIn(id)` through `useRun`. A refusal shows O-10's form-error text in `FormError` and announces it. `{ ok: true }` shows nothing, because the page is leaving.

Steps:
- [ ] **Step 1: Write the failing tests.**
  1. **`route.test.ts`:**
     - `/account/callback/discord` and `/account/callback/github/` → `callback`;
     - `/account/callback/`, `/account/callback/Disc%20ord`, `/account/callback/a/b` and `/account/reset-password` → `game`.
     - **Mounted at `/account/callback/github?code=c&state=s`:** `useRoute` leaves `location.pathname + location.search` unchanged.
     - **Mounted at `/account/reset-password?token=t`:** the location is replaced with `/`.
  2. **`Settings.test.tsx` 4:** accounts off → `ACCOUNTS_OFF` and no buttons.
  3. **5a:** accounts on, `providers: []` → "Sign-in isn't available right now." and no `[data-provider]`.
  4. **5b:** `providers: ["discord", "github"]`.
     - Two buttons in that order, named "Sign in with Discord" and "Sign in with GitHub".
     - Terminal theme: the visible text is `> login --discord`. Clean (Dark): "Sign in with Discord".
     - A click calls `beginSignIn("discord")` once. A second click while pending doesn't call it again.
     - `providers: ["gitlab"]` gives "Sign in with gitlab".
  5. **5c: the refusals.** Each of `unsaved`, `storage` (with the provider's name), `unavailable` and `not-allowed` puts O-10's text in `[data-form-error]` and announces it once.
  6. **5d:** `view.leaving = "github"` → both buttons have `aria-disabled="true"`. GitHub's reads "Opening GitHub…" with `aria-busy="true"`.
  7. **6, signed in:**
     - `{ provider: "discord", email: "a@x" }` → "Signed in with Discord as a@x";
     - `{ provider: "github", email: null }` → "Signed in with GitHub";
     - `{ provider: null, email: null }` → "Signed in";
     - Sign out and the parked line work as today.
  8. **7, the chip:** it isn't shown with `providers: []` even at tier 1, and is shown with `["github"]`. Clicking it opens Settings with focus on the first provider button.
  9. **`Notices`:** `signed-in` and `sign-in-failed` have a dismiss control. `signed-out` still doesn't.
- [ ] **Step 2:** run `pnpm --filter @manufactory/web exec vitest run src/ui/route.test.ts src/ui/Settings.test.tsx src/ui/Shell.test.tsx`. Watch them fail.
- [ ] **Step 3: Implement.** Delete the old methods and their tests. Grep `apps/web/src` for `signUp`, `signIn(`, `sendReset`, `submitNewPassword`, `reset-password`, `AuthField`, `ResetResult` and `emailpassword`, until all are gone outside the git history.
- [ ] **Step 4:** run `pnpm --filter @manufactory/web test`. Green.
- [ ] **Step 5: Mutations, each undone by hand:**
  - drop the `callback` case from `parseRoute`: route test 1's mounted case fails (the query is stripped);
  - make `showsChip` ignore `providers`: Settings test 8 fails;
  - render the provider id instead of `providerName(id)`: test 4 fails;
  - leave `EmailPassword.init()` in the `recipeList`: client test 1 fails.
- [ ] **Step 6:** run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`. Then run `pnpm --filter @manufactory/web e2e` once. Expect only `accounts.spec.ts` and `layout-320.spec.ts`'s account steps to fail, and record which. Commit: `Web: one button per provider, the callback route, and email/password gone from the client (O-1, O-8, O-13, O-18)`.

---

### Task 5: e2e through the fake, the READMEs, and the deploy probe

**Files:**
- **Rewrite:** `apps/web/e2e/accounts.spec.ts`.
- **Modify:**
  - `apps/web/e2e/helpers.ts`: `signUpThroughSettings` goes, and `signInThroughSettings` comes in;
  - `apps/web/e2e/layout-320.spec.ts`;
  - `README.md`: the "Accounts in local play" paragraph;
  - `apps/api/README.md`: the variable table, "Auth model", and "Fake sessions";
  - `infra/README.md`: the account variables and the smoke-test section;
  - `infra/unraid/README.md`: step 6, the one-time note (O-16), the callback URLs, and "Adding a variable";
  - `infra/unraid/deploy.sh`: the probe and its comments;
  - `.github/workflows/ci.yml`: the `web-e2e` comment's times only, if they moved.

**Interfaces:**

```ts
// helpers.ts
/** Sets the fake provider's user (cookie dev-oauth-user), opens Settings, presses "Sign in with <Name>",
 *  and resolves once the page is back on "/" with data-sync="ready". */
export async function signInThroughSettings(page: Page, provider: "discord" | "github", user: string): Promise<void>;
```

Steps:
- [ ] **Step 1: `accounts.spec.ts`**, one test with `test.step`s. Every wait is on the DOM, a store attribute, storage or the request log (W-23). It keeps the existing request log with `allHeaders()`. Users are `<name>-${Date.now()}`, because the reused dev server keeps users in memory.
  1. **Health:** `accounts: true` and `providers: ["discord", "github"]`. The failure message says to start the API with `DEV_FAKE_SESSIONS=1`.
  2. **A guest with progress, then Discord** (Review Focus 1):
     - reorder to state version 1, and note the token;
     - `signInThroughSettings(page, "discord", alice)`;
     - the claim is the first world-ish request after `/auth/signinup`'s response, and nothing world-ish (`/api/world`, `/api/actions`, `/api/guests`, `/api/auth/claim`) comes between the callback page's load and the claim's answer;
     - the claim body is `{ guestToken }` with no `authorization`;
     - `/auth/authorisationurl` and `/auth/signinup` carry `fdi-version`;
     - the URL is `/` with an empty search;
     - `mi.guestToken` is null, and the version is 1;
     - `[data-notice="signed-in"]` reads "Signed in with Discord as alice-…@discord.example."
  3. **The callback URL again** (Review Focus 2): `page.goto(<the callback URL recorded in step 2>)`. No new `/auth/signinup` request, the URL becomes `/`, still signed in, version 1, and no `sign-in-failed` notice.
  4. **A reload stays signed in.** No guest POST, and no `Authorization` on world GETs. Settings shows "Signed in with Discord as alice-…" (from `mi.account`).
  5. **Sign out:** a new guest, as today.
  6. **A denial** (Review Focus 5): user `deny` on GitHub. The page is back on `/` with the `sign-in-failed` toast "Sign-in with GitHub was cancelled. You're still playing as a guest." There's no `/auth/signinup` request, and the guest token is unchanged.
  7. **A stale callback** (Review Focus 4): `page.goto("/account/callback/github?code=x&state=nope")`. The `stale` text shows, there's no `/auth/signinup`, the URL is `/`, and the token is unchanged. Then `/account/callback/gitlab?code=x&state=y`: "That sign-in provider isn't available here." `/account/reset-password?token=t` lands on `/`, the game.
  8. **The 409 park:** Discord with alice again. The new guest is parked (`mi.parkedGuestToken`), `account-has-factory` shows, and the version is 1.
  9. **The drain** (Review Focus 1). Sign out (back to the parked guest at version 0). Route `**/api/actions` to delay its response until a flag is set, then reorder, then press "Sign in with GitHub" (user bob):
     - while the action is held, no `/auth/authorisationurl` request is made, and the button reads "Opening GitHub…";
     - release it, and the page goes to GitHub's fake and back;
     - the claim is 200, and the account is at version 1 with the guest's seed. That's the GitHub provider with a 200 claim.
  10. **No-email:** sign out, then GitHub with user `no-email`. The toast is the `no-email` text, and the page is still a guest.
- [ ] **Step 2: `layout-320.spec.ts`.** "The sign-up form with a field error" becomes "the Account section": the provider buttons are visible, with no overflow and no target under 44 × 44. "The reset-password page" step is replaced by "a sign-in toast": `page.goto("/account/callback/github?error=access_denied&state=x")`, the toast is visible, and `expectNoOverflow`.
- [ ] **Step 3: Docs and deploy.**
  - **`deploy.sh`:** the probe is `curl -fsS --max-time 15 "$base/auth/loginmethods"`, which must contain `"status":"OK"`. Log the health body's `providers`. Update the step-6 comment. In `render()`'s comment, "such as the SMTP ones" becomes "such as the DISCORD_* ones".
  - **`infra/unraid/README.md`:**
    - **step 6** names `/auth/loginmethods`;
    - a new **"Sign-in providers"** section:
      - the callback URLs to register, `https://manufactory.neverendingcode.com/account/callback/discord` and `…/github`;
      - Discord's scopes `identify email` and GitHub's `read:user user:email` (both the SDK's defaults; nothing to set);
      - the four variables;
      - that `/api/health`'s `providers` shows which are live;
    - a new **"Upgrading across the OAuth change (once)"** with O-16's commands;
    - **"Adding a variable":** its example becomes `DISCORD_CLIENT_SECRET`;
    - **the secrets table:** drop `SMTP_*`, and note that existing `SMTP_*` lines in the template are now ignored and can be deleted.
  - **`apps/api/README.md`:** drop the `SMTP_*` row and the R-24 paragraph. Add `GOOGLE_*` as "not yet: one line in `PROVIDER_TABLE`". "Auth model": sign-in is Discord and GitHub through SuperTokens ThirdParty, with the redirect URI pinned (O-4). "Fake sessions": O-14's endpoints, the `dev-oauth-user` cookie, and the special users `deny`, `no-email` and `not-allowed`.
  - **`infra/README.md`:** drop "SMTP for reset mail". The smoke section describes O-15.
  - **The root `README.md`:** "Settings → Account signs in with a fake Discord or GitHub that redirects straight back; set the `dev-oauth-user` cookie to choose the user." The reset-link sentence goes.
- [ ] **Step 4: Run the e2e locally, in the foreground:** `pnpm --filter @manufactory/web e2e`. Every spec must pass. If one fails, debug it with the retained trace, never with sleeps. Update the `ci.yml` comment's times if they moved.
- [ ] **Step 5: Mutations, each undone by hand (rebuild between):**
  - make `beginSignIn` skip the drain (navigate right after `authorisationURL`): step 9 fails;
  - make `useRoute` strip the callback (drop the parser case): step 2 fails with `stale`;
  - remove `hasSession()`-first from the callback branch: step 3 fails (a second `/auth/signinup`, then an `unavailable` toast).
- [ ] **Step 6:** run `pnpm test`, then `pnpm lint`, then `pnpm typecheck`, then `pnpm --filter @manufactory/web e2e`, all green. Commit: `Web: the account e2e signs in through the fake Discord and GitHub; READMEs and the deploy probe move to OAuth (O-14, O-16)`.

---

## Superseded rulings (for the reviewer)

1. **R-12** ("dev and CI run EmailPassword only"): dev and CI run the fake ThirdParty (O-14). Providers still need both env vars (O-2).
2. **R-24** (self-hosted reset mail): retired with the recipe (O-1).
3. **W-15**'s "EmailPassword + Session recipes": these are now ThirdParty + Session. Cookie mode, same origin and the health-gated init stand.
4. **W-16:**
   - "Sign-up and sign-in run in a sheet": the sheet starts the redirect, and the callback finishes it (O-5, O-6);
   - "Discord and GitHub stay off in the UI until a LICENSE": the GPL notice is in About (UI-1), so they're on;
   - the claim outcomes are unchanged.
5. **S-4:** the hold now covers the callback boot (O-6). `beginSignIn` drains instead of holding, because the page leaves (O-5).
6. **S-8:** the fake's endpoints are O-14's. The cookie, front-token, sign-out, refresh and FDI rules stand.
7. **S-9:** `websiteBasePath` stays `/account` for the callback paths (O-17). There's no reset link any more.
8. **S-10:** the routes are `/`, `/handbook[/:itemId]` and `/account/callback/:provider`.
9. **S-11:** the Account section is O-18's buttons or the signed-in line (O-9). "No user-info route" stands.
10. **S-12:** the chip opens Account (no mode) and needs a provider (O-13).
11. **The Phase 4 spec's open question 4** ("defer until a deployment has credentials, then add `providers` and `/account/callback/:provider`") is what this plan does.
