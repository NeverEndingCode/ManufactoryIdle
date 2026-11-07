// 4c (W-16, W-23, S-4 to S-7) and the OAuth plan (O-5 to O-11, O-14): accounts against the
// dev server's fake SuperTokens and fake providers (DEV_FAKE_SESSIONS=1). A guest with progress
// signs in with Discord and the claim is the first world request after the callback; the
// callback URL again does nothing; a reload stays signed in; sign-out makes a new guest; a
// denial, a stale callback and an unknown provider leave the guest alone; signing in again
// parks the new guest (409); the redirect waits for the outbox to drain; and a provider with
// no email is refused. Every wait is on the DOM, a store attribute, storage or the request log.
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { signInThroughSettings, startGuest } from "./helpers.js";

const TOKEN_KEY = "mi.guestToken";
const PARKED_KEY = "mi.parkedGuestToken";
const GUEST_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Everything world-shaped (O-6): none of it may go out before the claim answers. */
const WORLD_PATHS = ["/api/world", "/api/actions", "/api/guests", "/api/auth/claim"];

interface Seen {
  method: string;
  url: string;
  path: string;
  navigation: boolean;
  /** allHeaders(), not headers(): headers() leaves out authorization and cookies. */
  headers: () => Promise<Record<string, string>>;
  body: string | null;
}

interface Answer {
  path: string;
  status: number;
  /** The log's length when the response came in: requests at or after it came after. */
  at: number;
}

const isWorld = (r: Seen) => WORLD_PATHS.some((p) => r.path.startsWith(p));

/** The priority list's order, by entry. */
async function priorityOrder(page: Page): Promise<string[]> {
  await page
    .getByRole("tablist", { name: "Panels" })
    .getByRole("tab", { name: /priority/ })
    .click();
  const rows = page.locator("#view-priority li[data-entry]");
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-entry") ?? ""));
}

/** Moves iron ore one place down: one REORDER, so the state version goes up by one. */
async function reorder(page: Page, root: Locator, version: number): Promise<void> {
  await page
    .getByRole("tablist", { name: "Panels" })
    .getByRole("tab", { name: /priority/ })
    .click();
  const ore = page.locator('#view-priority li[data-entry="item:iron_ore"]');
  await ore.focus();
  await ore.press("Alt+ArrowDown");
  await expect(root).toHaveAttribute("data-state-version", String(version));
}

