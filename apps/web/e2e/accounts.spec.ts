// 4c (W-16, W-23, S-4 to S-7): accounts against the dev server's fake SuperTokens
// (DEV_FAKE_SESSIONS=1). A guest with progress signs up and the claim is the first world
// request after it; a reload stays signed in; sign-out makes a new guest; signing in again
// parks that guest (409) and loads the account's world; sign-out returns to the parked guest;
// then a password reset through the dev reset link.
import { expect, test, type Request } from "@playwright/test";
import { signUpThroughSettings, startGuest } from "./helpers.js";

const TOKEN_KEY = "mi.guestToken";
const PARKED_KEY = "mi.parkedGuestToken";
const GUEST_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const WORLD_PATHS = ["/api/world", "/api/actions", "/api/auth/claim"];

interface Seen {
  method: string;
  path: string;
  /** allHeaders(), not headers(): headers() leaves out authorization and cookies. */
  headers: () => Promise<Record<string, string>>;
  body: string | null;
}

test("sign up claims the guest; sign out, a 409 park, the way back, and a reset", async ({
  page,
  request,
}) => {
  await test.step("the API runs the fake sessions", async () => {
    const health = (await (await request.get("/api/health")).json()) as { accounts?: unknown };
    expect(health.accounts, "start the API with DEV_FAKE_SESSIONS=1 (reuseExistingServer)").toBe(
      true,
    );
  });

  // Every request the page makes, in order, and the log index at the sign-up's response.
  const log: Seen[] = [];
  let signupAnsweredAt = -1;
  page.on("request", (req: Request) => {
    log.push({
      method: req.method(),
      path: new URL(req.url()).pathname,
      headers: () => req.allHeaders(),
      body: req.postData(),
    });
  });
  let claimAnsweredAt = -1;
  page.on("response", (res) => {
    const path = new URL(res.url()).pathname;
    if (path === "/auth/signup" && signupAnsweredAt === -1) signupAnsweredAt = log.length;
    if (path === "/api/auth/claim" && claimAnsweredAt === -1) claimAnsweredAt = log.length;
  });
  const storage = (key: string) => page.evaluate((k) => localStorage.getItem(k), key);
  const guestPosts = () => log.filter((r) => r.method === "POST" && r.path === "/api/guests");

  // The page's clock, so the hold below can age the snapshot past MIN_REPOLL_MS (5 s).
  await page.clock.install();
  const { root } = await startGuest(page);
  const sheet = page.getByRole("dialog", { name: "Settings" });
  const email = `e2e-${Date.now()}@example.com`;
  let firstGuest = "";

  await test.step("a guest with progress", async () => {
    // Desktop Chrome is 1280 px wide: three panes, the priority list always shown.
    const ore = page.locator('#pane-priority li[data-entry="item:iron_ore"]');
    await ore.focus();
    await ore.press("Alt+ArrowDown");
    await expect(root).toHaveAttribute("data-state-version", "1");
    firstGuest = (await storage(TOKEN_KEY)) ?? "";
    expect(firstGuest).toMatch(GUEST_TOKEN);
  });

  let claimedAt = -1;
  await test.step("sign up: the claim goes first", async () => {
    // S-4: while the first claim is out, everything that would GET is tried: the timers run
    // 6 s on and the window takes focus. Nothing may go out until the claim answers. The
    // half second is room for a wrong request to be seen, not a wait for a right one.
    await page.route(
      "**/api/auth/claim",
      async (route) => {
        await page.clock.fastForward(6_000);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await new Promise((r) => setTimeout(r, 500));
        await route.continue();
      },
      { times: 1 },
    );
    await signUpThroughSettings(page, email, "password1");
    await expect.poll(() => storage(TOKEN_KEY)).toBeNull();
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(root).toHaveAttribute("data-state-version", "1");

    const signup = log.find((r) => r.method === "POST" && r.path === "/auth/signup");
    expect((await signup?.headers())?.["fdi-version"], "S-1: the SDK's FDI pin").toBeTruthy();
    expect(signupAnsweredAt).toBeGreaterThan(-1);
    const after = log.slice(signupAnsweredAt);
    const firstWorld = after.find((r) => WORLD_PATHS.some((p) => r.path.startsWith(p)));
    expect(firstWorld && `${firstWorld.method} ${firstWorld.path}`).toBe("POST /api/auth/claim");
    claimedAt = log.indexOf(firstWorld!);
    expect(claimAnsweredAt).toBeGreaterThan(claimedAt);
    const held = log
      .slice(signupAnsweredAt, claimAnsweredAt)
      .filter((r) => r !== firstWorld && WORLD_PATHS.some((p) => r.path.startsWith(p)));
    expect(
      held.map((r) => `${r.method} ${r.path}`),
      "S-4: nothing before the claim's answer",
    ).toEqual([]);
    // S-5: the guest token in the body, under the new session's cookie, no Authorization.
    expect(JSON.parse(firstWorld!.body ?? "null")).toEqual({ guestToken: firstGuest });
    expect((await firstWorld!.headers()).authorization).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });

  await test.step("a reload stays signed in", async () => {
    const before = guestPosts().length;
    await page.reload();
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(root).toHaveAttribute("data-state-version", "1");
    expect(guestPosts().length).toBe(before);
    expect(await storage(TOKEN_KEY)).toBeNull();
    const worldGets = log.slice(claimedAt + 1).filter((r) => r.path.startsWith("/api/world"));
    expect(worldGets.length).toBeGreaterThan(0);
    const auths = await Promise.all(worldGets.map(async (r) => (await r.headers()).authorization));
    expect(auths).toEqual(worldGets.map(() => undefined));
    await page.locator("[data-open-settings]").click();
    await expect(sheet.locator("p[data-signed-in]")).toContainText("Signed in");
  });

  let secondGuest = "";
  await test.step("sign out: a new guest", async () => {
    const before = guestPosts().length;
    await sheet.getByRole("button", { name: "Sign out" }).click();
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(root).toHaveAttribute("data-state-version", "0");
    await expect.poll(() => storage(TOKEN_KEY)).toMatch(GUEST_TOKEN);
    secondGuest = (await storage(TOKEN_KEY))!;
    expect(secondGuest).not.toBe(firstGuest);
    expect(guestPosts().length).toBe(before + 1);
    expect(await storage(PARKED_KEY)).toBeNull();
  });

  await test.step("sign in again: the 409 parks the new guest", async () => {
    await expect(sheet.getByRole("form", { name: "Create account" })).toBeVisible();
    await sheet.getByRole("button", { name: "Sign in instead" }).click();
    const form = sheet.getByRole("form", { name: "Sign in" });
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Password").fill("password1");
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(sheet.locator("p[data-signed-in]")).toContainText("Signed in");
    await expect.poll(() => storage(PARKED_KEY)).toBe(secondGuest);
    expect(await storage(TOKEN_KEY)).toBeNull();
    await expect(root).toHaveAttribute("data-state-version", "1");
    await expect(page.locator('[data-notice="account-has-factory"]')).toBeVisible();
  });

  await test.step("sign out: back to the parked guest", async () => {
    const before = guestPosts().length;
    await sheet.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => storage(TOKEN_KEY)).toBe(secondGuest);
    expect(await storage(PARKED_KEY)).toBeNull();
    await expect(root).toHaveAttribute("data-sync", "ready");
    await expect(root).toHaveAttribute("data-state-version", "0");
    expect(guestPosts().length).toBe(before);
  });

  await test.step("reset the password through the dev link", async () => {
    // The sheet is still on the sign-in form it last showed.
    await expect(sheet.getByRole("form", { name: "Sign in" })).toBeVisible();
    await sheet.getByRole("button", { name: "Forgot password?" }).click();
    const forgot = sheet.getByRole("form", { name: "Reset password" });
    await forgot.getByLabel("Email").fill(email);
    await forgot.getByRole("button", { name: "Send reset link" }).click();
    await expect(sheet).toContainText("If that email has an account, a reset link is on its way.");

    const res = await request.get(`/auth/dev/reset-link?email=${encodeURIComponent(email)}`);
    expect(res.status()).toBe(200);
    const { link } = (await res.json()) as { link: string };
    await page.goto(link);
    const main = page.locator('main[data-reset="form"]');
    await main.getByLabel("New password", { exact: true }).fill("password2");
    await main.getByRole("button", { name: "Change password" }).click();
    const done = page.locator('main[data-reset="done"]');
    await expect(done).toContainText("Password changed.");
    await done.getByRole("button", { name: "Sign in" }).click();

    const form = sheet.getByRole("form", { name: "Sign in" });
    await expect(form).toBeVisible();
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Password").fill("password1");
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(form.locator("[data-form-error]")).toHaveText(
      "That email and password don't match.",
    );
    await form.getByLabel("Password").fill("password2");
    await form.getByRole("button", { name: "Sign in" }).click();
    await expect(sheet.locator("p[data-signed-in]")).toContainText("Signed in");
  });
});