test("sign in with Discord and GitHub through the fake: the claim, the callback, a 409 park, the drain", async ({
  page,
  request,
}) => {
  await test.step("the API runs the fake sessions and both fake providers", async () => {
    const health = (await (await request.get("/api/health")).json()) as {
      accounts?: unknown;
      providers?: unknown;
    };
    const hint = "start the API with DEV_FAKE_SESSIONS=1 (reuseExistingServer)";
    expect(health.accounts, hint).toBe(true);
    expect(health.providers, hint).toEqual(["discord", "github"]);
  });

  // Every request the page makes, in order, and where each response came in.
  const log: Seen[] = [];
  const answers: Answer[] = [];
  page.on("request", (req: Request) => {
    log.push({
      method: req.method(),
      url: req.url(),
      path: new URL(req.url()).pathname,
      navigation: req.isNavigationRequest(),
      headers: () => req.allHeaders(),
      body: req.postData(),
    });
  });
  page.on("response", (res) => {
    answers.push({ path: new URL(res.url()).pathname, status: res.status(), at: log.length });
  });
  const storage = (key: string) => page.evaluate((k) => localStorage.getItem(k), key);
  const guestPosts = () => log.filter((r) => r.method === "POST" && r.path === "/api/guests");
  const requestsTo = (path: string, from = 0) => log.slice(from).filter((r) => r.path === path);
  const lastAnswer = (path: string) => answers.filter((a) => a.path === path).at(-1);

  const { root } = await startGuest(page);
  const sheet = page.getByRole("dialog", { name: "Settings" });
  const toast = (kind: string) => page.locator(`[data-notice="${kind}"]`);
  const openSettings = async () => {
    await page.locator("[data-open-settings]").click();
    await expect(sheet).toBeVisible();
  };
  const signOut = async () => {
    await openSettings();
    await sheet.getByRole("button", { name: "Sign out" }).click();
    await expect(sheet.locator("[data-provider]").first()).toBeVisible();
    await expect(root).toHaveAttribute("data-sync", "ready");
  };
  const run = Date.now();
  const alice = `alice-${run}`;
  const bob = `bob-${run}`;

  let firstGuest = "";
  let callbackURL = "";
  let order: string[] = [];
  await test.step("a guest with progress signs in with Discord: the claim goes first", async () => {
    await reorder(page, root, 1);
    firstGuest = (await storage(TOKEN_KEY)) ?? "";
    expect(firstGuest).toMatch(GUEST_TOKEN);
    order = await priorityOrder(page);

    const from = log.length;
    await signInThroughSettings(page, "discord", alice);
    await expect(toast("signed-in")).toHaveText(
      new RegExp(`^Signed in with Discord as ${alice}@discord\\.example\\.`),
    );
    await expect.poll(() => storage(TOKEN_KEY)).toBeNull();
    await expect(root).toHaveAttribute("data-state-version", "1");
    expect(new URL(page.url()).search).toBe("");

    const callback = log
      .slice(from)
      .find((r) => r.navigation && r.path === "/account/callback/discord");
    expect(callback, "the fake provider redirects to the callback").toBeDefined();
    callbackURL = callback!.url;
    const callbackAt = log.indexOf(callback!);
    const signinup = lastAnswer("/auth/signinup");
    const claim = lastAnswer("/api/auth/claim");
    expect(signinup && signinup.at).toBeGreaterThan(callbackAt);
    expect(claim?.status).toBe(200);

    // The claim is the first world request after the sign-in's answer, and nothing
    // world-shaped went out between the callback page's load and the claim's answer (O-6).
    const firstWorld = log.slice(signinup!.at).find(isWorld);
    expect(firstWorld && `${firstWorld.method} ${firstWorld.path}`).toBe("POST /api/auth/claim");
    const early = log
      .slice(callbackAt, claim!.at)
      .filter((r) => r !== firstWorld && isWorld(r))
      .map((r) => `${r.method} ${r.path}`);
    expect(early, "O-6: nothing world-shaped before the claim's answer").toEqual([]);
    // S-5: the guest token in the body, under the new session's cookie, no Authorization.
    expect(JSON.parse(firstWorld!.body ?? "null")).toEqual({ guestToken: firstGuest });
    expect((await firstWorld!.headers()).authorization).toBeUndefined();

    for (const path of ["/auth/authorisationurl", "/auth/signinup"]) {
      const sent = requestsTo(path, from);
      expect(sent.length, path).toBe(1);
      expect((await sent[0]!.headers())["fdi-version"], `S-1: ${path} pins the FDI`).toBeTruthy();
    }
    expect(await priorityOrder(page)).toEqual(order);
  });

  await test.step("the callback URL again signs nothing in twice", async () => {
    const from = log.length;
    await page.goto(callbackURL);
    await expect(page).toHaveURL(/\/$/);
    expect(new URL(page.url()).search).toBe("");
    expect(requestsTo("/auth/signinup", from), "O-6: hasSession() first").toEqual([]);
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(toast("sign-in-failed")).toHaveCount(0);
    await openSettings();
    await expect(sheet.locator("p[data-signed-in]")).toContainText(
      `Signed in with Discord as ${alice}`,
    );
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  await test.step("a reload stays signed in", async () => {
    const before = guestPosts().length;
    const from = log.length;
    await page.reload();
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(root).toHaveAttribute("data-state-version", "1");
    expect(guestPosts().length).toBe(before);
    expect(await storage(TOKEN_KEY)).toBeNull();
    const worldGets = log.slice(from).filter((r) => r.method === "GET" && r.path === "/api/world");
    expect(worldGets.length).toBeGreaterThan(0);
    const auths = await Promise.all(worldGets.map(async (r) => (await r.headers()).authorization));
    expect(auths).toEqual(worldGets.map(() => undefined));
    await openSettings();
    await expect(sheet.locator("p[data-signed-in]")).toContainText(
      `Signed in with Discord as ${alice}`,
    );
    await page.keyboard.press("Escape");
  });

  let secondGuest = "";
  await test.step("sign out: a new guest", async () => {
    const before = guestPosts().length;
    await signOut();
    await expect(root).toHaveAttribute("data-state-version", "0");
    await expect.poll(() => storage(TOKEN_KEY)).toMatch(GUEST_TOKEN);
    secondGuest = (await storage(TOKEN_KEY))!;
    expect(secondGuest).not.toBe(firstGuest);
    expect(guestPosts().length).toBe(before + 1);
    expect(await storage(PARKED_KEY)).toBeNull();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  await test.step("a denial on GitHub: still the same guest", async () => {
    const from = log.length;
    await signInThroughSettings(page, "github", "deny");
    await expect(toast("sign-in-failed")).toHaveText(
      /^Sign-in with GitHub was cancelled\. You're still playing as a guest\./,
    );
    expect(requestsTo("/auth/signinup", from)).toEqual([]);
    expect(await storage(TOKEN_KEY)).toBe(secondGuest);
    expect(new URL(page.url()).search).toBe("");
  });

  await test.step("a stale callback, an unknown provider and an old reset link", async () => {
    const from = log.length;
    await page.goto("/account/callback/github?code=x&state=nope");
    await expect(toast("sign-in-failed")).toHaveText(
      /^That sign-in didn't finish in this tab, or it took too long\. Start it again from Settings\./,
    );
    await expect(page).toHaveURL(/\/$/);
    await expect(root).toHaveAttribute("data-sync", "ready");
    expect(requestsTo("/auth/signinup", from)).toEqual([]);
    expect(await storage(TOKEN_KEY)).toBe(secondGuest);

    await page.goto("/account/callback/gitlab?code=x&state=y");
    await expect(toast("sign-in-failed")).toHaveText(
      /^That sign-in provider isn't available here\./,
    );
    await expect(page).toHaveURL(/\/$/);
    expect(requestsTo("/auth/signinup", from)).toEqual([]);

    await page.goto("/account/reset-password?token=t");
    await expect(page).toHaveURL(/\/$/);
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(page.locator("#view-factory")).toBeVisible();
    expect(await storage(TOKEN_KEY)).toBe(secondGuest);
  });

  await test.step("Discord with alice again: the 409 parks the new guest", async () => {
    await signInThroughSettings(page, "discord", alice);
    await expect.poll(() => storage(PARKED_KEY)).toBe(secondGuest);
    expect(await storage(TOKEN_KEY)).toBeNull();
    await expect.poll(() => lastAnswer("/api/auth/claim")?.status).toBe(409);
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(toast("account-has-factory")).toBeVisible();
  });

  await test.step("the drain: GitHub waits for the outbox, then claims the guest", async () => {
    const before = guestPosts().length;
    await signOut();
    await expect.poll(() => storage(TOKEN_KEY)).toBe(secondGuest);
    expect(await storage(PARKED_KEY)).toBeNull();
    await expect(root).toHaveAttribute("data-state-version", "0");
    expect(guestPosts().length).toBe(before);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // The REORDER's POST is held until `release`.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    await page.route(
      "**/api/actions",
      async (route) => {
        held = true;
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    const origin = new URL(page.url()).origin;
    await page.context().addCookies([{ name: "dev-oauth-user", value: bob, url: origin }]);
    const from = log.length;
    await page
      .getByRole("tablist", { name: "Panels" })
      .getByRole("tab", { name: /priority/ })
      .click();
    const ore = page.locator('#view-priority li[data-entry="item:iron_ore"]');
    await ore.focus();
    await ore.press("Alt+ArrowDown");
    await expect.poll(() => held).toBe(true);
    const guestOrder = await priorityOrder(page);

    await openSettings();
    const github = sheet.locator('[data-provider="github"]');
    const callback = page.waitForRequest(
      (r) => r.isNavigationRequest() && new URL(r.url()).pathname === "/account/callback/github",
    );
    await github.click();
    await expect(github).toHaveText("Opening GitHub…");
    await expect(github).toHaveAttribute("aria-busy", "true");
    expect(requestsTo("/auth/authorisationurl", from), "O-5: not before the outbox drains").toEqual(
      [],
    );

    release();
    await callback;
    await expect(page).toHaveURL(`${origin}/`);
    await expect(root).toHaveAttribute("data-sync", "ready");
    expect(requestsTo("/auth/authorisationurl", from).length).toBe(1);
    await expect.poll(() => lastAnswer("/api/auth/claim")?.status).toBe(200);
    await expect.poll(() => storage(TOKEN_KEY)).toBeNull();
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(toast("signed-in")).toHaveText(
      new RegExp(`^Signed in with GitHub as ${bob}@github\\.example\\.`),
    );
    expect(await priorityOrder(page)).toEqual(guestOrder);
  });

  await test.step("no email from GitHub: still a guest", async () => {
    await signOut();
    await expect.poll(() => storage(TOKEN_KEY)).toMatch(GUEST_TOKEN);
    const guest = (await storage(TOKEN_KEY))!;
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    await signInThroughSettings(page, "github", "no-email");
    await expect(toast("sign-in-failed")).toHaveText(
      /^GitHub didn't share an email address, and an account needs one\. Check the email on your GitHub account, then try again\./,
    );
    expect(await storage(TOKEN_KEY)).toBe(guest);
    await openSettings();
    await expect(sheet.locator("[data-provider]")).toHaveCount(2);
    await expect(sheet.locator("p[data-signed-in]")).toHaveCount(0);
  });
});
